const http = require('http');
const fs = require('fs');
const { requireStepSettings, pointsToSteps, clickType, integer, MAX_STEPS, MAX_CLICK_STEPS, MAX_LOOPS, MAX_LOOP_INTERVAL, DEFAULT_CLICK_TYPE } = require('../renderer/point-settings');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { RunHistory } = require('../core/run-history');
let createDebugLog;
try { ({ createDebugLog } = require('../core/debug-log')); } catch { /* VM tests may omit the helper module. */ }
const { ProfileStore, totalClicks, MAX_POINT_CLICKS } = require('../core/profile-store');
const dataDir = process.env.MOUSECLIK_DATA || path.resolve(__dirname, '../..');
const history = new RunHistory(path.join(dataDir, 'run-history.json'));
const profileStore = new ProfileStore(path.join(dataDir, 'profiles.json'));

const root = path.resolve(__dirname, '../renderer');
const port = Number(process.env.PORT || 8000);
// 端口只有一个权威（RV-03）：CORS 兜底与前端回退都从这里派生，不再硬编码 8000。
const serverOrigin = `http://127.0.0.1:${port}`;
// RV-02：写操作必须携带本次启动下发的 token。没有 token 的部署（直接 `node server.js`）
// 默认拒绝一切写请求，只有在显式打开开发开关时才放行。
const serverToken = process.env.MOUSECLIK_SERVER_TOKEN || null;
const allowInsecureWrites = process.env.MOUSECLIK_ALLOW_INSECURE_WRITES === '1';
// file:// 直开（浏览器 origin 为字面量 "null"）默认不再被信任，需要显式开关（RV-02）。
const allowFileOrigin = process.env.MOUSECLIK_ALLOW_FILE_ORIGIN === '1';
const HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY_BYTES = 1_000_000;
// RV-01：只有界面真正加载的这几个文件可以被 HTTP 回源（与 package.json 的 files 列表一致）。
// 目录穿越已在下面用带分隔符的前缀判断挡住，这里是第二道：源码与配置不会被下载。
const STATIC_ALLOWLIST = new Set(['/index.html', '/floating.html', '/style.css', '/floating.css', '/app.js', '/floating.js', '/point-settings.js']);
const workerPath = path.resolve(__dirname, '../worker/native-click-worker.ps1');
const debugDir = path.join(dataDir, 'debug');
const legacyDebugPath = path.join(dataDir, 'debug.log');
const runs = new Map();
let activeRunId = null;
let startingRun = false;
let debugWriteQueue = Promise.resolve();

const TERMINAL_STATUSES = new Set(['stopped', 'completed', 'error']);
const RUN_RETENTION_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 1500;
const WORKER_ERROR_MESSAGES = {
  TARGET_WINDOW_CLOSED: '目标窗口已关闭或句柄已失效',
  TARGET_WINDOW_UNAVAILABLE: '无法激活目标窗口',
  TARGET_NOT_FOREGROUND: '目标窗口不在前台且无法恢复，已停止以避免点错位置',
  TARGET_POINT_OCCLUDED: '点击位置上不是目标窗口（被其它窗口覆盖），已停止以避免点错位置',
  NATIVE_INPUT_FAILED: '无法移动鼠标到目标坐标',
  WORKER_EXCEPTION: '点击 worker 执行失败',
  WORKER_START_FAILED: '点击 worker 启动失败',
  WORKER_PAYLOAD_INVALID: '点击 worker 载荷解析失败'
};

fs.mkdirSync(debugDir, { recursive: true });
if (fs.existsSync(legacyDebugPath)) {
  try {
    const legacyLines = fs.readFileSync(legacyDebugPath, 'utf8').split('\n').filter(Boolean);
    for (let offset = 0; offset < legacyLines.length; offset += 10) {
      const index = Math.floor(offset / 10) + 1;
      fs.writeFileSync(path.join(debugDir, `debug-${String(index).padStart(3, '0')}.log`), legacyLines.slice(offset, offset + 10).join('\n') + '\n');
    }
    fs.unlinkSync(legacyDebugPath);
  } catch { /* keep the legacy file if migration is interrupted */ }
}
const debugLog = createDebugLog ? ((log) => (event, details = {}) => {
  debugWriteQueue = log(event, details);
  return debugWriteQueue;
})(createDebugLog(debugDir)) : (event, details = {}) => {
  debugWriteQueue = debugWriteQueue.then(() => fs.promises.appendFile(path.join(debugDir, 'debug-001.log'), `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`)).catch(() => {});
  return debugWriteQueue;
};
if (profileStore.error) debugLog('profiles.load_error', { message: profileStore.error });

