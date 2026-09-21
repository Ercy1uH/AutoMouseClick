const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.MOUSECLIK_TEST_URL;
const token = process.env.MOUSECLIK_TEST_TOKEN;
const artifact = name => { const dir = process.env.MOUSECLIK_TEST_ARTIFACTS; fs.mkdirSync(dir, { recursive: true }); return path.join(dir, name); };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(token => {
      window.mouseclikDesktop = { getServerToken: async () => token, sendRunState: state => { window.lastFloatingState = state; } };
    }, token);
    const profile = name => ({ name, loops: 1, steps: [{ type: 'click', x: 100, y: 100 }] });
    assert.ok((await page.request.put(`${origin}/api/profiles`, { headers: { 'X-MouseClik-Token': token }, data: { profiles: [profile('Original'), profile('Other')], active: 0 } })).ok());
    await page.route('**/api/windows', route => route.fulfill({ json: [] }));
    await page.goto(origin);
    await page.waitForFunction(() => document.querySelector('#profileTitle').textContent === 'Original');
    const input = page.locator('#profileNameInput');
    await page.locator('#renameProfile').click();
    assert.equal(await input.inputValue(), 'Original');
    await input.fill('Discarded');
    await page.locator('#cancelProfileName').click();
    assert.equal(await page.locator('#profileTitle').textContent(), 'Original');
    await page.locator('#renameProfile').click();
    await input.fill('   ');
    await input.press('Enter');
    assert.ok(await page.locator('#profileNameEditor').isVisible());
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#profileTitle').textContent(), 'Original');
    const name = '<img src=x onerror=alert(1)> 新配置';
    await input.fill(`  ${name}  `);
    const save = page.waitForResponse(response => response.url().endsWith('/api/profiles') && response.request().method() === 'PUT' && response.request().postDataJSON().profiles[0].name === name);
    await input.press('Enter');
    assert.ok((await save).ok());
    assert.equal(await page.locator('#profileTitle').textContent(), name);
    assert.equal(await page.locator('.profile-name').first().textContent(), name);
    assert.equal(await page.locator('.profile-name').nth(1).textContent(), 'Other');
    assert.equal(await page.locator('#profileTitle img, #profileList img').count(), 0);
    assert.equal(await page.evaluate(() => window.lastFloatingState.profileName), name);
    await page.reload();
    await page.waitForFunction(name => document.querySelector('#profileTitle').textContent === name, name);
    await page.locator('#renameProfile').click();
    await input.fill('名'.repeat(80));
    const savedLong = page.waitForResponse(response => response.url().endsWith('/api/profiles') && response.request().method() === 'PUT' && response.request().postDataJSON().profiles[0].name.length === 80);
    await input.press('Enter');
    assert.ok((await savedLong).ok());
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.locator('.profile-heading').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.locator('.topbar').screenshot({ path: artifact(`rename-${width}.png`) });
    }
    await page.evaluate(() => renderRunState({ status: 'running', completed: 0, total: 1 }));
    assert.equal(await page.locator('#renameProfile').isDisabled(), true);
    await page.close();

    for (const scale of [1, 1.25, 1.5, 2]) {
      const floating = await browser.newPage({ viewport: { width: 300, height: 132 }, deviceScaleFactor: scale });
      floating.on('pageerror', error => errors.push(error.message));
      await floating.addInitScript(() => {
        window.mouseclikDesktop = { onFloatingState: fn => { window.paint = fn; }, onFloatingSettings: fn => { window.settings = fn; } };
      });
      await floating.goto(`${origin}/floating.html`);
      await floating.evaluate(() => window.settings({ stopShortcut: 'Control+Shift+Alt+F12' }));
      for (const status of ['idle', 'running', 'paused', 'stopping', 'error']) {
        await floating.evaluate(status => window.paint({ status, profileName: '很长的配置名称'.repeat(12), targetName: '目标窗口'.repeat(20), detail: '流程 1/100 · 循环 1：第 10/100 次 · 等待 120 ms' }), status);
        const fits = await floating.locator('#floatShell, #hideFloat, #statusText, #runDetail, #startButton, #stopButton').evaluateAll(elements => elements.every(el => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && (!el.matches('button') || (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth));
        }));
        assert.ok(fits, `floating controls fit at scale ${scale} in ${status}`);
      }
      await floating.screenshot({ path: artifact(`floating-${scale}.png`) });
      await floating.close();
    }
    assert.deepEqual(errors, []);
    console.log('Profile/floating UI passed: rename, validation, escaping, persistence, long names, run lock, floating bounds at four DPI scales');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
