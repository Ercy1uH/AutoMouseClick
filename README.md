# 点序 MouseClik

Windows 多点连点器。通过目标窗口预览编辑点击、等待和循环步骤，并用全局快捷键或悬浮控制条控制执行。

## 下载与运行

前往 [GitHub Releases](https://github.com/Ercy1uH/AutoMouseClick/releases/latest) 下载 `MouseClik-1.5.0-portable.exe`，双击运行，无需安装 Node.js。

- 支持 Windows 10/11 x64。
- 选择目标窗口后抓取预览，在预览中添加或拖动坐标点。
- 支持左键、右键、中键、双击，以及独立等待步骤。
- 循环块可重复一组点击和等待步骤；整个流程也可设置执行次数。
- 支持多配置保存、配置重命名、运行历史与悬浮控制条。

默认快捷键：`Ctrl+F6` 运行或暂停，`F6` 停止，`Esc` 强制停止。可在设置中调整快捷键。

## 1.5.0 更新

- 新增循环块编辑、重复次数设置、步骤插入与运行进度显示。
- 改进循环内坐标预览、颜色区分、拖动与撤销。
- 新增配置名称内联编辑，改善长名称及悬浮条显示。
- 加强配置迁移、执行器检查与自动化回归覆盖。

完整更新说明见 [releases/v1.5.0.md](releases/v1.5.0.md)。

## 源码开发

需要 Node.js 22 LTS、npm 和 Windows PowerShell 5.1 或更高版本。

```powershell
npm ci
npm start
```

桌面程序使用本机端口 `28232`。执行桌面测试前请退出正在运行的 MouseClik。

## 测试与打包

```powershell
npm test
npm run test:e2e
npm run test:desktop
npm run dist
```

`npm test` 包含单元、PowerShell 执行器和界面测试。界面与端到端测试依赖 Microsoft Edge；编排器会自动创建独立测试服务和临时数据目录并负责清理，无需手动启动服务。

打包生成 `dist/MouseClik-1.5.0-portable.exe` 和对应的 `.sha256` 校验文件。构建校验会逐字节比较解包目录中的应用源码；发布记录见 `releases/`。

## 项目结构

```text
src/
  main/       Electron 主进程、桌面桥接和本地服务
  renderer/   页面、样式、悬浮条和共用步骤规则
  core/       配置、运行历史和日志
  worker/     Windows 点击执行器
tests/
  *.test.js   单元与基础设施回归测试
  ui/         界面回归测试
  e2e/        HTTP、持久化与端到端测试
  desktop/    Electron 桌面交互测试
  manual/     受控窗口手动验收工具
scripts/      构建清理、产物校验与源码导出
releases/     更新说明、构建记录与历史归档
```

当前循环块不支持嵌套；空循环不能启动。真实目标窗口的权限、遮挡和系统缩放会影响点击效果，请先在受控窗口中检查位置。
