const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-desktop-'));
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, MOUSECLIK_PROFILE: profile }
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('#markers .marker');
    const rows = page.locator('.click-row');
    const before = await rows.count();
    await page.locator('.screen-content').click({ position: { x: 20, y: 20 } });
    assert.equal(await rows.count(), before + 1);
    assert.equal(await page.locator('#floatingToggle').evaluate(el => el.classList.contains('active')), true);
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('floating.html'));
      main.minimize();
    });
    const deadline = Date.now() + 5000;
    let visible = false;
    while (!visible && Date.now() < deadline) {
      visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('floating.html') && w.isVisible()));
      if (!visible) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(visible, true, 'minimizing main window shows floating controls');
    console.log('Desktop interactions passed: initialized renderer, workspace click, floating on minimize');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
