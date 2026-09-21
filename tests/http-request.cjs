/*
 * 有界的 HTTP 请求助手：请求侧与响应侧都必须能可靠 settle。
 *
 * 只处理 res.data / res.end / req.error 是不够的 —— 收到响应头与部分 body 之后连接断开时，
 * 两边都不会再有事件，Promise 永远挂着；此时超时回调里再 req.destroy(error) 也给不出
 * 能拒绝它的 error（请求已结束）。所以还要接住响应的 aborted / error / close。
 *
 * 用 node:http 而不是 fetch：Host 是 fetch 的禁用头，DNS rebinding 防护测不了。
 */
const http = require('node:http');

function request(baseUrl, method, pathname, { token, host, body, rawBody, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = rawBody !== undefined ? rawBody : body === undefined ? null : JSON.stringify(body);
    let settled = false;
    let timer = null;
    const finish = (action) => { if (settled) return; settled = true; clearTimeout(timer); action(); };

    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: {
        ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { 'X-MouseClik-Token': token } : {}),
        ...(host ? { Host: host } : {})
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => finish(() => resolve({ status: res.statusCode, headers: res.headers, text, json: () => { try { return JSON.parse(text); } catch { return null; } } })));
      res.on('aborted', () => finish(() => reject(new Error(`响应中断（${method} ${pathname}）`))));
      res.on('error', (error) => finish(() => reject(new Error(`响应出错（${method} ${pathname}）：${error.message}`))));
      // 'close' 在正常结束时也会触发，但那时 end 已经 settle，这里不会覆盖结果
      res.on('close', () => finish(() => reject(new Error(`连接在响应完成前关闭（${method} ${pathname}）`))));
    });

    timer = setTimeout(() => {
      finish(() => reject(new Error(`请求超时（${method} ${pathname}，${timeoutMs}ms）`)));
      req.destroy();
    }, timeoutMs);
    req.on('error', (error) => finish(() => reject(error)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

module.exports = { request };