function publicRun(run) {
  return {
    runId: run.runId,
    status: run.status,
    completed: run.completed,
    total: run.total,
    loop: run.loop,
    pointIndex: run.pointIndex,
    pointClickIndex: run.pointClickIndex || 0,
    loopId: run.loopId || '',
    loopLabel: run.loopLabel || '',
    iteration: run.iteration || 0,
    repeatCount: run.repeatCount || 0,
    stepId: run.stepId || '',
    stepLabel: run.stepLabel || '',
    phase: run.phase || '',
    remainingMs: run.remainingMs || 0,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt
  };
}

function isTerminal(run) {
  return Boolean(run) && TERMINAL_STATUSES.has(run.status);
}

function updateRun(run, patch) {
  const previousStatus = run.status;
  Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  if (previousStatus !== run.status) recordHistory(run);
}

function recordHistory(run) {
  history.save({ ...publicRun(run), profileName: run.profileName, windowTitle: run.windowTitle,
    endedAt: isTerminal(run) ? run.updatedAt : null });
}

function retainRun(run) {
  clearTimeout(run.retentionTimer);
  run.retentionTimer = setTimeout(() => {
    if (runs.get(run.runId) === run && isTerminal(run)) runs.delete(run.runId);
  }, RUN_RETENTION_MS);
  if (run.retentionTimer.unref) run.retentionTimer.unref();
}

function cleanupRun(run) {
  if (run.forceStopTimer) clearTimeout(run.forceStopTimer);
  if (run.controlPath) {
    try { fs.unlinkSync(run.controlPath); } catch { /* the worker may have removed it */ }
  }
  run.child = null;
  if (activeRunId === run.runId) activeRunId = null;
  retainRun(run);
}

function setRunError(run, code, message) {
  if (isTerminal(run)) return;
  const resolvedMessage = WORKER_ERROR_MESSAGES[code] || message;
  updateRun(run, { status: 'error', errorCode: code, errorMessage: resolvedMessage });
  debugLog('run.error', { runId: run.runId, code, message: resolvedMessage });
}

function forceStopRun(run) {
  if (!run.child || run.closed || isTerminal(run)) return;
  const pid = Number(run.child.pid);
  if (!pid) return;
  debugLog('run.force_stop', { runId: run.runId, pid });
  execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      debugLog('run.force_stop_error', { runId: run.runId, pid, message: error.message, stdout: stdout || '', stderr: stderr || '' });
      try { run.child.kill(); } catch { /* process may already have exited */ }
    }
  });
}

function finishRun(run, code, signal) {
  if (run.closed) return;
  run.closed = true;
  if (!isTerminal(run)) {
    if (run.stopRequested || run.status === 'stopping') {
      updateRun(run, { status: 'stopped' });
    } else if (code === 0) {
      updateRun(run, { status: 'completed', completed: run.total });
    } else if (code === 10) {
      setRunError(run, 'TARGET_WINDOW_CLOSED', '目标窗口已关闭');
    } else {
      setRunError(run, 'WORKER_EXITED', `点击 worker 异常退出（代码 ${code ?? 'unknown'}${signal ? `，信号 ${signal}` : ''}）`);
    }
  }
  debugLog('run.exit', { runId: run.runId, code, signal, status: run.status });
  cleanupRun(run);
}

