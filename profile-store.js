const fs = require('node:fs');
const path = require('node:path');
const { requireStepSettings, sanitizeStepSettings, resolveLabelAuto, pointsToSteps, legacyInterval, clickType, applyAutoLabels, MAX_POINT_CLICKS, MAX_STEPS, MAX_CLICK_STEPS, MAX_LOOPS, MAX_LOOP_INTERVAL, DEFAULT_CLICK_TYPE } = require('./point-settings');
const SCHEMA_VERSION = 4, MIN_SCHEMA_VERSION = 1, MAX_PROFILES = 8, MAX_LABEL = 80;
function clampNumber(value, min, max, fallback) { const number = Number(value); if (!Number.isFinite(number)) return fallback; return Math.max(min, Math.min(max, Math.round(number))); }
function sanitizeStep(step, fallbackClickType, fallbackDelayMs) {
  if (!step || typeof step !== 'object') return null;
  if (step.type === 'delay') { const settings = sanitizeStepSettings(step, fallbackClickType, fallbackDelayMs); return settings ? { type: 'delay', ms: settings.ms } : null; }
  const x = Number(step.x), y = Number(step.y); if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 9999 || y < 0 || y > 9999) return null;
  const label = typeof step.label === 'string' ? step.label.trim().slice(0, MAX_LABEL) : ''; const settings = sanitizeStepSettings(step, fallbackClickType, fallbackDelayMs); if (!settings) return null;
  return { type: 'click', x, y, label, labelAuto: resolveLabelAuto(step, label), clickType: settings.clickType, clickCount: settings.clickCount };
}
function requireStep(step, fallbackClickType) {
  if (!step || typeof step !== 'object') throw new Error('步骤无效'); const settings = requireStepSettings(step, fallbackClickType);
  if (settings.type === 'delay') return settings;
  const x = Number(step.x), y = Number(step.y); if (!Number.isInteger(x) || x < 0 || x > 9999) throw new Error('x 必须是 0–9999 范围内的整数'); if (!Number.isInteger(y) || y < 0 || y > 9999) throw new Error('y 必须是 0–9999 范围内的整数');
  const label = typeof step.label === 'string' ? step.label.trim().slice(0, MAX_LABEL) : ''; return { type: 'click', x, y, label, labelAuto: resolveLabelAuto(step, label), clickType: settings.clickType, clickCount: settings.clickCount };
}
function limitSteps(steps) { const result = []; let clicks = 0; for (const step of steps) { if (result.length >= MAX_STEPS) break; if (step.type === 'click' && ++clicks > MAX_CLICK_STEPS) continue; result.push(step); } return applyAutoLabels(result); }
function sanitizeProfile(profile, index, strict = false) {
  const fallbackClickType = clickType(profile.defaultClickType ?? profile.clickType, DEFAULT_CLICK_TYPE);
  const legacyPoints = (Array.isArray(profile.points) ? profile.points : []).map((point) => ({ ...point, intervalAfterMs: point.intervalAfterMs === undefined ? legacyInterval(profile.pointInterval) : point.intervalAfterMs }));
  const source = Array.isArray(profile.steps) ? profile.steps : pointsToSteps(legacyPoints);
  const steps = limitSteps(strict ? source.map((step) => requireStep(step, fallbackClickType)) : source.map((step) => sanitizeStep(step, fallbackClickType, legacyInterval(profile.pointInterval))).filter(Boolean));
  const name = typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim().slice(0, 80) : `配置 ${String(index + 1).padStart(2, '0')}`; const clickCount = steps.filter((step) => step.type === 'click').length;
  return { name, note: typeof profile.note === 'string' ? profile.note.slice(0, 120) : `${clickCount} 个坐标点`, steps, defaultClickType: fallbackClickType, loops: clampNumber(profile.loops, 1, MAX_LOOPS, 1), loopInterval: clampNumber(profile.loopInterval, 0, MAX_LOOP_INTERVAL, 500) };
}
function sanitizeProfiles(list, strict = false) { return (Array.isArray(list) ? list : []).filter((profile) => profile && typeof profile === 'object').map((profile, index) => sanitizeProfile(profile, index, strict)).slice(0, MAX_PROFILES); }
function sanitizeActive(active, profiles) { const index = Number(active); return Number.isInteger(index) ? Math.max(0, Math.min(profiles.length - 1, index)) : 0; }
function pointClicks(step) { return step?.type === 'delay' ? 0 : requireStepSettings(step).clickCount; }
function totalClicks(steps, loops) { const rounds = clampNumber(loops, 1, MAX_LOOPS, 1); return (Array.isArray(steps) ? steps : []).reduce((sum, step) => sum + pointClicks(step), 0) * rounds; }
class ProfileStore {
  constructor(file) { this.file = file; this.profiles = []; this.active = 0; this.error = null; try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < MIN_SCHEMA_VERSION || data.schemaVersion > SCHEMA_VERSION || !Array.isArray(data.profiles)) throw new Error('Invalid profile store'); this.profiles = sanitizeProfiles(data.profiles); this.schemaVersion = SCHEMA_VERSION; this.active = sanitizeActive(data.active, this.profiles); if (data.schemaVersion < SCHEMA_VERSION) { this.migrationVersion = data.schemaVersion; try { this.write(); } catch { this.error = '配置升级失败，原配置未修改'; } } } catch (error) { if (error.code !== 'ENOENT') { const quarantined = this.quarantine(); this.error = quarantined ? `配置读取失败，原文件已备份为 ${path.basename(quarantined)}，已回退默认配置` : '配置读取失败，原文件保留在磁盘上（未能备份），已回退默认配置'; } } }
  // RV-06：读不出来的文件必须先隔离再回退。否则磁盘上还留着那份"读不了"的原文件，用户任何一次
  // 无关编辑都会触发保存，把它永久变成内置默认配置 —— 数据丢失且不可逆。
  quarantine() { try { const target = `${this.file}.corrupt-${Date.now()}.json`; fs.renameSync(this.file, target); return target; } catch { return null; } }
  save(payload) { let profiles, active; try { profiles = sanitizeProfiles(payload?.profiles, true); active = sanitizeActive(payload?.active, profiles); } catch (error) { this.error = error.message; throw error; } this.profiles = profiles; this.active = active; try { this.write(); this.error = null; } catch { this.error = '配置保存失败，请检查数据目录权限'; } return this.profiles; }
  write() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.tmp`; try { fs.writeFileSync(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, active: this.active, profiles: this.profiles }), { encoding: 'utf8', flush: true }); if (this.migrationVersion) { const backup = path.join(path.dirname(this.file), `profiles.v${this.migrationVersion}.backup.json`); if (!fs.existsSync(backup)) fs.copyFileSync(this.file, backup, fs.constants.COPYFILE_EXCL); } fs.renameSync(temp, this.file); this.migrationVersion = null; } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; } }
}
module.exports = { ProfileStore, pointClicks, totalClicks, sanitizeStep, SCHEMA_VERSION, MAX_POINT_CLICKS };
