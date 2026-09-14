const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const startup = source.slice(0, source.indexOf('const $ ='));

function initialState(savedSetting = null) {
  const context = vm.createContext({
    PointSettings: require('../src/renderer/point-settings'), structuredClone,
    window: { location: { protocol: 'http:' } },
    localStorage: { getItem: (key) => key === 'mouseclik.floatingAutoShow' ? savedSetting : null }
  });
  vm.runInContext(startup, context);
  return vm.runInContext('state', context);
}

test('renderer starts with an editable profile, capture state and floating enabled', () => {
  const state = initialState();
  assert.equal(state.active, 0);
  assert.ok(state.profiles[state.active]);
  assert.equal(state.runStatus, 'idle');
  assert.equal(state.captureStream, null);
  assert.equal(state.captureSize.width, 1920);
  assert.equal(state.windows.length, 0);
  assert.equal(state.floatingAutoShow, true);
  assert.equal(state.hotkeys.stop, 'F6');
  assert.equal(state.persistenceReady, false);
});

test('renderer respects an explicitly disabled floating preference', () => {
  assert.equal(initialState('false').floatingAutoShow, false);
});
