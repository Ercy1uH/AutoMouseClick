const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../../src/renderer/point-settings');
const origin = process.env.MOUSECLIK_TEST_URL;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let saved = { profiles: [{ name: 'Loop preview', loops: 1, loopInterval: 0, steps: [
      ...settings.CLICK_TYPES.map((clickType, i) => ({ id: `outer-${i}`, type: 'click', x: 220 + i * 400, y: 200, clickType, clickCount: 1 })),
      { id: 'wait', type: 'delay', ms: 100 },
      { id: 'block', type: 'loop', label: 'Loop 1', repeatCount: 2, steps:
        settings.CLICK_TYPES.map((clickType, i) => ({ id: `inner-${i}`, type: 'click', x: 220 + i * 400, y: 700, clickType, clickCount: 1 })) }
    ] }], active: 0 };
    await page.route('**/api/windows', route => route.fulfill({ json: [] }));
    await page.route('**/api/profiles', route => {
      if (route.request().method() === 'PUT') saved = route.request().postDataJSON();
      return route.fulfill({ json: saved });
    });
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#profileTitle').textContent === 'Loop preview');
    const marker = id => page.locator(`#markers [data-id="${id}"]`);
    const color = locator => locator.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(await page.locator('#markers .marker').count(), 8);
    for (let i = 0; i < 4; i++) {
      assert.ok(await marker(`inner-${i}`).isVisible());
      assert.equal(await marker(`inner-${i}`).textContent(), `${settings.MARKER_NAME[settings.CLICK_TYPES[i]]}2`);
      const outer = await color(marker(`outer-${i}`));
      const inner = await color(marker(`inner-${i}`));
      assert.notEqual(inner, outer);
      const channels = value => value.match(/\d+/g).map(Number);
      assert.deepEqual(channels(inner), channels(outer).map(channel => Math.round(channel * 0.72)));
      assert.equal(inner, await color(page.locator(`.point-row[data-id="inner-${i}"] .point-index`)));
      assert.match(await marker(`inner-${i}`).getAttribute('title'), /Loop 1/);
    }
    const row = page.locator('.point-row[data-id="inner-0"] .point-coord');
    const before = await row.textContent();
    const outerBefore = await page.locator('.point-row[data-id="outer-0"] .point-coord').textContent();
    await marker('inner-0').scrollIntoViewIfNeeded();
    const box = await marker('inner-0').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y - 45, { steps: 6 });
    await page.mouse.up();
    assert.notEqual(await row.textContent(), before);
    assert.equal(await page.locator('.point-row[data-id="outer-0"] .point-coord').textContent(), outerBefore);
    assert.equal(await page.locator('#markers .marker').count(), 8);
    await page.locator('#undoPoints').click();
    assert.equal(await row.textContent(), before);
    await page.locator('.loop-collapse').click();
    assert.equal(await page.locator('#markers .marker').count(), 8, 'collapsed loop keeps its markers');
    await page.locator('.loop-card header').click();
    await page.locator('.screen-content').click({ position: { x: 150, y: 150 } });
    assert.equal(await page.locator('.loop-card .click-row').count(), 5);
    assert.equal(await page.locator('#markers .marker').count(), 9, 'new point in collapsed loop is visible');
    assert.equal(await page.locator('.loop-collapse').getAttribute('aria-expanded'), 'true');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.locator('.screen-content').scrollIntoViewIfNeeded();
      for (const id of ['inner-0', 'inner-1', 'inner-2', 'inner-3']) {
        assert.ok(await marker(id).isVisible());
      }
      const dir = process.env.MOUSECLIK_TEST_ARTIFACTS;
      fs.mkdirSync(dir, { recursive: true });
      await page.locator('#screenPreview').screenshot({ path: path.join(dir, `loop-preview-${width}.png`) });
    }
    // Wait for the debounced save before testing a loop-only reload.
    await page.waitForTimeout(700);
    saved.profiles[0].steps = saved.profiles[0].steps.filter(step => step.type === 'loop');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#markers .marker').length === 5);
    assert.equal(await page.locator('.loop-card .click-row').count(), 5);
    assert.deepEqual(errors, []);
    console.log('Loop preview passed: all button colors, stable-ID drag, undo, collapsed insertion, mobile, loop-only reload');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