function handleWorkerEvent(run, event) {
  if (!event || typeof event.type !== 'string' || run.closed) return;
  const type = event.type;
  if (type === 'started') {
    updateRun(run, { status: run.stopRequested ? 'stopping' : 'running', total: Number(event.total) || run.total, errorCode: null, errorMessage: null });
  } else if (type === 'progress') {
    const completed = Math.max(0, Math.min(run.total, Number(event.completed) || 0));
    updateRun(run, {
      status: run.stopRequested ? 'stopping' : 'running',
      completed,
      loop: Number.isFinite(Number(event.loop)) ? Number(event.loop) : run.loop,
      pointIndex: Number.isFinite(Number(event.stepIndex)) ? Number(event.stepIndex) : Number.isFinite(Number(event.pointIndex)) ? Number(event.pointIndex) : run.pointIndex,
      pointClickIndex: Number(event.pointClickIndex) || 0
    });
  } else if (type === 'position') {
    updateRun(run, {
      status: run.stopRequested ? 'stopping' : 'running',
      loop: Number(event.loop) || run.loop,
      loopId: String(event.loopId || run.loopId || ''),
      loopLabel: String(event.loopLabel || run.loopLabel || ''),
      iteration: Number(event.iteration) || 0,
      repeatCount: Number(event.repeatCount) || 0,
      stepId: String(event.stepId || run.stepId || ''),
      stepLabel: String(event.stepLabel || run.stepLabel || ''),
      phase: String(event.phase || run.phase || ''),
      remainingMs: Number(event.remainingMs) || 0
    });
  } else if (type === 'paused') {
    if (!run.stopRequested) updateRun(run, { status: 'paused' });
  } else if (type === 'resumed') {
    if (!run.stopRequested) updateRun(run, { status: 'running' });
  } else if (type === 'completed') {
    updateRun(run, { status: 'completed', completed: run.total, loop: run.loops, pointIndex: -1 });
  } else if (type === 'stopped') {
    updateRun(run, { status: 'stopped' });
  } else if (type === 'diagnostic') {
    debugLog('run.input_diagnostic', {
      runId: run.runId,
      rect: event.rect || null,
      capture: event.capture || null,
      point: event.point || null,
      screen: event.screen || null
    });
  } else if (type === 'error') {
    const code = String(event.code || 'WORKER_ERROR');
    const message = String(event.message || '点击 worker 执行失败');
    setRunError(run, code, message);
    if (code === 'WORKER_EXCEPTION') debugLog('run.worker_exception_detail', { runId: run.runId, message });
  }
}

function parseWorkerLine(run, text) {
  const trimmed = String(text).trim();
  if (!trimmed) return;
  try {
    handleWorkerEvent(run, JSON.parse(trimmed));
  } catch (error) {
    debugLog('run.worker_output_parse_error', { runId: run.runId, message: error.message, line: trimmed.slice(0, 1000) });
  }
}

// 按换行切分缓冲区；最后一段可能是半行，留在缓冲区里等下一个 chunk。
function drainWorkerLines(run) {
  const lines = run.stdoutBuffer.split(/\r?\n/);
  run.stdoutBuffer = lines.pop() || '';
  for (const line of lines) parseWorkerLine(run, line);
}

function parseWorkerOutput(run, chunk) {
  run.stdoutBuffer += chunk;
  drainWorkerLines(run);
}

// 退出时把最后一条没有换行结尾的记录也处理掉。
// 不能把缓冲区再拼一次交给 parseWorkerOutput —— 那会把残行拼两遍、必然解析失败。
function flushWorkerOutput(run) {
  const residual = run.stdoutBuffer;
  run.stdoutBuffer = '';
  if (residual.trim()) parseWorkerLine(run, residual);
}

function writeControl(run, command) {
  if (!run.controlPath || run.closed) return false;
  try {
    fs.writeFileSync(run.controlPath, command, 'utf8');
    return true;
  } catch (error) {
    debugLog('run.control_write_error', { runId: run.runId, command, message: error.message });
    return false;
  }
}

const windowsScript = String.raw`
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WindowInfo {
  public string Handle { get; set; }
  public string Title { get; set; }
  public int ProcessId { get; set; }
  public int Left { get; set; }
  public int Top { get; set; }
  public int Right { get; set; }
  public int Bottom { get; set; }
}
public static class WindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<WindowInfo> GetWindows() {
    var list = new List<WindowInfo>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var length = GetWindowTextLength(hWnd);
      if (length < 1) return true;
      var title = new StringBuilder(length + 1);
      GetWindowText(hWnd, title, title.Capacity);
      RECT rect;
      if (!GetWindowRect(hWnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
      int pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (IsIconic(hWnd)) return true;
      list.Add(new WindowInfo { Handle = hWnd.ToInt64().ToString(), Title = title.ToString(), ProcessId = pid, Left = rect.Left, Top = rect.Top, Right = rect.Right, Bottom = rect.Bottom });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
try { if (-not [WindowApi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) { $null = [WindowApi]::SetProcessDPIAware() } } catch { $null = [WindowApi]::SetProcessDPIAware() }
[WindowApi]::GetWindows() | ConvertTo-Json -Compress
`;

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': res.__corsOrigin || serverOrigin });
  if (status === 204) return res.end();
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

