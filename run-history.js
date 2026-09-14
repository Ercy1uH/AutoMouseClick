const fs = require('node:fs');
const path = require('node:path');

class RunHistory {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.error = null;
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
      if (error.code !== 'ENOENT') this.error = '历史记录读取失败';
    }
  }

  save(entry) {
    this.entries = [entry, ...this.entries.filter((item) => item.runId !== entry.runId)].slice(0, 100);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ schemaVersion: 1, entries: this.entries }), 'utf8');
      fs.renameSync(`${this.file}.tmp`, this.file);
      this.error = null;
    } catch { this.error = '历史记录保存失败，请检查数据目录权限'; }
  }
}

module.exports = { RunHistory };
