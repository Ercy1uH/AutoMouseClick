const { app, BrowserWindow, dialog, desktopCapturer, globalShortcut, ipcMain, screen, utilityProcess, Tray, Menu, nativeImage } = require('electron');
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVER_PORT = 28232;
const serverToken = randomBytes(32).toString('hex');
let tray = null;
let trayStatus = null;
let quitting = false;
let serverProcess = null;
let mainWindow = null;
let floatingWindow = null;
let desktopLogPath = null;
let captureWindowHandle = '';
let captureWindowTitle = '';
let registeredHotkeys = [];
let hotkeyConfig = { runPause: 'Control+F6', stop: 'F6' };
let floatingAutoShow = true;
let latestRunState = { status: 'idle' };

// Keep Chromium's profile in a writable per-user location. This also prevents a
// portable build from inheriting a locked profile left by a previous run.
const profileRoot = process.env.MOUSECLIK_PROFILE || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'MouseClik');
try { fs.mkdirSync(profileRoot, { recursive: true }); app.setPath('userData', profileRoot); } catch { /* Electron will use its default profile if this is unavailable. */ }

// A second launch must not create another backend on the fixed local port.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

// This is a 2D tool. Disable GPU before Electron creates any child process; some
// Windows installations have a broken GPU DLL chain and crash the helper.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disk-cache-size', '1');

