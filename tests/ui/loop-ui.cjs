const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.MOUSECLIK_TEST_URL;
const token = process.env.MOUSECLIK_TEST_TOKEN;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(token => { window.mouseclikDesktop = { getServerToken: async () => token }; }, token);
    await page.route('**/api/windows', route => route.fulfill({ json: [] }));
    const steps = Array.from({ length: 14 }, (_, i) => ({ id: `click-${i}`, type: 'click', x: 100, y: 100, label: `Point ${i}`, clickCount: 1 }));
    const seeded = await page.request.put(`${origin}/api/profiles`, { headers: { 'X-MouseClik-Token': token }, data: { profiles: [{ name: 'Loop UI', steps, loops: 1 }], active: 0 } });
    assert.ok(seeded.ok());
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#profileTitle').textContent === 'Loop UI');
    await page.locator('#addLoop').click();
    const first = page.locator('.loop-card').first();
    assert.equal(await page.locator('.loop-card').count(), 1);
    assert.equal(await page.locator('#pointList > .loop-card').count(), 1);
    assert.equal(await first.evaluate(el => el.previousElementSibling.dataset.id), 'click-13');
    assert.equal(await first.locator('.loop-collapse').getAttribute('aria-expanded'), 'true');
    assert.equal(await first.locator('.loop-state').textContent(), '正在编辑');
    assert.equal(await first.locator('[data-setting="repeatCount"]').inputValue(), '1');
    assert.ok(await first.locator('[data-setting="repeatCount"]').evaluate(el => document.activeElement === el));
    assert.ok(await first.locator('header').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
    assert.match(await page.locator('#toast').textContent(), /已添加循环/);
    assert.match(await page.locator('#previewHint').textContent(), /循环 1 内/);
    await first.locator('.loop-footer button').nth(1).click();
    assert.equal(await first.locator('.delay-row').count(), 1);
    await page.locator('#addLoop').click();
    assert.equal(await page.locator('#pointList > .loop-card').count(), 2);
    assert.equal(await page.locator('.loop-card .loop-card').count(), 0);
    assert.match(await page.locator('#toast').textContent(), /之后添加循环/);
    await page.locator('#undoPoints').click();
    assert.equal(await page.locator('.loop-card').count(), 1);
    await page.locator('#redoPoints').click();
    assert.equal(await page.locator('.loop-card').count(), 2);
    await page.locator('.click-row').first().click();
    await page.locator('#addLoop').click();
    assert.equal(await page.locator('#pointList > .loop-card').first().evaluate(el => el.previousElementSibling.dataset.id), 'click-0');
    for (const width of [1440, 980, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const header = page.locator('.loop-card header').first();
      assert.ok(await header.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `loop header fits at ${width}`);
      const dir = process.env.MOUSECLIK_TEST_ARTIFACTS;
      fs.mkdirSync(dir, { recursive: true });
      await page.locator('.loop-card').first().screenshot({ path: path.join(dir, `loop-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('Loop UI passed: toolbar click, selection, focus, scroll, insertion, non-nesting, undo/redo, responsive headers');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
