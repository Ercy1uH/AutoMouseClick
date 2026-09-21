const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTree, metrics, flatten } = require('../src/renderer/point-settings');
const { totalClicks } = require('../src/core/profile-store');

const sample = () => validateTree([
  { id: 'a1', type: 'click', x: 10, y: 10, clickCount: 1 },
  { id: 'loop1', type: 'loop', label: '循环 1', repeatCount: 10, steps: [
    { id: 'a11', type: 'click', x: 20, y: 10, clickCount: 10 },
    { id: 'wait1', type: 'delay', ms: 120 },
    { id: 'a12', type: 'click', x: 30, y: 10, clickCount: 2 }
  ] }
]);

test('loop metrics count inner click actions once per repetition', () => {
  const steps = sample();
  assert.equal(metrics(steps).clicks, 121);
  assert.equal(totalClicks(steps, 1), 121);
  assert.equal(totalClicks(steps, 2), 242);
  assert.equal(flatten(steps).filter(step => step.type === 'click').length, 3);
});

test('nested loops and empty loops are rejected for execution', () => {
  assert.throws(() => validateTree([{ id: 'outer', type: 'loop', repeatCount: 2, steps: [{ id: 'inner', type: 'loop', repeatCount: 2, steps: [] }] }], { running: true }), /嵌套循环/);
  assert.throws(() => validateTree([{ id: 'empty', type: 'loop', repeatCount: 1, steps: [] }], { running: true }), /空循环/);
});
