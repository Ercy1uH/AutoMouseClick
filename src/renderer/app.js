const defaultPoints = [
  { x: 428, y: 316, label: '主按钮' },
  { x: 790, y: 316, label: '确认按钮' },
  { x: 790, y: 614, label: '提交区域' },
  { x: 428, y: 614, label: '返回入口' }
];

const pointColor = (step) => {
  const color = PointSettings.BUTTON_COLORS[step.clickType] || PointSettings.BUTTON_COLORS[PointSettings.DEFAULT_CLICK_TYPE];
  if (!locateStep(step.id)?.parent) return color;
  return '#' + color.slice(1).match(/.{2}/g).map(channel => Math.round(parseInt(channel, 16) * 0.72).toString(16).padStart(2, '0')).join('');
};
const pointColorSoft = (step) => `${pointColor(step)}6b`;

// 需求3：连续点击次数的钳制与统计（与服务端 / worker 同口径）
const MAX_POINT_CLICKS = PointSettings.MAX_POINT_CLICKS;
const RUN_WARN_CLICKS = 50000;
const normalizeClicks = (value) => PointSettings.requireStepSettings({ type: 'click', clickCount: value }).clickCount;
const sumClicks = (steps) => PointSettings.metrics(steps).clicks;

// 耗时格式化：支持超过 60 秒（10^9 次点击场景下 00:SS 会溢出）
function formatDuration(seconds) {
  const total = Math.max(1, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

// RV-03：端口只有一个权威。Electron 内是 http://127.0.0.1:28232 的同源页面（apiBase 为空），
// file:// 直开时允许用 ?api=http://127.0.0.1:<port> 指定，默认仅作本地调试用途。
const apiBase = window.location.protocol === 'file:'
  ? (new URLSearchParams(window.location.search).get('api') || 'http://127.0.0.1:8000')
  : '';

// RV-04：localStorage 脏数据（手改、旧版本残留、同源其他页面写入）曾让模块顶层的 JSON.parse
// 抛未捕获异常 → app.js 整体停止执行 → 界面完全没有交互、且没有任何提示。这里统一兜底。
function readLocal(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function readJson(key, fallback) {
  const raw = readLocal(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch {
    clientDebug('localstorage_corrupt', { key });
    try { localStorage.removeItem(key); } catch { /* 存储不可用时忽略 */ }
    return fallback;
  }
}
function readHotkeys() {
  const fallback = { runPause: 'Control+F6', stop: 'F6' };
  const stored = readJson('mouseclik.hotkeys', null);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback;
  return { runPause: String(stored.runPause || fallback.runPause), stop: String(stored.stop || fallback.stop) };
}

// RV-02：本地服务对写操作要求凭据，token 由主进程经 preload 下发；浏览器直开时取不到，
// 写请求会被服务端拒绝（这是有意的——不能再让任何本机网页操纵桌面连点）。
let serverToken = null;
const debugQueue = [];
const authHeaders = (extra = {}) => (serverToken ? { ...extra, 'X-MouseClik-Token': serverToken } : extra);
function sendDebug(payload) {
  try { fetch(`${apiBase}/api/debug`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) }).catch(() => {}); } catch { /* 诊断失败不能影响主流程 */ }
}
async function loadServerToken() {
  try { serverToken = (await window.mouseclikDesktop?.getServerToken?.()) || null; } catch { serverToken = null; }
  while (debugQueue.length) sendDebug(debugQueue.shift());
  return serverToken;
}
async function ensureServerToken() {
  // token 未就绪时先补取，避免"第一次保存 403、第二次才成功"这类时序问题。
  if (serverToken || !window.mouseclikDesktop?.getServerToken) return serverToken;
  return loadServerToken();
}

const state = {
  profiles: [
    { name: '采集流程 01', note: '4 个坐标点', points: structuredClone(defaultPoints), clickType: '左键单击', loops: 10, loopInterval: 800 },
    { name: '表单自动填写', note: '6 个坐标点', points: [{x:310,y:280,label:'输入框 01'},{x:600,y:280,label:'输入框 02'},{x:890,y:280,label:'输入框 03'},{x:310,y:510,label:'输入框 04'},{x:600,y:510,label:'输入框 05'},{x:890,y:510,label:'提交按钮'}], clickType:'左键单击', loops:1, loopInterval:500 },
    { name: '每日签到', note: '2 个坐标点', points: [{x:960,y:210,label:'签到入口'},{x:960,y:580,label:'领取奖励'}], clickType:'左键单击', loops:7, loopInterval:1200 }
  ],
  active: 0,
  running: false,
  timer: null,
  progress: 0,
  captureStream: null,
  captureSize: { width: 1920, height: 1080 },
  windows: [],
  nativeRunId: null,
  pendingRun: null,
  runStatus: 'idle',
  runSnapshot: null,
  statusPollTimer: null,
  statusPollFailures: 0,
  floatingAutoShow: readLocal('mouseclik.floatingAutoShow') !== 'false',
  hotkeys: readHotkeys(),
  listeningHotkey: null,
  persistenceReady: false
};

const $ = (id) => document.getElementById(id);
const toast = (message) => { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('show'), 2200); };
const currentProfile = () => state.profiles[state.active];
const pointHistory = new WeakMap();
let pointEditorTarget = null;
let profileNameTarget = null;

function openProfileNameEditor() {
  if (!canEditPoints()) return;
  profileNameTarget = currentProfile();
  $('profileNameInput').value = profileNameTarget.name;
  $('profileNameError').textContent = '';
  $('profileNameInput').removeAttribute('aria-invalid');
  $('profileNameEditor').showModal();
  $('profileNameInput').focus();
  $('profileNameInput').select();
}
let selectedStepId = null;
const collapsedLoops = new Set();
const expandedDuringRun = new Set();
const allSteps = (profile = currentProfile()) => PointSettings.flatten(profile.steps);
function locateStep(id) {
  const steps = currentProfile().steps;
  for (let index = 0; index < steps.length; index++) {
    if (steps[index].id === id) return { list: steps, index, step: steps[index], parent: null };
    if (steps[index].type === 'loop') {
      const child = steps[index].steps.findIndex(step => step.id === id);
      if (child >= 0) return { list: steps[index].steps, index: child, step: steps[index].steps[child], parent: steps[index] };
    }
  }
  return null;
}
function changeSequence(edit) {
  if (!canEditPoints()) return false;
  const profile = currentProfile(), original = structuredClone(profile.steps);
  try { edit(); profile.steps = PointSettings.validateTree(profile.steps); renderAll(); return true; }
  catch (error) { profile.steps = original; toast(error.message); return false; }
}
function insertStep(step) {
  return changeSequence(() => {
    const selected = locateStep(selectedStepId);
    if (step.type === 'loop') {
      const anchor = selected?.parent || selected?.step;
      const index = anchor ? currentProfile().steps.indexOf(anchor) + 1 : currentProfile().steps.length;
      currentProfile().steps.splice(index, 0, step);
      if (selected?.parent) toast('新循环已添加到当前循环之后');
    } else if (selected?.step.type === 'loop') { selected.step.steps.push(step); collapsedLoops.delete(selected.step.id); }
    else if (selected) { selected.list.splice(selected.index + 1, 0, step); if (selected.parent) collapsedLoops.delete(selected.parent.id); }
    else currentProfile().steps.push(step);
    selectedStepId = step.id;
  });
}

function canEditPoints() {
  if (['starting', 'running', 'paused', 'stopping'].includes(state.runStatus) || state.pendingRun || state.nativeRunId) { toast('请先停止执行再编辑坐标'); return false; }
  return true;
}

function normalizeProfilePoints(profile) {
  profile.defaultClickType = PointSettings.clickType(profile.defaultClickType ?? profile.clickType, PointSettings.DEFAULT_CLICK_TYPE);
  if (!Array.isArray(profile.steps)) {
    const fallbackDelay = PointSettings.legacyInterval(profile.pointInterval);
    profile.steps = PointSettings.pointsToSteps((profile.points || []).map((point) => ({ ...point, intervalAfterMs: point.intervalAfterMs === undefined ? fallbackDelay : point.intervalAfterMs })));
  }
  profile.steps = PointSettings.validateTree(profile.steps, { fallbackClickType: profile.defaultClickType });
  PointSettings.applyAutoLabels(profile.steps);
  delete profile.points; delete profile.clickType; delete profile.pointInterval;
}

function updatePoint(target, patch, profile = currentProfile()) {
  if (!canEditPoints() || profile !== currentProfile()) return false;
  // RV-15：改用索引定位，不再依赖对象引用身份。normalizeProfilePoints 每次都会把 steps 换成
  // 新数组，跨渲染残留的引用会让 includes() 为 false —— 编辑会被"静默丢弃"，没有任何提示。
  const points = allSteps(profile);
  const index = Number.isInteger(target) ? target : points.findIndex(point => point.id === target?.id || point.id === target);
  const point = points[index];
  if (!point) { clientDebug('point_update_missing', { index, patch: Object.keys(patch) }); return false; }
  try {
    const next = { ...point, ...patch };
    PointSettings.requireStepSettings(next, profile.defaultClickType);
    if (next.type === 'click' && patch.label !== undefined) next.labelAuto = false;
    Object.assign(point, next);
    PointSettings.applyAutoLabels(profile.steps);
    renderAll();
    return true;
  } catch (error) { toast(error.message); return false; }
}

function syncPointControls() {
  const locked = ['starting', 'running', 'paused', 'stopping'].includes(state.runStatus);
  $('renameProfile').disabled = locked;
  document.querySelectorAll('#pointList input, #pointList select, #pointList button:not(.loop-collapse), #addLoop, #addPoint, #addDelay, #clickType, #loopCount, #loopInterval, #addProfile').forEach((control) => { control.disabled = locked; });
  document.querySelectorAll('.point-row').forEach((row) => { row.draggable = !locked; });
}

function bindPointSettings() {
  const profile = currentProfile();
  document.querySelectorAll('[data-setting]').forEach((input) => {
    const point = allSteps(profile)[Number(input.dataset.index)];
    const field = input.dataset.setting;
    const commit = () => {
      if (!input.isConnected) return;
      const value = input.value.trim();
      try {
        if (!/^\d+$/.test(value)) throw new Error('请输入有效的整数');
        PointSettings.requireStepSettings({ ...point, [field]: Number(value) }, profile.defaultClickType);
        if (point[field] !== Number(value)) updatePoint(point, { [field]: Number(value) }, profile);
      } catch (error) { toast(error.message); }
      input.value = point[field];
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      if (event.key === 'Escape') { event.preventDefault(); input.value = point[field]; input.blur(); }
    });
  });
  document.querySelectorAll('[data-click-delta]').forEach((button) => {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      const point = allSteps(profile)[Number(button.dataset.index)];
      const value = point.clickCount + Number(button.dataset.clickDelta);
      if (value >= 1 && value <= MAX_POINT_CLICKS) updatePoint(point, { clickCount: value }, profile);
    });
  });
  syncPointControls();
}

