const fs = require('node:fs');
const path = require('node:path');

class RunHistory {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.error = null;
    this.writeBlocked = false;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.some((item) => !item || typeof item.runId !== 'string' || typeof item.status !== 'string')) throw new Error('Invalid history');
      this.entries = data.entries.slice(0, 100);
      for (const item of this.entries) {
        if (!['completed', 'stopped', 'error'].includes(item.status)) {
          Object.assign(item, { status: 'error', errorCode: 'APP_INTERRUPTED', errorMessage: '应用意外退出，执行已中断', endedAt: item.updatedAt });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        let quarantined = null;
        try { quarantined = `${this.file}.corrupt-${Date.now()}.json`; fs.renameSync(this.file, quarantined); } catch { quarantined = null; }
        this.error = quarantined ? `历史记录读取失败，原文件已隔离为 ${path.basename(quarantined)}` : '历史记录读取失败，原文件保留在磁盘上';
        this.writeBlocked = !quarantined;
      }
    }
  }

  save(entry) {
    this.entries = [entry, ...this.entries.filter((item) => item.runId !== entry.runId)].slice(0, 100);
    if (this.writeBlocked) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ schemaVersion: 1, entries: this.entries }), { encoding: 'utf8', flush: true });
      fs.renameSync(`${this.file}.tmp`, this.file);
      this.error = null;
    } catch { this.error = '历史记录保存失败，请检查数据目录权限'; }
  }
}

module.exports = { RunHistory };
