/*
 * clean-dist 的安全判据测试。
 *
 * 打包清理最容易出事的地方不是"没删掉"，而是"删错地方"：越界、祖先联接、跟随联接、
 * 把仓库当成输出目录。这里用**临时假仓库**（自己的 scripts/clean-dist.cjs + 自己的 dist）
 * 来跑，既走的是生产判据，又完全不碰真实仓库与真实 dist。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const realScript = path.resolve(__dirname, '../scripts/clean-dist.cjs');
const { captureIdentity, sameIdentity, verifyRecreatedDirectory, deleteVerifiedDirectory } = require('../scripts/clean-dist.cjs');

// 造一个"假仓库"：把 clean-dist.cjs 复制进 <fake>/scripts/，脚本就会以 <fake> 为仓库根。
function fakeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mouseclik-fakerepo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(realScript, path.join(root, 'scripts', 'clean-dist.cjs'));
  return root;
}

function run(fakeRoot, target) {
  return spawnSync(process.execPath, [path.join(fakeRoot, 'scripts', 'clean-dist.cjs'), ...(target ? [target] : [])], { encoding: 'utf8' });
}

function outsideDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('it removes old artifacts inside dist', (t) => {
  const repo = fakeRepo(t);
  const dist = path.join(repo, 'dist');
  fs.mkdirSync(path.join(dist, 'win-unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'win-unpacked', 'resources', 'app.asar'), 'old');
  fs.writeFileSync(path.join(dist, 'MouseClik-9.9.9-portable.exe'), 'old portable');
  fs.writeFileSync(path.join(dist, 'builder-debug.yml'), 'old');

  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dist), [], '输出目录里的旧产物应被清空');
  assert.equal(fs.existsSync(dist), true, '只清内容，不删 dist 目录本身');
});

test('a missing dist directory is a no-op', (t) => {
  const result = run(fakeRepo(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /无需清理/);
});

test('it refuses to clean anything outside the repository', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-outside-');
  // 目录名也必须是 dist，才轮得到"是否在仓库内"这条判据
  const outsideDist = path.join(outside, 'dist');
  fs.mkdirSync(outsideDist, { recursive: true });
  const victim = path.join(outsideDist, 'precious.txt');
  fs.writeFileSync(victim, 'must survive');

  const result = run(repo, outsideDist);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /拒绝清理：解析真实路径后不是本仓库的 dist/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'must survive', '仓库外的文件必须原样保留');
});

test('it refuses to treat the repository root as the output directory', (t) => {
  const repo = fakeRepo(t);
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  const result = run(repo, repo);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /拒绝清理：目标就是仓库根/);
  assert.equal(fs.existsSync(path.join(repo, 'package.json')), true);
});

test('it refuses a directory that is not named dist', (t) => {
  const repo = fakeRepo(t);
  const other = path.join(repo, 'not-dist');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep');
  const result = run(repo, other);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /目标目录名必须是 dist/);
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
});

test('it refuses a path that only looks like it is inside the repository', (t) => {  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-ancestor-');
  const victimDir = path.join(outside, 'dist');
  fs.mkdirSync(victimDir, { recursive: true });
  const victim = path.join(victimDir, 'precious.txt');
  fs.writeFileSync(victim, 'must survive');

  // 仓库内的 alias 联接到仓库外：alias\dist 看着在仓库里、末级也是普通目录，
  // 真实路径却在外面。只查末级是不是链接的话，这里会照删不误。
  fs.symlinkSync(outside, path.join(repo, 'alias'), 'junction');

  const result = run(repo, path.join(repo, 'alias', 'dist'));
  assert.notEqual(result.status, 0, '祖先联接必须被识破');
  assert.match(result.stderr, /拒绝清理：解析真实路径后不是本仓库的 dist/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'must survive', '联接指向的目录内容必须原样保留');
});

test('it refuses to follow a junction out of dist', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-linked-');
  const victim = path.join(outside, 'linked-file.txt');
  fs.writeFileSync(victim, 'must survive');

  const dist = path.join(repo, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.symlinkSync(outside, path.join(dist, 'linked'), 'junction');

  const result = run(repo);
  assert.notEqual(result.status, 0, '遇到联接必须拒绝，而不是照着删');
  assert.match(result.stderr, /拒绝清理符号链接或目录联接/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'must survive', '联接指向的内容必须原样保留');
});

// 身份比较必须撑得起"不同目录身份一定不同"：Windows 的 ino 是 64 位，
// 折成 Number 会把相差 1 的两个 ino 变成同一个值。
test('identity comparison keeps 64-bit inodes apart', (t) => {
  const identity = captureIdentity(fakeRepo(t));
  assert.equal(typeof identity.ino, 'bigint', 'ino 必须用 bigint 保存');
  assert.equal(typeof identity.dev, 'bigint', 'dev 必须用 bigint 保存');

  const real = 1672805786591446987n; // 实测自本机 dist
  const neighbour = 1672805786591446988n;
  assert.equal(Number(real), Number(neighbour), '前提：折成 Number 后两者相等（这就是原缺陷）');
  assert.equal(sameIdentity({ dev: 1n, ino: real }, { dev: 1n, ino: neighbour }), false, 'bigint 比较必须区分它们');
  assert.equal(sameIdentity({ dev: 1n, ino: real }, { dev: 1n, ino: real }), true);
});

// 拒绝路径绝不能删东西：连"看起来是我们自己建的空目录"也不删。
// 新设计里改名目标本身就是 payload，没有需要二次回收的暂存目录。
test('a refusal never deletes anything at all', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-refuse-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'must survive');

  const dist = path.join(repo, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'ours.txt'), 'ours');
  const identity = captureIdentity(dist);
  const moved = path.join(repo, 'dist-moved');
  fs.renameSync(dist, moved);
  fs.symlinkSync(outside, dist, 'junction');

  let message = '';
  assert.throws(() => deleteVerifiedDirectory(dist, identity), (error) => { message = error.message; return /身份与验证时不一致/.test(message); });
  assert.match(message, /未删除任何内容/);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'must survive', '链外文件必须原样保留');
  assert.equal(fs.existsSync(moved), true, '被挪走的真实目录必须原样保留');
  const stagedLeft = fs.readdirSync(repo).filter((name) => name.startsWith('.clean-dist-'));
  // 恢复原名成功后，仓库里不应再有任何 .clean-dist-* 残留
  assert.deepEqual(stagedLeft, [], '恢复原名后不应留下暂存路径');
});

// 恢复原名失败时，payload 必须原地保留，并把位置写进错误里（不能被回收掉）。
test('a refusal that cannot restore the name keeps the payload and says where', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-keep-');
  const dist = path.join(repo, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'ours.txt'), 'ours');
  const identity = captureIdentity(dist);
  fs.renameSync(dist, path.join(repo, 'dist-moved'));
  fs.symlinkSync(outside, dist, 'junction');

  // 让"改回原名"失败：目标路径上已经有东西，rename 抛错
  const originalRename = fs.renameSync;
  const rename = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to) === dist) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return originalRename(from, to);
  });
  let message = '';
  try { deleteVerifiedDirectory(dist, identity); } catch (error) { message = error.message; }
  rename.mock.restore();

  assert.match(message, /未删除任何内容/);
  const stagedLeft = fs.readdirSync(repo).filter((name) => name.startsWith('.clean-dist-'));
  assert.equal(stagedLeft.length, 1, `payload 必须原地保留，实际 ${stagedLeft.join(', ') || '无'}`);
  assert.equal(fs.readFileSync(path.join(repo, 'dist-moved', 'ours.txt'), 'utf8'), 'ours', '真实内容必须原样保留');
  assert.match(message, /内容完整保留在/, '错误信息必须写明保留位置');
  fs.rmSync(path.join(repo, stagedLeft[0]), { recursive: true, force: true });
});

// 重建后的校验：读目录期间被换成指向空目录的联接必须被发现。
test('the recreated directory check notices a swap during verification', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-swap2-');
  const dist = path.join(repo, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  assert.equal(verifyRecreatedDirectory(dist), null, '正常的空目录应通过');

  const moved = path.join(repo, 'dist-recreated');
  const originalReaddir = fs.readdirSync;
  const readdir = t.mock.method(fs, 'readdirSync', (target, ...rest) => {
    if (String(target) === dist) { fs.renameSync(dist, moved); fs.symlinkSync(outside, dist, 'junction'); }
    return originalReaddir(target, ...rest);
  });
  const failure = verifyRecreatedDirectory(dist);
  readdir.mock.restore();
  assert.match(failure || '', /被换掉|非普通目录/, '替换必须被发现');
});

test('a successful clean leaves no staging path behind', (t) => {
  const repo = fakeRepo(t);
  const dist = path.join(repo, 'dist');
  fs.mkdirSync(path.join(dist, 'win-unpacked'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'MouseClik-9.9.9-portable.exe'), 'old');
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(repo).filter((name) => name.startsWith('.clean-dist-')), [], '成功时不得留下暂存路径');
  assert.deepEqual(fs.readdirSync(dist), [], '输出目录应为空');
});

// 竞态：验证通过之后、删除之前，dist 被换成指向外部的联接。
// 删除走的是"改名进私有暂存 + 身份核对"，所以此时必须失败，且外部同名文件毫发无损。
test('it never deletes a directory that was swapped after validation', (t) => {
  const repo = fakeRepo(t);
  const outside = outsideDir(t, 'mouseclik-swap-');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'must survive');

  const dist = path.join(repo, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'precious.txt'), 'our own file');
  const identity = captureIdentity(dist);

  // 交换：把真实目录挪走，在原路径放一个指向外部的联接
  const moved = path.join(repo, 'dist-moved');
  fs.renameSync(dist, moved);
  fs.symlinkSync(outside, dist, 'junction');

  assert.throws(
    () => deleteVerifiedDirectory(dist, identity),
    /身份与验证时不一致/,
    '身份不符必须拒绝删除'
  );
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'must survive', '链外同名文件必须原样保留');
  assert.equal(fs.existsSync(moved), true, '被挪走的真实目录也不该被删');
});
