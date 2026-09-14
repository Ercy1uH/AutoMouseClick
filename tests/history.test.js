const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunHistory } = require('../run-history');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'history.json');
}

test('history persists, updates without duplication, and retains the newest 100 runs', (t) => {
  const file = fixture(t), store = new RunHistory(file);
  for (let i = 0; i < 110; i++) store.save({ runId: String(i), status: 'completed', completed: i });
  store.save({ runId: '109', status: 'stopped', completed: 7 });
  const restored = new RunHistory(file);
  assert.equal(restored.entries.length, 100);
  assert.deepEqual(restored.entries[0], { runId: '109', status: 'stopped', completed: 7 });
  assert.equal(restored.entries.at(-1).runId, '10');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('interrupted runs are recovered as errors while terminal runs stay intact', (t) => {
  const file = fixture(t), store = new RunHistory(file);
  store.save({ runId: 'complete', status: 'completed' });
  store.save({ runId: 'active', status: 'paused', updatedAt: '2026-09-08T00:00:00Z' });
  const restored = new RunHistory(file);
  assert.equal(restored.entries[0].errorCode, 'APP_INTERRUPTED');
  assert.equal(restored.entries[0].endedAt, '2026-09-08T00:00:00Z');
  assert.equal(restored.entries[1].status, 'completed');
});

test('corrupt history and failed writes are reported without crashing', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, 'broken');
  const store = new RunHistory(file);
  assert.equal(store.entries.length, 0);
  assert.ok(store.error);
  fs.writeFileSync(file, 'blocked parent');
  store.file = path.join(file, 'invalid.json');
  store.save({ runId: 'one', status: 'error' });
  assert.ok(store.error);
  assert.equal(store.entries.length, 1);
});

test('invalid history is quarantined byte-for-byte before subsequent saves', (t) => {
  for (const content of ['{', JSON.stringify({ schemaVersion: 99, entries: [] })]) {
    const file = fixture(t);
    fs.writeFileSync(file, content);
    const store = new RunHistory(file);
    const backup = fs.readdirSync(path.dirname(file)).find((name) => name.includes('.corrupt-'));
    assert.ok(backup);
    assert.equal(fs.existsSync(file), false);
    store.save({ runId: 'new', status: 'completed' });
    assert.equal(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8'), content);
    assert.equal(new RunHistory(file).entries[0].runId, 'new');
  }
});

test('failed quarantine blocks writes to the original history', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, '{');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('locked'); });
  const store = new RunHistory(file);
  rename.mock.restore();
  store.save({ runId: 'new', status: 'completed' });
  assert.ok(store.error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
