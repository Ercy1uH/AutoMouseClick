#!/usr/bin/env node
/*
 * 隔离的回归编排器（批次 1.1 / 1.2）
 *
 * 为什么需要它：两个 UI 套件原本要求开发者自己先在 28332 起一个服务、token 必须是 feature-check、
 * 跑完还把截图丢进仓库的 .runtime-profile/。于是"回归"只在特定机器状态下能跑，还会和真实实例
 * 互相污染。这里把服务、token、数据目录、端口、截图目录全部收进编排器。
 *
 * 硬约束（每一条都必须能被证伪，否则就是假绿）：
 *  - 数据目录：独立临时目录，经 MOUSECLIK_DATA 显式传给服务；跑完必须删掉，删不掉要失败
 *  - 端口：自己取一个空闲端口；健康探测 + netstat 归属比对确认是本次启动的进程，否则失败
 *  - token：编排器生成，服务用 MOUSECLIK_SERVER_TOKEN，套件用 MOUSECLIK_TEST_TOKEN
 *  - 不使用、也不透传 MOUSECLIK_ALLOW_INSECURE_WRITES=1
 *  - 串行执行；finally 关自建服务（确认进程真的消失）并清理临时目录，任一步失败都让命令失败
 *  - 跑完比对本机配置目录下的应用数据文件（新增/修改/删除都算改动）
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const APP_SERVER_PORT = 28232; // src/main/main.js 的 SERVER_PORT：桌面套件会拉起真实 Electron

const SUITES = {
  ui: [
    { name: 'profile-floating-ui', script: 'tests/ui/profile-floating-ui.cjs', server: true, browser: true },
    { name: 'loop-preview-ui', script: 'tests/ui/loop-preview-ui.cjs', server: true, browser: true },
    { name: 'loop-ui', script: 'tests/ui/loop-ui.cjs', server: true, browser: true },
    { name: 'ui-smoke', script: 'tests/ui/ui-smoke.cjs', server: true, browser: true },
    { name: 'point-settings-ui', script: 'tests/ui/point-settings-ui.cjs', server: true, browser: true }
  ],
  e2e: [
    { name: 'e2e-http', script: 'tests/e2e/e2e-http.cjs', server: false },
    { name: 'e2e-ui', script: 'tests/e2e/e2e-ui.cjs', server: true, browser: true }
  ],
  desktop: [
    { name: 'desktop-interactions', script: 'tests/desktop/desktop-interactions.cjs', server: false }
  ]
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[suites] ${message}`);
const startedChildren = [];
const tempDirs = [];
const registeredTempNames = new Set();

// 明令禁止的开关：既不给子进程设置，也主动从继承环境里剔除，免得开发者的 shell 把它带进来。
function suiteEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MOUSECLIK_ALLOW_INSECURE_WRITES;
  return env;
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  registeredTempNames.add(path.basename(dir)); // 只有登记过的名字才算"我们的"
  return dir;
}

// 连接探测要覆盖两族地址：只连 127.0.0.1 会漏掉仅监听 [::1] 的进程
function portInUse(port) {
  const attempt = (host) => new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(800);
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
  return attempt('127.0.0.1').then((v4) => (v4 ? true : attempt('::1')));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 归属证明：谁在监听这个端口。拿不到就返回 null —— 调用方必须把它当成"未证明"而不是"没问题"。
// 同一个端口可能同时有 [::1] 与 127.0.0.1 两条监听记录，优先取我们实际绑定的 127.0.0.1。
function listeningPid(port) {
  const entries = [];
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (match && Number(match[2]) === Number(port)) entries.push({ address: match[1], pid: Number(match[3]) });
    }
  } catch { /* 拿不到就当作未证明 */ }
  const preferred = entries.find((entry) => entry.address === '127.0.0.1');
  return (preferred || entries[0])?.pid ?? null;
}

// 把"归属判定"抽成纯函数，才能对三个分支都给出可复现的证据（拿不到 PID / 不是本次进程 / 通过）。
function ownershipFailure(port, ownerPid, childPid) {
  if (ownerPid === null) return `无法确认端口 ${port} 的监听进程（netstat 未给出 PID），不能证明服务归属，拒绝继续`;
  if (ownerPid !== childPid) return `端口 ${port} 的监听进程是 ${ownerPid}，不是本次启动的 ${childPid}；拒绝借用已有服务`;
  return null;
}

