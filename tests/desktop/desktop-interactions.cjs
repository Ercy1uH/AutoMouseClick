/*
 * e2e 第三层：桌面链路（真实 Electron）
 *
 * 覆盖：启动后的渲染、点击预览加点、最小化弹出悬浮条，
 * 以及悬浮条 → IPC → 主窗口 → 控制请求 → 状态回传 的暂停/继续全链路（RV-24）。
 *
 * 说明：本层不点击真实外部窗口，也不做 DPI 换算 —— 那是发布前在受控窗口上的手验项。
 * 控制请求用 route 拦截，因此不需要真的跑起一个点击任务。
 */
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { waitForPortReleased, portOwnerReport, probeListening, ancestryContains, isPidAlive, killDescendantsOf } = require('../run-suites.cjs');

const APP_SERVER_PORT = 28232; // src/main/main.js 的 SERVER_PORT

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// firstWindow() 不保证返回主窗口：悬浮控制条是第二个窗口，而它没有 #markers。
// 这里按 URL 明确挑选，避免套件随机挑到悬浮条页然后超时。
async function waitForWindow(app, match, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = app.windows().find((page) => match(page.url()));
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`等待窗口超时；当前窗口：${app.windows().map((page) => page.url()).join(' | ') || '(无)'}`);
}

async function waitFor(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(80);
  }
  throw new Error(`等待超时：${message}`);
}

