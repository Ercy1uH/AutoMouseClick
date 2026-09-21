/*
 * e2e 第二层：浏览器 UI（真实服务、真实 HTTP 写盘）
 *
 * 与 test:ui 的区别：这里不 mock /api/profiles —— 改动必须真的经 HTTP 落到磁盘，
 * 再刷新页面从服务端读回来。另外承接三条防回归断言：
 *   RV-25 客户端延迟上限取自共享常量
 *   RV-28 客户端 loops 取整与服务端一致
 *   RV-24 悬浮条在过渡态禁用、运行中可暂停
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = process.env.MOUSECLIK_TEST_URL || 'http://127.0.0.1:28332';
const TOKEN = process.env.MOUSECLIK_TEST_TOKEN || 'feature-check';
// 只轮询 GET /api/profiles 证明不了写盘：profile-store 是"先改内存再试写盘、失败只置 error"，
// 而 GET 照旧 200 返回内存数据。要证明落盘，就得直接读这个临时数据目录里的文件。
const DATA_DIR = process.env.MOUSECLIK_TEST_DATA;
if (!DATA_DIR) throw new Error('缺少 MOUSECLIK_TEST_DATA：本套件必须直接读临时数据目录来证明写盘');
const authStub = `window.mouseclikDesktop = { getServerToken: async () => '${TOKEN}' };`;

const diskProfiles = () => {
  const file = path.join(DATA_DIR, 'profiles.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const authHeaders = { 'X-MouseClik-Token': TOKEN };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(authStub);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // 只挡窗口枚举：本层测的是 UI→HTTP→磁盘，不需要真的去枚举 Windows 窗口。
    await page.route('**/api/windows', (route) => route.fulfill({ json: [] }));
    await page.goto(ORIGIN);

    const readProfiles = async () => {
      const response = await page.request.get(`${ORIGIN}/api/profiles`);
      assert.equal(response.status(), 200);
      const body = await response.json();
      // 写盘失败时服务端会把 error 带在响应里、内存数据却照旧返回；只看 200 会漏掉这种情况。
      assert.equal(body.error, null, `读配置不应带错误：${body.error}`);
      return body.profiles;
    };
    // 同时要求"接口里的"和"磁盘上的"都满足条件，才算这次改动真的落盘了。
    const waitForSave = async (predicate, description) => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const profiles = await readProfiles();
        const disk = diskProfiles();
        if (predicate(profiles) && disk && predicate(disk.profiles)) return { profiles, disk };
        await page.waitForTimeout(100);
      }
      throw new Error(`等待写盘超时：${description}`);
    };

    // --- UI → HTTP → 磁盘 ---
    const rows = page.locator('.click-row');
    const before = await rows.count();
    await page.locator('.screen-content').click({ position: { x: 30, y: 30 } });
    assert.equal(await rows.count(), before + 1, '点击预览应新增一个坐标点');
    const persisted = await waitForSave(
      (profiles) => profiles.length && profiles[0].steps.filter((step) => step.type === 'click').length === before + 1,
      `新增点位（${before + 1} 个点击步骤）`
    );
    // 用磁盘上的那份来断言内容：接口返回可能是内存态，磁盘才是"写成了"的证据。
    const newStep = persisted.disk.profiles[0].steps.filter((step) => step.type === 'click').at(-1);
    assert.ok(Number.isInteger(newStep.x) && Number.isInteger(newStep.y), '落盘的坐标应为整数');
    assert.ok(newStep.x >= 0 && newStep.y >= 0);
    assert.equal(persisted.disk.schemaVersion, 5, '磁盘上的配置 schema 必须是 5');

    // --- RV-25：客户端上限来自共享常量 ---
    await page.locator('#addDelay').click();
    const bounds = await page.evaluate(() => ({
      delayMax: document.querySelector('[data-setting="ms"]').max,
      loopsMax: document.querySelector('#loopCount').max,
      shared: { delay: window.PointSettings.MAX_DELAY_MS, loops: window.PointSettings.MAX_LOOPS }
    }));
    assert.equal(bounds.delayMax, String(bounds.shared.delay), '延迟输入框上限必须等于共享常量 MAX_DELAY_MS');
    assert.equal(bounds.loopsMax, String(bounds.shared.loops), '循环次数上限必须等于共享常量 MAX_LOOPS');

    // --- RV-28：小数循环次数，客户端取整后与服务端一致 ---
    await page.locator('#loopCount').fill('2.5');
    await page.locator('#loopCount').press('Tab');
    assert.equal(await page.locator('#loopCount').inputValue(), '3', '客户端必须把 2.5 取整为 3');
    const rounded = await waitForSave((profiles) => profiles.length && profiles[0].loops === 3, '循环次数取整落盘');
    assert.equal(rounded.disk.profiles[0].loops, 3, '磁盘上的循环次数必须与客户端取整口径一致');

    // --- 刷新页面：从服务端读回 ---
    await page.reload();
    await page.waitForSelector('.click-row');
    assert.equal(await page.locator('.click-row').count(), before + 1, '刷新后应恢复已写盘的点位');
    assert.equal(await page.locator('#loopCount').inputValue(), '3', '刷新后循环次数应从服务端恢复');

    // --- RV-24：悬浮控制条的过渡态与暂停可用性 ---
    const floating = await browser.newPage({ viewport: { width: 240, height: 100 } });
    await floating.addInitScript(`
      window.__captured = { actions: [] };
      window.mouseclikDesktop = {
        onFloatingState: (callback) => { window.__applyFloatingState = callback; },
        onFloatingSettings: (callback) => { window.__applyFloatingSettings = callback; },
        floatingAction: (action) => { window.__captured.actions.push(action); },
        toggleFloating: () => { window.__captured.actions.push('toggle'); }
      };
    `);
    await floating.goto(`${ORIGIN}/floating.html`);
    const startButton = floating.locator('#startButton');
    await floating.evaluate(() => window.__applyFloatingSettings({ stopShortcut: 'F6' }));
    await floating.evaluate(() => window.__applyFloatingState({ status: 'starting' }));
    assert.equal(await startButton.isDisabled(), true, 'starting 过渡态必须禁用开始按钮');
    await floating.evaluate(() => window.__applyFloatingState({ status: 'stopping' }));
    assert.equal(await startButton.isDisabled(), true, 'stopping 过渡态必须禁用开始按钮');
    await floating.evaluate(() => window.__applyFloatingState({ status: 'running' }));
    assert.equal(await startButton.isDisabled(), false, '运行中必须可以从悬浮条暂停（RV-24）');
    assert.equal((await startButton.textContent()).trim(), 'Ⅱ 暂停');
    await startButton.click();
    assert.deepEqual(await floating.evaluate(() => window.__captured.actions), ['pause'], '运行中点击必须发出 pause');
    await floating.evaluate(() => window.__applyFloatingState({ status: 'paused' }));
    assert.equal((await startButton.textContent()).trim(), '▶ 继续执行');
    await startButton.click();
    assert.deepEqual(await floating.evaluate(() => window.__captured.actions), ['pause', 'start'], '暂停后点击必须发出继续动作');

    assert.deepEqual(errors, [], '页面不应有未捕获异常');
    console.log('E2E UI passed: UI→HTTP→disk round trip (disk file read directly), reload recovery, shared-constant bounds (RV-25), fractional loops rounding (RV-28), floating transitions (RV-24)');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
