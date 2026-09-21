# 1.4.2 历史构建与验收记录

> 目的：把"被验收的 exe"钉到某一次具体构建上，避免出现"源码修好了、用户拿到的包还是旧的"
> （RV-21 的教训）。
>
> 本文件已归档至 `releases/archive/` 且**受版本控制**：`dist/` 与 `docs/` 都在 `.gitignore` 里，
> 交付材料放那里不会进提交。哈希的权威副本仍然随产物放在 `dist/` 旁边。

## 当前被验收产物

| 项 | 值 |
|---|---|
| 产物 | `dist/MouseClik-1.4.2-portable.exe` |
| 大小 | 85,252,716 字节（81.3 MB） |
| 构建时间 | 2026-09-19 22:19:07（`npm run dist`，`electron-builder` 26.15.3 / electron 38.8.6） |
| SHA-256 | `72f682af58f57967edfc868e053221f2318dd17ba703db72d61b6d0b9e6c1ba2` |
| 哈希副本 | `dist/MouseClik-1.4.2-portable.exe.sha256`（由 `verify-dist` 自动写出） |
| 打包输入的源码提交 | `973c5b4` |
| 版本 | 1.4.2（`package.json`） |

### 关于"哈希钉的是什么"

- 打包**输入**是 `973c5b4` 里的 `src/**` 与 `package.json`；本记录与 `scripts/verify-dist.cjs`
  的改动不在 `build.files` 内，不影响产物内容。
- **构建非字节可复现（本机观测，非可复核实验）**：2026-09-19 两次同源码构建分别得到
  `4ab1927c…`（21:12:46，85,252,718 字节）与 `14efbe6c…`（21:15:11，85,252,719 字节）。
  两次都只在本机执行过一次、只留了哈希前缀，没有保留产物或输入清单，
  因此这是一条**观测记录**，不能当作"已验证的可复现性实验"引用。
  结论：哈希标识的是"被验收的那一个产物"，不是源码指纹；换一次构建就要重新记录。
- 同一时期还有一次**构建前置清理失败**的观测：暂存目录曾放在 `%TEMP%`（C: 盘）而仓库在 D: 盘，
  `rename` 跨卷报 `EXDEV`，clean-dist 失败并留下旧 exe（当时实测"失败后 dist 内 exe 数: 1"）。
  该缺陷已修（暂存目录改为同卷兄弟目录），修后重测为 `0`。同样只留了现象记录，未保留现场。

### verify-dist 的结论口径（不要扩大解释）

`node scripts/verify-dist.cjs` 做的是：

1. 对 `package.json`：只比对版本号；
2. 对 `build.files` 里其余 **14 个文件**：逐字节比对 `dist/win-unpacked/resources/app/<file>` 与仓库同名文件；
3. 对 `dist/MouseClik-1.4.2-portable.exe`：**只断言存在、非空，并写出 sha256**。

也就是说：它**不是**对 `app/**` 全目录的一致性证明（目录里允许存在未列在 `build.files` 中的其他文件），
也**没有解包校验 portable exe 的内部载荷**。

### 本机证据限制

- **未做 case-sensitive 目录的实盘测试**：`clean-dist` 的"真实路径精确等于 `<仓库根 realpath>\dist`"
  这一判据，只在本机（`D:\` 与 `D:\MouseClick` 的 case sensitivity 均为 disabled）验证过；
  大小写敏感场景下的行为仅有代码与静态结构支撑，没有实机证据。
- **未做受控窗口的真实点击与 DPI 缩放手验**（见下节）。

复核命令：

```
npm run dist                                        # clean-dist → electron-builder → verify-dist
node scripts/verify-dist.cjs                        # 只校验，不重建
Get-FileHash dist\MouseClik-1.4.2-portable.exe -Algorithm SHA256
```

## 仍未完成的手验项（关单前必须补，且要关联到上面的哈希）

以下两项**没有**自动化证据，只能在受控窗口上人工执行，并把记录关联到本表里的哈希：

1. **真实外部窗口点击**：用一个受控目标窗口（记事本或专用测试窗口），
   在预览里取点后启动运行，确认点击落在预期坐标、`completed/total` 与实际一致、
   暂停/继续/停止即时生效，并记录用例与截图。
2. **DPI 缩放换算**：在 100% 与 125%/150% 缩放下各跑一次，确认抓取尺寸与客户区比例换算正确
   （取点位置不偏移）。

> 这两项刻意排除在默认回归之外：它们要求真实外部窗口与特定显示设置，
> 放进 `npm test` 会变成不稳定、不可复现的用例。

## 自动化回归现状

| 命令 | 覆盖 |
|---|---|
| `npm run test:unit` | 95 个单元用例（含编排器守卫、清理门禁、历史迁移、HTTP 助手、预算/归属/击杀反例） |
| `npm run test:worker` | worker 的 PowerShell 用例 |
| `npm run test:ui` | ui-smoke、point-settings-ui（隔离服务 + 临时数据目录） |
| `npm run test:e2e` | e2e-http（自带服务与重启恢复）、e2e-ui（直接读磁盘证明写盘） |
| `npm run test:desktop` | 桌面链路（28232 监听 PID 归属证明 + 清理确认） |
| `npm test` | unit + worker + 两个 UI 套件 |