// --- 本机配置：只比对应用自己的数据文件。Chromium 的 Cache/Preferences 会随运行变化，
// 算进来只会制造假失败；但也不能像之前那样"读不到就折成 null 当成没改动"。 ---
// 命名族要覆盖全部产物：profiles.json / profiles.v3.backup.json / run-history.json /
// run-history.json.corrupt-*.json / history.v1.backup.json（历史备份用的是 history 前缀）。
const CONFIG_DATA_PATTERN = /^(profiles|run-history|history)(\..*)?\.json$/i;

function configDataDir() {
  return process.env.MOUSECLIK_PROFILE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MouseClik');
}

function snapshotConfigData(dir = configDataDir()) {
  const files = {};
  const otherJson = [];
  let exists = false;
  let error = null;
  try {
    const stat = fs.statSync(dir);
    if (stat.isDirectory()) exists = true;
    else error = `${dir} 不是目录`;
  } catch (statError) {
    // 只有"确实不存在"才算不存在；权限等其它错误必须当成"无法确认"，不能折成不存在。
    if (statError.code !== 'ENOENT') error = `无法读取配置目录（${statError.code || statError.message}）`;
  }
  if (exists) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (readError) { error = `无法列出配置目录（${readError.code || readError.message}）`; }
    for (const name of names) {
      if (!/\.json$/i.test(name)) continue;
      if (!CONFIG_DATA_PATTERN.test(name)) { otherJson.push(name); continue; }
      try { files[name] = { hash: crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, name))).digest('hex'), unreadable: null }; }
      catch (readError) { files[name] = { hash: null, unreadable: readError.code || readError.message }; }
    }
  }
  return { dir, exists, error, files, otherJson };
}

function configDataDiff(before, after) {
  const changes = [];
  // 无法确认（权限、非目录、列目录失败）本身就是失败判据：不能证明没改动，就不许报绿。
  if (before.error || after.error) changes.push(`配置目录无法确认：${before.error || after.error}`);
  if (before.exists !== after.exists) changes.push(`配置目录存在性变化 ${before.exists} → ${after.exists}`);
  for (const name of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    const from = before.files[name] || null;
    const to = after.files[name] || null;
    if (from && to) {
      if (from.unreadable || to.unreadable) changes.push(`无法读取 ${name}（${from.unreadable || to.unreadable}），不能证明未改动`);
      else if (from.hash !== to.hash) changes.push(`修改 ${name}`);
      continue;
    }
    if (from) changes.push(from.unreadable ? `无法读取 ${name}（${from.unreadable}）` : `删除 ${name}`);
    else changes.push(to.unreadable ? `新增但无法读取 ${name}（${to.unreadable}）` : `新增 ${name}`);
  }
  return changes;
}

// 端口释放是有时序的：刚杀完进程的瞬间可能还连得上。守卫要的是"最终确实没人监听"，
// 所以做有界重试；真的赖着不走才算失败。
async function waitForPortReleased(port, timeoutMs = 3000, probe = portInUse) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(port))) return true;
    await sleep(100);
  }
  return !(await probe(port));
}

// 失败时把现场带出来，免得下次只看到一句"仍有进程监听"却无从下手。
function portOwnerReport(port) {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const lines = output.split(/\r?\n/).filter((line) => line.includes(`:${port} `));
    return lines.length ? lines.map((line) => line.trim().replace(/\s+/g, ' ')).join(' / ') : 'netstat 中没有该端口的记录';
  } catch (error) { return `netstat 不可用：${error.message}`; }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// 必须等到"确认消失"，不能发个信号就当清理完了。
async function waitForExit(pid, timeoutMs, alive = isPidAlive) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

