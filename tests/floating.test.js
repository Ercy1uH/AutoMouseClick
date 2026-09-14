const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('floating control pauses running tasks and resumes paused tasks', () => {
  const elements = new Map();
  const actions = [];
  let render;
  const context = {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, classList: { toggle() {} }, addEventListener(type, fn) { this[type] = fn; } });
      return elements.get(id);
    } },
    window: { mouseclikDesktop: { floatingAction: (action) => actions.push(action), onFloatingState: (fn) => { render = fn; }, onFloatingSettings() {} } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../floating.js'), 'utf8'), context);
  const start = elements.get('startButton');
  render({ status: 'running' });
  assert.equal(start.disabled, false);
  assert.ok(start.textContent.includes('\u6682\u505c'));
  start.click();
  render({ status: 'paused' });
  assert.equal(start.disabled, false);
  start.click();
  assert.deepEqual(actions, ['pause', 'start']);
  for (const status of ['starting', 'stopping']) {
    render({ status });
    assert.equal(start.disabled, true);
  }
});
