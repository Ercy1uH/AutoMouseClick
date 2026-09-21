/*
 * 编排器自身的防回归测试。
 *
 * 起因：清理失败、目录删不掉、端口还占着，编排器原先只打警告就报"全部通过"。
 * 这些用例把三条判据钉死：它们必须能真的产出失败，而不是吞掉。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { configDataDiff, snapshotConfigData, cleanupDirs, waitForExit, stopChildren, runSuite, terminateSuite, descendantPids, killDescendantsOf, isPidAlive, portInUse, waitForPortReleased, probeListening, listeningPid, ownershipFailure } = require('./run-suites.cjs');

function tempFixture(t, prefix = 'mouseclik-suites-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 系统临时区快照：用来证明"套件与浏览器的临时目录没有落在体系之外"
function systemTempSnapshot() {
  const names = fs.readdirSync(os.tmpdir());
  return {
    playwright: names.filter((name) => name.startsWith('playwright')),
    desktop: names.filter((name) => name.startsWith('mouseclik-desktop-'))
  };
}

test('config diff detects modifications, additions and deletions of app data files', (t) => {
  const dir = tempFixture(t);
  fs.mkdirSync(path.join(dir, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Cache', 'noise.bin'), 'chromium cache');
  fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{"schemaVersion":4}');
  fs.writeFileSync(path.join(dir, 'run-history.json'), '{"schemaVersion":2}');

  const baseline = snapshotConfigData(dir);
  assert.deepEqual(Object.keys(baseline.files).sort(), ['profiles.json', 'run-history.json'], '只比对应用数据文件，Chromium 的缓存与偏好不算');
  assert.deepEqual(configDataDiff(baseline, snapshotConfigData(dir)), []);

  fs.writeFileSync(path.join(dir, 'profiles.json'), '{"schemaVersion":4,"active":1}');
  assert.deepEqual(configDataDiff(baseline, snapshotConfigData(dir)).sort(), ['修改 profiles.json'].sort());

  fs.writeFileSync(path.join(dir, 'profiles.v4.backup.json'), '{"schemaVersion":3}');
  assert.deepEqual(configDataDiff(baseline, snapshotConfigData(dir)).sort(), ['修改 profiles.json', '新增 profiles.v4.backup.json'].sort());

  fs.rmSync(path.join(dir, 'run-history.json'));
  assert.deepEqual(configDataDiff(baseline, snapshotConfigData(dir)).sort(), ['修改 profiles.json', '新增 profiles.v4.backup.json', '删除 run-history.json'].sort());
});

test('config diff does not claim "unchanged" when the directory never existed', (t) => {
  const missing = path.join(tempFixture(t), 'does-not-exist');
  const baseline = snapshotConfigData(missing);
  assert.equal(baseline.exists, false);
  assert.deepEqual(configDataDiff(baseline, snapshotConfigData(missing)), []);
  // 目录被创建出来必须算改动，而不是"前后都读不到 → 没变"
  fs.mkdirSync(missing, { recursive: true });
  fs.writeFileSync(path.join(missing, 'profiles.json'), '{"schemaVersion":4}');
  assert.notDeepEqual(configDataDiff(baseline, snapshotConfigData(missing)), []);
});

test('cleanup reports a directory it could not delete', (t) => {
  const dir = tempFixture(t);
  const removed = cleanupDirs([dir], false);
  assert.deepEqual(removed, [], '正常删除不应报失败');
  assert.equal(fs.existsSync(dir), false);

  const stubborn = tempFixture(t);
  // 必须在用例结束前恢复：t.after 的清理跑在 mock 恢复之前，否则夹具目录会一起删不掉。
  const rm = t.mock.method(fs, 'rmSync', () => { /* 模拟删不掉 */ });
  const failures = cleanupDirs([stubborn], false);
  rm.mock.restore();
  assert.equal(failures.length, 1, '删不掉必须产出一条失败');
  assert.match(failures[0], /仍然存在/);
  fs.rmSync(stubborn, { recursive: true, force: true });
});

test('cleanup keeps the artifacts directory only when asked to', (t) => {
  const artifacts = tempFixture(t, 'mouseclik-suites-artifacts-');
  assert.deepEqual(cleanupDirs([artifacts], true), []);
  assert.equal(fs.existsSync(artifacts), true, '失败时应保留截图目录');
  assert.deepEqual(cleanupDirs([artifacts], false), []);
  assert.equal(fs.existsSync(artifacts), false, '成功时应删掉截图目录');
});