async function stopChildren(children = startedChildren.splice(0), alive = isPidAlive) {
  const failures = [];
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill(); } catch { /* 已经退出 */ }
    if (await waitForExit(child.pid, 3000, alive)) continue;
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (killed.status !== 0) failures.push(`进程 ${child.pid} 的 taskkill 未成功（退出码 ${killed.status ?? 'null'}${killed.error ? `/${killed.error.message}` : ''}）`);
    if (await waitForExit(child.pid, 5000, alive)) continue;
    failures.push(`进程 ${child.pid} 未被确认终止（taskkill exit ${killed.status ?? 'null'}）`);
  }
  return failures;
}

function cleanupDirs(dirs, keep) {
  const failures = [];
  for (const dir of dirs) {
    if (keep && dir.includes('artifacts')) { log(`保留截图目录：${dir}`); continue; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { failures.push(`临时目录删除失败：${dir}（${error.message}）`); continue; }
    if (fs.existsSync(dir)) failures.push(`临时目录仍然存在：${dir}`);
  }
  return failures;
}

function startServer({ port, dataDir, token }) {
  const child = spawn(process.execPath, [path.join(root, 'src/main/server.js')], {
    cwd: root,
    env: suiteEnv({ PORT: String(port), MOUSECLIK_DATA: dataDir, MOUSECLIK_SERVER_TOKEN: token }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  startedChildren.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, readOutput: () => output, port };
}

async function waitForOwnService(server, baseUrl, token) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`服务提前退出（exit ${server.child.exitCode}）：\n${server.readOutput()}`);
    let body = null;
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { 'X-MouseClik-Token': token }, signal: AbortSignal.timeout(1000) });
      body = await response.json();
    } catch { /* 服务还没起来，继续等 */ }
    if (body) {
      // 端口上确实有服务在答，但它不是我们这次启动的实例 —— 拒绝借用。
      if (body.app !== 'mouseclik') throw new Error(`端口 ${server.port} 上运行着其它服务（app=${body.app}），拒绝借用已有服务`);
      if (body.authorized !== true) throw new Error(`端口 ${server.port} 上的 MouseClik 服务不接受本次 token（authorized=false），拒绝借用已有服务`);
      // 光看响应还不够：能接受任意 token 的既有服务会通过上面两条，所以再验一次监听进程归属。
      const failure = ownershipFailure(server.port, listeningPid(server.port), server.child.pid);
      if (failure) throw new Error(failure);
      return;
    }
    await sleep(150);
  }
  throw new Error(`等待服务健康检查超时（${baseUrl}/api/health）：\n${server.readOutput()}`);
}

