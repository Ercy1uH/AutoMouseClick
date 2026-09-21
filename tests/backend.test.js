const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RunHistory } = require('../src/core/run-history');
const { ProfileStore } = require('../src/core/profile-store');

function backend(t, runSteps, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-backend-'));
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  const spawnArgs = [];
  const proc = Object.assign(new EventEmitter(), { env: { MOUSECLIK_DATA: dir }, parentPort: new EventEmitter(), exit() {} });
  const native = {
    execFile: (_exe, _args, _options, callback) => callback(null, JSON.stringify([{ Handle: '123', Title: 'Test target', ProcessId: 12 }])),
    spawn: (_exe, _args) => { spawnArgs.push(_args); return child; }, execFileSync() {}
  };
  const context = vm.createContext({
    require: (name) => name === '../renderer/point-settings' ? require('../src/renderer/point-settings') : name === 'child_process' ? native : name === 'http' ? { createServer: () => ({ listen() {} }) } : name === '../core/run-history' ? { RunHistory } : name === '../core/profile-store' ? require('../src/core/profile-store') : require(name),
    __dirname: path.resolve(__dirname, '../src/main'), process: proc, Buffer, URL, console, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main/server.js'), 'utf8'), context);
  let body;
  context.testResponse = { writeHead() {}, end: (text) => { body = JSON.parse(text); } };
  const payload = runSteps === undefined
    ? { windowId: '123', profileName: 'Test profile', points: [{ x: 1, y: 2, clickCount: 7 }, { x: 3, y: 4 }], loops: 2, ...patch }
    : { windowId: '123', profileName: 'Test profile', steps: runSteps, loops: 2, ...patch };
  vm.runInContext(`startNativeRun(testResponse, ${JSON.stringify(payload)})`, context);
  const runId = body.runId;
  const event = (data) => child.stdout.emit('data', JSON.stringify(data) + '\n');
  t.after(async () => {
    await vm.runInContext('debugWriteQueue', context);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { context, child, event, runId, body: () => body, spawnPayload: () => JSON.parse(spawnArgs.at(-1).find((arg) => String(arg).startsWith('{'))), dir, history: () => JSON.parse(fs.readFileSync(path.join(dir, 'run-history.json'), 'utf8')).entries };
}

test('worker lifecycle persists the final result and metadata without duplicate history', (t) => {
  const b = backend(t);
  b.event({ type: 'started', total: 2 });
  b.event({ type: 'progress', completed: 1, loop: 1, pointIndex: 0 });
  b.event({ type: 'paused' });
  assert.equal(b.history()[0].completed, 1);
  b.event({ type: 'resumed' });
  b.event({ type: 'completed' });
  b.child.emit('close', 0, null);
  assert.equal(b.history().length, 1);
  assert.equal(b.history()[0].status, 'completed');
  assert.equal(b.history()[0].completed, 2);
  assert.equal(b.history()[0].profileName, 'Test profile');
  assert.equal(b.history()[0].windowTitle, 'Test target');
  assert.ok(b.history()[0].endedAt);
});

test('unexpected worker exit persists error and application shutdown persists stop', (t) => {
  const b = backend(t);
  b.child.emit('close', 9, null);
  assert.equal(b.history()[0].errorCode, 'WORKER_EXITED');
  const stopped = backend(t);
  vm.runInContext('stopAllRuns()', stopped.context);
  assert.equal(stopped.history()[0].status, 'stopped');
});

test('run total counts clickCount as sum(clickCount) * loops', (t) => {
  const b = backend(t);
  assert.equal(b.body().total, 16);
  assert.equal(b.history()[0].total, 16);
});

test('worker rejects invalid click counts instead of changing the request', (t) => {
  const b = backend(t, [{ type: 'click', x: 1, y: 2, clickType: '左键单击', clickCount: 9999 }]);
  assert.match(b.body().error, /clickCount/);
});

test('worker payload carries mixed steps and step progress', (t) => {
  const b = backend(t, [{ type: 'delay', ms: 0 }, { type: 'click', x: 1, y: 2, clickType: '中键单击', clickCount: 3 }, { type: 'delay', ms: 600000 }]);
  assert.deepEqual(b.spawnPayload().steps.map((step) => step.type), ['delay', 'click', 'delay']);
  assert.equal(b.spawnPayload().steps[1].clickType, '中键单击');
  assert.equal(b.spawnPayload().points, undefined);
  assert.equal(b.spawnPayload().clickAction, undefined);
  b.event({ type: 'progress', completed: 3, stepIndex: 1, pointClickIndex: 3 });
  assert.equal(vm.runInContext('publicRun(runs.get(activeRunId)).pointClickIndex', b.context), 3);
  assert.equal(vm.runInContext('publicRun(runs.get(activeRunId)).pointIndex', b.context), 1);
});

test('run rejects fractional and out of range delays', (t) => {
  for (const ms of [-1, 600001, 0.5, '', null]) {
    const b = backend(t, [{ type: 'delay', ms }, { type: 'click', x: 1, y: 2, clickType: '左键单击', clickCount: 1 }]);
    assert.match(b.body().error, /ms/);
  }
});

test('legacy points-only request converts to steps without a final delay', (t) => {
  const b = backend(t, undefined, { points: [{ x: 1, y: 2, clickCount: 2, intervalAfterMs: 180 }, { x: 3, y: 4, clickCount: 1, intervalAfterMs: 500 }], clickType: '右键单击' });
  assert.deepEqual(b.spawnPayload().steps.map((step) => step.type), ['click', 'delay', 'click']);
  assert.equal(b.spawnPayload().steps[0].clickType, '右键单击');
  assert.equal(b.body().total, 6);
});

// 退出时最后一条没有换行结尾的记录必须被处理一次 —— 早先的实现把残行拼两遍，必然解析失败。
// 用"退出码非 0"来观察：这时 finishRun 不会覆盖 completed，只有残行真的被解析才会出现 completed=7。
test('a final worker line without a newline is parsed exactly once', async (t) => {
  const b = backend(t);
  b.event({ type: 'started', total: 16 });
  b.child.stdout.emit('data', JSON.stringify({ type: 'progress', completed: 7, loop: 1, pointIndex: 0 })); // 无换行结尾
  b.child.emit('close', 9, null);
  await vm.runInContext('debugWriteQueue', b.context);

  assert.equal(b.history()[0].completed, 7, '残行必须被当成一条完整记录处理');
  assert.equal(b.history()[0].status, 'error');
  assert.equal(b.history()[0].errorCode, 'WORKER_EXITED');
  const debugDir = path.join(b.dir, 'debug');
  const logs = fs.readdirSync(debugDir).map((name) => fs.readFileSync(path.join(debugDir, name), 'utf8')).join('');
  assert.doesNotMatch(logs, /worker_output_parse_error/, '残行不得被重复拼接后解析失败');
});