function checkpointPoints() {
  const profile = currentProfile();
  const snapshot = JSON.stringify(profile.steps);
  let history = pointHistory.get(profile);
  if (!history) { history = { current: snapshot, undo: [], redo: [] }; pointHistory.set(profile, history); }
  else if (history.current !== snapshot) {
    history.undo.push(history.current);
    if (history.undo.length > 50) history.undo.shift();
    history.redo = []; history.current = snapshot;
  }
  $('undoPoints').disabled = !history.undo.length;
  $('redoPoints').disabled = !history.redo.length;
}

function restorePoints(direction) {
  if (!canEditPoints()) return;
  const history = pointHistory.get(currentProfile());
  if (!history?.[direction].length) return;
  history[direction === 'undo' ? 'redo' : 'undo'].push(history.current);
  history.current = history[direction].pop();
  currentProfile().steps = JSON.parse(history.current);
  renderAll();
}

function openPointEditor(index = null) {
  if (!canEditPoints()) return;
  const profile = currentProfile();
  if (index === null && allSteps(profile).filter((step) => step.type === 'click').length >= PointSettings.MAX_CLICK_STEPS) return toast('最多支持 100 个点击步骤');
  pointEditorTarget = { profile, index };
  const point = index === null ? { type: 'click', x: 0, y: 0, label: '', labelAuto: true, clickType: profile.defaultClickType, clickCount: 1 } : allSteps(profile)[index];
  $('pointEditorTitle').textContent = index === null ? '添加坐标' : '编辑坐标';
  $('pointLabel').value = point.label; $('pointX').value = point.x; $('pointY').value = point.y;
  $('pointEditor').showModal(); $('pointX').focus(); $('pointX').select();
}

async function loadHistory() {
  $('historyMessage').textContent = '正在加载';
  $('refreshHistory').disabled = true;
  try {
    const response = await fetch(`${apiBase}/api/history`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('历史记录加载失败');
    const body = await response.json();
    const names = { starting: '启动中', running: '运行中', paused: '已暂停', stopping: '停止中', stopped: '已停止', completed: '已完成', error: '异常' };
    $('historyRows').replaceChildren();
    for (const entry of body.entries) {
      const row = document.createElement('tr');
      const seconds = Math.max(0, Math.round((Date.parse(entry.endedAt || new Date().toISOString()) - Date.parse(entry.startedAt)) / 1000));
      // RV-19：v1 老记录的计数口径无法确认（点 or 动作组），只能标注，不能按当前配置倒推。
      const countNote = entry.countUnit === 'actionGroup' ? '' : '（旧版口径未确认）';
      for (const value of [new Date(entry.startedAt).toLocaleString(), `${entry.profileName || '未命名配置'} / ${entry.windowTitle || '未知窗口'}`, names[entry.status] || entry.status, `${entry.completed} / ${entry.total}${countNote}`, `${seconds} 秒`, entry.errorMessage || entry.errorCode || '']) {
        const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      }
      $('historyRows').appendChild(row);
    }
    $('historyMessage').textContent = body.error || (body.entries.length ? `最近 ${body.entries.length} 次运行` : '暂无运行记录');
  } catch (error) { $('historyMessage').textContent = error.message || '历史记录加载失败'; }
  finally { $('refreshHistory').disabled = false; }
}
const escapeHtml = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

// --- 配置持久化：启动时从后端恢复，任何修改经 renderAll/saveForm 汇集为一次防抖保存 ---
// lastPersistedProfiles 记录最近一次成功落盘（或加载）的快照：加载失败时兜底默认配置
// 不会反向覆盖磁盘数据；pagehide + keepalive 保证退出前 pending 的修改仍然送达。
let profilesSaveTimer = null;
let profilesSaveFailed = false;
let lastPersistedProfiles = '';

function profilesSnapshot() {
  return JSON.stringify({ profiles: state.profiles, active: state.active });
}

function scheduleProfilesSave() {
  if (!state.persistenceReady || profilesSnapshot() === lastPersistedProfiles) return;
  clearTimeout(profilesSaveTimer);
  profilesSaveTimer = setTimeout(saveProfiles, 400);
}

async function saveProfiles() {
  clearTimeout(profilesSaveTimer);
  profilesSaveTimer = null;
  const snapshot = profilesSnapshot();
  try {
    await ensureServerToken();
    const response = await fetch(`${apiBase}/api/profiles`, { method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }), keepalive: true, body: snapshot });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '配置保存失败');
    lastPersistedProfiles = snapshot;
    profilesSaveFailed = false;
  } catch (error) {
    clientDebug('profiles_save_error', { message: error.message });
    if (!profilesSaveFailed) { profilesSaveFailed = true; toast('配置自动保存失败，本次修改可能不会保留'); }
  }
}

window.addEventListener('pagehide', () => { if (profilesSaveTimer) saveProfiles(); });

