const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.MOUSECLIK_TEST_URL || 'http://127.0.0.1:28332';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/windows', (route) => route.fulfill({ json: [] }));
    const profile = { name: 'Point settings', loops: 2, loopInterval: 800, clickType: '双击', points: [
      { x: 100, y: 200, label: 'First', clickCount: 1, intervalAfterMs: 320 },
      { x: 300, y: 200, label: 'Second', clickCount: 3, intervalAfterMs: 500 },
      { x: 500, y: 200, label: 'Last', clickCount: 1, intervalAfterMs: 900 }
    ] };
    assert.ok((await page.request.put(`${origin}/api/profiles`, { data: { profiles: [profile], active: 0 } })).ok());
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#profileTitle').textContent === 'Point settings');
    const count = () => page.locator('[data-setting="clickCount"]').first();
    const interval = () => page.locator('[data-setting="ms"]').first();
    assert.equal(await page.locator('#pointInterval').count(), 0);
    assert.equal(await page.locator('#pointClickCount').count(), 0);
    assert.equal(await page.locator('.delay-row').count(), 2);
    await page.locator('#addDelay').click();
    assert.equal(await page.locator('.delay-row').count(), 3);
    await page.locator('.delay-row').last().locator('.point-remove').click();
    assert.equal(await page.locator('.delay-row').count(), 2);
    await page.locator('.click-row').first().locator('[data-click-type="中键单击"]').click();
    assert.match(await page.locator('#markers .marker').first().textContent(), /^中1$/);
    await page.locator('[data-click-delta="1"]').first().click();
    assert.equal(await count().inputValue(), '2');
    await page.locator('[data-click-delta="-1"]').first().click();
    assert.equal(await count().inputValue(), '1');
    for (const bad of ['', '0', '-1', '1.5', '1000']) {
      await count().fill(bad); await count().press('Enter');
      assert.equal(await count().inputValue(), '1');
    }
    await count().fill('999'); await count().press('Escape');
    assert.equal(await count().inputValue(), '1');
    await count().fill('999'); await count().press('Tab');
    assert.equal(await count().inputValue(), '999');
    await page.locator('#undoPoints').click();
    assert.equal(await count().inputValue(), '1');
    await page.locator('#redoPoints').click();
    assert.equal(await count().inputValue(), '999');
    for (const bad of ['', '-1', '1.5', '600001']) {
      await interval().fill(bad); await interval().press('Enter');
      assert.equal(await interval().inputValue(), '320');
    }
    await interval().fill('600000'); await interval().press('Escape');
    assert.equal(await interval().inputValue(), '320');
    await interval().fill('0'); await interval().press('Enter');
    assert.equal(await interval().inputValue(), '0');
    await page.locator('.point-down').first().click();
    assert.equal(await page.locator('.point-label').first().textContent(), 'First');
    assert.equal(await page.locator('[data-setting="ms"]').first().inputValue(), '0');
    assert.equal(await page.locator('[data-setting="clickCount"]').first().inputValue(), '999');
    await page.locator('#duplicateProfile').click();
    await count().fill('8'); await count().press('Enter');
    await page.locator('[data-profile="0"]').click();
    assert.equal(await count().inputValue(), '999');
    for (const status of ['starting','running','paused','stopping']) {
      await page.evaluate((status) => renderRunState({ status, total: 2002, completed: 1 }), status);
      assert.equal(await count().isDisabled(), true);
      assert.equal(await interval().isDisabled(), true);
    }
    for (const status of ['idle','completed','stopped','error']) {
      await page.evaluate((status) => renderRunState({ status }), status);
      assert.equal(await count().isDisabled(), false);
    }
    await page.evaluate(() => renderRunState({ status: 'idle' }));
    await page.waitForTimeout(550);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('[data-profile]').length === 2);
    assert.equal(await page.locator('[data-setting="clickCount"]').first().inputValue(), '999');
    assert.equal(await page.locator('[data-setting="ms"]').first().inputValue(), '0');
    await page.locator('.point-remove').last().click();
    assert.equal(await page.locator('.delay-row').count(), 2);
    await page.locator('.point-remove').last().click();
    assert.equal(await page.locator('.delay-row').count(), 1);
    await page.locator('#undoPoints').click(); await page.locator('#undoPoints').click();
    fs.mkdirSync('.runtime-profile/point-settings', { recursive: true });
    await page.screenshot({ path: '.runtime-profile/point-settings/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.runtime-profile/point-settings/mobile.png', fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('Point settings UI passed: stepper, strict input, Escape/blur/Enter, undo/redo, reorder, copy, disabled states, persistence, responsive layout');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