function desktopLog(event, details = {}) {
  if (!desktopLogPath) return;
  try { fs.appendFileSync(desktopLogPath, JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n'); } catch { /* logging must not affect startup */ }
}

function reportCaptureDiagnostic(level, message, details = {}) {
  desktopLog(`capture.${level}`, { message, ...details });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mouseclik:capture-diagnostic', { level, message });
}

function handlesMatch(sourceHandle, selectedHandle) {
  try { return BigInt(String(sourceHandle)) === BigInt(String(selectedHandle)); } catch { return String(sourceHandle) === String(selectedHandle); }
}

function findCaptureSource(sources) {
  const handleMatch = sources.find((source) => {
    const match = String(source.id).match(/^window:([^:]+)(?::|$)/i);
    return match && handlesMatch(match[1], captureWindowHandle);
  });
  if (handleMatch) return { source: handleMatch, method: 'handle' };
  const titleMatches = captureWindowTitle ? sources.filter((source) => source.name === captureWindowTitle) : [];
  return titleMatches.length === 1 ? { source: titleMatches[0], method: 'title' } : { source: null, method: 'none', titleMatches: titleMatches.length };
}

function unregisterGlobalHotkeys() {
  if (!registeredHotkeys.length) return;
  for (const accelerator of registeredHotkeys) globalShortcut.unregister(accelerator);
  registeredHotkeys = [];
  desktopLog('hotkeys.unregistered');
}

function sendToRenderer(channel, payload) {
  for (const window of [mainWindow, floatingWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function showFloatingWindow() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (!floatingWindow.isVisible()) floatingWindow.showInactive();
}

function hideFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.hide();
}

function createFloatingWindow() {
  const width = 300, height = 132;
  floatingWindow = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const workArea = screen.getPrimaryDisplay().workArea;
  floatingWindow.setPosition(Math.max(workArea.x, workArea.x + workArea.width - width - 16), Math.max(workArea.y, workArea.y + workArea.height - height - 16));
  floatingWindow.setAlwaysOnTop(true, 'floating');
  floatingWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/floating.html`).catch((error) => desktopLog('floating.load_error', { message: error.message }));
  floatingWindow.on('closed', () => { floatingWindow = null; });
  floatingWindow.webContents.once('did-finish-load', () => {
    sendToRenderer('mouseclik:floating-state', latestRunState);
    sendToRenderer('mouseclik:floating-settings', {
      autoShow: floatingAutoShow,
      stopShortcut: hotkeyConfig.stop,
      runPauseShortcut: hotkeyConfig.runPause
    });
  });
}

function registerGlobalHotkeys(config = hotkeyConfig) {
  unregisterGlobalHotkeys();
  const nextConfig = {
    runPause: String(config?.runPause || hotkeyConfig.runPause),
    stop: String(config?.stop || hotkeyConfig.stop)
  };
  const failed = [];
  const seen = new Set();
  if (nextConfig.runPause.toLowerCase() === nextConfig.stop.toLowerCase()) {
    failed.push({ accelerator: nextConfig.stop, action: 'stop', reason: '运行/暂停快捷键与结束执行快捷键冲突' });
  }
  const bindings = [
    [nextConfig.runPause, 'toggle'],
    [nextConfig.stop, 'stop'],
    ['Escape', 'stop']
  ];
  for (const [accelerator, action] of bindings) {
    const key = accelerator.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (nextConfig.runPause.toLowerCase() === nextConfig.stop.toLowerCase() && action === 'stop' && key === nextConfig.stop.toLowerCase()) continue;
    try {
      const registered = globalShortcut.register(accelerator, () => {
        sendToRenderer('mouseclik:hotkey', action);
      });
      if (registered) {
        registeredHotkeys.push(accelerator);
        desktopLog('hotkey.registered', { accelerator, action });
      } else {
        failed.push({ accelerator, action, reason: '快捷键已被系统或其他软件占用' });
        desktopLog('hotkey.registration_failed', { accelerator, action });
      }
    } catch (error) {
      failed.push({ accelerator, action, reason: error.message });
      desktopLog('hotkey.registration_error', { accelerator, action, message: error.message });
    }
  }
  const customFailure = failed.some((item) => item.accelerator === nextConfig.runPause || item.accelerator === nextConfig.stop);
  if (!customFailure) hotkeyConfig = nextConfig;
  const status = { registered: registeredHotkeys, failed, config: hotkeyConfig };
  sendToRenderer('mouseclik:hotkey-status', status);
  sendToRenderer('mouseclik:floating-settings', { autoShow: floatingAutoShow, stopShortcut: hotkeyConfig.stop, runPauseShortcut: hotkeyConfig.runPause });
  return status;
}

function startServer() {
  const serverScript = path.join(__dirname, 'server.js');
  try {
    serverProcess = utilityProcess.fork(serverScript, [], {
      env: { ...process.env, PORT: String(SERVER_PORT), MOUSECLIK_DATA: app.getPath('userData'), MOUSECLIK_SERVER_TOKEN: serverToken },
      stdio: 'pipe'
    });
  } catch (error) {
    desktopLog('server.fork_error', { message: error.message, stack: error.stack || '' });
    throw error;
  }
  if (serverProcess.stdout) serverProcess.stdout.on('data', (data) => console.log(`[server] ${data}`));
  if (serverProcess.stderr) serverProcess.stderr.on('data', (data) => console.error(`[server] ${data}`));
  serverProcess.on('error', (error) => { desktopLog('server.error', { message: error.message }); console.error('[server] failed to start', error); });
  serverProcess.on('exit', (code, signal) => desktopLog('server.exit', { code, signal }));
  desktopLog('server.started', { pid: serverProcess.pid, script: serverScript, port: SERVER_PORT });
}

function stopServer() {
  unregisterGlobalHotkeys();
  if (!serverProcess) return;
  try { serverProcess.kill(); } catch (error) { desktopLog('server.stop_error', { message: error.message }); }
  serverProcess = null;
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      // RV-02：/api/health 不再把 token 明文回显给任何调用者，改为「谁带对 token 谁才拿到
      // authorized: true」。这样既保留"端口上是不是我自己那个服务"的自检，也不再泄漏凭据。
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`, {
        signal: AbortSignal.timeout(700),
        headers: { 'X-MouseClik-Token': serverToken }
      });
      if (response.ok) {
        const health = await response.json();
        if (health.app === 'mouseclik' && health.authorized === true && health.version === app.getVersion()) return true;
      }
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function createWindow() {
  desktopLogPath = path.join(app.getPath('userData'), 'desktop.log');
  desktopLog('app.start', { version: app.getVersion(), packaged: app.isPackaged, dirname: __dirname });
  startServer();
  if (!await waitForServer()) {
    desktopLog('server.timeout', { port: SERVER_PORT });
    dialog.showErrorBox('MouseClik 启动失败', `本地服务未能通过身份校验，端口 ${SERVER_PORT} 可能已被占用。请关闭冲突程序后重试。`);
    app.quit();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#eef2f1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const appSession = mainWindow.webContents.session;
  // getDisplayMedia is gated by the 'media' permission (and on some flows also
  // 'display-capture'). Chromium consults the synchronous setPermissionCheckHandler;
  // with no check handler the query defaults to DENY and the request is rejected with
  // "NotAllowedError: Permission denied" BEFORE setDisplayMediaRequestHandler ever runs,
  // so the preview can never connect. Grant both capture permissions at both layers.
  const capturePermission = (permission) => permission === 'display-capture' || permission === 'media';
  appSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (capturePermission(permission)) { desktopLog('permission.request', { permission, allowed: true }); return callback(true); }
    return callback(false);
  });
  appSession.setPermissionCheckHandler((_webContents, permission) => {
    if (capturePermission(permission)) { desktopLog('permission.check', { permission, allowed: true }); return true; }
    return false;
  });
  appSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      if (!request.videoRequested || !captureWindowHandle) {
        reportCaptureDiagnostic('rejected', '未选择有效的目标窗口');
        return callback({});
      }
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
      const result = findCaptureSource(sources);
      if (!result.source) {
        reportCaptureDiagnostic('source_missing', '未找到目标窗口的可捕获画面，请确认窗口未最小化且仍然存在', {
          windowHandle: captureWindowHandle,
          windowTitle: captureWindowTitle,
          sourceCount: sources.length,
          titleMatches: result.titleMatches || 0
        });
        return callback({});
      }
      desktopLog('capture.source_selected', { windowHandle: captureWindowHandle, sourceId: result.source.id, title: result.source.name, method: result.method });
      callback({ video: result.source });
    } catch (error) {
      reportCaptureDiagnostic('source_error', '读取可捕获窗口失败，请重试', { error: error.message, windowHandle: captureWindowHandle });
      callback({});
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/?desktop=1`).catch((error) => desktopLog('renderer.load_error', { message: error.message, code: error.code || null }));
  createFloatingWindow();
  createTray();
  registerGlobalHotkeys();
  mainWindow.webContents.on('render-process-gone', (_event, details) => desktopLog('renderer.gone', details));
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => desktopLog('renderer.load_error', { errorCode, errorDescription, validatedURL }));
  mainWindow.on('minimize', () => { if (floatingAutoShow) showFloatingWindow(); });
  mainWindow.on('hide', () => { if (floatingAutoShow) showFloatingWindow(); });
  mainWindow.on('restore', () => { if (mainWindow.isFocused()) hideFloatingWindow(); });
  mainWindow.on('focus', () => hideFloatingWindow());
  mainWindow.on('blur', () => { if (floatingAutoShow) setTimeout(() => { if (mainWindow && !mainWindow.isFocused()) showFloatingWindow(); }, 120); });
  mainWindow.on('closed', () => { unregisterGlobalHotkeys(); if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close(); mainWindow = null; });
  mainWindow.on('close', (event) => {
    if (!quitting && tray) { event.preventDefault(); mainWindow.hide(); }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  // BGRA bitmap keeps the portable tray icon independent of external assets.
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const offset = (y * 32 + x) * 4;
    const mark = x >= 12 && x <= 19 && y >= 6 && y <= 25;
    pixels.set(mark ? [255, 255, 255, 255] : [153, 168, 16, 255], offset);
  }
  try {
    tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
    tray.setToolTip('MouseClik');
    tray.on('double-click', showMainWindow);
    refreshTray();
  } catch (error) { desktopLog('tray.error', { message: error.message }); }
}

function refreshTray() {
  if (!tray) return;
  if (trayStatus === latestRunState.status) return;
  trayStatus = latestRunState.status;
  const active = ['starting', 'running', 'paused', 'stopping'].includes(latestRunState.status);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: latestRunState.status === 'paused' ? '继续执行' : active ? '暂停执行' : '开始执行', enabled: !['starting', 'stopping'].includes(latestRunState.status), click: () => sendToRenderer('mouseclik:hotkey', 'toggle') },
    { label: '停止执行', enabled: active, click: () => sendToRenderer('mouseclik:hotkey', 'stop') },
    { type: 'separator' },
    { label: '退出 MouseClik', click: () => app.quit() }
  ]));
}

// RV-02：渲染进程通过这里拿到本次启动的 token，用于给本地服务的写请求带凭据。
// 只有本应用页面能走到 IPC，第三方网页拿不到这个值。
ipcMain.handle('server:auth', () => serverToken);

ipcMain.handle('capture:set-window', (_event, target) => {
  const windowHandle = String(target?.windowHandle || '');
  captureWindowHandle = /^\d+$/.test(windowHandle) ? windowHandle : '';
  captureWindowTitle = captureWindowHandle ? String(target?.windowTitle || '') : '';
  desktopLog('capture.target_changed', { windowHandle: captureWindowHandle || null, windowTitle: captureWindowTitle || null });
  return { ok: Boolean(captureWindowHandle) };
});

ipcMain.handle('capture:get-source', async () => {
  if (!captureWindowHandle) return { ok: false, error: '未选择目标窗口' };
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });
    const result = findCaptureSource(sources);
    if (!result.source) {
      desktopLog('capture.source_missing', { windowHandle: captureWindowHandle, windowTitle: captureWindowTitle, sourceCount: sources.length, titleMatches: result.titleMatches || 0 });
      return { ok: false, error: '未找到目标窗口的可捕获画面，请确认窗口未最小化' };
    }
    desktopLog('capture.source_selected_direct', { windowHandle: captureWindowHandle, sourceId: result.source.id, title: result.source.name, method: result.method });
    return { ok: true, sourceId: result.source.id };
  } catch (error) {
    desktopLog('capture.source_error', { message: error.message, windowHandle: captureWindowHandle });
    return { ok: false, error: error.message || '读取窗口画面失败' };
  }
});

ipcMain.on('run-state:update', (_event, state) => {
  latestRunState = state && typeof state === 'object' ? state : { status: 'idle' };
  sendToRenderer('mouseclik:floating-state', latestRunState);
  refreshTray();
});

ipcMain.on('floating:set-enabled', (_event, enabled) => {
  floatingAutoShow = Boolean(enabled);
  if (!floatingAutoShow) hideFloatingWindow();
  sendToRenderer('mouseclik:floating-settings', { autoShow: floatingAutoShow });
});

ipcMain.on('floating:toggle', () => {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (floatingWindow.isVisible()) hideFloatingWindow(); else showFloatingWindow();
});

ipcMain.on('floating:action', (_event, action) => {
  desktopLog('floating.action', { action, mainWindowAvailable: Boolean(mainWindow && !mainWindow.isDestroyed()) });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mouseclik:floating-action', action);
});

ipcMain.handle('hotkeys:set-config', (_event, config) => {
  const requested = {
    runPause: String(config?.runPause || ''),
    stop: String(config?.stop || '')
  };
  if (!requested.runPause || !requested.stop) return { ok: false, error: '快捷键不能为空', config: hotkeyConfig };
  if (requested.runPause.toLowerCase() === requested.stop.toLowerCase()) return { ok: false, error: '运行/暂停快捷键不能与结束执行快捷键相同', config: hotkeyConfig };
  const previous = hotkeyConfig;
  const status = registerGlobalHotkeys(requested);
  const failedBinding = status.failed.find((item) => item.accelerator === requested.runPause || item.accelerator === requested.stop);
  if (failedBinding) {
    registerGlobalHotkeys(previous);
    return { ok: false, error: `${failedBinding.accelerator} 注册失败：${failedBinding.reason}`, config: previous, status };
  }
  return { ok: true, config: hotkeyConfig, status };
});

app.on('second-instance', () => {
  showMainWindow();
});
app.whenReady().then(() => { if (isPrimaryInstance) return createWindow(); });
app.on('window-all-closed', () => {
  // During an explicit quit the renderer closes first so pagehide can flush
  // pending profile changes while the local server is still accepting PUTs.
  if (quitting) return;
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

function shutdownServerAndQuit() {
  if (!serverProcess) return app.quit();
  const child = serverProcess;
  const timeout = setTimeout(() => { stopServer(); app.quit(); }, 4000);
  child.once('exit', () => { clearTimeout(timeout); serverProcess = null; app.quit(); });
  try { child.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timeout); stopServer(); app.quit(); }
}

app.on('before-quit', (event) => {
  if (quitting) return stopServer();
  quitting = true;
  event.preventDefault();
  if (tray) { tray.destroy(); tray = null; }
  unregisterGlobalHotkeys();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.close();
  setTimeout(shutdownServerAndQuit, 600);
});
