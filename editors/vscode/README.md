# CC-lite for VS Code

纯本地轻量插件：不用登录、不联网（除模型 API 本身），数据全在你机器上。

## 功能

- **侧边栏聊天面板**（活动栏鱿鱼图标）：直接在侧边栏和 cclite 对话，流式输出，工具调用可见
  - 顶栏可切 `pro / plus / se` 档位与思考等级（auto–max，对应 CLI 的 `/effort`）
  - 「新会话」重开会话；切换档位/思考等级会自动以新配置重开
  - 「导出」把当前对话保存成 Markdown 文件
- 状态栏常驻当前 pro 档模型（WebUI 改绑后自动刷新，点击打开侧边栏）
- 终端命令兜底：交互会话、一次性提问、分析当前文件/选中代码、打开配置 WebUI

## 前置条件

先装 CLI：在 CC-lite 仓库根目录跑 `install.sh` / `install.ps1`，确认终端里 `cclite` 可用。
侧边栏走 CLI 的 stream-json 协议，模型与供应商配置完全来自 `ccliteweb`（`~/.claude/providers.json`）。

## 本地安装

```bash
npx @vscode/vsce package
code --install-extension cclite-1.1.0.vsix
```

或在 VS Code：扩展面板 → `...` → **Install from VSIX...**

## 设置

| 设置 | 说明 | 默认 |
|---|---|---|
| `cclite.cliPath` | cclite 可执行文件路径（留空走 PATH） | 空 |
| `cclite.permissionMode` | 侧边栏会话权限模式：`default` 会拒绝需批准的工具；`acceptEdits` 自动接受编辑；`bypassPermissions` 完全放行（慎重） | `acceptEdits` |

## 原理

侧边栏 = webview UI + 一个 `cclite -p --output-format stream-json --input-format stream-json` 常驻子进程；每条消息是一行 JSON 写入 stdin，回复/工具事件从 stdout 流式读出。多轮对话由同一进程维护（等价于 CLI 里的持续会话），新会话即重启进程。
