const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { RunHistory } = require('../src/core/run-history');

const TOKEN = 'test-token-0123456789';

class FakeResponse extends Writable {
  constructor() { super(); this.chunks = []; this.status = null; this.headers = null; }
  _write(chunk, _encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  writeHead(status, headers) { this.status = status; this.headers = headers || {}; return this; }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
  get payload() { const body = this.text(); if (!body) return null; try { return JSON.parse(body); } catch { return null; } }
}

function server(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-auth-'));
  const sibling = `${dir}-evil`;
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'TOP SECRET');
  fs.mkdirSync(path.join(dir, 'src/renderer'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/renderer/index.html'), '<!doctype html><title>ok</title>');
  fs.writeFileSync(path.join(dir, 'server.js'), '// source of the local service');
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(sibling, { recursive: true, force: true }); });
  const native = {
    execFile: (_exe, _args, _options, callback) => callback(null, JSON.stringify([{ Handle: '123', Title: 'Test target', ProcessId: 12 }])),
    spawn: () => { throw new Error('the worker must never start in auth tests'); },
    execFileSync() {}
  };
  const proc = Object.assign(new EventEmitter(), {
    env: { MOUSECLIK_DATA: dir, MOUSECLIK_SERVER_TOKEN: TOKEN, ...env },
    parentPort: new EventEmitter(),
    exit() {}
  });
  const context = vm.createContext({
    require: (name) => name === '../renderer/point-settings' ? require('../src/renderer/point-settings')
      : name === 'child_process' ? native
        : name === 'http' ? { createServer: () => ({ listen() {} }) }
          : name === '../core/run-history' ? { RunHistory }
            : name === '../core/profile-store' ? require('../src/core/profile-store')
              : name === '../../package.json' ? require('../package.json')
                : require(name),
    __dirname: path.join(dir, 'src/main'), process: proc, Buffer, URL, console, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main/server.js'), 'utf8'), context);
  t.after(async () => { await vm.runInContext('debugWriteQueue', context); });
  return { context, dir, handle: vm.runInContext('handle', context) };
}

async function request({ context, handle }, { method, url, headers = {}, body, host = '127.0.0.1:28232' }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host, ...headers };
  req.resume = () => {};          // IncomingMessage 的排水接口，超限时 server.js 会调用
  const res = new FakeResponse();
  const promise = handle(req, res);
  if (body !== undefined) req.emit('data', body);
  req.emit('end');
  await promise;
  // 静态文件是 createReadStream(...).pipe(res)，handle 返回时正文还没写完。
  if (!res.writableEnded) await new Promise((resolve) => res.once('finish', resolve));
  return res;
}

const profilePayload = JSON.stringify({
  active: 0,
  profiles: [{ name: 'Saved', steps: [{ type: 'click', x: 5, y: 6, label: '', labelAuto: true, clickType: '左键单击', clickCount: 2 }] }]
});

test('every write endpoint rejects a caller without the launch token (RV-02)', async (t) => {
  const s = server(t);
  const profilesBefore = vm.runInContext('JSON.stringify(profileStore.profiles)', s.context);
  const attempts = [
    { method: 'PUT', url: '/api/profiles', body: profilePayload },
    { method: 'POST', url: '/api/run', body: JSON.stringify({ windowId: '123', steps: [{ type: 'click', x: 1, y: 2 }] }) },
    { method: 'POST', url: '/api/run/some-run/control', body: JSON.stringify({ action: 'stop' }) },
    { method: 'POST', url: '/api/stop', body: JSON.stringify({ runId: 'some-run' }) },
    { method: 'POST', url: '/api/debug', body: JSON.stringify({ event: 'evil' }) },
    { method: 'PUT', url: '/api/profiles', headers: { 'x-mouseclik-token': 'wrong-token' }, body: profilePayload }
  ];
  for (const attempt of attempts) {
    const response = await request(s, attempt);
    assert.equal(response.status, 403, `${attempt.method} ${attempt.url} must be rejected`);
  }
  assert.equal(vm.runInContext('JSON.stringify(profileStore.profiles)', s.context), profilesBefore, 'rejected writes must not touch the config');
  assert.equal(vm.runInContext('runs.size', s.context), 0, 'rejected runs must not start a worker');
  assert.equal(fs.existsSync(path.join(s.dir, 'profiles.json')), false, 'rejected writes must not create a config file');
});

test('the launch token unlocks writes for the app itself', async (t) => {
  const s = server(t);
  const response = await request(s, { method: 'PUT', url: '/api/profiles', headers: { 'x-mouseclik-token': TOKEN }, body: profilePayload });
  assert.equal(response.status, 200);
  assert.equal(response.payload.profiles[0].name, 'Saved');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'profiles.json'), 'utf8')).profiles[0].steps[0].clickCount, 2);
});