// RV-02：写操作的唯一授权判断。token 由 main.js 在启动 server 时通过环境变量下发，
// 并经由 preload 只交给本应用的渲染进程；任何第三方页面都拿不到它。
function authorized(req) {
  if (!serverToken) return allowInsecureWrites;
  return String(req.headers['x-mouseclik-token'] || '') === serverToken;
}

// RV-02：Host 校验拦掉 DNS rebinding（攻击域名解析到 127.0.0.1 时 Host 头仍是攻击域名）。
function hostAllowed(req) {
  return HOST_PATTERN.test(String(req.headers.host || ''));
}

function findWindow(windowId, callback) {
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript], { windowsHide: true, maxBuffer: 2_000_000 }, (error, stdout) => {
    if (error) return callback(error);
    try {
      const parsed = stdout.trim() ? JSON.parse(stdout) : [];
      const windows = Array.isArray(parsed) ? parsed : [parsed];
      callback(null, windows.find((window) => String(window.Handle) === String(windowId)));
    } catch (parseError) { callback(parseError); }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      // RV-09：只 destroy() 不会触发 'error'，await 会永久挂起；这里先 reject 再排空，
      // 让上层能正常回 400，连接不会悬挂。
      if (body.length > MAX_BODY_BYTES) {
        settled = true;
        body = '';
        reject(new Error('请求体过大'));
        req.resume();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', (error) => { if (settled) return; settled = true; reject(error); });
  });
}

function listWindows(res) {
  debugLog('windows.request', { origin: res.__requestOrigin || '', url: '/api/windows' });
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript], { windowsHide: true, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
    if (error) {
      debugLog('windows.powershell_error', { message: error.message, stderr: stderr || '', code: error.code || null });
      return send(res, 500, { error: `无法读取 Windows 窗口：${stderr || error.message}` });
    }
    try {
      const parsed = stdout.trim() ? JSON.parse(stdout) : [];
      const windows = Array.isArray(parsed) ? parsed : [parsed];
      debugLog('windows.success', { count: windows.length, stdoutLength: stdout.length });
      send(res, 200, windows);
    } catch (parseError) {
      debugLog('windows.parse_error', { message: parseError.message, stdout: stdout.slice(0, 1000) });
      send(res, 500, { error: `窗口列表解析失败：${parseError.message}` });
    }
  });
}