async function loadProfiles() {
  let loaded = false;
  let loadError = '';
  try {
    const response = await fetch(`${apiBase}/api/profiles`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '配置加载失败');
    loadError = body.error || '';
    if (Array.isArray(body.profiles) && !loadError) loaded = true;
    if (Array.isArray(body.profiles) && body.profiles.length) {
      state.profiles = body.profiles;
      state.active = Number.isInteger(body.active) ? Math.max(0, Math.min(body.profiles.length - 1, body.active)) : 0;
    }
  } catch (error) { clientDebug('profiles_load_error', { message: error.message }); }
  state.profiles.forEach(normalizeProfilePoints);
  lastPersistedProfiles = profilesSnapshot();
  // RV-06：只有「服务端确实读到了配置」才允许自动保存。读取失败（文件损坏 / schemaVersion
  // 高于本版本 / 网络失败）时磁盘上还有原文件，此时任何自动保存都会用默认配置覆盖它 —— 必须停手。
  state.persistenceReady = loaded;
  if (!loaded) {
    const reason = loadError ? `原因：${loadError}` : '本轮未能读取到配置';
    clientDebug('profiles_load_degraded', { error: loadError });
    setTimeout(() => toast(`配置未能加载，已暂停自动保存（${reason}）。请先处理数据目录中的 profiles.json 后重启应用`), 300);
  }
  renderAll();
}

function targetWindowName() {
  const windowId = $('targetWindow')?.value;
  return state.windows.find((window) => String(window.Handle) === String(windowId))?.Title || '';
}

function shortcutLabel(accelerator) {
  return String(accelerator || '').split('+').map((part) => ({ Control: 'Ctrl', Command: 'Cmd', Alt: 'Alt', Shift: 'Shift', Super: 'Win', Escape: 'Esc' }[part] || part)).join(' + ');
}

function renderHotkeySettings() {
  const runPause = shortcutLabel(state.hotkeys.runPause);
  const stop = shortcutLabel(state.hotkeys.stop);
  $('runPauseShortcut').textContent = runPause;
  $('stopShortcut').textContent = stop;
  $('sidebarRunPauseShortcut').textContent = runPause;
  $('sidebarStopShortcut').textContent = stop;
  $('shortcutTip').textContent = `运行 / 暂停：${runPause} · 结束执行：${stop} · ESC 强制停止`;
}

function acceleratorFromEvent(event) {
  const key = String(event.key || '');
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Tab'].includes(key)) return '';
  const normalized = key.length === 1 ? key.toUpperCase() : key === ' ' ? 'Space' : key;
  if (!(/^F([1-9]|1[0-2])$/.test(normalized) || /^[A-Z0-9]$/.test(normalized) || ['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Left', 'Right', 'Up', 'Down'].includes(normalized))) return '';
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Command');
  if (!modifiers.length && !/^F/.test(normalized)) return '';
  return [...modifiers, normalized].join('+');
}

function captureHotkey(kind) {
  const button = kind === 'stop' ? $('stopShortcut') : $('runPauseShortcut');
  state.listeningHotkey = kind;
  button.classList.add('listening');
  button.textContent = '请按组合键';
  const handler = async (event) => {
    if (state.listeningHotkey !== kind) return;
    event.preventDefault(); event.stopPropagation();
    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) return;
    state.listeningHotkey = null;
    button.classList.remove('listening');
    const next = { ...state.hotkeys, [kind === 'stop' ? 'stop' : 'runPause']: accelerator };
    const result = await window.mouseclikDesktop?.setHotkeyConfig?.(next);
    if (!result?.ok) { toast(result?.error || '快捷键注册失败'); renderHotkeySettings(); return; }
    state.hotkeys = result.config || next;
    localStorage.setItem('mouseclik.hotkeys', JSON.stringify(state.hotkeys));
    renderHotkeySettings();
    toast('快捷键已保存');
    document.removeEventListener('keydown', handler);
  };
  document.addEventListener('keydown', handler);
  setTimeout(() => { document.removeEventListener('keydown', handler); if (state.listeningHotkey === kind) { state.listeningHotkey = null; button.classList.remove('listening'); renderHotkeySettings(); } }, 10000);
}

function publishFloatingState() {
  if (!window.mouseclikDesktop?.sendRunState) return;
  const snapshot = state.runSnapshot || {};
  const total = Number(snapshot.total) || 0;
  const completed = Number(snapshot.completed) || 0;
  window.mouseclikDesktop.sendRunState({
    status: state.runStatus || 'idle',
    profileName: currentProfile()?.name || '未选择配置',
    targetName: targetWindowName(),
    completed,
    total,
    progress: total ? completed / total * 100 : 0,
    errorMessage: snapshot.errorMessage || ''
    ,detail: runDetailText(snapshot, state.runStatus)
  });
}

function clientDebug(event, details = {}) {
  const payload = { event, details: { page: location.href, origin: location.origin, apiBase, ...details } };
  // /api/debug 也是写操作，需要凭据；token 未取到时先排队，取到后补发，避免丢掉关键诊断。
  if (!serverToken) { if (debugQueue.length < 20) debugQueue.push(payload); return; }
  sendDebug(payload);
}

