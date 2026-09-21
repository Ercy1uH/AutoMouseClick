/*
 * HTTP 助手的有界性反例：响应半途断开时不能永远挂着。
 *
 * 这类连接的特点是"有响应头、有部分 body、然后静默断开"：请求已经结束、响应不再有事件，
 * 只有接住 aborted/close 才能拒绝 Promise。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('./http-request.cjs');

async function withServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a response cut off mid-body rejects instead of hanging', async (t) => {
  const baseUrl = await withServer(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"partial":');
    setTimeout(() => res.socket?.destroy(), 50);
  });
  const started = Date.now();
  await assert.rejects(
    () => request(baseUrl, 'GET', '/api/whatever', { timeoutMs: 5000 }),
    /响应中断|连接在响应完成前关闭|响应出错|socket hang up|aborted/i
  );
  assert.ok(Date.now() - started < 4000, '必须在有界时间内拒绝，而不是等满超时或永久挂住');
});

test('a server that never responds is cut off by the request timeout', async (t) => {
  const baseUrl = await withServer(t, () => { /* 接到连接但不回任何响应 */ });
  const started = Date.now();
  await assert.rejects(() => request(baseUrl, 'GET', '/api/whatever', { timeoutMs: 600 }), /请求超时/);
  assert.ok(Date.now() - started < 5000, '超时必须生效');
});

test('a normal response still resolves', async (t) => {
  const baseUrl = await withServer(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const response = await request(baseUrl, 'GET', '/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { ok: true });
});
