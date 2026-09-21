#!/usr/bin/env node
/*
 * 打包前置清理：只清 dist 输出目录。
 *
 * 安全规则（每条都必须先证明，再删除）：
 *  - 目标的**真实路径**（逐级解开祖先链接后）必须精确等于 <仓库根 realpath>\dist。
 *    比较按大小写敏感进行，不做无条件转小写 —— 否则在大小写敏感的目录上
 *    D:\Repo\alias\dist 与 D:\repo\dist 会被判成同一个目录而删错。
 *    （限制：本机未做 case-sensitive 目录的实盘测试，此判据的证据仅来自代码与静态结构。）
 *  - 目录身份用 dev + ino 表示，且**必须用 bigint**：Windows 的 ino 是 64 位
 *    （实测 1672805786591446987），转成 Number 会把 …987 与 …988 折成同一个值。
 *  - 只有一个破坏性动作，且**没有需要二次回收的暂存目录**：
 *      改名目标本身就是一个随机名的兄弟路径（同卷，避免 EXDEV），payload 就是它；
 *      身份核对不过 → 改回原名或原地保留，**不删除任何东西**（连空目录都不删）；
 *      身份核对通过 → 删 payload，随后确认它已消失。成功即"无任何残留"。
 *    这样就不存在"拒绝路径还要去回收暂存目录"的窗口，也不存在"回收时删到替换者"。
 *  - 重建 dist 后，用 lstat 前后两次身份比对确认它没在读目录期间被换掉，且为空
 *
 * 用法：node scripts/clean-dist.cjs [dist 路径]
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const realpath = (target) => fs.realpathSync.native(target);

function refuse(message) {
  console.error(`[clean-dist] ${message}`);
  process.exitCode = 1;
}

// 目录身份：dev+ino（bigint，避免 64 位 ino 被 Number 折叠）。改名不改变身份。
function captureIdentity(target) {
  const stat = fs.statSync(target, { bigint: true });
  if (!stat.isDirectory()) throw new Error(`不是目录：${target}`);
  return { dev: stat.dev, ino: stat.ino };
}

function identityOf(target) {
  try { return captureIdentity(target); } catch { return null; }
}

const sameIdentity = (left, right) => Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;

function tryRename(from, to) {
  try { fs.renameSync(from, to); return true; } catch { return false; }
}

// 把"验证过的目录"与"删掉的目录"尽量绑成同一个对象。
// 拒绝路径不删除任何东西 —— 包括那些看起来"反正是我们自己建的空目录"。
function deleteVerifiedDirectory(target, identity) {
  const staged = path.join(path.dirname(target), `.clean-dist-${process.pid}-${Date.now()}`);
  try {
    fs.renameSync(target, staged);
    if (!sameIdentity(identityOf(staged), identity)) {
      const restored = tryRename(staged, target);
      throw new Error(`目录身份与验证时不一致（${target}）：${restored ? '已改回原名' : `未能改回原名，内容完整保留在 ${staged}`}；未删除任何内容`);
    }
    if (fs.lstatSync(staged).isSymbolicLink()) {
      fs.unlinkSync(staged); // 只删链接本身
      throw new Error(`暂存目标是符号链接或目录联接，已只删除链接本身：${staged}`);
    }
    if (!sameIdentity(identityOf(staged), identity)) {
      const restored = tryRename(staged, target);
      throw new Error(`删除前身份发生变化（${target}）：${restored ? '已改回原名' : `内容完整保留在 ${staged}`}；未删除任何内容`);
    }
    fs.rmSync(staged, { recursive: true, force: true });
    if (fs.existsSync(staged)) throw new Error(`删除后暂存目标仍然存在（${staged}）`);
    return { staged };
  } catch (error) {
    throw error;
  }
}

// 重建后的校验：lstat 两次比对身份，确认"读目录"期间没有被换成别的目录或联接。
function verifyRecreatedDirectory(target) {
  const first = fs.lstatSync(target, { bigint: true });
  if (!first.isDirectory() || first.isSymbolicLink()) return `重建的输出目录不是普通目录：${target}`;
  const entries = fs.readdirSync(target);
  const second = fs.lstatSync(target, { bigint: true });
  if (!second.isDirectory() || second.isSymbolicLink()) return `重建的输出目录在读目录期间变成了非普通目录：${target}`;
  if (first.ino !== second.ino || first.dev !== second.dev) return `重建的输出目录在验证期间被换掉：${target}`;
  if (entries.length) return `重建的输出目录不是空的：${target}`;
  return null;
}

function clean(requested = path.resolve(root, 'dist')) {
  if (requested === root) return refuse(`拒绝清理：目标就是仓库根（${requested}）`);
  if (path.basename(requested) !== 'dist') return refuse(`拒绝清理：目标目录名必须是 dist（${requested}）`);
  if (!fs.existsSync(requested)) return console.log(`[clean-dist] 输出目录不存在，无需清理：${path.relative(root, requested)}`);
  if (!fs.lstatSync(requested).isDirectory()) return refuse(`拒绝清理：目标不是目录（${requested}）`);

  let distReal = null;
  try { distReal = realpath(requested); } catch (error) { return refuse(`拒绝清理：无法解析目标真实路径（${error.message}）`); }
  const expected = path.join(realpath(root), 'dist');
  if (distReal !== expected) return refuse(`拒绝清理：解析真实路径后不是本仓库的 dist（${distReal} ≠ ${expected}）`);
  if (fs.lstatSync(distReal).isSymbolicLink()) return refuse(`拒绝清理：dist 自身是符号链接或目录联接（${distReal}）`);

  const identity = captureIdentity(distReal);
  if (!sameIdentity(identityOf(distReal), identity)) return refuse('拒绝清理：dist 在清理开始前发生了变化，已停止');
  const entries = fs.readdirSync(distReal);
  if (!entries.length) return console.log('[clean-dist] 输出目录已经是空的');
  // 顶层出现链接就拒绝（用于决策的静态检查；安全性来自身份核对）
  for (const name of entries) {
    const entry = path.join(distReal, name);
    if (fs.lstatSync(entry).isSymbolicLink()) return refuse(`拒绝清理符号链接或目录联接（可能指向 dist 之外）：${entry}`);
  }

  try {
    deleteVerifiedDirectory(distReal, identity);
    console.log(`[clean-dist] 已清空输出目录 ${path.relative(root, distReal)}`);
  } catch (error) {
    return refuse(error.message);
  }
  fs.mkdirSync(distReal, { recursive: true });
  const recreatedFailure = verifyRecreatedDirectory(distReal);
  if (recreatedFailure) return refuse(recreatedFailure);
}

module.exports = { clean, realpath, captureIdentity, identityOf, sameIdentity, verifyRecreatedDirectory, deleteVerifiedDirectory };

if (require.main === module) clean(path.resolve(root, process.argv[2] || 'dist'));
