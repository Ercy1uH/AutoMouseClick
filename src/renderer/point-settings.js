(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PointSettings = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const MAX_POINT_CLICKS = 999, MAX_DELAY_MS = 600000, MAX_STEPS = 200, MAX_CLICK_STEPS = 100, MAX_LOOPS = 100000, MAX_LOOP_INTERVAL = 60000;
  const DEFAULT_DELAY_MS = 180, DEFAULT_CLICK_TYPE = '左键单击';
  const CLICK_TYPES = ['左键单击', '中键单击', '右键单击', '双击'];
  const DOUBLE_CLICK = '双击';
  const SHORT_NAME = { '左键单击': '左键', '中键单击': '中键', '右键单击': '右键', '双击': '双击' };
  const MARKER_NAME = { '左键单击': '左', '中键单击': '中', '右键单击': '右', '双击': '双' };
  const CLICK_ACTION = { '左键单击': 0, '右键单击': 1, '中键单击': 2, '双击': 0 };
  const BUTTON_COLORS = { '左键单击': '#10a899', '中键单击': '#6b7fd1', '右键单击': '#c0564f', '双击': '#d4a72c' };
  const AUTO_LABEL_PATTERN = /^坐标点\s*\d*$/;
  function integer(value, min, max, field) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${field} 必须是 ${min}–${max} 范围内的整数`);
    return value;
  }
  function legacyInterval(value) { return Number.isInteger(value) && value >= 10 && value <= 60000 ? value : DEFAULT_DELAY_MS; }
  function clickType(value, fallback = DEFAULT_CLICK_TYPE) { return CLICK_TYPES.includes(value) ? value : fallback; }
  function requireStepSettings(step, fallbackClickType = DEFAULT_CLICK_TYPE, fallbackDelayMs = DEFAULT_DELAY_MS) {
    if (!step || typeof step !== 'object') throw new Error('步骤无效');
    if (step.type === 'loop') return { type: 'loop', repeatCount: integer(step.repeatCount, 1, MAX_LOOPS, '重复次数') };
    if (step.type !== undefined && !['click', 'delay'].includes(step.type)) throw new Error(`未知步骤类型：${step.type}`);
    if (step.type === 'delay') return { type: 'delay', ms: integer(step.ms === undefined ? fallbackDelayMs : step.ms, 0, MAX_DELAY_MS, 'ms') };
    return { type: 'click', clickType: clickType(step.clickType, fallbackClickType), clickCount: integer(step.clickCount === undefined ? 1 : step.clickCount, 1, MAX_POINT_CLICKS, 'clickCount') };
  }
  function sanitizeStepSettings(step, fallbackClickType, fallbackDelayMs) { try { return requireStepSettings(step, fallbackClickType, fallbackDelayMs); } catch { return null; } }
  function resolveLabelAuto(step, label) { if (step.labelAuto === true) return true; if (step.labelAuto === false) return false; return label === '' || AUTO_LABEL_PATTERN.test(label); }
  function applyAutoLabels(steps) {
    const counters = new Map();
    for (const step of flatten(steps)) { if (!step || step.type !== 'click') continue; const short = SHORT_NAME[step.clickType] || SHORT_NAME[DEFAULT_CLICK_TYPE]; const ordinal = (counters.get(short) || 0) + 1; counters.set(short, ordinal); if (step.labelAuto) step.label = `${short}${ordinal}`; }
    return steps;
  }
  function clickOrdinals(steps) {
    const counters = new Map();
    return (Array.isArray(steps) ? steps : []).map((step) => { if (!step || step.type !== 'click') return 0; const ordinal = (counters.get(step.clickType) || 0) + 1; counters.set(step.clickType, ordinal); return ordinal; });
  }
  function pointsToSteps(points) {
    if (!Array.isArray(points)) return [];
    const steps = [];
    points.forEach((point, index) => { steps.push({ ...point, type: 'click' }); const wait = Number(point?.intervalAfterMs); if (index < points.length - 1 && Number.isFinite(wait) && wait > 0) steps.push({ type: 'delay', ms: wait }); });
    return steps;
  }
  function newId() { return globalThis.crypto?.randomUUID?.() || `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
  function flatten(steps) { return (steps || []).flatMap(step => step.type === 'loop' ? [step, ...step.steps] : [step]); }
  function metrics(steps) {
    return (steps || []).reduce((sum, step) => {
      const part = step.type === 'loop' ? metrics(step.steps) : { clicks: step.type === 'click' ? step.clickCount : 0, ms: step.type === 'delay' ? step.ms : (step.clickCount - 1) * 50 + (step.clickType === DOUBLE_CLICK ? step.clickCount * 50 : 0) };
      const multiplier = step.type === 'loop' ? step.repeatCount : 1;
      return { clicks: sum.clicks + part.clicks * multiplier, ms: sum.ms + part.ms * multiplier };
    }, { clicks: 0, ms: 0 });
  }
  function validateTree(steps, { running = false, fallbackClickType = DEFAULT_CLICK_TYPE } = {}) {
    if (!Array.isArray(steps)) throw new Error('操作序列必须是数组');
    const ids = new Set(); let nodes = 0, clicks = 0, blocks = 0;
    function visit(list, parent = '') {
      return list.map((step, index) => {
        const location = `${parent || '主序列'} / 第 ${index + 1} 步`;
        try {
          const settings = requireStepSettings(step, fallbackClickType);
          const id = step.id === undefined ? newId() : step.id;
          if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || ids.has(id)) throw new Error('步骤 ID 无效或重复');
          ids.add(id);
          if (settings.type === 'loop') {
            if (parent) throw new Error('不支持嵌套循环');
            if (++blocks > 20) throw new Error('最多支持 20 个循环块');
            if (!Array.isArray(step.steps)) throw new Error('循环内容无效');
            if (running && !step.steps.length) throw new Error('空循环不能启动');
            const label = String(step.label || `循环 ${blocks}`).trim().slice(0, 80);
            return { id, ...settings, label, steps: visit(step.steps, label) };
          }
          if (++nodes > MAX_STEPS) throw new Error('最多支持 200 个点击/等待步骤');
          if (settings.type === 'delay') return { id, ...settings };
          if (++clicks > MAX_CLICK_STEPS) throw new Error('最多支持 100 个点击步骤');
          const label = typeof step.label === 'string' ? step.label.trim().slice(0, 80) : '';
          return { id, ...settings, x: integer(step.x, 0, 9999, 'x'), y: integer(step.y, 0, 9999, 'y'), label, labelAuto: resolveLabelAuto(step, label) };
        } catch (error) { throw new Error(`${location}：${error.message}`); }
      });
    }
    const result = visit(steps);
    if (running && !clicks) throw new Error('请先添加至少一个点击步骤');
    return applyAutoLabels(result);
  }
  return { newId, flatten, metrics, validateTree, integer, legacyInterval, clickType, requireStepSettings, sanitizeStepSettings, resolveLabelAuto, applyAutoLabels, clickOrdinals, pointsToSteps, MAX_POINT_CLICKS, MAX_DELAY_MS, MAX_STEPS, MAX_CLICK_STEPS, MAX_LOOPS, MAX_LOOP_INTERVAL, DEFAULT_DELAY_MS, DEFAULT_CLICK_TYPE, CLICK_TYPES, DOUBLE_CLICK, SHORT_NAME, MARKER_NAME, CLICK_ACTION, BUTTON_COLORS, AUTO_LABEL_PATTERN };
});