// 终止套件：必须**先杀进程树**。根进程一死，taskkill /T 就再也找不到它的后代了，
// 而 e2e-http 的服务、桌面的 Electron 都只登记在套件自己那边。
// 判定必须覆盖整个进程树，而不是"根 PID 消失"：taskkill 的退出码、后代是否清干净都要进结果。
// 后代枚举支持**多个种子**：后置枚举必须从此前已知的全部家族成员出发 ——
// 中间环节一旦退出（它的父亲边就没了），只从根 PID 走会漏掉它生的后代。
function descendantPids(rootPids, timeoutMs = 20000) {
  const seeds = (Array.isArray(rootPids) ? rootPids : [rootPids]).map(Number).filter((value) => Number.isInteger(value) && value > 0);
  if (!seeds.length) return [];
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId`,
    `  $queue = New-Object System.Collections.Queue`,
    `  $found = New-Object System.Collections.ArrayList`,
    `  @(${seeds.join(',')}) | ForEach-Object { $queue.Enqueue($_) }`,
    `  while ($queue.Count -gt 0) { $cur = $queue.Dequeue(); foreach ($p in $all) { if ($p.ParentProcessId -eq $cur) { [void]$found.Add($p.ProcessId); $queue.Enqueue($p.ProcessId) } } }`,
    `  'OK:' + ($found -join ',')`,
    `} catch { 'ERR:' + $_.Exception.Message; exit 3 }`
  ].join('; ');
  try {
    const output = String(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: Math.max(1000, timeoutMs) })).trim();
    // PowerShell 的非终止错误不会让 execFileSync 失败，还可能污染输出 —— 只认带哨兵的成功结果
    const match = output.match(/^OK:(.*)$/m);
    if (!match) return null;
    const body = match[1].trim();
    return body ? body.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0) : [];
  } catch { return null; }
}

async function waitForAllGone(pids, timeoutMs, alive = isPidAlive) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    const remaining = pids.filter((pid) => alive(pid));
    if (!remaining.length) return [];
    await sleep(100);
  }
  return pids.filter((pid) => alive(pid));
}

// 判定必须覆盖整棵树，且必须能说清"是本次终止的"：
//  - 后代枚举失败（含 PowerShell 非终止错误）→ 失败，不能当成"没有后代"
//  - taskkill 未成功 → 失败，不能因为恰好查不到活进程就宣称已确认终止
//  - 杀树后再枚举一次（根即使退出，Windows 仍保留 ParentProcessId），覆盖枚举后新生的后代
async function terminateSuite(child, name, options = {}) {
  if (child.exitCode !== null && child.signalCode !== null) return null;
  // 可注入点：替身测试要能构造"中间环节已退出、只从根走找不到孙代"的拓扑
  const enumerate = options.enumerate || descendantPids;
  const alive = options.alive || isPidAlive;
  const runKill = options.runKill || ((args, extra = {}) => spawnSync('taskkill.exe', args, { windowsHide: true, encoding: 'utf8', ...extra }));
  const clock = options.now || Date.now;
  // 统一上限：前面几个同步子命令也必须在预算之内，不能各跑各的上限再相加
  const deadline = clock() + 45000;
  const left = () => Math.max(0, deadline - clock());
  const problems = [];
  // 剩余预算不足就不执行，绝不把不足 1 秒的预算放大成 1 秒
  const killWithBudget = (args) => {
    const remaining = left();
    if (remaining <= 250) { problems.push(`预算耗尽（剩余 ${remaining}ms），跳过 ${args.join(' ')}`); return null; }
    return runKill(args, { timeout: remaining });
  };

  const family = left() > 0 ? enumerate([child.pid], Math.min(20000, left())) : null;
  if (family === null) problems.push('前置后代枚举失败或超时');

  const killed = killWithBudget(['/PID', String(child.pid), '/T', '/F']);

  // 后置枚举从"已知的全部家族成员"出发：中间环节退出后，只从根走就找不到它生的后代
  const seeds = [child.pid, ...(family || [])];
  const postFamily = left() > 0 ? enumerate(seeds, Math.min(20000, left())) : null;
  if (postFamily === null) problems.push('后置后代枚举失败或超时');

  const targets = [...new Set([...seeds, ...(postFamily || [])])];
  // 补杀共享一个清理预算，而不是每个 PID 各 10 秒（10N 会无限膨胀）
  const cleanupDeadline = clock() + 15000;
  const cleanupLeft = () => Math.max(0, Math.min(left(), cleanupDeadline - clock()));
  let stragglers = await waitForAllGone(targets, Math.min(8000, cleanupLeft()), alive);
  while (stragglers.length && cleanupLeft() > 250) {
    const beforeCount = stragglers.length;
    for (const pid of stragglers) {
      const remaining = cleanupLeft();
      if (remaining <= 250) break;
      runKill(['/PID', String(pid), '/F'], { timeout: remaining });
    }
    stragglers = await waitForAllGone(stragglers, Math.min(5000, cleanupLeft()), alive);
    if (stragglers.length >= beforeCount) break; // 没有进展就不再空转
  }

  if (killed && killed.status !== 0) problems.push(`taskkill 未成功（退出码 ${killed.status ?? 'null'}${killed.error ? `/${killed.error.message}` : ''}）`);
  if (stragglers.length) problems.push(`仍有存活进程 ${stragglers.join(', ')}`);
  // 预算耗尽同样不能宣称"已确认"：没能走完验证流程，就不是确认
  if (left() <= 0) problems.push('超出 45s 预算，未能完成完整确认');
  if (!problems.length) return null;
  return `套件 ${name} 的进程树未被确认清除：root=${child.pid}${alive(child.pid) ? '(仍在)' : '(已退出)'}；${problems.join('；')}`;
}

// 套件必须有上限：一个接得住连接却不回响应的服务、或卡死的浏览器，会让整个命令永久挂住，
// 而不是有界失败。
function runSuite(suite, env, timeoutMs = Number(process.env.MOUSECLIK_TEST_SUITE_TIMEOUT_MS) || 600000) {
  return new Promise((resolve) => {
    log(`▶ ${suite.name}`);
    const child = spawn(process.execPath, [path.join(root, suite.script)], { cwd: root, env, stdio: 'inherit' });
    let settled = false;
    let terminating = false; // 进入超时处理后，close 不能抢先 settle
    const settle = (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve(code); };
    const timer = setTimeout(async () => {
      terminating = true;
      log(`✗ ${suite.name} 超过 ${Math.round(timeoutMs / 1000)}s 未结束，终止进程树`);
      const failure = await terminateSuite(child, suite.name);
      if (failure) log(`✗ ${failure}`);
      else log(`已确认 ${suite.name} 的进程树终止`);
      settle(1); // 超时一律计失败；且必须等清理真正结束才 resolve
    }, timeoutMs);
    child.once('close', (code) => { if (!terminating) settle(code ?? 1); });
  });
}

// --- 兜底检查：套件自己登记的服务与目录，编排器也要能发现漏网的 ---

// 可区分的端口探测：ok=false 表示"查不出来"，不能与"没人监听"混为一谈。
// 任何本地地址上的监听都算占用（0.0.0.0 与 IPv6 不能只看 127.0.0.1）。
function probeListening(port) {
  try {
    const output = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const entries = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (match && Number(match[2]) === Number(port)) entries.push({ address: match[1], pid: Number(match[3]) });
    }
    const preferred = entries.find((entry) => entry.address === '127.0.0.1');
    const chosen = preferred || entries[0] || null;
    return { ok: true, pid: chosen ? chosen.pid : null, address: chosen ? chosen.address : null };
  } catch (error) { return { ok: false, error: error.message }; }
}

function processParentPid(pid) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const parent = Number(String(output).trim());
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch { return null; }
}

// 带"未知"状态的归属查询：查询失败返回 { ok: false }，
// 绝不能把"查不到"折成"不属于我们"，否则候选会被静默放过。
function processParentPidSafe(pid) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const parent = Number(String(output).trim());
    return { ok: true, pid: Number.isInteger(parent) && parent > 0 ? parent : null };
  } catch { return { ok: false, pid: null }; }
}

// true = 是我们的后代；false = 确定不是；null = 查不出来（未知）
function syncAncestryState(pid, ancestorPid, maxDepth = 8) {
  let current = Number(pid);
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    if (current === Number(ancestorPid)) return true;
    const parent = processParentPidSafe(current);
    if (!parent.ok) return null;
    current = parent.pid;
  }
  return false;
}

function syncAncestryContains(pid, ancestorPid, maxDepth = 8) {
  return syncAncestryState(pid, ancestorPid, maxDepth) === true;
}

// 紧急收尾（同步）：把"由本进程派生、且命令行引用给定标记"的进程整棵收掉。
// 覆盖 launch 还没返回就先崩的 Electron：那时 app 对象还不存在，但底层进程已经起来了。
// 判定依据是"确认消失"，不是 taskkill 的退出码 —— 父子都在候选里时，先杀父会让子已经消失，
// 对子再 taskkill 必然非零，不能因此永久记失败。
function killDescendantsOf(ancestorPid, markers, options = {}) {
  const snapshot = options.snapshot || relatedProcessSnapshot;
  const relation = options.relation || syncAncestryState;
  const runKill = options.runKill || ((args, extra = {}) => spawnSync('taskkill.exe', args, { windowsHide: true, encoding: 'utf8', ...extra }));
  const alive = options.alive || isPidAlive;
  const clock = options.now || Date.now;
  const deadline = clock() + (options.budgetMs || 20000);
  const left = () => Math.max(0, deadline - clock());

  const candidates = snapshot(markers);
  if (candidates === null) return { ok: false, killed: [], candidates: 0, reason: '无法枚举进程' };
  const ours = [];
  const unknown = [];
  for (const entry of candidates) {
    if (entry.pid === Number(ancestorPid)) continue;
    const state = relation(entry.pid, ancestorPid);
    if (state === true) ours.push(entry);
    else if (state === null) unknown.push(entry); // 归属未知也按"可能是我们的"处理，不能放过
  }
  const targets = [...ours, ...unknown];
  if (!targets.length) return { ok: true, killed: [], candidates: candidates.length, unknown: [] };

  const killFailures = [];
  for (const entry of targets) {
    if (left() <= 250) { killFailures.push(`预算耗尽，未处理 ${entry.pid}`); continue; }
    const result = runKill(['/PID', String(entry.pid), '/T', '/F'], { timeout: left() });
    if (result && result.status !== 0) killFailures.push(`${entry.pid}(${entry.name}) 退出码 ${result.status}`);
  }

  let remaining = targets.filter((entry) => alive(entry.pid));
  while (remaining.length && left() > 0) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch { /* 忙等兜底 */ }
    remaining = remaining.filter((entry) => alive(entry.pid));
  }
  const unresolved = remaining.map((entry) => entry.pid);
  const unknownUnresolved = unknown.filter((entry) => unresolved.includes(entry.pid)).map((entry) => entry.pid);
  if (unresolved.length) {
    return {
      ok: false,
      killed: targets.map((entry) => entry.pid),
      candidates: candidates.length,
      unknown: unknown.map((entry) => entry.pid),
      reason: `仍未消失 ${unresolved.join(', ')}${unknownUnresolved.length ? `（其中归属未知：${unknownUnresolved.join(', ')}）` : ''}${killFailures.length ? `；${killFailures.join('；')}` : ''}`
    };
  }
  return { ok: true, killed: targets.map((entry) => entry.pid), candidates: candidates.length, unknown: unknown.map((entry) => entry.pid) };
}

// 归属证明：监听端口的进程必须是本次拉起的主进程的后代。
async function ancestryContains(pid, ancestorPid, maxDepth = 6) {
  let current = Number(pid);
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    if (current === Number(ancestorPid)) return true;
    current = processParentPid(current);
  }
  return false;
}

// 与本次运行相关的进程：命令行引用仓库路径或本次临时根 —— 覆盖 node 服务、Electron、浏览器。
// 标记必须在清理临时目录之前取好，否则数组被清空后就只剩仓库路径这一个标记了。
function relatedProcessSnapshot(markers) {
  const list = markers && markers.length ? markers : [root];
  const filter = list.map((marker) => `$_.CommandLine -like '*${String(marker).replace(/'/g, "''")}*'`).join(' -or ');
  const script = `$ErrorActionPreference='Stop'; $self = $PID; Get-CimInstance Win32_Process | Where-Object { (${filter}) -and $_.ProcessId -ne $self -and $_.ProcessId -ne ${Number(process.pid)} } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [pid, name] = line.split('|');
      return { pid: Number(pid), name: name || '?' };
    }).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  } catch { return null; }
}

function tempDirNames() {
  try { return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mouseclik-')); } catch { return null; }
}

// 两个 UI 套件都走 msedge 通道：缺了它，套件只会在自己的 launch 里报一句难懂的错。
// 这里先做一次真实探测，把前置条件说清楚。
// 预检在编排器自己的进程里调 Playwright，所以必须临时把 TEMP 也指到我们的临时根，
// 否则它建的 playwright-artifacts-* / chromiumdev_profile-* 会落在系统临时区、扫不到也清不掉。
async function preflightMsEdge(tempRoot) {
  const { chromium } = require('playwright');
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  if (tempRoot) { process.env.TEMP = tempRoot; process.env.TMP = tempRoot; process.env.TMPDIR = tempRoot; }
  let browser = null;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    throw new Error(`前提不满足：msedge 通道无法启动（UI 套件依赖它）——${String(error.message).split('\n')[0]}`);
  } finally {
    if (browser) await browser.close();
    if (saved.TEMP === undefined) delete process.env.TEMP; else process.env.TEMP = saved.TEMP;
    if (saved.TMP === undefined) delete process.env.TMP; else process.env.TMP = saved.TMP;
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR;
  }
  log('前置条件就绪：msedge 通道可用');
}

async function main() {
  const modes = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (!modes.length) throw Object.assign(new Error('用法：node tests/run-suites.cjs <ui|e2e|desktop> [...]'), { exitCode: 2 });
  const unknown = modes.filter((mode) => !SUITES[mode]);
  if (unknown.length) throw Object.assign(new Error(`未知套件组：${unknown.join(', ')}（可用：${Object.keys(SUITES).join(' / ')}）`), { exitCode: 2 });
  const selected = modes.flatMap((mode) => SUITES[mode].map((suite) => ({ ...suite, mode })));
  if (!selected.length) throw Object.assign(new Error(`${modes.join('/')} 还没注册任何套件，本次没有跑任何东西`), { exitCode: 2 });

  if (selected.some((suite) => suite.mode === 'desktop') && await portInUse(APP_SERVER_PORT)) {
    throw new Error(`端口 ${APP_SERVER_PORT} 已被占用：桌面套件要拉起真实 Electron，请先退出正在运行的 MouseClik 实例`);
  }

  const token = crypto.randomBytes(24).toString('hex');
  const dataDir = tempDir('mouseclik-suites-data-');
  const artifacts = tempDir('mouseclik-suites-artifacts-');
  // 套件自己的临时目录一律建在这里面：超时 /F 杀树时套件的 finally 不会执行，
  // 只有把根交给编排器，才谈得上"失败也无残留"。
  const suiteTempRoot = tempDir('mouseclik-suites-tmp-');
  // 进程扫描的标记必须在清理临时目录之前取好：cleanupDirs 会把数组清空，
  // 之后再取就只剩仓库路径这一个标记，引用了本次临时根的残留进程会被漏检。
  const processMarkers = [root, ...tempDirs];
  const beforeConfig = snapshotConfigData();
  const beforeRelated = relatedProcessSnapshot(processMarkers);
  const beforeTemp = tempDirNames();
  const failures = [];
  let baseUrl = null;
  let comparedFiles = null;

  try {
    try {
      if (selected.some((suite) => suite.browser)) await preflightMsEdge(suiteTempRoot);
      if (selected.some((suite) => suite.server)) {
        const port = Number(process.env.MOUSECLIK_TEST_PORT) || await freePort();
        if (await portInUse(port)) throw new Error(`端口 ${port} 已被占用，拒绝借用已有服务（可用 MOUSECLIK_TEST_PORT 指定其它端口）`);
        const server = startServer({ port, dataDir, token });
        baseUrl = `http://127.0.0.1:${port}`;
        await waitForOwnService(server, baseUrl, token);
        log(`服务已就绪：${baseUrl}（本次进程 ${server.child.pid}，数据目录 ${dataDir}）`);
      }

      for (const suite of selected) {
        const env = suiteEnv({
          MOUSECLIK_TEST_TOKEN: token,
          MOUSECLIK_TEST_ARTIFACTS: artifacts,
          MOUSECLIK_TEST_DATA: dataDir,
          MOUSECLIK_TEST_TEMP_ROOT: suiteTempRoot,
          // 把子进程的 TEMP 也指到我们的临时根：Playwright 会在 os.tmpdir() 下建
          // playwright-artifacts-* / playwright_chromiumdev_profile-*，不重定向就落在系统临时区，
          // 既不在清理范围、也扫不到（扫描只看 mouseclik-*）。
          TEMP: suiteTempRoot,
          TMP: suiteTempRoot,
          TMPDIR: suiteTempRoot,
          ...(baseUrl ? { MOUSECLIK_TEST_URL: baseUrl } : {})
        });
        const code = await runSuite(suite, env);
        if (code !== 0) { failures.push(`${suite.name} 退出码 ${code}`); break; }
      }
    } catch (error) {
      failures.push(error.message);
    }
  } finally {
    failures.push(...await stopChildren());
    failures.push(...cleanupDirs(tempDirs.splice(0), failures.length > 0));
    if (baseUrl) {
      const port = Number(new URL(baseUrl).port);
      if (!(await waitForPortReleased(port))) failures.push(`自建服务端口 ${port} 在清理后仍有进程监听（${portOwnerReport(port)}）`);
    }
    // 桌面组：套件自己负责关 Electron，这里再独立确认一次 28232 真的释放了
    if (selected.some((suite) => suite.mode === 'desktop') && !(await waitForPortReleased(APP_SERVER_PORT, 3000))) {
      failures.push(`桌面套件结束后端口 ${APP_SERVER_PORT} 仍被监听（${portOwnerReport(APP_SERVER_PORT)}）`);
    }
    // 自管服务的套件（e2e-http）与桌面套件即使退出码为 0，也不能留下进程
    const afterRelated = relatedProcessSnapshot(processMarkers);
    if (beforeRelated === null || afterRelated === null) {
      failures.push('无法枚举进程，给不出"已确认无残留"的结论');
    } else {
      const before = new Set(beforeRelated.map((entry) => entry.pid));
      const leaked = afterRelated.filter((entry) => !before.has(entry.pid));
      if (leaked.length) {
        const label = leaked.map((entry) => `${entry.pid}(${entry.name})`).join(', ');
        for (const entry of leaked) spawnSync('taskkill.exe', ['/PID', String(entry.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        const remaining = await waitForAllGone(leaked.map((entry) => entry.pid), 5000);
        failures.push(remaining.length
          ? `残留进程未能清除：${label}`
          : `检测到残留进程 ${label}（已强制清除，但本次运行不干净）`);
      }
    }
    // 套件自己的临时目录：跑前跑后对比。只有**实际登记过**的名字才算我们的，
    // 同名前缀但没登记（例如 mouseclik-suites-unregistered-*）一律算残留。
    const afterTemp = tempDirNames();
    if (beforeTemp === null || afterTemp === null) failures.push('无法枚举临时目录，给不出"已确认无残留"的结论');
    else {
      const appeared = afterTemp.filter((name) => !beforeTemp.includes(name));
      const ours = appeared.filter((name) => registeredTempNames.has(name));
      const stray = appeared.filter((name) => !registeredTempNames.has(name));
      if (ours.length) log(`注意：保留了编排器临时目录（失败时按设计保留）：${ours.join(', ')}`);
      if (stray.length) failures.push(`出现未登记的临时目录残留：${stray.join(', ')}`);
    }
    const afterConfig = snapshotConfigData(beforeConfig.dir);
    const changes = configDataDiff(beforeConfig, afterConfig);
    if (changes.length) failures.push(`本机配置数据被改动：${changes.join('、')}（${beforeConfig.dir}）`);
    comparedFiles = { exists: afterConfig.exists, names: Object.keys(afterConfig.files), otherJson: afterConfig.otherJson };
  }

  if (failures.length) {
    for (const failure of failures) log(`✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (!comparedFiles.exists) log('本机没有配置目录，未被创建');
  else log(`本机配置数据未被改动（逐字节比对 ${comparedFiles.names.length} 个文件：${comparedFiles.names.join(', ') || '目录下没有应用数据文件'}）`);
  // 命名族之外的 json 不进比对，但要让它们可见，免得将来新增一类数据文件后悄悄落在盲区。
  if (comparedFiles.otherJson.length) log(`注意：配置目录下未纳入比对的 json：${comparedFiles.otherJson.join(', ')}`);
  log(`✓ ${selected.length} 个套件全部通过`);
}

module.exports = { configDataDiff, snapshotConfigData, cleanupDirs, waitForExit, stopChildren, runSuite, terminateSuite, descendantPids, ancestryContains, syncAncestryState, killDescendantsOf, relatedProcessSnapshot, tempDirNames, probeListening, isPidAlive, portInUse, waitForPortReleased, portOwnerReport, listeningPid, ownershipFailure, CONFIG_DATA_PATTERN };

if (require.main === module) {
  process.once('SIGINT', () => { for (const child of startedChildren) { try { child.kill(); } catch { /* 已退出 */ } } process.exit(130); });
  main().catch((error) => {
    console.error(`[suites] ${error.message}`);
    process.exitCode = error.exitCode || 1;
  });
}
