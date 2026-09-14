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