test('waitForExit only reports success once the process is really gone', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });

  assert.equal(await waitForExit(child.pid, 300), false, '进程还活着时不得返回成功');
  assert.equal(await waitForExit(child.pid, 500, () => true), false, '存活判定为真时必须超时失败');
  child.kill();
  await once(child, 'exit');
  assert.equal(await waitForExit(child.pid, 2000), true, '进程真的退出后才算清理完成');
});

test('stopChildren reports failure when termination cannot be confirmed', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });

  const failures = await stopChildren([{ pid: child.pid, exitCode: null, signalCode: null, kill() { /* 模拟 kill 无效 */ } }], () => true);
  assert.equal(failures.length, 1, '无法确认终止必须产出失败，而不是静默通过');
  assert.match(failures[0], /未被确认终止/);

  const clean = await stopChildren([{ pid: child.pid, exitCode: 0, signalCode: null, kill() {} }], () => true);
  assert.deepEqual(clean, [], '已经退出的子进程不应报失败');
});

test('portInUse and listeningPid agree on who owns a port', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(() => server.close());
  assert.equal(await portInUse(port), true);
  assert.equal(listeningPid(port), process.pid, '监听归属必须能落到真实 PID 上');
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse(port), false);
  assert.equal(listeningPid(port), null, '端口没人监听时不得返回某个 PID');
});

// 一个能接受任意 token 的既有服务会通过 app/authorized 两道检查，只有归属比对能识破它。
test('ownership check rejects a service that is not this run child', () => {
  assert.equal(ownershipFailure(28332, 111, 111), null, '监听进程就是本次子进程时应通过');
  assert.match(ownershipFailure(28332, 999, 111), /监听进程是 999.*不是本次启动的 111/);
  assert.match(ownershipFailure(28332, null, 111), /无法确认端口 28332 的监听进程/);
});

// 端口刚释放的瞬时时序不能算成"仍有进程监听"，但真的赖着不走必须失败。
test('port release guard tolerates a transient blip but fails a stuck listener', async () => {
  let calls = 0;
  const blip = async () => { calls += 1; return calls <= 2; };
  assert.equal(await waitForPortReleased(28332, 2000, blip), true, '短暂还连得上、随后释放，应判定为已释放');

  assert.equal(await waitForPortReleased(28332, 300, async () => true), false, '一直有人监听必须判定为未释放');
  assert.equal(await waitForPortReleased(28332, 300, async () => false), true, '立刻释放应立即通过');
});

// 用户注入过的三条假绿：读不到当成没改动、权限错误当成目录不存在、历史备份不在比对范围。
test('an unreadable data file is reported as unproven rather than unchanged', (t) => {
  const dir = tempFixture(t);
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{"schemaVersion":4}');
  const original = fs.readFileSync;
  const read = t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).endsWith('profiles.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(file, ...rest);
  });
  const unreadable = snapshotConfigData(dir);
  read.mock.restore();

  assert.equal(unreadable.files['profiles.json'].unreadable, 'EACCES');
  assert.match(configDataDiff(unreadable, unreadable).join('|'), /无法读取 profiles\.json/, '前后都读不到也不能报"没改动"');
  assert.match(configDataDiff(unreadable, snapshotConfigData(dir)).join('|'), /无法读取 profiles\.json/);
});

test('a config directory that cannot be stat-ed is not treated as missing', (t) => {
  const dir = path.join(tempFixture(t), 'nope');
  const original = fs.statSync;
  const stat = t.mock.method(fs, 'statSync', (target, ...rest) => {
    if (String(target) === dir) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(target, ...rest);
  });
  const denied = snapshotConfigData(dir);
  stat.mock.restore();

  assert.equal(denied.exists, false);
  assert.match(denied.error, /无法读取配置目录（EACCES）/);
  const trulyMissing = snapshotConfigData(dir);
  assert.equal(trulyMissing.error, null, '只有 ENOENT 才算真的不存在');
  assert.match(configDataDiff(denied, trulyMissing).join('|'), /配置目录无法确认/);
});

test('history migration backups are inside the snapshot scope', (t) => {
  const dir = tempFixture(t);
  const names = ['profiles.json', 'profiles.v3.backup.json', 'run-history.json', 'run-history.json.corrupt-1.json', 'history.v1.backup.json', 'history.v1.1.backup.json'];
  for (const name of names) fs.writeFileSync(path.join(dir, name), `{"name":"${name}"}`);
  const snapshot = snapshotConfigData(dir);
  assert.deepEqual(Object.keys(snapshot.files).sort(), [...names].sort(), '历史迁移备份必须在比对范围内');
  assert.deepEqual(snapshot.otherJson, []);

  fs.writeFileSync(path.join(dir, 'history.v1.1.backup.json'), '{"changed":true}');
  assert.deepEqual(configDataDiff(snapshot, snapshotConfigData(dir)).sort(), ['修改 history.v1.1.backup.json'].sort());
  fs.rmSync(path.join(dir, 'history.v1.backup.json'));
  assert.deepEqual(configDataDiff(snapshot, snapshotConfigData(dir)).sort(), ['修改 history.v1.1.backup.json', '删除 history.v1.backup.json'].sort());
});

