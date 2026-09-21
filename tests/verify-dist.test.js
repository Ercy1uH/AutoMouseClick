const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = require(path.join(root, 'package.json'));
const script = path.join(root, 'scripts/verify-dist.cjs');

// 反例夹具：verify-dist 只有"能失败"才算证明包内载荷，否则它只是一句自我感觉良好的日志。
function fakeDist(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const packedRoot = path.join(dir, 'win-unpacked/resources/app');
  for (const file of source.build.files) {
    const target = path.join(packedRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.writeFileSync(path.join(dir, `MouseClik-${source.version}-portable.exe`), 'fake portable payload');
  return dir;
}

const verify = (distDir) => spawnSync(process.execPath, [script, distDir], { encoding: 'utf8' });
const packedPath = (dir, file) => path.join(dir, 'win-unpacked/resources/app', file);

test('a matching dist tree passes verification', (t) => {
  const result = verify(fakeDist(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified portable/);
  assert.match(result.stdout, /非 manifest 文件逐字节一致/, '输出必须说明实际比对范围');
  assert.match(result.stdout, /sha256 [0-9a-f]{64}/, '必须写出产物哈希');
});

test('a stale packaged version fails', (t) => {
  const dir = fakeDist(t);
  const manifest = JSON.parse(fs.readFileSync(packedPath(dir, 'package.json'), 'utf8'));
  manifest.version = '0.0.1';
  fs.writeFileSync(packedPath(dir, 'package.json'), JSON.stringify(manifest));
  const result = verify(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /版本/);
});

test('a packaged file that differs from source fails', (t) => {
  const dir = fakeDist(t);
  fs.appendFileSync(packedPath(dir, 'src/core/run-history.js'), '\n// stale\n');
  const result = verify(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /过期构建/);
  assert.match(result.stderr, /run-history\.js/);
});

test('a missing packaged file fails', (t) => {
  const dir = fakeDist(t);
  fs.rmSync(packedPath(dir, 'src/main/server.js'));
  const result = verify(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少文件/);
});

test('a missing or empty portable exe fails', (t) => {
  const missing = fakeDist(t);
  fs.rmSync(path.join(missing, `MouseClik-${source.version}-portable.exe`));
  const missingResult = verify(missing);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /未找到打包产物/);

  const empty = fakeDist(t);
  fs.writeFileSync(path.join(empty, `MouseClik-${source.version}-portable.exe`), '');
  const emptyResult = verify(empty);
  assert.notEqual(emptyResult.status, 0);
  assert.match(emptyResult.stderr, /空文件/);
});

test('a missing dist directory fails instead of passing silently', (t) => {
  const dir = fakeDist(t);
  fs.rmSync(dir, { recursive: true, force: true });
  const result = verify(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /打包目录不存在/);
});
