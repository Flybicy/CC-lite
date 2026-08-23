# CC-lite for VS Code

本地轻量集成：把 `cclite` CLI 带进 VS Code。

## 功能

- 状态栏常驻当前档位与模型（`pro · <模型> (<供应商>)`），WebUI 改绑后自动刷新
- 命令面板 / 右键菜单：
  - **CC-lite: 打开交互式会话** — 集成终端里启动 `cclite`
  - **CC-lite: 一次性提问 (-p)** — 输入提示词，跑一次就走
  - **CC-lite: 分析当前文件/选中代码** — 有选中发选中片段，否则发整文件
  - **CC-lite: 打开配置 WebUI (ccliteweb)** — 管理供应商与 pro/plus/se 绑定

## 前置条件

先安装 CLI（仓库根目录 `install.sh` / `install.ps1`），确认终端里 `cclite` 可用。

## 本地安装

```bash
npm i -g @vscode/vsce
vsce package          # 产出 cclite-<version>.vsix
code --install-extension cclite-1.0.0.vsix
```

或在 VS Code: Extensions 面板 → `...` → **Install from VSIX...**

## 配置

- `cclite.cliPath`：cclite 可执行文件路径（留空走 PATH）

本体不内置 API Key 管理——一切走 CLI 的 `~/.claude/providers.json`，用 `ccliteweb` 配置。