function startNativeRun(res, payload) {
  const fallbackClickType = clickType(payload.defaultClickType ?? payload.clickType, DEFAULT_CLICK_TYPE);
  const sourceSteps = Array.isArray(payload.steps) ? payload.steps : pointsToSteps(payload.points).map((step) => step.type === 'click' ? { ...step, clickType: fallbackClickType } : step);
  const loops = Math.max(1, Math.min(MAX_LOOPS, Math.round(Number(payload.loops) || 1)));
  const loopInterval = Math.max(0, Math.min(MAX_LOOP_INTERVAL, Number(payload.loopInterval) || 0));
  const windowId = String(payload.windowId || '');
  if (startingRun || (activeRunId && !isTerminal(runs.get(activeRunId)))) return send(res, 409, { error: '已有运行任务，请先停止当前任务' });
  if (!/^\d+$/.test(windowId) || !sourceSteps.some((step) => step?.type !== 'delay')) return send(res, 400, { error: '目标窗口或点击步骤无效' });
  let safeSteps;
  try {
    safeSteps = require('../renderer/point-settings').validateTree(sourceSteps, { running: true, fallbackClickType });
  } catch (error) { return send(res, 400, { error: error.message }); }
  const total = totalClicks(safeSteps, loops);
  startingRun = true;
  findWindow(windowId, (error, target) => {
    startingRun = false;
    if (error) return send(res, 500, { error: '目标窗口验证失败' });
    if (!target) return send(res, 404, { error: '目标窗口已关闭或不可用，请刷新窗口列表' });
    const runId = randomUUID();
    const controlPath = path.join(debugDir, `.run-${runId}.control`);
    const now = new Date().toISOString();
    const run = {
      runId,
      status: 'starting',
      profileName: String(payload.profileName || '').slice(0, 120),
      windowTitle: String(target.Title || '').slice(0, 300),
      completed: 0,
      total,
      loop: 0,
      pointIndex: -1,
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      updatedAt: now,
      loops,
      child: null,
      controlPath,
      stdoutBuffer: '',
      stopRequested: false,
      closed: false,
      forceStopTimer: null,
      retentionTimer: null
    };
    try { fs.writeFileSync(controlPath, 'run', 'utf8'); } catch (controlError) {
      debugLog('run.control_create_error', { runId, message: controlError.message });
      return send(res, 500, { error: '运行控制通道创建失败' });
    }
    const workerPayload = JSON.stringify({
      runId,
      windowId,
      targetProcessId: Number(target.ProcessId) || 0,
      steps: safeSteps,
      loops,
      loopInterval,
      captureWidth: Math.max(1, Math.min(10000, Number(payload.captureWidth) || 1920)),
      captureHeight: Math.max(1, Math.min(10000, Number(payload.captureHeight) || 1080)),
      // RV-08：单击上限由 point-settings.js 单一下发，worker 不再自带 999 副本。
      maxPointClicks: MAX_POINT_CLICKS,
      jitter: Boolean(payload.jitter),
      controlPath
    });
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', workerPath, workerPayload], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnError) {
      setRunError(run, 'WORKER_START_FAILED', `无法启动点击 worker：${spawnError.message}`);
      cleanupRun(run);
      return send(res, 500, { error: run.errorMessage });
    }
    run.child = child;
    runs.set(runId, run);
    recordHistory(run);
    activeRunId = runId;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => parseWorkerOutput(run, chunk));
    child.stderr.on('data', (chunk) => debugLog('run.worker_stderr', { runId, text: String(chunk).slice(0, 2000) }));
    child.once('error', (childError) => {
      setRunError(run, 'WORKER_START_FAILED', `点击 worker 发生错误：${childError.message}`);
    });
    child.once('close', (code, signal) => {
      if (run.stdoutBuffer.trim()) flushWorkerOutput(run);
      finishRun(run, code, signal);
    });
    debugLog('run.started', { runId, pid: child.pid, total: run.total, windowId, targetProcessId: target.ProcessId });
    send(res, 200, { runId, status: run.status, total: run.total });
  });
}

