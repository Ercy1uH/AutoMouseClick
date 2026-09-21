const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
// Only reviewed source files belong in the export. New files require an explicit entry.
const files = [
  '.gitattributes', '.gitignore', 'README.md', 'package.json', 'package-lock.json',
  'src/renderer/app.js', 'src/core/debug-log.js', 'src/renderer/floating.css', 'src/renderer/floating.html', 'src/renderer/floating.js',
  'src/renderer/index.html', 'src/main/main.js', 'src/worker/native-click-worker.ps1', 'src/renderer/point-settings.js',
  'src/main/preload.js', 'src/core/profile-store.js', 'src/core/run-history.js', 'src/main/server.js', 'src/renderer/style.css',
  'scripts/prepare-github.cjs', 'scripts/verify-dist.cjs', 'scripts/clean-dist.cjs',
  'releases/v1.5.0.md', 'releases/BUILD_RECORD-1.5.0.md', 'releases/archive/BUILD_RECORD-1.4.2.md',
  'tests/auth.test.js', 'tests/backend.test.js', 'tests/debug-log.test.js',
  'tests/desktop.test.js', 'tests/floating.test.js', 'tests/history.test.js',
  'tests/profile-store.test.js', 'tests/startup-state.test.js',
  'tests/worker-settings.test.ps1', 'tests/loops.test.js',
  'tests/clean-dist.test.js', 'tests/verify-dist.test.js',
  'tests/http-request.cjs', 'tests/http-request.test.js',
  'tests/run-suites.cjs', 'tests/run-suites.test.js', 'tests/powershell-encoding.test.js',
  'tests/desktop/desktop-interactions.cjs',
  'tests/e2e/e2e-http.cjs', 'tests/e2e/e2e-ui.cjs',
  'tests/ui/ui-smoke.cjs', 'tests/ui/point-settings-ui.cjs',
  'tests/ui/loop-ui.cjs', 'tests/ui/loop-preview-ui.cjs', 'tests/ui/profile-floating-ui.cjs',
  'tests/manual/observer-window.ps1', 'tests/manual/steal-foreground.ps1',
  'tests/manual/verify-click-mapping.ps1', 'tests/manual/verify-clicks.ps1',
];
const checks = [
  ['private key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['API credential', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,})\b/],
  ['personal home path', /(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/home\/[^/\s"']+|\/Users\/[^/\s"']+)/i],
  ['URL credential', /https?:\/\/[^\s/@]+:[^\s/@]+@/i],
  ['literal credential', /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\r\n]{8,}["']/i],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
const fixtures = new Map([
  ['tests/auth.test.js', 'test-token-0123456789'],
]);
const upstreamContact = ['i', 'izs.me'].join('@');
const contents = new Map();
const findings = [];
for (const file of files) {
  const source = path.join(root, file);
  if (fs.realpathSync(source) !== source || !fs.lstatSync(source).isFile()) {
    throw new Error(`Export requires a regular source file: ${file}`);
  }
  const bytes = fs.readFileSync(source);
  contents.set(file, bytes);
  bytes.toString('utf8').split(/\r?\n/).forEach((line, index) => {
    for (const [label, pattern] of checks) {
      if (!pattern.test(line)) continue;
      if (label === 'literal credential' && fixtures.has(file) &&
          line.trim() === ['const TOKEN', "= '" + fixtures.get(file) + "';"].join(' ')) continue;
      // Public maintainer contact in upstream npm metadata, not a project identity.
      if (label === 'email address' && file === 'package-lock.json' &&
          line.trim().startsWith('"deprecated":') && line.includes(upstreamContact) &&
          !pattern.test(line.replace(upstreamContact, ''))) continue;
      findings.push(`${file}:${index + 1}: ${label}`);
    }
  });
}
if (findings.length) {
  console.error('Export blocked; review these possible sensitive values (contents withheld):\n' + findings.join('\n'));
  process.exitCode = 1;
} else {
  const outputRoot = path.join(root, 'github-upload');
  fs.mkdirSync(outputRoot, { recursive: true });
  if (fs.realpathSync(outputRoot) !== outputRoot) throw new Error('Export directory must not be a link');
  const output = fs.mkdtempSync(path.join(outputRoot, 'MouseClik-source-'));
  for (const [file, bytes] of contents) {
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  const manifest = [...contents].map(([file, bytes]) =>
    `${createHash('sha256').update(bytes).digest('hex')}  ${file}`).join('\n') + '\n';
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), manifest, { flag: 'wx' });
  console.log(`Exported ${contents.size} source files plus SHA256SUMS.txt to:\n${output}`);
  console.log('No Git history, local profiles, logs, dependencies or builds are included.');
  console.log('Pattern checks are a safeguard, not a guarantee; review the export before publishing.');
}
