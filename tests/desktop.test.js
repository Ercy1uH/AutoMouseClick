const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function desktopContext(fetch, options = {}) {
  const app = new EventEmitter();
  Object.assign(app, { getPath: () => '.', setPath() {}, requestSingleInstanceLock: () => true, disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), getVersion: () => '1.0.5', quit() { app.quitCalled = true; } });
  class Tray extends EventEmitter {
    constructor() { super(); Tray.instance = this; }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const electron = { app, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromBitmap: (data) => data }, ipcMain: Object.assign(new EventEmitter(), { handle() {} }), globalShortcut: { unregister() {} } };
  let now = 0;
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === 'fs' ? { mkdirSync() {} } : require(name),
    __dirname: path.resolve(__dirname, '..'), process: { env: {}, platform: 'win32' }, Buffer, console,
    fetch, AbortSignal, Date: { now: () => (now += 1000) }, setTimeout: options.setTimeout || ((callback) => { callback(); return 1; }), clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  return { context, app, Tray };
}

test('startup rejects another service and accepts only this launch token and version', async () => {
  let requests = 0, token;
  const { context } = desktopContext(async (url) => {
    assert.match(url, /\/api\/health$/);
    return { ok: true, json: async () => ({ app: 'mouseclik', version: '1.0.5', token: ++requests === 1 ? 'foreign' : token }) };
  });
  token = vm.runInContext('serverToken', context);
  assert.equal(await vm.runInContext('waitForServer()', context), true);
  assert.equal(requests, 2);
  const foreign = desktopContext(async () => ({ ok: true, json: async () => ({ app: 'mouseclik', token: 'foreign', version: '1.0.5' }) }));
  assert.equal(await vm.runInContext('waitForServer()', foreign.context), false);
});

test('tray restores hidden windows and reflects pause/stop availability', () => {
  const { context, Tray, app } = desktopContext();
  vm.runInContext('createTray()', context);
  assert.equal(Tray.instance.menu[2].enabled, false);
  vm.runInContext("latestRunState = {status: 'paused'}; refreshTray()", context);
  assert.equal(Tray.instance.menu[1].label, '继续执行');
  assert.equal(Tray.instance.menu[2].enabled, true);
  const calls = [];
  context.testWindow = { isDestroyed: () => false, isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
  vm.runInContext('mainWindow = testWindow', context);
  Tray.instance.emit('double-click');
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  Tray.instance.menu.at(-1).click();
  assert.equal(app.quitCalled, true);
});

test('quit closes renderers before shutting down the server after the profile flush grace period', () => {
  const timers = [];
  const { context, app } = desktopContext(undefined, { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; } });
  const calls = [];
  context.testMain = { isDestroyed: () => false, close: () => calls.push('main.close') };
  context.testFloating = { isDestroyed: () => false, close: () => calls.push('floating.close') };
  context.testServer = Object.assign(new EventEmitter(), { postMessage: () => calls.push('server.shutdown'), kill: () => calls.push('server.kill') });
  vm.runInContext('mainWindow = testMain; floatingWindow = testFloating; serverProcess = testServer', context);
  app.emit('before-quit', { preventDefault: () => calls.push('preventDefault') });
  assert.deepEqual(calls, ['preventDefault', 'main.close', 'floating.close']);
  assert.equal(timers[0].delay, 600);
  app.emit('window-all-closed');
  assert.deepEqual(calls, ['preventDefault', 'main.close', 'floating.close']);
  timers[0].callback();
  assert.equal(calls.at(-1), 'server.shutdown');
  assert.equal(timers[1].delay, 4000);
});
