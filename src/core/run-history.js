const fs = require('node:fs');
const path = require('node:path');

// RV-19：历史文件有独立的 schema 版本，与配置（profile-store 的 SCHEMA_VERSION = 4）互不相干，
// 不要为了"统一"把两者合并。v1 → v2 只改一件事：completed / total 的计数单位从「点数」改为
// 「点击动作组数」（一个点可以带 clickCount 次点击，也可能只是 delay）。
const SCHEMA_VERSION = 2;
const MIN_SCHEMA_VERSION = 1;
const COUNT_UNIT_ACTION_GROUP = 'actionGroup';
// 合法 v1 记录无法证明当年统计的是点还是动作组：保留原始数字，只标注口径未确认。
// 禁止一律按动作组解读，也禁止按当前配置倒推换算。
const COUNT_UNIT_UNCONFIRMED = 'unconfirmed';

function usableEntry(item) {
  return Boolean(item) && typeof item.runId === 'string' && typeof item.status === 'string';
}

// v2 里只有明确的 actionGroup 才算"已确认的新口径"。unconfirmed、字段缺失、拼错、任意值
// 一律按未确认处理 —— 格式不完整的记录不得被静默提升成动作组。
function stampCountUnit(entry, legacy) {
  const countUnit = !legacy && entry.countUnit === COUNT_UNIT_ACTION_GROUP ? COUNT_UNIT_ACTION_GROUP : COUNT_UNIT_UNCONFIRMED;
  return { ...entry, countUnit };
}

class RunHistory {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.error = null;
    this.writeBlocked = false;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < MIN_SCHEMA_VERSION || data.schemaVersion > SCHEMA_VERSION
        || !Array.isArray(data.entries) || data.entries.some((item) => !usableEntry(item))) throw new Error('Invalid history');
      const legacy = data.schemaVersion < SCHEMA_VERSION;
      this.entries = data.entries.slice(0, 100).map((item) => stampCountUnit(item, legacy));
      for (const item of this.entries) {
        if (!['completed', 'stopped', 'error'].includes(item.status)) {
          Object.assign(item, { status: 'error', errorCode: 'APP_INTERRUPTED', errorMessage: '应用意外退出，执行已中断', endedAt: item.updatedAt });
        }
      }
      // 合法 v1 走迁移，不落进损坏隔离分支。备份或写入任一步失败都保留原文件，只报错。
      if (legacy) {
        this.migrationVersion = data.schemaVersion;
        try { this.write(); } catch { this.error = '历史记录升级失败，原文件未修改'; }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const quarantined = this.quarantine();
        this.error = quarantined ? `历史记录读取失败，原文件已隔离为 ${path.basename(quarantined)}` : '历史记录读取失败，原文件保留在磁盘上';
        this.writeBlocked = !quarantined;
      }
    }
  }

  // RV-23：读不出来的文件先隔离再回退，否则用户任何一次无关运行都会把这份"读不了"的原文件覆盖掉。
  quarantine() { try { const target = `${this.file}.corrupt-${Date.now()}.json`; fs.renameSync(this.file, target); return target; } catch { return null; } }

  save(entry) {
    this.entries = [{ ...entry, countUnit: COUNT_UNIT_ACTION_GROUP }, ...this.entries.filter((item) => item.runId !== entry.runId)].slice(0, 100);
    if (this.writeBlocked) return;
    try { this.write(); this.error = null; } catch { this.error = '历史记录保存失败，请检查数据目录权限'; }
  }

  // 与 ProfileStore.write 同构：先写临时文件、再留逐字节备份、最后替换。
  // 备份或替换失败都会删掉临时文件并抛出，磁盘上的原文件保持不变。
  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, entries: this.entries }), { encoding: 'utf8', flush: true });
      if (this.migrationVersion) this.backupOriginal();
      fs.renameSync(temp, this.file);
      this.migrationVersion = null;
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* 临时文件可能尚未创建 */ }
      throw error;
    }
  }

  // 判据不是"同名备份存在"，而是"本次这个原文件确实已有一份逐字节备份"：
  // 同名文件内容相同才承认它可复用，否则换一个不冲突的名字再留一份；
  // 一份都留不下就抛错，绝不在没有备份的情况下替换原文件。
  backupOriginal() {
    const directory = path.dirname(this.file);
    const original = fs.readFileSync(this.file);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const name = attempt === 0 ? `history.v${this.migrationVersion}.backup.json` : `history.v${this.migrationVersion}.${attempt}.backup.json`;
      const target = path.join(directory, name);
      try {
        fs.copyFileSync(this.file, target, fs.constants.COPYFILE_EXCL);
        return target;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (fs.readFileSync(target).equals(original)) return target;
      }
    }
    throw new Error('无法为历史迁移创建备份');
  }
}

module.exports = { RunHistory, SCHEMA_VERSION, COUNT_UNIT_ACTION_GROUP, COUNT_UNIT_UNCONFIRMED };
