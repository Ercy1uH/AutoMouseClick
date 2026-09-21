const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 由 tests/run-suites.cjs 下发：隔离服务地址、共享 token、截图目录。
// 单独手工跑时会回退到旧默认值以便调试，但正式回归一律走编排器。
const ORIGIN = process.env.MOUSECLIK_TEST_URL || 'http://127.0.0.1:28332';
const TOKEN = process.env.MOUSECLIK_TEST_TOKEN || 'feature-check';
const ARTIFACTS = process.env.MOUSECLIK_TEST_ARTIFACTS || '.runtime-profile/feature-check';
const shot = (name) => { fs.mkdirSync(ARTIFACTS, { recursive: true }); return path.join(ARTIFACTS, name); };

// RV-02：本地服务对写操作要求凭据。真实运行时 token 由主进程经 preload 下发，
// 这里的浏览器环境没有 preload，所以显式注入一个同名桩。
const authStub = `window.mouseclikDesktop = { getServerToken: async () => '${TOKEN}' };`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(authStub);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.route('**/api/windows', (route) => route.fulfill({ json: [] }));
    const profilePuts = [];
    await page.route('**/api/profiles', (route) => {
      if (route.request().method() === 'PUT') profilePuts.push(route.request().postDataJSON());
      return route.fulfill({ json: { profiles: [], active: 0 } });
    });
    await page.goto(ORIGIN);
    const rows = page.locator('.click-row');
    assert.equal(await rows.count(), 4);
    assert.equal(await page.locator('.move-destination').count(), 0, 'step move menu is removed');
    const profileName = page.locator('.profile-name').first();
    const originalName = await profileName.textContent();
    await profileName.evaluate(el => { el.textContent = '这是一个用于验证配置栏布局的很长配置名称'; });
    for (const width of [1440, 980]) {
      await page.setViewportSize({ width, height: 1000 });
      const layouts = await page.locator('.profile-item').evaluateAll(items => items.map(item => {
        const box = item.getBoundingClientRect();
        const name = item.querySelector('.profile-name').getBoundingClientRect();
        const sub = item.querySelector('.profile-sub').getBoundingClientRect();
        const icon = item.querySelector('.profile-icon').getBoundingClientRect();
        const more = item.querySelector('.profile-more').getBoundingClientRect();
        return name.bottom <= sub.top && name.left >= icon.right && name.right <= more.left
          && sub.right <= more.left && sub.bottom <= box.bottom;
      }));
      assert.ok(layouts.every(Boolean), `profile text must occupy separate rows within bounds at ${width}px`);
      await page.locator('#profileList').screenshot({ path: shot(`profiles-${width}.png`) });
    }
    await profileName.evaluate((el, name) => { el.textContent = name; }, originalName);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.screen-content').click({ position: { x: 20, y: 20 } });
    assert.equal(await rows.count(), 5, 'workspace click creates a coordinate');
    assert.match(await page.locator('#toast').textContent(), /X/);
    await rows.last().locator('.point-remove').click();
    await page.locator('#captureWindow').click();
    assert.equal(await page.locator('#toast').textContent(), '请先选择实际点击目标窗口');
    assert.deepEqual(errors, [], 'startup and initial interactions must not throw');
    await page.locator('#addPoint').click();
    await page.locator('#pointX').fill('123');
    await page.locator('#pointY').fill('456');
    await page.locator('#pointLabel').fill('<img src=x onerror=alert(1)>');
    await page.locator('#pointForm button[type=submit]').click();
    assert.equal(await rows.count(), 5);
    assert.equal(await rows.last().locator('.point-label').textContent(), '<img src=x onerror=alert(1)>');
    await rows.last().locator('[data-setting="clickCount"]').fill('7');
    await rows.last().locator('[data-setting="clickCount"]').press('Enter');
    assert.equal(await rows.last().locator('[data-setting="clickCount"]').inputValue(), '7');
    assert.equal(await page.locator('#pointList img').count(), 0);
    await rows.last().locator('[title="编辑坐标"]').click();
    await page.locator('#pointX').fill('789');
    await page.locator('#pointForm button[type=submit]').click();
    assert.match(await rows.last().textContent(), /0789/);
    await page.locator('#undoPoints').click();
    assert.match(await rows.last().textContent(), /0123/);
    await page.locator('#redoPoints').click();
    assert.match(await rows.last().textContent(), /0789/);
    await rows.last().locator('.point-up').click();
    assert.match(await rows.nth(3).textContent(), /0789/);
    await page.locator('#undoPoints').click();
    assert.match(await rows.last().textContent(), /0789/);
    await rows.last().locator('.point-remove').click();
    assert.equal(await rows.count(), 4);
    await page.locator('#undoPoints').click();
    assert.equal(await rows.count(), 5);
    await page.locator('#clearPoints').click();
    assert.equal(await rows.count(), 0);
    await page.locator('#undoPoints').click();
    assert.equal(await rows.count(), 5);
    await page.locator('[data-profile="1"]').click();
    assert.equal(await page.locator('#undoPoints').isDisabled(), true);
    await page.locator('[data-profile="0"]').click();
    assert.equal(await rows.count(), 5);
    await rows.last().locator('[data-click-type="中键单击"]').click();
    const indexColors = await page.locator('.point-index').evaluateAll((els) => els.map((el) => el.style.backgroundColor));
    assert.notEqual(indexColors[0], indexColors.at(-1), 'different buttons must have distinct colors');
    await page.locator('[data-profile="1"]').click();
    await page.locator('[data-profile="0"]').click();
    const indexColorsAgain = await page.locator('.point-index').evaluateAll((els) => els.map((el) => el.style.backgroundColor));
    assert.deepEqual(indexColorsAgain, indexColors, 'point colors must stay stable across profile switches');
    assert.equal(await page.locator('#markers .marker').count(), 5);
    const markerBox = await page.locator('#markers .marker').first().boundingBox();
    const coordBefore = await rows.first().locator('.point-coord').textContent();
    await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(markerBox.x + 90, markerBox.y + 70, { steps: 6 });
    await page.mouse.up();
    assert.equal(await rows.count(), 5, 'marker drag must not add a new point');
    const coordAfter = await rows.first().locator('.point-coord').textContent();
    assert.notEqual(coordAfter, coordBefore, 'marker drag must update the point coordinates');
    await page.locator('#undoPoints').click();
    assert.equal(await rows.first().locator('.point-coord').textContent(), coordBefore, 'undo must restore pre-drag coordinates');
    const coordStable = await rows.first().locator('.point-coord').textContent();
    await page.locator('#markers .marker').first().click();
    assert.equal(await rows.first().locator('.point-coord').textContent(), coordStable, 'clicking a marker must not nudge coordinates (threshold guard)');
    await page.locator('#showHistory').click();
    await page.waitForFunction(() => !document.getElementById('refreshHistory').disabled);
    assert.equal(await page.locator('#historyMessage').textContent(), '暂无运行记录');
    await page.route('**/api/history', (route) => route.fulfill({ json: { entries: [
      { runId: 'test', startedAt: '2026-09-08T08:00:00Z', endedAt: '2026-09-08T08:00:12Z', profileName: 'Test profile', windowTitle: 'Test window', status: 'completed', completed: 40, total: 40, countUnit: 'actionGroup' },
      { runId: 'error', startedAt: '2026-09-08T07:00:00Z', endedAt: '2026-09-08T07:00:01Z', status: 'error', completed: 1, total: 10, errorMessage: '<img src=x onerror=alert(1)>', countUnit: 'unconfirmed' }
    ] } }));
    await page.locator('#refreshHistory').click();
    await page.waitForFunction(() => !document.getElementById('refreshHistory').disabled);
    assert.equal(await page.locator('#historyRows tr').count(), 2);
    assert.equal(await page.locator('#historyRows img').count(), 0);
    // RV-19：新记录按动作组计，v1 老记录标注口径未确认，两者必须在界面上可区分。
    assert.equal(await page.locator('#historyRows tr').first().locator('td').nth(3).textContent(), '40 / 40');
    assert.match(await page.locator('#historyRows tr').last().locator('td').nth(3).textContent(), /1 \/ 10（旧版口径未确认）/);
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: shot('history.png') });
    await page.locator('#closeHistory').click();
    await page.screenshot({ path: shot('desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#addPoint').click();
    await page.screenshot({ path: shot('mobile.png'), fullPage: true });
    assert.ok(await page.locator('#pointEditor').evaluate((el) => el.getBoundingClientRect().right <= innerWidth));
    await page.waitForTimeout(600);
    assert.ok(profilePuts.length >= 1, 'profile persistence sent at least one PUT');
    assert.equal(profilePuts.at(-1).active, 0);
    assert.equal(profilePuts.at(-1).profiles[0].steps.filter((step) => step.type === 'click').length, 5);
    const addedPoint = profilePuts.at(-1).profiles[0].steps.find((point) => point.label === '<img src=x onerror=alert(1)>');
    assert.equal(addedPoint.clickCount, 7, 'clickCount must be persisted through PUT payloads');
    assert.deepEqual(errors, []);
    const health = await (await page.request.get(`${ORIGIN}/api/health`, { headers: { 'X-MouseClik-Token': TOKEN } })).json();
    assert.equal(health.authorized, true);
    assert.equal(health.token, undefined, 'health must not echo the token');
    await page.locator('#cancelPoint').click();
    await page.close();

    const api = await browser.newContext();
    await api.request.put(`${ORIGIN}/api/profiles`, { headers: { 'X-MouseClik-Token': TOKEN }, data: { profiles: [], active: 0 } });
    const persistencePage = await browser.newPage();
    await persistencePage.addInitScript(authStub);
    await persistencePage.route('**/api/windows', (route) => route.fulfill({ json: [] }));
    await persistencePage.goto(ORIGIN);
    await persistencePage.locator('#addProfile').click();
    await persistencePage.close();
    let persistedProfiles = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await api.request.get(`${ORIGIN}/api/profiles`);
      persistedProfiles = (await response.json()).profiles;
      if (persistedProfiles.length === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(persistedProfiles.length, 4, 'pagehide keepalive persisted a change made inside the debounce window');
    await api.close();
    console.log('UI smoke passed: add/edit/clickCount/undo/redo/reorder/delete/clear/profile isolation/escaping/colors/marker-drag/drag-threshold/history/persistence/pagehide/health');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