(async () => {
  // 临时 profile 建在编排器给的根里：本套件被 /F 杀树时 finally 不会执行，只能靠编排器兜底。
  const profile = fs.mkdtempSync(path.join(process.env.MOUSECLIK_TEST_TEMP_ROOT || os.tmpdir(), 'mouseclik-desktop-'));
  let app = null;
  let launched = false;
  let cleanupFailure = null;
  // 阶段化：只有真正收尾完成（done）之后，迟到的异常才算"不影响结论"；
  // 关闭过程中出问题必须走紧急清理，不能被吞成成功。
  let phase = 'running';

  const syncSleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 忙等兜底 */ } };

  // Playwright 的 electron.launch 在可执行文件异常时会直接把进程打崩（未捕获异常），
  // 那种情况下 finally 根本不会执行 —— 所以这里再兜一层同步清理与如实报告。
  const emergencyCleanup = (reason) => {
    if (phase === 'done') return;
    phase = 'done';
    const notes = [];
    let swept = [];
    let candidates = 0;
    if (launched && app) {
      // 已经起来的 Electron 必须被收掉，且要确认真的没了
      const pid = app.process().pid;
      try {
        const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
        if (killed.status !== 0) notes.push(`终止 Electron 的 taskkill 未成功（退出码 ${killed.status ?? 'null'}${killed.error ? `/${killed.error.message}` : ''}）`);
        for (let attempt = 0; attempt < 40 && isPidAlive(pid); attempt += 1) syncSleep(200);
        if (isPidAlive(pid)) notes.push(`Electron 主进程 ${pid} 未被确认终止`);
      } catch (error) { notes.push(`终止 Electron 失败：${error.message}`); }
    }
    // 启动握手期崩溃：electron.launch() 还没返回（app 仍是 null），但底层进程可能已经起来。
    // 按"由本进程派生或归属未知 + 命令行引用仓库/profile"收尾，不能因为拿不到 app 就当没起过。
    const sweep = killDescendantsOf(process.pid, [path.resolve(__dirname, '../..'), profile]);
    swept = sweep.killed || [];
    candidates = sweep.candidates || 0;
    if (!sweep.ok) notes.push(`子进程收尾未能确认：${sweep.reason}`);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      if (fs.existsSync(profile)) notes.push('临时 profile 未能删除');
    } catch (error) { notes.push(`临时 profile 删除失败：${error.message}`); }
    // 端口用可区分的探测：查不出来 ≠ 没人监听；且任何本地地址上的监听都算占用
    const probe = probeListening(APP_SERVER_PORT);
    if (!probe.ok) notes.push(`端口 ${APP_SERVER_PORT} 状态未知（${probe.error}）`);
    else if (probe.pid !== null) notes.push(`端口 ${APP_SERVER_PORT} 仍被 PID ${probe.pid} 监听（${probe.address}）`);
    const headline = launched
      ? '运行期间发生未捕获异常（Electron 已拉起）'
      : (swept.length || candidates > 0)
        ? '启动期间发生未捕获异常（launch 未返回，已尝试收掉底层进程）'
        : '启动失败：未拉起 Electron';
    console.error(`${headline}（${reason}；同步清理结果：${notes.length ? notes.join('；') : '临时 profile 已删除、端口空闲'}）`);
    process.exit(1);
  };
  const lateNoise = (label, error) => {
    const message = error && error.message ? error.message : String(error);
    if (phase === 'done') { console.error(`注意：收尾阶段出现${label}（不影响结论）：${message}`); return; }
    emergencyCleanup(`${label} ${message}`);
  };
  process.on('uncaughtException', (error) => lateNoise('未捕获异常', error));
  process.on('unhandledRejection', (error) => lateNoise('未处理的 Promise 拒绝', error));

  try {
    // 启动必须放在 try 内：launch 失败时也要走到清理，不能把临时目录留在磁盘上。
    // executablePath 仅用于反例测试；先做存在性预检，避免落到上面那条"进程被打崩"的路径。
    const executable = process.env.MOUSECLIK_TEST_ELECTRON_EXECUTABLE || null;
    if (executable && !fs.existsSync(executable)) throw new Error(`指定的 Electron 可执行文件不存在：${executable}`);
    app = await electron.launch({
      args: [path.resolve(__dirname, '../..')],
      env: { ...process.env, MOUSECLIK_PROFILE: profile },
      ...(executable ? { executablePath: executable } : {})
    });
    launched = true;
    const appPid = app.process().pid;
    // 归属证明：28232 上必须有一个**本次 Electron 的后代**在监听，而不是"端口有人应答就算数"。
    const ownerDeadline = Date.now() + 20000;
    let owner = null;
    let lastProbe = null;
    while (Date.now() < ownerDeadline) {
      const probe = probeListening(APP_SERVER_PORT);
      lastProbe = probe;
      if (probe.ok && probe.pid !== null && await ancestryContains(probe.pid, appPid)) { owner = probe.pid; break; }
      await sleep(200);
    }
    assert.ok(owner, lastProbe && !lastProbe.ok
      ? `无法确认端口 ${APP_SERVER_PORT} 的监听者（${lastProbe.error}），不能证明归属`
      : `无法证明端口 ${APP_SERVER_PORT} 属于本次 Electron（主进程 ${appPid}）`);
    console.log(`端口归属确认：${APP_SERVER_PORT} 由 ${owner} 监听，是本次 Electron（${appPid}）的后代`);

    // 仅用于反例测试：注入一个启动之后的未捕获异常，验证紧急清理路径
    // （Playwright 的 launch 崩溃只覆盖"未拉起"那一半）。
    if (process.env.MOUSECLIK_TEST_DESKTOP_CRASH === 'after-launch') {
      setTimeout(() => { throw new Error('injected crash after launch'); }, 50);
      await sleep(5000);
    }

    const main = await waitForWindow(app, (url) => url.includes('?desktop=1'));
    await main.waitForSelector('#markers .marker');
    const rows = main.locator('.click-row');
    const before = await rows.count();
    await main.locator('.screen-content').click({ position: { x: 20, y: 20 } });
    assert.equal(await rows.count(), before + 1);
    assert.equal(await main.locator('#floatingToggle').evaluate((el) => el.classList.contains('active')), true);

    await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => !window.webContents.getURL().includes('floating.html'));
      mainWindow.minimize();
    });
    const floating = await waitForWindow(app, (url) => url.includes('floating.html'));
    await waitFor(
      () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().includes('floating.html') && window.isVisible())),
      '最小化主窗口后悬浮条应可见'
    );
    await app.evaluate(({ BrowserWindow }) => {
      const floatingWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('floating.html'));
      floatingWindow.showInactive();
    });

    // --- RV-24：过渡态禁用、运行中可暂停 ---
    const contentSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('floating.html')).getContentSize());
    // Windows can include a small non-client inset in transparent window bounds.
    assert.ok(contentSize[0] >= 300 && contentSize[0] <= 304 && contentSize[1] >= 132 && contentSize[1] <= 136);
    assert.ok(await floating.locator('#hideFloat, #startButton, #stopButton').evaluateAll(elements => elements.every(el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    })), 'native floating window must contain every control');
    const startButton = floating.locator('#startButton');
    await floating.evaluate(() => render({ status: 'starting' }));
    assert.equal(await startButton.isDisabled(), true, 'starting 过渡态必须禁用');
    await floating.evaluate(() => render({ status: 'stopping' }));
    assert.equal(await startButton.isDisabled(), true, 'stopping 过渡态必须禁用');

    // --- 悬浮条 → IPC → 主窗口 → 控制请求 → 状态回传 ---
    const controls = [];
    await main.route('**/api/run/*/control', async (route) => {
      const action = route.request().postDataJSON()?.action;
      controls.push(action);
      await route.fulfill({ json: { runId: 'e2e-run', status: action === 'pause' ? 'paused' : 'running', completed: 1, total: 10, loop: 1, pointIndex: 0 } });
    });
    await main.evaluate(() => {
      state.pendingRun = null;
      state.nativeRunId = 'e2e-run';
      state.runSnapshot = { runId: 'e2e-run', status: 'running', completed: 1, total: 10, loop: 1, pointIndex: 0 };
      renderRunState(state.runSnapshot);
    });
    await waitFor(async () => (await startButton.textContent()).includes('暂停'), '运行状态应经 IPC 回传到悬浮条');
    assert.equal(await startButton.isDisabled(), false);

    await startButton.click();
    await waitFor(() => Promise.resolve(controls.length === 1), '悬浮条点击应触发一次控制请求');
    assert.equal(controls[0], 'pause', '运行中点击必须请求 pause');
    await waitFor(async () => (await floating.locator('#statusText').textContent()) === '已暂停', '暂停状态应回传到悬浮条');
    assert.equal((await startButton.textContent()).trim(), '▶ 继续执行');

    await startButton.click();
    await waitFor(() => Promise.resolve(controls.length === 2), '再次点击应触发继续请求');
    assert.equal(controls[1], 'resume', '暂停后点击必须请求 resume');
    await waitFor(async () => (await floating.locator('#statusText').textContent()) === '正在执行', '继续状态应回传到悬浮条');
    assert.equal((await startButton.textContent()).trim(), 'Ⅱ 暂停');

    console.log('Desktop interactions passed: renderer init, workspace click, floating on minimize, floating→IPC→control(pause/resume)→status chain, transition disabling (RV-24)');
  } finally {
    phase = 'cleanup';
    // 每一步都各自兜住：关闭抛错不能连带跳过删目录，删目录失败也不能只打日志。
    if (app) {
      try { await app.close(); } catch (error) { cleanupFailure = cleanupFailure || `关闭 Electron 失败：${error.message}`; }
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      if (fs.existsSync(profile)) cleanupFailure = cleanupFailure || `临时 profile 目录未能删除：${profile}`;
    } catch (error) { cleanupFailure = cleanupFailure || `清理临时 profile 失败：${error.message}`; }
    // 启动失败（可捕获的 reject 走的是 finally，不是紧急处理器）同样可能有底层进程残留
    if (!launched) {
      const sweep = killDescendantsOf(process.pid, [path.resolve(__dirname, '../..'), profile]);
      if (!sweep.ok) cleanupFailure = cleanupFailure || `启动失败后的子进程收尾未能确认：${sweep.reason}`;
      else if (sweep.killed.length) console.error(`注意：启动失败后收掉了底层进程 ${sweep.killed.join(', ')}`);
    }
    // 端口检查不挂在 app 上：launch 失败（app 为 null）时同样要确认 28232 没被留下
    if (!(await waitForPortReleased(APP_SERVER_PORT, launched ? 5000 : 1500))) {
      cleanupFailure = cleanupFailure || `端口 ${APP_SERVER_PORT} 仍被监听（${portOwnerReport(APP_SERVER_PORT)}）`;
    }
    if (cleanupFailure) { console.error(`清理失败：${cleanupFailure}`); process.exitCode = 1; }
    else if (launched) console.log(`Desktop cleanup confirmed: Electron 已关闭，端口 ${APP_SERVER_PORT} 已释放，临时 profile 已删除`);
    else console.error('启动失败：未拉起 Electron（已确认端口与临时目录状态，未执行任何桌面断言）');
    phase = 'done'; // 只有收尾全部走完，迟到的异常才算不影响结论
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
