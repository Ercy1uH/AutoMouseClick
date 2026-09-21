/*
 * e2e 第一层：真实 HTTP（自带服务生命周期）
 *
 * 覆盖：鉴权、Host 校验、静态白名单、超大请求后服务仍存活、配置写入与重启恢复，
 * 以及两条来自审查的边界：延迟上限必须来自共享常量（RV-25）、
 * 小数循环次数的服务端取整（RV-28 的服务端一半）。
 *
 * 本套件自己起服务、自己重启、自己清理，因此编排器里注册为 server: false。
 */
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { MAX_DELAY_MS, MAX_LOOPS } = require('../../src/renderer/point-settings');
// 复用编排器里已经验过的守卫：归属比对与"确认终止"不能只在编排器自建服务上生效，
// 本套件自己起的服务同样要按同一判据把关。
const { listeningPid, ownershipFailure, waitForExit, waitForPortReleased } = require('../run-suites.cjs');
const { request } = require('../http-request.cjs');

const root = path.resolve(__dirname, '../..');
const TOKEN = crypto.randomBytes(16).toString('hex');
// 临时目录建在编排器给的根里：超时被 /F 杀树时本套件的 finally 不会执行，
// 只有把根交给编排器才谈得上"失败也无残留"。
const TEMP_ROOT = process.env.MOUSECLIK_TEST_TEMP_ROOT || os.tmpdir();
const dataDir = fs.mkdtempSync(path.join(TEMP_ROOT, 'mouseclik-e2e-http-'));
const servers = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'src/main/server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), MOUSECLIK_DATA: dataDir, MOUSECLIK_SERVER_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const server = { child, port, baseUrl: `http://127.0.0.1:${port}`, output: () => output };
  servers.push(server);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出（exit ${child.exitCode}）：\n${output}`);
    let body = null;
    try { body = (await request(server.baseUrl, 'GET', '/api/health', { token: TOKEN })).json(); } catch { /* 还在启动 */ }
    if (body) {
      // 只看 authorized 不够：一个接受任意 token 的旧实例会被放行，而本套件第一条请求正是
      // 无 token 的 PUT —— 那会先把别人的数据改掉。所以归属必须落到本次子进程。
      const failure = ownershipFailure(port, listeningPid(port), child.pid);
      if (failure) { try { child.kill(); } catch { /* 可能已退出 */ } throw new Error(failure); }
      if (body.authorized !== true) throw new Error(`本次服务未接受测试 token（authorized=false）`);
      return server;
    }
    await sleep(120);
  }
  throw new Error(`等待服务启动超时：\n${output}`);
}

// 停止必须"确认终止"：等五秒就无条件返回，等于把清理失败伪装成成功。
async function stopServer(server) {
  const { child, port } = server;
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill(); } catch { /* 已经退出 */ }
    if (!(await waitForExit(child.pid, 3000))) {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (!(await waitForExit(child.pid, 5000))) return `进程 ${child.pid} 未被确认终止`;
    }
  }
  if (!(await waitForPortReleased(port, 3000))) return `端口 ${port} 在停止后仍被监听`;
  return null;
}

// 请求助手见 tests/http-request.cjs：请求与响应两侧都有界（含响应半途断开）。


const PROFILE = {
  name: 'e2e-http', note: '', defaultClickType: '双击', loops: 3, loopInterval: 700,
  steps: [
    { type: 'click', x: 11, y: 22, label: 'e2e-click', clickCount: 2, clickType: '双击' },
    { type: 'delay', ms: 150 }
  ]
};

(async () => {
  try {
    const first = await startServer();
    const base = first.baseUrl;

    // --- 鉴权 ---
    assert.equal((await request(base, 'PUT', '/api/profiles', { body: { profiles: [PROFILE], active: 0 } })).status, 403, '无 token 的写操作必须被拒绝');
    assert.equal((await request(base, 'PUT', '/api/profiles', { token: `${TOKEN}-wrong`, body: { profiles: [PROFILE], active: 0 } })).status, 403, '错误 token 必须被拒绝');
    assert.equal((await request(base, 'GET', '/api/health')).json().authorized, false, 'health 无 token 时 authorized 应为 false');
    assert.equal((await request(base, 'GET', '/api/health', { token: TOKEN })).json().authorized, true, 'health 带 token 时 authorized 应为 true');
    assert.equal((await request(base, 'GET', '/api/profiles')).status, 200, '读操作不需要 token（当前契约）');

    // --- Host 校验（DNS rebinding）---
    assert.equal((await request(base, 'GET', '/api/health', { host: `evil.example.com:${new URL(base).port}` })).status, 403, '陌生 Host 必须 403');
    assert.equal((await request(base, 'GET', '/api/health', { host: `localhost:${new URL(base).port}` })).status, 200, 'localhost Host 必须放行');

    // --- 静态白名单 ---
    assert.equal((await request(base, 'GET', '/index.html')).status, 200, 'index.html 必须可访问');
    for (const blocked of ['/src/main/server.js', '/package.json', '/src/worker/native-click-worker.ps1']) {
      assert.equal((await request(base, 'GET', blocked)).status, 404, `${blocked} 不在白名单内，必须 404`);
    }

    // --- 超大请求后服务仍存活 ---
    const huge = await request(base, 'PUT', '/api/profiles', { token: TOKEN, rawBody: JSON.stringify({ profiles: [], active: 0, pad: 'x'.repeat(1_100_000) }) });
    assert.equal(huge.status, 400, '超过 1 MB 的请求体必须被拒绝而不是把服务打挂');
    assert.match(huge.json().error, /过大/);
    assert.equal((await request(base, 'GET', '/api/health', { token: TOKEN })).status, 200, '超大请求之后服务必须仍然存活');
    assert.equal((await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [PROFILE], active: 0 } })).status, 200, '超大请求之后普通写入必须仍然可用');

    // --- 共享常量边界（RV-25：上限来自 point-settings，而不是各处硬编码）---
    const exact = await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [{ ...PROFILE, steps: [{ type: 'delay', ms: MAX_DELAY_MS }] }], active: 0 } });
    assert.equal(exact.json().profiles[0].steps.length, 1, `ms=${MAX_DELAY_MS} 必须被接受`);
    const over = await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [{ ...PROFILE, steps: [{ type: 'delay', ms: MAX_DELAY_MS + 1 }] }], active: 0 } });
    assert.equal(over.status, 400, `ms=${MAX_DELAY_MS + 1} 必须被拒绝`);
    assert.match(over.json().error, /ms 必须是/, '拒绝原因应指出越界的是 ms，而不是笼统的"配置无效"');
    assert.equal((await request(base, 'GET', '/api/profiles')).json().profiles[0].steps.length, 1, '被拒绝的写入不得改动已保存的配置');

    // --- 小数循环次数：服务端取整口径（RV-28 的服务端一半）---
    const rounded = await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [{ ...PROFILE, loops: 2.5 }], active: 0 } });
    assert.equal(rounded.json().profiles[0].loops, 3, '2.5 必须按 Math.round 存成 3');
    const capped = await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [{ ...PROFILE, loops: MAX_LOOPS + 500 }], active: 0 } });
    assert.equal(capped.json().profiles[0].loops, MAX_LOOPS, `loops 上限必须等于共享常量 ${MAX_LOOPS}`);

    // --- 写盘 + 重启恢复 ---
    const saved = await request(base, 'PUT', '/api/profiles', { token: TOKEN, body: { profiles: [PROFILE], active: 0 } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().profiles[0].steps.length, 2);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8'));
    assert.equal(onDisk.schemaVersion, 5, '磁盘上的配置 schema 必须是 5');
    assert.equal(onDisk.profiles[0].steps[0].clickCount, 2);
    await stopServer(first);

    const second = await startServer();
    const restored = (await request(second.baseUrl, 'GET', '/api/profiles')).json();
    assert.equal(restored.profiles.length, 1, '重启后配置必须恢复');
    assert.equal(restored.profiles[0].name, 'e2e-http');
    assert.equal(restored.profiles[0].loops, 3);
    assert.deepEqual(restored.profiles[0].steps.map((step) => step.type), ['click', 'delay']);
    const stopFailure = await stopServer(second);
    assert.equal(stopFailure, null, `第二次服务必须确认停止：${stopFailure}`);

    console.log(`E2E HTTP passed: auth(403/200), host rebinding(403), static allowlist(404), body limit + survival, shared-constant bounds(${MAX_DELAY_MS}/${MAX_LOOPS}), restart recovery; 两次服务均确认停止且端口已释放`);
  } finally {
    const cleanup = [];
    for (const server of servers) { const failure = await stopServer(server); if (failure) cleanup.push(failure); }
    for (const failure of cleanup) console.error(`清理失败：${failure}`);
    if (cleanup.length) process.exitCode = 1;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
