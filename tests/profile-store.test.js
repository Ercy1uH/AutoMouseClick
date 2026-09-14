const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, totalClicks } = require('../profile-store');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-points-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'profiles.json');
}
const profile = (point = {}) => ({ name: 'Example', points: [{ x: 10, y: 20, label: 'Point', ...point }], loops: 2 });
test('v1 and v2 migrate to v4 with exact backup', (t) => {
  for (const schemaVersion of [1, 2]) {
    const file = fixture(t);
    const data = JSON.stringify({ schemaVersion, active: 0, profiles: [{ ...profile({ clickCount: 3 }), pointInterval: 320 }] });
    fs.writeFileSync(file, data);
    const store = new ProfileStore(file);
    assert.equal(store.error, null);
    assert.equal(store.profiles[0].steps[0].clickCount, 3);
    assert.equal(store.profiles[0].steps[0].type, 'click');
    assert.equal(store.profiles[0].pointInterval, undefined);
    assert.equal(JSON.parse(fs.readFileSync(file)).schemaVersion, 4);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), `profiles.v${schemaVersion}.backup.json`), 'utf8'), data);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.deepEqual(new ProfileStore(file).profiles, store.profiles);
  }
});
test('migration failure retains original and compatible in-memory data', (t) => {
  const file = fixture(t);
  const old = JSON.stringify({ schemaVersion: 1, profiles: [profile()] });
  fs.writeFileSync(file, old);
  const copy = fs.copyFileSync;
  fs.copyFileSync = () => { throw new Error('denied'); };
  let store;
  try { store = new ProfileStore(file); } finally { fs.copyFileSync = copy; }
  assert.match(store.error, /升级失败/);
  assert.equal(store.profiles[0].steps[0].type, 'click');
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  store.save({ profiles: store.profiles });
  assert.equal(store.error, null);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'profiles.v1.backup.json'), 'utf8'), old);
});
test('valid boundaries survive restart and totals count action groups', (t) => {
  const file = fixture(t), store = new ProfileStore(file);
  store.save({ active: 7, profiles: [profile({ clickCount: 999, intervalAfterMs: 600000 }), profile({ intervalAfterMs: 0 })] });
  assert.equal(store.error, null);
  assert.equal(store.active, 1);
  assert.equal(totalClicks(store.profiles[0].steps, 2), 1998);
  assert.deepEqual(new ProfileStore(file).profiles, store.profiles);
});
test('invalid execution fields are rejected without changing saved data', (t) => {
  const file = fixture(t), store = new ProfileStore(file);
  store.save({ profiles: [profile()] });
  const before = fs.readFileSync(file, 'utf8');
  for (const clickCount of [0, -1, 1.5, 1000, '', '3', null]) assert.throws(() => store.save({ profiles: [profile({ clickCount })] }), /clickCount/);
  for (const ms of [-1, 600001, 0.5, '', null]) assert.throws(() => store.save({ profiles: [{ steps: [{ type: 'delay', ms }] }] }), /ms/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('missing or corrupt stores and failed writes do not crash', (t) => {
  const file = fixture(t);
  assert.equal(new ProfileStore(file).error, null);
  for (const data of ['broken', JSON.stringify({ schemaVersion: 5, profiles: [] })]) {
    fs.writeFileSync(file, data);
    const store = new ProfileStore(file);
    assert.ok(store.error);
    // RV-06：读不出来的文件会被隔离改名，磁盘上不再留着一份"下次保存就会被默认配置覆盖"的原文件。
    assert.equal(store.profiles.length, 0);
  }
  assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.corrupt-')).length, 2);
  const store = new ProfileStore(file);
  // 用一个必然写失败的路径（把普通文件当目录用）验证写入失败只报错、不抛异常。
  const blocker = path.join(path.dirname(file), 'blocker.txt');
  fs.writeFileSync(blocker, 'x');
  store.file = path.join(blocker, 'invalid.json');
  store.save({ profiles: [profile()] });
  assert.ok(store.error);
  assert.equal(store.profiles.length, 1);
});

test('an unreadable store is quarantined before falling back (RV-06)', (t) => {
  const file = fixture(t);
  const raw = JSON.stringify({ schemaVersion: 99, profiles: [{ name: 'future', steps: [] }] });
  fs.writeFileSync(file, raw);
  const store = new ProfileStore(file);
  assert.match(store.error, /备份|保留/);
  assert.equal(fs.existsSync(file), false, '原文件必须被移走，否则下一次无关保存就会把它覆盖成默认配置');
  const quarantined = fs.readdirSync(path.dirname(file)).filter((name) => /\.corrupt-\d+\.json$/.test(name));
  assert.equal(quarantined.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), quarantined[0]), 'utf8'), raw, '隔离副本必须与原文件逐字节一致');
});

test('v3 migration preserves non-final waits and applies button labels', (t) => {
  const file = fixture(t);
  const raw = JSON.stringify({ schemaVersion: 3, profiles: [{ name: 'A', clickType: '中键单击', points: [
    { x: 1, y: 2, label: '坐标点 01', clickCount: 2, intervalAfterMs: 180 },
    { x: 3, y: 4, label: '确认按钮', clickCount: 1, intervalAfterMs: 500 }
  ] }] });
  fs.writeFileSync(file, raw);
  const store = new ProfileStore(file);
  assert.deepEqual(store.profiles[0].steps.map((step) => step.type), ['click', 'delay', 'click']);
  assert.equal(store.profiles[0].steps[0].label, '中键1');
  assert.equal(store.profiles[0].steps[2].label, '确认按钮');
  assert.equal(store.profiles[0].defaultClickType, '中键单击');
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'profiles.v3.backup.json'), 'utf8'), raw);
});

test('bad loaded step is dropped while strict save reports invalid fields', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 4, profiles: [{ steps: [
    { type: 'click', x: 1, y: 2, clickType: '左键单击', clickCount: 1, label: '' },
    { type: 'click', x: 2, y: 3, clickType: '左键单击', clickCount: 1000, label: 'bad' }
  ] }] }));
  const store = new ProfileStore(file);
  assert.equal(store.error, null);
  assert.equal(store.profiles[0].steps.length, 1);
  assert.throws(() => store.save({ profiles: [{ steps: [{ type: 'click', x: 1, y: 2, clickCount: 0 }] }] }), /clickCount/);
});

test('v1 profile interval becomes a delay between clicks', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, profiles: [{ pointInterval: 320, points: [
    { x: 1, y: 2, label: 'A' }, { x: 3, y: 4, label: 'B' }
  ] }] }));
  const store = new ProfileStore(file);
  assert.deepEqual(store.profiles[0].steps.map((step) => step.type), ['click', 'delay', 'click']);
  assert.equal(store.profiles[0].steps[1].ms, 320);
});
