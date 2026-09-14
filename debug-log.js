const fs = require('node:fs');
const path = require('node:path');

function createDebugLog(directory, { maxBytes = 5 * 1024 * 1024, maxFiles = 10, now = Date.now } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const list = async () => (await fs.promises.readdir(directory))
    .filter((name) => /^debug-\d+\.log$/.test(name))
    .sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
  let queue = Promise.resolve();
  let index;
  let size = 0;
  let rejectedCount = 0;
  let lastRejectedAt = -Infinity;

  function log(event, details = {}) {
    if (event === 'request.bad_host' || event === 'request.unauthorized') {
      rejectedCount += 1;
      const time = now();
      if (time - lastRejectedAt < 1000) return queue;
      details = { ...details, rejectedCount };
      rejectedCount = 0;
      lastRejectedAt = time;
    }
    let line = JSON.stringify({ time: new Date(now()).toISOString(), ...details, event }) + '\n';
    if (Buffer.byteLength(line) > maxBytes) {
      line = JSON.stringify({ time: new Date(now()).toISOString(), event: 'log.truncated' }) + '\n';
    }
    queue = queue.then(async () => {
      if (index === undefined) {
        const files = await list();
        index = files.length ? Number(files.at(-1).slice(6, -4)) + 1 : 1;
      }
      const bytes = Buffer.byteLength(line);
      if (size && size + bytes > maxBytes) { index += 1; size = 0; }
      await fs.promises.appendFile(path.join(directory, `debug-${String(index).padStart(3, '0')}.log`), line);
      size += bytes;
      const files = await list();
      for (const name of files.slice(0, Math.max(0, files.length - maxFiles))) {
        try { await fs.promises.unlink(path.join(directory, name)); } catch { /* Retry locked files on the next write. */ }
      }
    }).catch(() => {});
    return queue;
  }
  return log;
}

module.exports = { createDebugLog };