async function loadWindows(showToast = false) {
  const select = $('targetWindow');
  const requestUrl = `${apiBase}/api/windows`;
  clientDebug('windows_load_start', { requestUrl, showToast });
  try {
    const response = await fetch(requestUrl, { cache: 'no-store' });
    const body = await response.text();
    clientDebug('windows_load_response', { requestUrl, status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), bodyLength: body.length, bodyPreview: body.slice(0, 300) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
    const windows = JSON.parse(body);
    const previous = select.value;
    state.windows = windows.filter((window) => window.Title && window.Right > window.Left && window.Bottom > window.Top);
    select.innerHTML = state.windows.length ? `<option value="">请选择目标窗口...</option>${state.windows.map((window) => `<option value="${window.Handle}">${escapeHtml(window.Title)} · ${window.Right - window.Left}×${window.Bottom - window.Top}</option>`).join('')}` : '<option value="">没有可用窗口</option>';
    if (state.windows.some((window) => window.Handle === previous)) select.value = previous;
    clientDebug('windows_load_success', { count: state.windows.length });
    publishFloatingState();
    if (showToast) toast(`已找到 ${state.windows.length} 个窗口`);
  } catch (error) {
    clientDebug('windows_load_error', { name: error.name, message: error.message, stack: error.stack || '' });
    select.innerHTML = '<option value="">无法读取窗口列表</option>';
    toast(`窗口列表失败：${error.message}`);
  }
}

const terminalRunStatuses = new Set(['stopped', 'completed', 'error']);
const activeRunStatuses = new Set(['starting', 'running', 'paused', 'stopping']);

function clearRunPolling() {
  if (state.statusPollTimer) clearTimeout(state.statusPollTimer);
  state.statusPollTimer = null;
}

function isRunActive() {
  return Boolean(state.pendingRun || state.nativeRunId) && activeRunStatuses.has(state.runStatus);
}

function runDetailText(run, status) {
  if (status === 'starting') return '正在连接目标窗口';
  if (status === 'stopping') return '正在停止点击 worker';
  if (status === 'paused') return `已完成 ${run.completed || 0} / ${run.total || 0} 次 · 按 F6 继续`;
  if (status === 'running') {
    const loop = Number(run.loop) || 0;
    const point = Number(run.pointIndex);
    const location = run.loopLabel ? `${run.loopLabel}：第 ${run.iteration || 0} / ${run.repeatCount || 0} 次` : '主序列';
    const action = run.phase === 'waiting' ? `等待中 · 剩余 ${run.remainingMs || 0} ms` : `${run.stepLabel || `坐标 ${point >= 0 ? point + 1 : '-'}`} 点击 ${run.pointClickIndex || 0}`;
    return `流程 ${loop} · ${location} · ${action} · ${run.completed || 0} / ${run.total || 0}`;
  }
  if (status === 'completed') return `已完成 ${run.completed || run.total || 0} / ${run.total || 0} 次`;
  if (status === 'stopped') return `已停止 · 完成 ${run.completed || 0} / ${run.total || 0} 次`;
  if (status === 'error') return run.errorMessage || '运行失败，请检查目标窗口和权限';
  return '';
}

function renderRunState(run = null) {
  const snapshot = run || state.runSnapshot || {};
  const status = run?.status || state.runStatus || 'idle';
  state.runStatus = status;
  state.runSnapshot = snapshot;
  state.running = activeRunStatuses.has(status);
  syncPointControls();
  const labels = {
    idle: '准备就绪', starting: '正在启动', running: '正在实际点击', paused: '已暂停',
    stopping: '正在停止', stopped: '已停止', completed: '运行完成', error: '运行异常'
  };
  $('runState').textContent = labels[status] || '准备就绪';
  $('runDetail').textContent = status === 'idle' ? (updateRunDetail() || $('runDetail').textContent) : runDetailText(snapshot, status);
  const total = Number(snapshot.total) || 0;
  const completed = Math.max(0, Math.min(total || Number(snapshot.completed) || 0, Number(snapshot.completed) || 0));
  state.progress = total ? completed / total * 100 : 0;
  $('progressBar').style.width = `${Math.min(100, state.progress)}%`;
  const activeVisual = status === 'running' || status === 'paused' || status === 'stopping';
  $('runButton').classList.toggle('running', activeVisual);
  $('runButton').disabled = false;
  $('runIcon').textContent = status === 'paused' ? '▶' : status === 'running' ? 'Ⅱ' : '▶';
  $('runLabel').textContent = status === 'running' ? '停止运行' : status === 'paused' ? '继续运行' : status === 'starting' ? '取消启动' : '开始运行';
  $('stateRing').classList.toggle('running', activeVisual);
  $('sideStatusDot').classList.toggle('running', activeVisual);
  $('sideStatusText').textContent = status === 'running' ? '点击中 · F6 暂停' : status === 'paused' ? '已暂停 · F6 继续' : status === 'stopping' ? '正在停止...' : status === 'error' ? '运行异常，请查看提示' : status === 'completed' ? '运行完成' : status === 'stopped' ? '已停止' : '就绪，等待开始';
  const pointIndex = Number(snapshot.pointIndex);
  document.querySelectorAll('.point-row').forEach((row) => row.classList.toggle('current', activeVisual && snapshot.stepId ? row.dataset.id === snapshot.stepId : activeVisual && pointIndex >= 0 && Number(row.dataset.step) === pointIndex));
  document.querySelectorAll('.marker').forEach((marker) => marker.classList.toggle('current', activeVisual && snapshot.stepId ? marker.dataset.id === snapshot.stepId : activeVisual && pointIndex >= 0 && Number(marker.dataset.step) === pointIndex));
  publishFloatingState();
}

function resetRunState() {
  state.nativeRunId = null;
  state.pendingRun = null;
  state.runStatus = 'idle';
  state.runSnapshot = null;
  state.progress = 0;
  clearRunPolling();
  renderRunState({ status: 'idle' });
}

function applyRunStatus(run) {
  if (!run || (state.nativeRunId && String(run.runId) !== String(state.nativeRunId))) return;
  renderRunState(run);
  if (!terminalRunStatuses.has(run.status)) return;
  const runId = state.nativeRunId;
  clearRunPolling();
  state.nativeRunId = null;
  state.pendingRun = null;
  if (run.status === 'completed') toast('实际点击完成');
  if (run.status === 'stopped') toast('已停止运行');
  if (run.status === 'error') {
    toast(run.errorMessage || '运行异常');
    if (run.errorCode === 'TARGET_WINDOW_CLOSED') {
      $('targetWindow').value = '';
      loadWindows(false);
    }
  }
}

function scheduleRunPolling(runId, delay = 220) {
  clearRunPolling();
  state.statusPollTimer = setTimeout(() => pollRunStatus(runId), delay);
}

async function pollRunStatus(runId) {
  if (String(state.nativeRunId) !== String(runId)) return;
  try {
    const response = await fetch(`${apiBase}/api/run/${encodeURIComponent(runId)}/status`, { cache: 'no-store' });
    const body = await response.json();
    if (response.status === 404) {
      applyRunStatus({ ...(state.runSnapshot || {}), runId, status: 'error', errorCode: 'RUN_NOT_FOUND', errorMessage: '运行状态已丢失，请重新启动' });
      return;
    }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    state.statusPollFailures = 0;
    applyRunStatus(body);
    if (state.nativeRunId && !terminalRunStatuses.has(body.status)) scheduleRunPolling(runId);
  } catch (error) {
    state.statusPollFailures += 1;
    clientDebug('run_status_error', { runId, failures: state.statusPollFailures, message: error.message });
    if (state.statusPollFailures === 1 || state.statusPollFailures % 5 === 0) toast('运行状态连接异常，正在重试');
    if (state.nativeRunId) scheduleRunPolling(runId, Math.min(2000, 220 * Math.max(1, state.statusPollFailures)));
  }
}

async function requestRunControl(action) {
  const runId = state.nativeRunId;
  if (!runId) return false;
  if (action === 'stop') {
    state.runStatus = 'stopping';
    renderRunState({ ...(state.runSnapshot || {}), runId, status: 'stopping' });
  }
  try {
    await ensureServerToken();
    const response = await fetch(`${apiBase}/api/run/${encodeURIComponent(runId)}/control`, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (body.status) applyRunStatus(body);
    return true;
  } catch (error) {
    clientDebug('run_control_error', { runId, action, message: error.message });
    toast(error.message || '运行控制失败');
    if (action === 'stop') renderRunState(state.runSnapshot || { status: state.runStatus });
    return false;
  }
}

function stopNativeRun() {
  if (state.pendingRun && !state.nativeRunId) {
    state.pendingRun.cancelled = true;
    state.pendingRun = null;
    resetRunState();
    return Promise.resolve(true);
  }
  return requestRunControl('stop');
}

function renderProfiles() {
  $('slotCount').textContent = `${state.profiles.length} / 8`;
  $('profileList').innerHTML = state.profiles.map((profile, index) => { const count = PointSettings.flatten(profile.steps || []).filter((step) => step.type === 'click').length; return `<button class="profile-item ${index === state.active ? 'active' : ''}" data-profile="${index}"><span class="profile-icon">${String(index + 1).padStart(2, '0')}</span><span class="profile-copy"><span class="profile-name">${escapeHtml(profile.name)}</span><span class="profile-sub">${count} 个点击步骤</span></span><span class="profile-more">···</span></button>`; }).join('');
  document.querySelectorAll('[data-profile]').forEach((button) => button.addEventListener('click', () => { if (state.running) stopRun(); state.active = Number(button.dataset.profile); renderAll(); }));
}

function renderPoints() {
  checkpointPoints();
  const points = allSteps();
  const clickCount = points.filter((step) => step.type === 'click').length;
  $('pointCount').textContent = `${points.length} 个步骤 · ${clickCount} 个点击`;
  $('pointList').innerHTML = points.length ? points.map((point, index) => point.type === 'loop' ? `<section class="loop-card" data-loop-id="${point.id}"><header draggable="true" data-loop-drag="${point.id}"><button class="loop-collapse" aria-label="折叠或展开 ${escapeHtml(point.label)}" aria-expanded="${!collapsedLoops.has(point.id)}">${collapsedLoops.has(point.id) ? '▶' : '▼'}</button><strong>${escapeHtml(point.label)}</strong><span class="loop-state"></span><label>重复 <input data-setting="repeatCount" data-index="${index}" type="number" min="1" max="100000" value="${point.repeatCount}" aria-label="重复次数"> 次</label><small>框内全部步骤执行一遍，计为一次。</small><select class="loop-menu" aria-label="循环操作"><option value="">操作…</option value="rename">重命名</option><option value="copy">复制</option><option value="up">上移</option><option value="down">下移</option><option value="dissolve">解散后取消重复</option><option value="delete">删除循环及内容</option></select></header><p class="loop-summary">重复 ${point.repeatCount} 次 · ${point.steps.filter(s => s.type === 'click').length} 个点击步骤 · ${point.steps.filter(s => s.type === 'delay').length} 个等待 · 共 ${sumClicks([point])} 次点击动作</p><div class="loop-body" ${collapsedLoops.has(point.id) ? 'hidden' : ''}></div></section>` : point.type === 'delay'
    ? `<div class="point-row delay-row" draggable="true" data-point="${index}" data-step="${index}"><span class="drag-handle">⠿</span><span class="delay-icon">◷</span><label>等待 <input data-setting="ms" data-index="${index}" type="number" min="0" max="${PointSettings.MAX_DELAY_MS}" step="1" value="${point.ms}" aria-label="等待时间"> ms</label><span class="point-actions"><button class="point-action point-up" title="上移">↑</button><button class="point-action point-down" title="下移">↓</button><button class="point-action point-remove" title="删除">×</button></span></div>`
    : `<div class="point-row click-row" draggable="true" data-point="${index}" data-step="${index}"><span class="drag-handle">⠿</span><span class="point-index" style="background:${pointColor(point)}">${String(index + 1).padStart(2,'0')}</span><span><span class="point-label">${escapeHtml(point.label)}</span><span class="point-coord">X ${String(point.x).padStart(4,'0')}　Y ${String(point.y).padStart(4,'0')}</span><span class="click-type-segments">${PointSettings.CLICK_TYPES.map((type) => `<button type="button" data-click-type="${type}" data-index="${index}" class="${point.clickType === type ? 'active' : ''}" title="${type}">${PointSettings.MARKER_NAME[type]}</button>`).join('')}</span></span><span class="click-stepper"><button data-click-delta="-1" data-index="${index}" title="减少连续点击次数">−</button><input data-setting="clickCount" data-index="${index}" type="number" min="1" max="${MAX_POINT_CLICKS}" step="1" value="${point.clickCount}" aria-label="连续点击次数"><button data-click-delta="1" data-index="${index}" title="增加连续点击次数">+</button></span><span class="point-actions"><button class="point-action point-edit" title="编辑坐标">✎</button><button class="point-action point-up" title="上移">↑</button><button class="point-action point-down" title="下移">↓</button><button class="point-action point-remove" title="删除">×</button></span></div>`).join('') : '<div class="empty-points">还没有步骤</div>';
  arrangeLoopCards(points);
  document.querySelectorAll('.point-remove').forEach((button) => button.addEventListener('click', (event) => { const item = points[Number(event.target.closest('.point-row').dataset.step)]; changeSequence(() => { const location = locateStep(item.id); location.list.splice(location.index, 1); }); }));
  document.querySelectorAll('.point-up').forEach((button) => button.addEventListener('click', (event) => movePoint(Number(event.target.closest('.point-row').dataset.step), -1)));
  document.querySelectorAll('.point-down').forEach((button) => button.addEventListener('click', (event) => movePoint(Number(event.target.closest('.point-row').dataset.step), 1)));
  document.querySelectorAll('[data-click-type]').forEach((button) => button.addEventListener('click', () => updatePoint(points[Number(button.dataset.index)], { clickType: button.dataset.clickType })));
  document.querySelectorAll('.point-edit').forEach((button) => button.addEventListener('click', (event) => openPointEditor(Number(event.target.closest('.point-row').dataset.step))));
  bindPointSettings(); setupDrag(); renderMarkers(); if (state.runStatus === 'idle') updateRunDetail();
}


function selectStep(id) {
  selectedStepId = id;
  document.querySelectorAll('.point-row').forEach(row => row.classList.toggle('selected', row.dataset.id === id));
  document.querySelectorAll('.loop-card').forEach(card => { card.classList.toggle('selected', card.dataset.loopId === id); card.querySelector('.loop-state').textContent = card.dataset.loopId === id ? '正在编辑' : ''; });
  const target = locateStep(id);
  const parent = target?.step.type === 'loop' ? target.step : target?.parent;
  $('previewHint').textContent = `新增位置：${parent ? `${parent.label} 内` : '主序列'}`;
  renderMarkers();
}
function arrangeLoopCards(points) {
  points.forEach((point, index) => {
    if (point.type === 'loop') return;
    const row = document.querySelector(`.point-row[data-step="${index}"]`);
    row.dataset.id = point.id;
    const location = locateStep(point.id);
    if (location.parent) document.querySelector(`[data-loop-id="${location.parent.id}"] .loop-body`).appendChild(row);
    row.tabIndex = 0;
    row.addEventListener('click', () => selectStep(point.id));
    row.addEventListener('focusin', () => selectStep(point.id));
  });
  document.querySelectorAll('.loop-card').forEach(card => {
    const id = card.dataset.loopId, block = locateStep(id).step;
    card.querySelector('header').addEventListener('click', () => selectStep(id));
    card.querySelector('.loop-collapse').onclick = () => { collapsedLoops.has(id) ? collapsedLoops.delete(id) : collapsedLoops.add(id); renderPoints(); };
    card.querySelector('.loop-menu').onchange = event => {
      const action = event.target.value; event.target.value = '';
      if (!action) return;
      if (action === 'up' || action === 'down') return movePoint(points.indexOf(block), action === 'up' ? -1 : 1);
      const name = action === 'rename' ? prompt('循环名称', block.label) : null;
      if (action === 'rename' && !name?.trim()) return;
      changeSequence(() => {
        const location = locateStep(id);
        if (action === 'rename') block.label = name.trim();
        if (action === 'delete') location.list.splice(location.index, 1);
        if (action === 'dissolve') location.list.splice(location.index, 1, ...block.steps);
        if (action === 'copy') { const copy = structuredClone(block); PointSettings.flatten([copy]).forEach(step => { step.id = PointSettings.newId(); }); location.list.splice(location.index + 1, 0, copy); }
      });
    };
    const body = card.querySelector('.loop-body');
    const footer = document.createElement('div'); footer.className = 'loop-footer'; footer.dataset.dropInto = id;
    footer.innerHTML = '<button type="button">＋添加点击到循环内</button><button type="button">＋添加等待到循环内</button><span>循环结束</span>';
    footer.children[0].onclick = () => { selectStep(id); addPoint(); };
    footer.children[1].onclick = () => { selectStep(id); addDelay(); };
    body.appendChild(footer);
    const after = document.createElement('button'); after.className = 'loop-after'; after.dataset.dropAfter = id; after.textContent = '＋添加后续步骤';
    after.onclick = () => { selectedStepId = id; const step = { id: PointSettings.newId(), type: 'delay', ms: PointSettings.DEFAULT_DELAY_MS }; changeSequence(() => { const location = locateStep(id); location.list.splice(location.index + 1, 0, step); selectedStepId = step.id; }); };
    card.after(after);
  });
  selectStep(selectedStepId);
}
function relocate(id, destination, beforeId = null) {
  changeSequence(() => {
    const source = locateStep(id), target = destination === 'root' ? null : locateStep(destination)?.step;
    if (!source || (target && target.type !== 'loop')) throw new Error('移动位置无效');
    if (source.step.type === 'loop' && target) throw new Error('不支持嵌套循环');
    if (beforeId === id) return;
    const [step] = source.list.splice(source.index, 1), list = target ? target.steps : currentProfile().steps;
    const index = beforeId ? list.findIndex(s => s.id === beforeId) : list.length;
    list.splice(index < 0 ? list.length : index, 0, step);
    if (target) collapsedLoops.delete(target.id);
    selectedStepId = id;
  });
}
function movePoint(index, direction) {
  const point = allSteps()[index]; if (!point) return;
  changeSequence(() => { const location = locateStep(point.id), next = location.index + direction; if (next < 0 || next >= location.list.length) return; [location.list[location.index], location.list[next]] = [location.list[next], location.list[location.index]]; });
}
function setupDrag() {
  let dragged = null;
  document.querySelectorAll('.point-row, [data-loop-drag]').forEach(row => {
    row.addEventListener('dragstart', event => { if (!canEditPoints()) return event.preventDefault(); dragged = row.dataset.id || row.dataset.loopDrag; event.dataTransfer.setData('text/plain', dragged); });
  });
  document.querySelectorAll('.point-row, [data-drop-into], [data-drop-after], [data-loop-drag]').forEach(row => {
    row.addEventListener('dragover', event => { event.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      event.preventDefault(); event.stopPropagation(); row.classList.remove('drop-target'); if (!dragged) return;
      if (row.dataset.dropInto) relocate(dragged, row.dataset.dropInto);
      else if (row.dataset.dropAfter) { const location = locateStep(row.dataset.dropAfter); relocate(dragged, 'root', location.list[location.index + 1]?.id); }
      else { const location = locateStep(row.dataset.id || row.dataset.loopDrag); relocate(dragged, location.parent?.id || 'root', location.step.id); }
      dragged = null;
    });
  });
}
function getCaptureSize() { return state.captureSize || { width: 1920, height: 1080 }; }

// 需求1：预览区标记拖动改坐标 —— 拖动中只改内联样式（不重渲染、不触发保存），松手才写回并经 renderAll 落盘
const MARKER_DRAG_THRESHOLD_PX = 3;   // 小于该位移视为"点击"而非"拖动"

function setupMarkerDrag(area, marker, stepId, size) {
  marker.addEventListener('pointerdown', (event) => {
    if (!canEditPoints()) return;                       // 运行中禁止编辑（复用既有守卫，含暂停态）
    if (event.button !== 0) return;                     // 只响应主键
    event.preventDefault();                             // 阻止文本选择 / 原生拖拽启动
    event.stopPropagation();                            // 阻止冒泡到 .screen-content（area.onclick 守卫仍兜底）
    marker.setPointerCapture(event.pointerId);
    marker.classList.add('dragging');
    checkpointPoints();                                 // 拖动前打一次快照，可整体撤销
    const profile = currentProfile();

    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const rect = () => area.getBoundingClientRect();    // 每次实时读取，避免尺寸变化后坐标跳变
    const toRatio = (clientX, clientY) => {
      const box = rect();
      return {
        ratioX: Math.max(0, Math.min(1, (clientX - box.left) / box.width)),
        ratioY: Math.max(0, Math.min(1, (clientY - box.top) / box.height))
      };
    };

    const move = (moveEvent) => {
      if (!moved
          && Math.abs(moveEvent.clientX - startX) < MARKER_DRAG_THRESHOLD_PX
          && Math.abs(moveEvent.clientY - startY) < MARKER_DRAG_THRESHOLD_PX) return;
      moved = true;
      const { ratioX, ratioY } = toRatio(moveEvent.clientX, moveEvent.clientY);
      marker.style.left = `${Math.max(1, Math.min(99, ratioX * 100))}%`;
      marker.style.top = `${Math.max(1, Math.min(99, ratioY * 100))}%`;
      $('cursorPosition').textContent = `X ${String(Math.round(ratioX * size.width)).padStart(4,'0')}　Y ${String(Math.round(ratioY * size.height)).padStart(4,'0')}`;
    };

    const up = (upEvent) => {
      marker.releasePointerCapture?.(upEvent.pointerId);
      marker.classList.remove('dragging');
      marker.removeEventListener('pointermove', move);
      marker.removeEventListener('pointerup', up);
      marker.removeEventListener('pointercancel', up);
      if (!moved) return;                               // 未越过阈值 = 点击，不改坐标（避免误触微调）
      const { ratioX, ratioY } = toRatio(upEvent.clientX, upEvent.clientY);
      const x = Math.max(0, Math.min(9999, Math.round(ratioX * size.width)));
      const y = Math.max(0, Math.min(9999, Math.round(ratioY * size.height)));
      if (profile !== currentProfile() || !canEditPoints()) return;
      const point = locateStep(stepId)?.step;
      if (!point || point.type !== 'click') return;
      if (point.x === x && point.y === y) return;
      point.x = x;
      point.y = y;
      renderAll();                                      // 唯一保存出口（防抖保存）
      toast(`${point.label} 已移动到 X ${x}，Y ${y}`);
    };

    marker.addEventListener('pointermove', move);
    marker.addEventListener('pointerup', up);
    marker.addEventListener('pointercancel', up);
  });
}

function renderMarkers() {
  const area = $('screenPreview').querySelector('.screen-content');
  const markers = $('markers');
  const size = getCaptureSize();
  markers.innerHTML = '';
  const steps = allSteps();
  const ordinals = PointSettings.clickOrdinals(steps);
  steps.forEach((point, index) => {
    if (point.type !== 'click') return;
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.textContent = `${PointSettings.MARKER_NAME[point.clickType]}${ordinals[index]}`;
    marker.style.left = `${Math.max(1, Math.min(99, point.x / size.width * 100))}%`;
    marker.style.top = `${Math.max(1, Math.min(99, point.y / size.height * 100))}%`;
    marker.style.background = pointColor(point);
    marker.style.boxShadow = `0 2px 6px ${pointColorSoft(point)}`;
    marker.style.setProperty('--marker-ring', pointColorSoft(point));
    marker.dataset.step = String(index);
    marker.dataset.id = point.id;
    const parent = locateStep(point.id)?.parent;
    marker.title = `${parent ? parent.label : '主序列'} / ${point.label} · X${point.x} Y${point.y}${point.clickCount > 1 ? ` · ×${normalizeClicks(point.clickCount)}` : ''}　（可拖动调整位置）`;
    marker.addEventListener('click', (event) => { event.stopPropagation(); toast(`坐标 ${index + 1}：X ${point.x}，Y ${point.y}${point.clickCount > 1 ? ` · 连续点击 ${normalizeClicks(point.clickCount)} 次` : ''}`); });
    setupMarkerDrag(area, marker, point.id, size);
    markers.appendChild(marker);
  });
  area.onmousemove = (event) => { const box = area.getBoundingClientRect(); const x = Math.round((event.clientX - box.left) / box.width * size.width); const y = Math.round((event.clientY - box.top) / box.height * size.height); $('cursorPosition').textContent = `X ${String(x).padStart(4,'0')}　Y ${String(y).padStart(4,'0')}`; };
  area.onclick = (event) => { if (event.target.closest('.marker')) return; const box = area.getBoundingClientRect(); const x = Math.round((event.clientX - box.left) / box.width * size.width); const y = Math.round((event.clientY - box.top) / box.height * size.height); addPoint(x, y); };
}

function setCaptureStatus(message, connected = false) {
  $('captureStatus').textContent = message;
  $('captureWindow').classList.toggle('connected', connected);
  $('captureWindow').innerHTML = connected ? '<span>■</span> 停止抓取' : '<span>▣</span> 抓取窗口';
}
function stopCapture(showToast = true) {
  if (state.captureStream) state.captureStream.getTracks().forEach((track) => track.stop());
  state.captureStream = null;
  state.captureSize = { width: 1920, height: 1080 };
  const video = $('captureVideo');
  video.pause();
  video.srcObject = null;
  $('screenPreview').classList.remove('capturing');
  $('captureEmpty').hidden = false;
  $('previewHint').textContent = '点击预览添加坐标';
  setCaptureStatus('坐标相对目标窗口左上角');
  renderMarkers();
  if (showToast) toast('已停止窗口抓取');
}
async function captureWindow() {
  if ($('captureWindow').disabled) return;
  if (state.captureStream) { stopCapture(); return; }
  const windowId = $('targetWindow').value;
  if (!windowId) { toast('请先选择实际点击目标窗口'); return; }
  const desktopCaptureAvailable = Boolean(navigator.mediaDevices?.getUserMedia && window.mouseclikDesktop?.getCaptureSource);
  const pickerAvailable = Boolean(navigator.mediaDevices?.getDisplayMedia);
  if (!desktopCaptureAvailable && !pickerAvailable) { toast('当前环境不支持窗口抓取'); return; }
  $('captureWindow').disabled = true;
  setCaptureStatus('正在连接目标窗口...');
  try {
    let captureSourceId = '';
    if (window.mouseclikDesktop?.setCaptureWindow) {
      const target = state.windows.find((window) => String(window.Handle) === String(windowId));
      const selected = await window.mouseclikDesktop.setCaptureWindow(windowId, target?.Title || '');
      if (!selected) throw new Error('目标窗口无效');
      const source = await window.mouseclikDesktop.getCaptureSource?.();
      if (!source?.ok || !source.sourceId) throw new Error(source?.error || '未找到目标窗口画面');
      captureSourceId = source.sourceId;
    }
    const stream = captureSourceId
      ? await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: captureSourceId } } })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    state.captureStream = stream;
    state.captureSize = { width: settings.width || 1920, height: settings.height || 1080 };
    track.addEventListener('ended', () => { if (state.captureStream === stream) stopCapture(false); });
    const video = $('captureVideo');
    video.srcObject = stream;
    await video.play();
    $('screenPreview').classList.add('capturing');
    $('captureEmpty').hidden = true;
    $('previewHint').textContent = '点击窗口画面添加坐标';
    setCaptureStatus(`已连接窗口 · ${state.captureSize.width} × ${state.captureSize.height}`, true);
    renderMarkers();
    toast('窗口抓取已连接');
  } catch (error) {
    if (state.captureStream) stopCapture(false);
    clientDebug('capture.error', { name: error.name, message: error.message, targetWindow: windowId });
    const message = error.name === 'NotAllowedError'
      ? '窗口捕获权限被拒绝，请重启应用后重试'
      : error.name === 'AbortError'
        ? '窗口捕获被取消或目标窗口不可用'
        : `无法抓取窗口：${error.message || '请重试'}`;
    setCaptureStatus(message);
    toast(message);
  } finally {
    $('captureWindow').disabled = false;
  }
}
function addPoint(x, y) {
  if (x === undefined || y === undefined) return openPointEditor();
  if (!canEditPoints()) return;
  const profile = currentProfile();
  if (profile.steps.filter((step) => step.type === 'click').length >= PointSettings.MAX_CLICK_STEPS) return toast('最多支持 100 个点击步骤');
  insertStep({ id: PointSettings.newId(), type: 'click', x, y, label: '', labelAuto: true, clickType: profile.defaultClickType, clickCount: 1 }); toast(`已添加坐标 X ${x}，Y ${y}`);
}
function addDelay() { const step = { id: PointSettings.newId(), type: 'delay', ms: PointSettings.DEFAULT_DELAY_MS }; if (allSteps().length >= PointSettings.MAX_STEPS) return toast('最多支持 200 个步骤'); insertStep(step); }
function addLoop() {
  const parent = locateStep(selectedStepId)?.parent;
  const loop = { id: PointSettings.newId(), type: 'loop', label: `循环 ${currentProfile().steps.filter(step => step.type === 'loop').length + 1}`, repeatCount: 1, steps: [] };
  if (!insertStep(loop)) return;
  const card = document.querySelector(`[data-loop-id="${loop.id}"]`);
  card.scrollIntoView({ block: 'center' });
  const input = card.querySelector('[data-setting="repeatCount"]');
  input.focus({ preventScroll: true });
  input.select();
  toast(parent ? `已在“${parent.label}”之后添加循环` : '已添加循环块');
}
function updateRunDetail() { const p = currentProfile(); const clickSteps = p.steps.filter((step) => step.type === 'click'); const clicks = sumClicks(p.steps); const waits = p.steps.reduce((sum, step) => sum + (step.type === 'delay' ? step.ms : 0), 0); const repeatWaits = (clicks - clickSteps.length) * 50; const doubleWaits = clickSteps.filter((step) => step.clickType === PointSettings.DOUBLE_CLICK).reduce((sum, step) => sum + step.clickCount * 50, 0); const seconds = (100 + (waits + repeatWaits + doubleWaits) * p.loops + p.loopInterval * Math.max(0, p.loops - 1)) / 1000; const text = `共 ${p.steps.length} 步 · ${clicks * Math.max(1, p.loops)} 次点击 · 预计 ${formatDuration(seconds)}`; $('runDetail').textContent = text; return text; }
function renderAll() { const p = currentProfile(); normalizeProfilePoints(p); $('profileTitle').textContent = p.name; $('clickType').value = p.defaultClickType; $('loopCount').value = p.loops; $('loopInterval').value = p.loopInterval; renderProfiles(); renderPoints(); publishFloatingState(); scheduleProfilesSave(); }
function saveForm() {
  const p = currentProfile();
  p.defaultClickType = $('clickType').value;
  // RV-07：前端按与服务端同一上限钳制，并把"被修正过"这件事明确告诉用户，避免出现
  // 「界面按 50 万次估算、实际只跑 10 万次」这种界面与执行结果不一致的情况。
  const rawLoops = Math.max(1, Number($('loopCount').value) || 1);
  const rawInterval = Math.max(0, Number($('loopInterval').value) || 0);
  p.loops = Math.min(PointSettings.MAX_LOOPS, Math.round(rawLoops));
  p.loopInterval = Math.min(PointSettings.MAX_LOOP_INTERVAL, rawInterval);
  const clamped = p.loops !== rawLoops || p.loopInterval !== rawInterval;
  $('loopCount').value = p.loops;
  $('loopInterval').value = p.loopInterval;
  // RV-11：note 是持久化字段（将来导入的备注也走它），不能每次保存都改写成自动摘要。
  if (typeof p.note !== 'string' || !p.note.trim()) p.note = `${p.steps.filter((step) => step.type === 'click').length} 个坐标点`;
  updateRunDetail();
  if (!state.persistenceReady) { toast('配置未能加载，已暂停自动保存，请先处理数据文件'); return; }
  scheduleProfilesSave();
  toast(clamped ? `超出上限，已调整为 ${p.loops} 次 / ${p.loopInterval} ms` : '配置已保存');
}
function stopRun() {
  if (!state.pendingRun && !state.nativeRunId) return resetRunState();
  stopNativeRun();
}

