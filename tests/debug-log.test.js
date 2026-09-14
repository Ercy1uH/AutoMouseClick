const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDebugLog } = require('../debug-log');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('queued logs rotate by bytes and retain at most ten files', async (t) => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  const log = createDebugLog(dir, { maxBytes: 256 });
  await Promise.all(Array.from({ length: 50 }, (_, id) => log('test', { id, value: 'x'.repeat(80) })));
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.log'));
  assert.equal(files.length, 10);
  for (const file of files) {
    assert.ok(fs.statSync(path.join(dir, file)).size <= 256);
    fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').forEach(JSON.parse);
  }
  assert.ok(fs.existsSync(path.join(dir, 'unrelated.txt')));
  const restarted = createDebugLog(dir, { maxBytes: 256 });
  await restarted('restart');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.log')).length, 10);
});

test('rejected requests share a one-second rate limit and aggregate counts', async (t) => {
  const dir = fixture(t);
  let time = 0;
  const log = createDebugLog(dir, { now: () => time });
  await log('request.bad_host');
  for (let i = 0; i < 100; i++) log('request.unauthorized');
  time = 1000;
  await log('request.bad_host');
  const lines = fs.readFileSync(path.join(dir, 'debug-001.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].rejectedCount, 101);
});

test('oversized records do not exceed the file size cap', async (t) => {
  const dir = fixture(t);
  await createDebugLog(dir, { maxBytes: 256 })('large', { text: 'x'.repeat(1000) });
  assert.ok(fs.statSync(path.join(dir, 'debug-001.log')).size <= 256);
});
