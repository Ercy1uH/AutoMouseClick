# 点序 MouseClik

基于 Electron 的 Windows 多点连点器，支持点击与延迟步骤、配置保存、运行历史、全局快捷键和悬浮控制条。

## 环境与启动

- Windows 10/11，Windows PowerShell 5.1 或更高版本。
- Node.js 22 LTS 与 npm。

```powershell
npm ci
npm start
```

默认使用 `Ctrl+F6` 运行或暂停、`F6` 停止、`Esc` 强制停止，可在设置中调整快捷键。桌面程序使用本机端口 `28232`。

## 验证与打包

```powershell
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/worker-settings.test.ps1
npm run dist
```

打包结果为 `dist/MouseClik-<版本号>-portable.exe`。打包命令会校验产物中的源码与当前源码一致。

`npm run test:ui` 是浏览器集成检查，需要已安装 Microsoft Edge，以及独立的测试服务。请使用临时数据目录；测试会修改配置。当前脚本使用端口 `28332`，其中身份校验测试使用占位 token `feature-check`，其他界面测试还需要测试服务显式允许无凭据写入。此模式仅用于本机测试，不应作为日常启动方式。

## 项目结构

- `main.js`、`preload.js`：Electron 窗口、系统快捷键和桌面桥接。
- `app.js`、`index.html`、`style.css`：主界面。
- `floating.*`：悬浮控制条。
- `server.js`、`native-click-worker.ps1`：本地服务及 Windows 点击执行。
- `profile-store.js`、`point-settings.js`、`run-history.js`、`debug-log.js`：配置、步骤、历史和日志。
- `tests/`：自动化检查；`scripts/`：打包校验和源码导出。

## 数据与凭据

桌面版默认把配置和日志保存在 `%LOCALAPPDATA%/MouseClik`；可以通过 `MOUSECLIK_PROFILE` 指定其他目录。单独运行服务时，可以通过 `MOUSECLIK_DATA` 指定数据目录，默认会写入项目目录。

项目不需要第三方 API 密钥。桌面程序会生成本次启动使用的本地服务 token。配置、运行历史和日志可能包含窗口标题、坐标、个人路径等数据，请勿提交到公开仓库或直接附加到 issue。

## 上传 GitHub

```powershell
npm run prepare:github
```

命令会在 `github-upload/` 中创建新的源码目录，仅导出脚本内明确列出的文件，并附上 `SHA256SUMS.txt` 校验清单。导出不包含 `.git`、内部文档、本地数据、依赖、日志或构建产物；不会改动原有本地数据。检测到常见密钥或个人路径时会中止，并只显示文件位置。

推荐将生成目录中的文件上传至新的 GitHub 仓库。网页上传时，请确认 `.gitignore` 和 `.gitattributes` 也已包含；压缩包需要先解压，才能作为可浏览的源码上传。

若使用 Git 推送，建议在导出目录中新建仓库，并在首次提交前设置 GitHub 提供的隐私邮箱。原项目的 `.git` 含提交者身份和历史，不能靠 `.gitignore` 隐藏。不要将整个工作目录直接打包上传。

检测规则不能识别所有个人信息。发布前仍应检查实际上传文件；新增源码文件时，也需要更新导出脚本中的文件清单。发布可执行文件请重新运行 `npm run dist`，检查后通过 GitHub Releases 单独发布。
