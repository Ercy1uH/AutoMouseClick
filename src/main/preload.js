const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mouseclikDesktop', {
  // RV-02：本地服务的写操作需要凭据，token 只在主进程与渲染进程之间传递。
  getServerToken: () => ipcRenderer.invoke('server:auth').catch(() => null),
  setCaptureWindow: (windowHandle, windowTitle) => ipcRenderer.invoke('capture:set-window', {
    windowHandle: String(windowHandle || ''),
    windowTitle: String(windowTitle || '')
  }).then((result) => Boolean(result?.ok)),
  getCaptureSource: () => ipcRenderer.invoke('capture:get-source'),
  setHotkeyConfig: (config) => ipcRenderer.invoke('hotkeys:set-config', config),
  onHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('mouseclik:hotkey', listener);
    return () => ipcRenderer.removeListener('mouseclik:hotkey', listener);
  },
  onHotkeyStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('mouseclik:hotkey-status', listener);
    return () => ipcRenderer.removeListener('mouseclik:hotkey-status', listener);
  },
  onCaptureDiagnostic: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, diagnostic) => callback(diagnostic);
    ipcRenderer.on('mouseclik:capture-diagnostic', listener);
    return () => ipcRenderer.removeListener('mouseclik:capture-diagnostic', listener);
  },
  sendRunState: (state) => ipcRenderer.send('run-state:update', state),
  setFloatingEnabled: (enabled) => ipcRenderer.send('floating:set-enabled', Boolean(enabled)),
  toggleFloating: () => ipcRenderer.send('floating:toggle'),
  floatingAction: (action) => ipcRenderer.send('floating:action', String(action || '')),
  onFloatingAction: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('mouseclik:floating-action', listener);
    return () => ipcRenderer.removeListener('mouseclik:floating-action', listener);
  },
  onFloatingState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('mouseclik:floating-state', listener);
    return () => ipcRenderer.removeListener('mouseclik:floating-state', listener);
  },
  onFloatingSettings: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('mouseclik:floating-settings', listener);
    return () => ipcRenderer.removeListener('mouseclik:floating-settings', listener);
  }
});
