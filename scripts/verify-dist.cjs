const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = require(path.join(root, 'package.json'));
const packedRoot = path.join(root, 'dist/win-unpacked/resources/app');
const packed = JSON.parse(fs.readFileSync(path.join(packedRoot, 'package.json'), 'utf8'));
assert.equal(packed.version, source.version, 'Packaged version differs from source');
for (const file of source.build.files.filter((file) => file !== 'package.json')) {
  assert.ok(fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(packedRoot, file))), `Stale packaged file: ${file}`);
}
assert.ok(fs.statSync(path.join(root, 'dist', `MouseClik-${source.version}-portable.exe`)).size > 0);
console.log(`Verified portable ${source.version}: all packaged source files match.`);
