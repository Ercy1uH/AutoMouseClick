const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunHistory } = require('../src/core/run-history');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'history.json');
}

const LEGACY = JSON.stringify({ schemaVersion: 1, entries: [{ runId: 'legacy', status: 'completed', completed: 3, total: 9 }] });

test('history persists, updates without duplication, and retains the newest 100 runs', (t) => {
  const file = fixture(t), store = new RunHistory(file);
  for (let i = 0; i < 110; i++) store.save({ runId: String(i), status: 'completed', completed: i });
  store.save({ runId: '109', status: 'stopped', completed: 7 });
  const restored = new RunHistory(file);
  assert.equal(restored.entries.length, 100);
  assert.deepEqual(restored.entries[0], { runId: '109', status: 'stopped', completed: 7, countUnit: 'actionGroup' });
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

// --- RV-19：历史 schema 独立升到 v2，v1 走迁移而不是损坏隔离 ---
test('legal v1 history migrates to v2 with a byte-for-byte backup and unconfirmed counts', (t) => {
  const file = fixture(t);
  const legacy = JSON.stringify({ schemaVersion: 1, entries: [
    { runId: 'old-complete', status: 'completed', completed: 12, total: 40 },
    { runId: 'old-paused', status: 'paused', updatedAt: '2026-09-08T00:00:00Z', completed: 5, total: 40 }
  ] });
  fs.writeFileSync(file, legacy);
  const store = new RunHistory(file);
  assert.equal(store.error, null);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'history.v1.backup.json'), 'utf8'), legacy);
  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.entries[0].countUnit, 'unconfirmed');
  assert.equal(migrated.entries[0].completed, 12);
  assert.equal(migrated.entries[0].total, 40);
  assert.equal(migrated.entries[1].errorCode, 'APP_INTERRUPTED');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-')), []);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(store.entries[0].countUnit, 'unconfirmed');
});

test('new records are stamped as action groups while the legacy marker survives reloads', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, LEGACY);
  const store = new RunHistory(file);
  store.save({ runId: 'fresh', status: 'completed', completed: 4, total: 8 });
  const reloaded = new RunHistory(file);
  assert.equal(reloaded.error, null);
  assert.equal(reloaded.entries[0].countUnit, 'actionGroup');
  assert.equal(reloaded.entries[1].countUnit, 'unconfirmed');
  assert.equal(reloaded.entries[1].completed, 3);
  const dir = path.dirname(file);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.backup.json')), ['history.v1.backup.json']);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')), []);
});

test('a failed migration backup never overwrites the original v1 file', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, LEGACY);
  const copy = t.mock.method(fs, 'copyFileSync', () => { throw new Error('denied'); });
  const store = new RunHistory(file);
  assert.ok(store.error);
  assert.equal(fs.readFileSync(file, 'utf8'), LEGACY);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(store.entries[0].countUnit, 'unconfirmed');
  store.save({ runId: 'fresh', status: 'completed' });
  assert.equal(fs.readFileSync(file, 'utf8'), LEGACY);
  assert.equal(store.entries[0].runId, 'fresh');
  copy.mock.restore();
});

test('a failed migration write keeps the original file and the next save retries safely', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, LEGACY);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('locked'); });
  const store = new RunHistory(file);
  rename.mock.restore();
  assert.ok(store.error);
  assert.equal(fs.readFileSync(file, 'utf8'), LEGACY);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  store.save({ runId: 'fresh', status: 'completed', completed: 1, total: 2 });
  assert.equal(store.error, null);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.entries[0].runId, 'fresh');
  assert.equal(saved.entries[0].countUnit, 'actionGroup');
  assert.equal(saved.entries[1].countUnit, 'unconfirmed');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'history.v1.backup.json'), 'utf8'), LEGACY);
});

// --- RV-29：历史落盘必须显式 flush，否则断电/强杀时最后一批记录可能还在页缓存里 ---
test('history writes are flushed to disk', (t) => {
  const file = fixture(t);
  const spy = t.mock.method(fs, 'writeFileSync');
  new RunHistory(file).save({ runId: 'flush-check', status: 'completed' });
  const historyWrite = spy.mock.calls.find((call) => String(call.arguments[0]).endsWith('.tmp'));
  assert.ok(historyWrite, '保存历史时应先写临时文件');
  assert.equal(historyWrite.arguments[2]?.flush, true, '历史落盘的 writeFileSync 必须带 flush: true');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].runId, 'flush-check');
});

// --- 备份判据：不是"同名文件存在"，而是"本次这个原文件确实留下了逐字节备份" ---

test('an unrelated same-named backup is never reused as this migration backup', (t) => {
  const file = fixture(t);
  const dir = path.dirname(file);
  const stale = path.join(dir, 'history.v1.backup.json');
  fs.writeFileSync(stale, 'unrelated content that must survive');
  fs.writeFileSync(file, LEGACY);
  const store = new RunHistory(file);
  assert.equal(store.error, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2);
  assert.equal(fs.readFileSync(stale, 'utf8'), 'unrelated content that must survive', '无关的同名文件不得被当成备份，也不得被改写');
  const fresh = path.join(dir, 'history.v1.1.backup.json');
  assert.equal(fs.readFileSync(fresh, 'utf8'), LEGACY, '必须另留一份本次原文件的逐字节备份');
});

test('an existing backup of the same original is reused instead of duplicated', (t) => {
  const file = fixture(t);
  const dir = path.dirname(file);
  fs.writeFileSync(file, LEGACY);
  new RunHistory(file);
  fs.writeFileSync(file, LEGACY); // 退回同一份 v1 原文，再迁移一次
  new RunHistory(file);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.backup.json')), ['history.v1.backup.json']);
  assert.equal(fs.readFileSync(path.join(dir, 'history.v1.backup.json'), 'utf8'), LEGACY);
});

test('v2 entries with a missing or malformed countUnit are not treated as action groups', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, entries: [
    { runId: 'confirmed', status: 'completed', countUnit: 'actionGroup' },
    { runId: 'missing', status: 'completed' },
    { runId: 'typo', status: 'completed', countUnit: 'actiongroup' },
    { runId: 'bogus', status: 'completed', countUnit: 42 },
    { runId: 'legacy', status: 'completed', countUnit: 'unconfirmed' }
  ] }));
  const store = new RunHistory(file);
  const byId = Object.fromEntries(store.entries.map((entry) => [entry.runId, entry.countUnit]));
  assert.equal(byId.confirmed, 'actionGroup');
  for (const id of ['missing', 'typo', 'bogus', 'legacy']) {
    assert.equal(byId[id], 'unconfirmed', `${id} 不得被解释成已确认的动作组口径`);
  }
});