test('json files outside the app data family are surfaced instead of silently ignored', (t) => {
  const dir = tempFixture(t);
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{}');
  fs.writeFileSync(path.join(dir, 'some-other.json'), '{}');
  const snapshot = snapshotConfigData(dir);
  assert.deepEqual(Object.keys(snapshot.files), ['profiles.json']);
  assert.deepEqual(snapshot.otherJson, ['some-other.json'], '族外的 json 要能被看见，避免将来悄悄落在盲区');
});

// 卡死的套件必须有界失败，而不是把整条命令挂住。
test('a hanging suite is killed and reported as a failure', async (t) => {
  const fixture = path.resolve(__dirname, 'zz-hang-fixture.cjs');
  fs.writeFileSync(fixture, 'setInterval(() => {}, 1000);\n');
  t.after(() => fs.rmSync(fixture, { force: true }));
  const started = Date.now();
  const code = await runSuite({ name: 'hang-fixture', script: 'tests/zz-hang-fixture.cjs' }, process.env, 800);
  assert.notEqual(code, 0, '超时终止必须报成失败');
  assert.ok(Date.now() - started < 15000, '必须在有界时间内返回');
});

// 光有 setInterval 证明不了进程树清理：夹具必须带后代进程与监听端口，
// 而 taskkill /T 只有在根进程还活着时才找得到后代 —— 所以顺序不能反。
test('a timed-out suite has its whole process tree terminated', async (t) => {
  const fixture = path.resolve(__dirname, 'zz-tree-fixture.cjs');
  const evidence = path.join(tempFixture(t), 'evidence.json');
  fs.writeFileSync(fixture, [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const { spawn } = require('node:child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "const server = net.createServer();",
    "server.listen(0, '127.0.0.1', () => {",
    "  fs.writeFileSync(process.env.MOUSECLIK_TEST_FIXTURE_EVIDENCE, JSON.stringify({ descendantPid: descendant.pid, port: server.address().port, selfPid: process.pid }));",
    "});",
    "setInterval(() => {}, 1000);"
  ].join('\n'));
  t.after(() => fs.rmSync(fixture, { force: true }));

  const code = await runSuite(
    { name: 'tree-fixture', script: 'tests/zz-tree-fixture.cjs' },
    { ...process.env, MOUSECLIK_TEST_FIXTURE_EVIDENCE: evidence },
    2500
  );
  assert.notEqual(code, 0, '超时终止必须报成失败');

  const proof = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  const deadline = Date.now() + 5000;
  let descendantGone = !isPidAlive(proof.descendantPid);
  let portFree = !(await portInUse(proof.port));
  while ((!descendantGone || !portFree) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    descendantGone = !isPidAlive(proof.descendantPid);
    portFree = !(await portInUse(proof.port));
  }
  assert.equal(descendantGone, true, `后代进程 ${proof.descendantPid} 必须被一起终止`);
  assert.equal(portFree, true, `夹具监听的端口 ${proof.port} 必须已释放`);
});

// launch 失败时既不能跳过端口检查，也不能打印"清理成功"。
test('a failed Electron launch does not skip the port check or claim success', (t) => {
  const missing = path.join(tempFixture(t), 'no-such-electron.exe');
  const result = spawnSync(process.execPath, ['tests/desktop/desktop-interactions.cjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOUSECLIK_TEST_ELECTRON_EXECUTABLE: missing }
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, '启动失败必须非零退出');
  assert.doesNotMatch(output, /Desktop cleanup confirmed/, '启动失败时不得打印清理成功日志');
  assert.match(output, /启动失败：未拉起 Electron/, '必须显式说明启动失败，且仍完成了端口与目录检查');
});

// 用"存在但不是 Electron"的可执行文件，走 Playwright 直接打崩进程的那条路径：
// 必须收掉已拉起的 Electron、删掉临时 profile，并如实报告（不能声称启动失败就完事）。
test('an Electron crash takes the launched app down and leaves no temp profile', (t) => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mouseclik-desktop-')));
  const result = spawnSync(process.execPath, ['tests/desktop/desktop-interactions.cjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOUSECLIK_TEST_ELECTRON_EXECUTABLE: process.execPath }
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, '崩溃必须非零退出');
  assert.doesNotMatch(output, /Desktop cleanup confirmed/, '崩溃时不得打印清理成功日志');
  assert.match(output, /未捕获异常|未处理的 Promise 拒绝/, '必须如实报告未捕获异常');
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mouseclik-desktop-') && !before.has(name));
  assert.deepEqual(after, [], '崩溃路径也必须清掉临时 profile');
});

// 用注入的"启动之后崩溃"覆盖 emergency 的另一半：Electron 已拉起时必须被收掉、端口释放。
test('a crash after launch takes the app down and releases the port', (t) => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mouseclik-desktop-')));
  const result = spawnSync(process.execPath, ['tests/desktop/desktop-interactions.cjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 240000,
    env: { ...process.env, MOUSECLIK_TEST_DESKTOP_CRASH: 'after-launch' }
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, '崩溃必须非零退出');
  assert.doesNotMatch(output, /Desktop cleanup confirmed/, '崩溃时不得打印清理成功日志');
  assert.match(output, /运行期间发生未捕获异常（Electron 已拉起）/, '必须按"已拉起"这一支如实报告');
  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mouseclik-desktop-') && !before.has(name));
  assert.deepEqual(after, [], '崩溃后不得留下临时 profile');
  const probe = probeListening(28232);
  assert.equal(probe.ok, true, `端口探测必须可用：${probe.error}`);
  assert.equal(probe.pid, null, '崩溃后 28232 必须已释放');
});

// 预算：不足 1 秒的剩余预算绝不能被放大成 1 秒，耗尽时必须报失败。
test('a spent budget is never inflated and remaining steps are reported', async () => {
  let now = 0;
  const timeouts = [];
  const enumerate = () => { now += 20000; return []; };
  const runKill = (args, extra) => { timeouts.push(extra.timeout); now += 24900; return { status: 0 }; };
  const failure = await terminateSuite(
    { pid: 100, exitCode: null, signalCode: null },
    'budget-stub',
    { enumerate, runKill, alive: () => false, now: () => now }
  );
  assert.deepEqual(timeouts, [25000], 'taskkill 必须用真实剩余预算，而不是 max(1000, 剩余)');
  assert.match(failure || '', /预算耗尽|后置后代枚举失败或超时|超出 45s 预算/, '预算耗尽必须报失败，不能因为恰好没查到活进程就宣称已确认');
});

test('a sub-second remaining budget skips the step instead of inflating it', async () => {
  let now = 0;
  const timeouts = [];
  const enumerate = () => { now += 20000; return []; };
  const runKill = (args, extra) => { timeouts.push(extra.timeout); return { status: 0 }; };
  const failure = await terminateSuite(
    { pid: 100, exitCode: null, signalCode: null },
    'budget-stub-2',
    { enumerate, runKill, alive: () => false, now: () => (now += 24850) }
  );
  assert.deepEqual(timeouts, [], '剩余不足 250ms 时不得再执行终止命令');
  assert.match(failure || '', /预算耗尽/, '必须把"没执行"记成失败');
});

// 归属查询失败（未知）不能被当成"不属于我们"：候选仍要尝试收掉，收不掉必须报失败。
test('an unknown-ownership candidate is treated as ours', () => {
  const result = killDescendantsOf(9, ['marker'], {
    snapshot: () => [{ pid: 200, name: 'electron.exe' }],
    relation: () => null,
    runKill: () => ({ status: 0 }),
    alive: (pid) => pid === 200,
    budgetMs: 400
  });
  assert.equal(result.ok, false, '归属未知且未确认消失时必须失败');
  assert.ok(result.killed.includes(200), '未知归属的候选也要尝试终止');
  assert.match(result.reason, /归属未知/);
});

// 父子都在候选里：先杀父会让子已消失，对子再 taskkill 必然非零 —— 不能因此永久记失败。
test('a non-zero kill for an already-dead child is not a permanent failure', () => {
  const result = killDescendantsOf(9, ['marker'], {
    snapshot: () => [{ pid: 200, name: 'parent' }, { pid: 300, name: 'child' }],
    relation: () => true,
    runKill: (args) => (String(args[1]) === '300' ? { status: 1 } : { status: 0 }),
    alive: () => false
  });
  assert.equal(result.ok, true, `两者都确认消失时应成功：${result.reason}`);
  assert.deepEqual([...result.killed].sort((left, right) => left - right), [200, 300]);
});

// 单测路径也要覆盖 TEMP：直接把套件跑起来时，Playwright 的临时目录不得落在系统临时区。
test('a redirected TEMP keeps Playwright artifacts out of the system temp', (t) => {
  const redirect = tempFixture(t);
  const before = systemTempSnapshot();
  const result = spawnSync(process.execPath, ['tests/desktop/desktop-interactions.cjs'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, MOUSECLIK_TEST_ELECTRON_EXECUTABLE: path.join(redirect, 'missing.exe'), TEMP: redirect, TMP: redirect, TMPDIR: redirect, MOUSECLIK_TEST_TEMP_ROOT: redirect }
  });
  assert.notEqual(result.status, 0, '这条用例只关心临时目录落点');
  const after = systemTempSnapshot();
  assert.deepEqual(after.playwright.filter((name) => !before.playwright.includes(name)), [], 'playwright-* 不得落在系统临时区');
  assert.deepEqual(after.desktop.filter((name) => !before.desktop.includes(name)), [], 'mouseclik-desktop-* 不得落在系统临时区');
});

// 中间环节退出后，只从根 PID 走就找不到它生的后代 —— 后置枚举必须从"已知的全部家族成员"出发。
// 注：本机 taskkill /F 杀父进程会连带杀掉孙代（job object 行为），构造不出"孤儿孙代存活"的真实拓扑，
// 因此这里用注入替身复现该场景（与审查方的复现方式一致）。
test('descendant enumeration must start from every known family member', async (t) => {
  const enumerationCalls = [];
  const enumerate = (seeds) => {
    enumerationCalls.push([...seeds]);
    // 第一次从根看到中间环节 200；后置枚举只有在种子里带上 200 时才看得到孙代 300
    if (enumerationCalls.length === 1) return [200];
    return seeds.includes(200) ? [300] : [];
  };
  const alive = (pid) => pid === 300; // 300 一直活着，其余视为已退出
  const runKill = () => ({ status: 0 });

  const failure = await terminateSuite(
    { pid: 100, exitCode: null, signalCode: null },
    'stub-suite',
    { enumerate, alive, runKill }
  );

  assert.deepEqual(enumerationCalls[0], [100], '前置枚举从根出发');
  assert.ok(enumerationCalls[1].includes(200), `后置枚举必须带上已知的中间环节，实际 ${enumerationCalls[1].join(', ')}`);
  assert.match(failure || '', /仍有存活进程 300/, '孙代 300 必须被发现并报成失败（原缺陷会返回 null 并宣称已确认终止）');
});

// 真实的链完整场景仍然要能枚举到两代。
test('descendant enumeration finds a grandchild while the chain is intact', async (t) => {
  const script = "const { spawn } = require('node:child_process'); const a = spawn(process.execPath, ['-e', \"const {spawn}=require('node:child_process');const b=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.env.EVIDENCE, String(b.pid));setInterval(()=>{},1000)\"], { stdio: 'ignore' }); require('fs').writeFileSync(process.env.EVIDENCE_A, String(a.pid)); setInterval(() => {}, 1000);";
  const evidenceA = path.join(tempFixture(t), 'a.pid');
  const evidenceB = path.join(tempFixture(t), 'b.pid');
  const root = spawn(process.execPath, ['-e', script], { stdio: 'ignore', env: { ...process.env, EVIDENCE: evidenceB, EVIDENCE_A: evidenceA } });
  await once(root, 'spawn');
  t.after(() => { try { spawnSync('taskkill.exe', ['/PID', String(root.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ } });

  const deadline = Date.now() + 10000;
  while ((!fs.existsSync(evidenceA) || !fs.existsSync(evidenceB)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const aPid = Number(fs.readFileSync(evidenceA, 'utf8'));
  const bPid = Number(fs.readFileSync(evidenceB, 'utf8'));
  const initial = descendantPids([root.pid]);
  assert.ok(initial.includes(aPid) && initial.includes(bPid), `链完整时应枚举到两代，实际 ${initial.join(', ')}`);
});

// 握手期崩溃：app 对象还不存在时，也要能按"由本进程派生"收掉底层进程。
test('killDescendantsOf sweeps processes started by this test run', async (t) => {
  const marker = path.resolve(__dirname, '..');
  const child = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000)`, marker], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => { try { child.kill(); } catch { /* 已退出 */ } });

  assert.equal(isPidAlive(child.pid), true);
  const result = killDescendantsOf(process.pid, [marker]);
  assert.equal(result.ok, true, `收尾应成功：${result.reason}`);
  assert.ok(result.killed.includes(child.pid), `应包含本次派生的 ${child.pid}，实际 ${result.killed.join(', ')}`);
  assert.equal(isPidAlive(child.pid), false, '被收掉的进程必须确认消失');
});
