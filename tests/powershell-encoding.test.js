/*
 * PowerShell 脚本的编码门禁。
 *
 * 背景：Windows PowerShell 5.1 只有在 UTF-8 BOM 下才按 UTF-8 解码脚本；
 * 没有 BOM 时按 ANSI 代码页解码，脚本里的中文常量（'右键单击' 等）会变成乱码，
 * 与命令行传来的正确中文永不相等 —— 右键/中键静默退化成左键，双击分支匹配不上，
 * 而进度照样增长。这个回归在真实机器上发生过一次（编辑脚本时把 BOM 弄丢）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scripts = [
  'src/worker/native-click-worker.ps1',
  'tests/worker-settings.test.ps1',
  'tests/manual/observer-window.ps1',
  'tests/manual/steal-foreground.ps1',
  'tests/manual/verify-clicks.ps1',
  'tests/manual/verify-click-mapping.ps1'
];

const hasBom = (file) => {
  const head = fs.readFileSync(file).subarray(0, 3);
  return head.length === 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
};

for (const script of scripts) {
  test(`${script} 必须带 UTF-8 BOM`, () => {
    const file = path.join(root, script);
    assert.ok(fs.existsSync(file), `${script} 不存在`);
    const head = fs.readFileSync(file).subarray(0, 3);
    assert.ok(hasBom(file), `${script} 缺少 UTF-8 BOM（前三字节 ${[...head].map((b) => b.toString(16)).join(' ')}）：`
      + 'PowerShell 5.1 会按 ANSI 解码，中文 clickType 常量将失配，右键/中键会静默退化成左键');
  });
}

test('worker 的中文 clickType 常量以 UTF-8 存储且能按 UTF-8 读出', () => {
  const text = fs.readFileSync(path.join(root, 'src/worker/native-click-worker.ps1'), 'utf8');
  // 左键是 Get-ClickAction 的默认返回，脚本里不出现 '左键单击' 这个字面量
  for (const literal of ['右键单击', '中键单击', '双击']) {
    assert.ok(text.includes(literal), `worker 脚本里应包含 ${literal}（按 UTF-8 读取时）`);
  }
});