function toggleRunFromHotkey() {
  if (state.pendingRun || state.runStatus === 'starting') return stopRun();
  if (!state.nativeRunId) return startRun();
  if (state.runStatus === 'paused') return requestRunControl('resume');
  if (state.runStatus === 'running') return requestRunControl('pause');
}

function handleRunButton() {
  if (state.pendingRun || state.runStatus === 'starting') return stopRun();
  if (state.runStatus === 'running') return stopRun();
  if (state.runStatus === 'paused') return requestRunControl('resume');
  if (!state.nativeRunId) return startRun();
}

async function startRun() {
  if (state.pendingRun || state.nativeRunId) return;
  if (!currentProfile().steps.some((step) => step.type === 'click')) { toast('请先添加至少一个点击步骤'); return; }
  const windowId = $('targetWindow').value;
  if (!windowId) { toast('请先选择实际点击目标窗口'); return; }
  saveForm();
  const profile = currentProfile();
  // 需求3 护栏：总点击量超过阈值时二次确认（10ms 间隔下 50000 次 ≈ 8.3 分钟，多为误设）
  const estimatedTotal = sumClicks(profile.steps) * Math.max(1, profile.loops);
  if (estimatedTotal > RUN_WARN_CLICKS &&
      !confirm(`本次运行预计点击 ${estimatedTotal.toLocaleString()} 次，可能耗时很长。确认开始？`)) return;
  const token = { cancelled: false };
  state.pendingRun = token;
  renderRunState({ status: 'starting', completed: 0, total: estimatedTotal, pointIndex: -1 });
  try {
    await ensureServerToken();
    const captureSize = getCaptureSize();
    const response = await fetch(`${apiBase}/api/run`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ profileName: profile.name, windowId, steps: profile.steps, loops: profile.loops, loopInterval: profile.loopInterval, jitter: $('jitterToggle').classList.contains('active'), captureWidth: captureSize.width, captureHeight: captureSize.height }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '原生点击启动失败');
    if (state.pendingRun !== token || token.cancelled) { fetch(`${apiBase}/api/stop`, { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ runId: result.runId }) }).catch(() => {}); return; }
    state.pendingRun = null;
    state.nativeRunId = result.runId;
    state.runStatus = result.status || 'starting';
    state.runSnapshot = { runId: result.runId, status: state.runStatus, completed: 0, total: result.total || estimatedTotal, pointIndex: -1 };
    state.statusPollFailures = 0;
    renderRunState(state.runSnapshot);
    scheduleRunPolling(result.runId, 80);
  } catch (error) {
    if (state.pendingRun === token) state.pendingRun = null;
    if (!token.cancelled) {
      renderRunState({ status: 'idle' });
      toast(error.message || '原生点击启动失败');
    }
  }
}

 $('addPoint').addEventListener('click', () => addPoint()); $('addDelay').addEventListener('click', addDelay); $('pickPoint').addEventListener('click', () => { $('pickHint').innerHTML = '<span class="hint-icon">⌖</span> 选择模式已开启，请点击右侧预览中的位置添加坐标点'; $('screenPreview').classList.add('pick-active'); toast('选择模式已开启'); }); $('clearPoints').addEventListener('click', () => { if (currentProfile().steps.length && confirm('确定清空全部步骤？')) { currentProfile().steps = []; renderAll(); toast('已清空步骤序列'); } }); $('clearDelays').addEventListener('click', () => { const profile = currentProfile(); if (profile.steps.some((step) => step.type === 'delay') && confirm('确定清空全部延迟？')) { profile.steps = profile.steps.filter((step) => step.type !== 'delay'); renderAll(); toast('已清空全部延迟'); } }); $('saveProfile').addEventListener('click', saveForm); $('runButton').addEventListener('click', handleRunButton);