function controlRun(runId, action) {
  const run = runs.get(String(runId));
  if (!run) return { ok: false, status: 404, body: { error: '运行任务不存在或已过期' } };
  if (action === 'stop') {
    if (isTerminal(run)) return { ok: true, status: 200, body: publicRun(run) };
    run.stopRequested = true;
    updateRun(run, { status: 'stopping' });
    writeControl(run, 'stop');
    if (!run.forceStopTimer) {
      run.forceStopTimer = setTimeout(() => forceStopRun(run), STOP_GRACE_MS);
      if (run.forceStopTimer.unref) run.forceStopTimer.unref();
    }
    debugLog('run.stop_requested', { runId: run.runId });
    return { ok: true, status: 200, body: publicRun(run) };
  }
  if (action === 'pause' || action === 'resume') {
    if (isTerminal(run) || run.stopRequested) return { ok: false, status: 409, body: { error: '运行任务当前不可暂停或继续', ...publicRun(run) } };
    if (!writeControl(run, action)) return { ok: false, status: 500, body: { error: '运行控制命令发送失败' } };
    return { ok: true, status: 200, body: publicRun(run) };
  }
  return { ok: false, status: 400, body: { error: '不支持的运行控制命令' } };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const origin = String(req.headers.origin || '');
  res.__requestOrigin = origin;
  // RV-03：CORS 必须在任何路由分派之前算好。过去 /api/health 与 /api/history 在 CORS 赋值前
  // 就 return 了，send() 只能落到硬编码旧端口的兜底值 —— 换个端口就只有这两个功能被浏览器拦下。
  // RV-02：file:// 直开（origin 为字面量 "null"）不再默认信任，需要显式开关。
  res.__corsOrigin = origin === 'null'
    ? (allowFileOrigin ? 'null' : serverOrigin)
    : LOCAL_ORIGIN_PATTERN.test(origin) ? origin : serverOrigin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': res.__corsOrigin, 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-MouseClik-Token' });
    return res.end();
  }
  // RV-02：不信任调用方。先验 Host（挡住 DNS rebinding），再验写权限（挡住本机网页的简单请求）。
  if (!hostAllowed(req)) {
    debugLog('request.bad_host', { host: String(req.headers.host || ''), url: url.pathname });
    return send(res, 403, { error: 'Forbidden' });
  }
  if (req.method !== 'GET' && !authorized(req)) {
    debugLog('request.unauthorized', { method: req.method, url: url.pathname, origin });
    return send(res, 403, { error: '未授权的本机请求：缺少有效的访问凭据' });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, {
    app: 'mouseclik', version: require('../../package.json').version, authorized: authorized(req)
  });
  if (req.method === 'GET' && url.pathname === '/api/history') return send(res, 200, {
    entries: history.entries.map((entry) => {
      const run = runs.get(entry.runId);
      return run ? { ...entry, ...publicRun(run) } : entry;
    }), error: history.error
  });
  if (req.method === 'POST' && url.pathname === '/api/debug') {
    try {
      const body = await readBody(req);
      debugLog('client.' + String(body.event || 'unknown'), { details: body.details || {}, userAgent: req.headers['user-agent'] || '' });
      return send(res, 204, null);
    } catch (error) { debugLog('client.debug_error', { message: error.message }); return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/profiles') return send(res, 200, { profiles: profileStore.profiles, active: profileStore.active, error: profileStore.error });
  if (req.method === 'PUT' && url.pathname === '/api/profiles') {
    try {
      profileStore.save(await readBody(req));
      if (profileStore.error) return send(res, 500, { error: profileStore.error });
      return send(res, 200, { profiles: profileStore.profiles, active: profileStore.active });
    } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/windows') return listWindows(res);
  if (req.method === 'POST' && url.pathname === '/api/run') {
    try { return startNativeRun(res, await readBody(req)); } catch (error) { return send(res, 400, { error: error.message }); }
  }
  const statusMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/status$/);
  if (req.method === 'GET' && statusMatch) {
    const run = runs.get(decodeURIComponent(statusMatch[1]));
    return run ? send(res, 200, publicRun(run)) : send(res, 404, { error: '运行任务不存在或已过期' });
  }
  const controlMatch = url.pathname.match(/^\/api\/run\/([^/]+)\/control$/);
  if (req.method === 'POST' && controlMatch) {
    try {
      const body = await readBody(req);
      const result = controlRun(decodeURIComponent(controlMatch[1]), String(body.action || '').toLowerCase());
      return send(res, result.status, result.body);
    } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    try {
      const body = await readBody(req);
      const result = controlRun(String(body.runId || ''), 'stop');
      if (!result.ok && result.status === 404) return send(res, 200, { stopped: true, status: 'stopped' });
      return send(res, result.status, result.body);
    } catch (error) { return send(res, 400, { error: error.message }); }
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  let requested;
  try { requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return send(res, 400, { error: 'Bad request' }); }
  const filePath = path.resolve(root, `.${requested}`);
  // RV-01：包含判断必须带路径分隔符 —— 缺分隔符时 D:\MouseClick-evil\ 这种**同级兄弟目录**
  // 会通过 startsWith 检查。同时只回源界面自己用到的这几个文件，源码（server.js /
  // profile-store.js / package.json / native-click-worker.ps1）不再能被 HTTP 下载。
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (filePath !== root && !filePath.startsWith(rootPrefix)) return send(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const ext = path.extname(filePath).toLowerCase();
  if (!STATIC_ALLOWLIST.has(requested) || !Object.prototype.hasOwnProperty.call(types, ext)) return send(res, 404, { error: 'Not found' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': types[ext] });
  fs.createReadStream(filePath).pipe(res);
}

http.createServer((req, res) => handle(req, res).catch((error) => send(res, 500, { error: error.message }))).listen(port, '127.0.0.1', () => {
  console.log(`MouseClik running at http://127.0.0.1:${port}`);
});

function stopAllRuns() {
  for (const run of runs.values()) {
    if (!isTerminal(run) && run.child?.pid) {
      updateRun(run, { status: 'stopped' });
      try {
        execFileSync('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        try { run.child.kill(); } catch { /* process may already have exited */ }
      }
    }
  }
}

process.once('SIGINT', () => { stopAllRuns(); process.exit(0); });
process.once('SIGTERM', () => { stopAllRuns(); process.exit(0); });
process.parentPort?.on('message', ({ data }) => {
  if (data?.type === 'shutdown') { stopAllRuns(); process.exit(0); }
});
