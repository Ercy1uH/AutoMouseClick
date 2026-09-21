const state = { run: { status: 'idle' } };
const $ = (id) => document.getElementById(id);
const activeStatuses = new Set(['starting', 'running', 'paused', 'stopping']);

function statusLabel(status) {
  return { idle: '准备就绪', starting: '正在启动', running: '正在执行', paused: '已暂停', stopping: '正在停止', stopped: '已停止', completed: '已完成', error: '异常' }[status] || '准备就绪';
}

function shortcutLabel(accelerator) {
  return String(accelerator || '').split('+').map((part) => ({ Control: 'Ctrl', Command: 'Cmd', Alt: 'Alt', Shift: 'Shift', Super: 'Win', Escape: 'Esc' }[part] || part)).join(' + ');
}

function render(run = state.run) {
  state.run = run || { status: 'idle' };
  const status = state.run.status || 'idle';
  const active = activeStatuses.has(status);
  $('profileName').textContent = state.run.profileName || '未选择配置';
  $('targetName').textContent = `目标：${state.run.targetName || '未选择窗口'}`;
  $('statusText').textContent = statusLabel(status);
  $('runDetail').textContent = state.run.detail || (status === 'running' ? `已完成 ${state.run.completed || 0} / ${state.run.total || 0}` : '等待开始');
  $('statusText').style.color = status === 'error' ? '#ffaaa4' : status === 'running' ? '#f3b67f' : '#75d2c2';
  $('progressBar').style.width = `${Math.max(0, Math.min(100, Number(state.run.progress) || 0))}%`;
  $('startButton').classList.toggle('running', active);
  $('startButton').classList.toggle('error', status === 'error');
  $('startButton').textContent = status === 'running' ? 'Ⅱ 暂停' : status === 'paused' ? '▶ 继续执行' : '▶ 开始执行';
  $('startButton').disabled = status === 'starting' || status === 'stopping';
  $('stopButton').disabled = !active;
}

$('startButton').addEventListener('click', () => window.mouseclikDesktop?.floatingAction(state.run.status === 'running' ? 'pause' : 'start'));
$('stopButton').addEventListener('click', () => window.mouseclikDesktop?.floatingAction('stop'));
$('hideFloat').addEventListener('click', () => window.mouseclikDesktop?.toggleFloating());
window.mouseclikDesktop?.onFloatingState(render);
window.mouseclikDesktop?.onFloatingSettings((settings) => {
  if (settings?.stopShortcut) $('stopButton').textContent = `■ 结束执行（${shortcutLabel(settings.stopShortcut)}）`;
});
render();