// RV-05：「按序点击」从来没接进执行载荷（server/worker 都不读它），却默认高亮并承诺"严格按顺序
// 执行"——界面在说谎。在实现 F05 之前先把它禁用并说明，避免用户以为关掉就会随机执行。
$('orderToggle').addEventListener('click', () => toast('该开关尚未实现，当前始终按序列顺序执行')); $('jitterToggle').addEventListener('click', (event) => event.currentTarget.classList.toggle('active')); $('showFloating').addEventListener('click', () => { window.mouseclikDesktop?.toggleFloating(); }); $('floatingToggle').classList.toggle('active', state.floatingAutoShow); $('floatingToggle').addEventListener('click', (event) => { state.floatingAutoShow = event.currentTarget.classList.toggle('active'); localStorage.setItem('mouseclik.floatingAutoShow', String(state.floatingAutoShow)); window.mouseclikDesktop?.setFloatingEnabled(state.floatingAutoShow); toast(state.floatingAutoShow ? '后台悬浮控制条已开启' : '后台悬浮控制条已关闭'); });
$('runPauseShortcut').addEventListener('click', () => captureHotkey('runPause'));
$('stopShortcut').addEventListener('click', () => captureHotkey('stop'));
$('resetRunPauseShortcut').addEventListener('click', () => captureHotkey('runPause'));
$('resetStopShortcut').addEventListener('click', () => captureHotkey('stop'));
$('captureWindow').addEventListener('click', captureWindow);
$('refreshWindows').addEventListener('click', () => loadWindows(true));
  $('targetWindow').addEventListener('change', () => { if (state.captureStream) stopCapture(false); publishFloatingState(); });
 $('addProfile').addEventListener('click', () => { if (state.profiles.length >= 8) return toast('最多支持 8 个配置'); const index = state.profiles.length + 1; state.profiles.push({ name:`新建配置 ${String(index).padStart(2,'0')}`, note:'0 个坐标点', steps:[], defaultClickType:'左键单击', loops:1, loopInterval:500 }); state.active = state.profiles.length - 1; renderAll(); toast('已创建新配置'); }); $('duplicateProfile').addEventListener('click', () => { if (state.profiles.length >= 8) return toast('最多支持 8 个配置'); const copy = structuredClone(currentProfile()); copy.name = `${copy.name} 副本`; state.profiles.push(copy); state.active = state.profiles.length - 1; renderAll(); toast('已复制当前配置'); }); $('deleteProfile').addEventListener('click', () => { if (state.profiles.length === 1) return toast('至少保留一个配置'); state.profiles.splice(state.active, 1); state.active = Math.max(0, state.active - 1); renderAll(); toast('配置已删除'); }); ['clickType','loopCount','loopInterval'].forEach((id) => $(id).addEventListener('change', saveForm));
 function setupHotkeys() {
   if (window.mouseclikDesktop?.onHotkey) {
     window.mouseclikDesktop.onHotkey((action) => {
       if (action === 'toggle') toggleRunFromHotkey();
       if (action === 'stop' && (state.pendingRun || state.nativeRunId)) stopRun();
       if (action === 'pause' && state.runStatus === 'running') requestRunControl('pause');
     });
  window.mouseclikDesktop.onHotkeyStatus((status) => {
       if (status?.config) { state.hotkeys = status.config; renderHotkeySettings(); }
       if (status?.failed?.length) toast(`全局快捷键注册失败：${status.failed.map((item) => typeof item === 'string' ? item : `${item.accelerator}（${item.reason}）`).join('、')}`);
     });
   }
   if (window.mouseclikDesktop?.onFloatingAction) {
     window.mouseclikDesktop.onFloatingAction((action) => {
       clientDebug('floating_action', { action, status: state.runStatus, hasPendingRun: Boolean(state.pendingRun), runId: state.nativeRunId });
       if (action === 'pause' && state.runStatus === 'running') requestRunControl('pause');
       if (action === 'start') {
         if (state.runStatus === 'paused') requestRunControl('resume');
         else if (!state.pendingRun && !state.nativeRunId) startRun();
       }
       if (action === 'stop' && (state.pendingRun || state.nativeRunId)) stopRun();
     });
   window.mouseclikDesktop.setFloatingEnabled(state.floatingAutoShow);
   window.mouseclikDesktop.setHotkeyConfig?.(state.hotkeys).then((result) => {
     if (result?.ok) { state.hotkeys = result.config || state.hotkeys; localStorage.setItem('mouseclik.hotkeys', JSON.stringify(state.hotkeys)); renderHotkeySettings(); }
     else { state.hotkeys = result?.config || state.hotkeys; localStorage.setItem('mouseclik.hotkeys', JSON.stringify(state.hotkeys)); toast(result?.error || '快捷键注册失败'); renderHotkeySettings(); }
   });
   }
   document.addEventListener('keydown', (event) => {
     if (!window.mouseclikDesktop && event.key === 'Escape' && (state.running || state.pendingRun)) stopRun();
   });
}
if (window.mouseclikDesktop?.onCaptureDiagnostic) {
  window.mouseclikDesktop.onCaptureDiagnostic((diagnostic) => {
    clientDebug('capture.main_diagnostic', diagnostic || {});
    if (diagnostic?.message) toast(diagnostic.message);
  });
}
$('renameProfile').addEventListener('click', openProfileNameEditor);
$('cancelProfileName').addEventListener('click', () => $('profileNameEditor').close());
$('profileNameEditor').addEventListener('close', () => { profileNameTarget = null; });
$('profileNameForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!canEditPoints() || profileNameTarget !== currentProfile()) return;
  const name = $('profileNameInput').value.trim();
  if (!name || name.length > 80) {
    $('profileNameError').textContent = '请输入 1–80 个字符的配置名称';
    $('profileNameInput').setAttribute('aria-invalid', 'true');
    $('profileNameInput').focus();
    return;
  }
  profileNameTarget.name = name;
  $('profileNameEditor').close();
  renderAll();
  toast('配置名称已更新');
});
$('addLoop').addEventListener('click', addLoop);
$('undoPoints').addEventListener('click', () => restorePoints('undo'));
$('redoPoints').addEventListener('click', () => restorePoints('redo'));
$('cancelPoint').addEventListener('click', () => $('pointEditor').close());
$('pointForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!canEditPoints() || !pointEditorTarget || currentProfile() !== pointEditorTarget.profile) return;
  const x = Number($('pointX').value), y = Number($('pointY').value), label = $('pointLabel').value.trim();
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 9999 || y > 9999 || !label) return toast('请输入有效的整数坐标和标签');
  const { profile, index } = pointEditorTarget;
  if (index === null) insertStep({ id: PointSettings.newId(), type: 'click', x, y, label, labelAuto: false, clickType: profile.defaultClickType, clickCount: 1 }); else updatePoint(allSteps(profile)[index], { x, y, label, labelAuto: false }, profile);
  $('pointEditor').close(); renderAll();
});
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
    event.preventDefault(); restorePoints(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
  }
});
const historyButton = document.createElement('button');
historyButton.className = 'secondary-button'; historyButton.id = 'showHistory'; historyButton.textContent = '运行历史';
$('showFloating').parentElement.appendChild(historyButton);
historyButton.addEventListener('click', () => { $('historyDialog').showModal(); loadHistory(); });
$('refreshHistory').addEventListener('click', loadHistory);
$('closeHistory').addEventListener('click', () => $('historyDialog').close());
// Capture phase prevents existing row actions from mutating an executing profile.
for (const id of ['pointList', 'clearPoints']) $(id).addEventListener('click', (event) => {
  if (!canEditPoints()) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
$('pointList').addEventListener('dragstart', (event) => { if (!canEditPoints()) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
$('pointList').addEventListener('drop', (event) => { if (!canEditPoints()) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
// RV-07 / RV-08：上限统一由 point-settings.js 注入 DOM，HTML 里不再各自复制一份常量。
$('loopCount').min = '1'; $('loopCount').max = String(PointSettings.MAX_LOOPS);
$('loopInterval').min = '0'; $('loopInterval').max = String(PointSettings.MAX_LOOP_INTERVAL);
loadServerToken();
setupHotkeys();
renderAll();
loadProfiles();
loadWindows();