test('health proves identity without handing out the token', async (t) => {
  const s = server(t);
  const bare = await request(s, { method: 'GET', url: '/api/health' });
  assert.equal(bare.status, 200);
  assert.equal(bare.payload.app, 'mouseclik');
  assert.equal(bare.payload.authorized, false);
  assert.equal(bare.payload.token, undefined);
  assert.equal(bare.text().includes(TOKEN), false, 'the health payload must not leak the token');
  const authorized = await request(s, { method: 'GET', url: '/api/health', headers: { 'x-mouseclik-token': TOKEN } });
  assert.equal(authorized.payload.authorized, true);
});

test('a foreign Host header is refused (DNS rebinding)', async (t) => {
  const s = server(t);
  assert.equal((await request(s, { method: 'GET', url: '/api/profiles', host: 'evil.example' })).status, 403);
  assert.equal((await request(s, { method: 'POST', url: '/api/stop', host: 'evil.example', headers: { 'x-mouseclik-token': TOKEN }, body: '{}' })).status, 403);
  assert.equal((await request(s, { method: 'GET', url: '/api/profiles', host: 'localhost:28232' })).status, 200);
  assert.equal((await request(s, { method: 'GET', url: '/api/profiles', host: '127.0.0.1:8000' })).status, 200);
});

test('the CORS fallback follows the actual port instead of a hardcoded one (RV-03)', async (t) => {
  const s = server(t, { PORT: '28123' });
  const health = await request(s, { method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
  assert.equal(health.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:28123');
  const history = await request(s, { method: 'GET', url: '/api/history', headers: { origin: 'https://evil.example' } });
  assert.equal(history.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:28123');
  const preflight = await request(s, { method: 'OPTIONS', url: '/api/profiles', headers: { origin: 'http://127.0.0.1:28123' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['Access-Control-Allow-Headers'], /X-MouseClik-Token/);
});

test('file:// origins stay untrusted unless explicitly enabled (RV-02)', async (t) => {
  const s = server(t);
  const denied = await request(s, { method: 'GET', url: '/api/profiles', headers: { origin: 'null' } });
  assert.equal(denied.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:8000');
  const opened = server(t, { MOUSECLIK_ALLOW_FILE_ORIGIN: '1' });
  const allowed = await request(opened, { method: 'GET', url: '/api/profiles', headers: { origin: 'null' } });
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'null');
});

test('static serving stays inside the root and only serves UI assets (RV-01)', async (t) => {
  const s = server(t);
  const siblingName = `${path.basename(s.dir)}-evil`;
  const escaped = await request(s, { method: 'GET', url: `/..%2f${siblingName}%2fsecret.txt` });
  assert.equal(escaped.status, 404, 'a sibling directory sharing the root prefix must not be reachable');
  assert.equal(escaped.text().includes('TOP SECRET'), false);
  assert.equal((await request(s, { method: 'GET', url: '/server.js' })).status, 404, 'the service source must not be downloadable');
  assert.equal((await request(s, { method: 'GET', url: '/%2e%2e%2f%2e%2e%2fetc%2fpasswd' })).status, 404);
  assert.equal((await request(s, { method: 'GET', url: '/..%2f..%2f..%2fWindows%2fwin.ini' })).status, 404);
  const index = await request(s, { method: 'GET', url: '/' });
  assert.equal(index.status, 200);
  assert.match(index.text(), /<title>ok<\/title>/);
  assert.match(index.headers['Content-Type'], /text\/html/);
});

test('an oversized body answers instead of hanging (RV-09)', async (t) => {
  const s = server(t);
  const response = await request(s, { method: 'PUT', url: '/api/profiles', headers: { 'x-mouseclik-token': TOKEN }, body: 'x'.repeat(1_000_001) });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /过大/);
});

test('without a token writes stay closed unless the dev switch is explicit', async (t) => {
  const closed = server(t, { MOUSECLIK_SERVER_TOKEN: '' });
  assert.equal((await request(closed, { method: 'PUT', url: '/api/profiles', body: profilePayload })).status, 403);
  const dev = server(t, { MOUSECLIK_SERVER_TOKEN: '', MOUSECLIK_ALLOW_INSECURE_WRITES: '1' });
  assert.equal((await request(dev, { method: 'PUT', url: '/api/profiles', body: profilePayload })).status, 200);
});
