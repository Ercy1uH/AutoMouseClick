const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = require(path.join(root, 'package.json'));
const distRoot = path.resolve(root, process.argv[2] || 'dist');
const packedRoot = path.join(distRoot, 'win-unpacked/resources/app');
const packedManifest = path.join(packedRoot, 'package.json');
assert.ok(fs.existsSync(distRoot), `打包目录不存在：${distRoot}`);
assert.ok(fs.existsSync(packedManifest), `包内缺少 package.json：${packedManifest}`);
const packed = JSON.parse(fs.readFileSync(packedManifest, 'utf8'));
assert.equal(packed.version, source.version, `包内版本 ${packed.version} 与源码 ${source.version} 不一致`);
for (const file of source.build.files.filter((file) => file !== 'package.json')) {
  const packedFile = path.join(packedRoot, file);
  assert.ok(fs.existsSync(packedFile), `包内缺少文件：${file}`);
  assert.ok(fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(packedFile)), `包内文件与源码不一致（过期构建）：${file}`);
}
const portable = path.join(distRoot, `MouseClik-${source.version}-portable.exe`);
assert.ok(fs.existsSync(portable), `未找到打包产物：${path.basename(portable)}`);
assert.ok(fs.statSync(portable).size > 0, `打包产物是空文件：${path.basename(portable)}`);
const compared = source.build.files.filter((file) => file !== 'package.json');
// 产物哈希随构建一起留存：交付记录里引用它，才能把"被验收的 exe"钉到某一次构建上。
const digest = crypto.createHash('sha256').update(fs.readFileSync(portable)).digest('hex');
fs.writeFileSync(`${portable}.sha256`, `${digest}  ${path.basename(portable)}\n`, 'ascii');
console.log(`Verified portable ${source.version}: build.files 里 ${compared.length} 个非 manifest 文件逐字节一致，package.json 只比版本。`);
console.log(`注意：portable exe 本身只断言存在且非空与写出 sha256，未解包校验其内部载荷。`);
console.log(`sha256 ${digest}  ${path.basename(portable)}`);
