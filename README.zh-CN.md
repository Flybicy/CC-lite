# CC-lite

> **简体中文** · [English](README.md)

剔除 Anthropic 所有 OAuth 登录、所有遥测、所有注入的安全提示词限制，解锁全部实验性功能。一个二进制，零回传。

---

## 这是什么

这是 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（Anthropic 的终端原生 AI 编程代理 CLI）的一个**干净、可构建的分支**，在公开源码快照之上应用了六类改动：

### 1. 隐私优先
- 无遥测 —— 不向 Anthropic 服务器发送任何多余数据
- 无分析 / 无指纹采集 / 无自动更新

### 2. 剔除 OAuth 与云服务
- 移除 `/login` 命令、claude.ai 远程会话、桥接/远程会话代码
- 无 GrowthBook 服务端功能开关依赖、无设置云同步
- 全部通过 API Key 认证（见 [API 配置](#api-配置)）

### 3. 兼容 OpenAI 兼容 API
新增 API 适配层（`src/services/api/openaiShim.ts`），在 Anthropic 消息格式与 OpenAI 兼容 API 之间透明转换，同时支持 Chat Completions 与新版 Responses API。所有工具（bash、文件读写、grep、glob、agents、MCP 等）在换用不同后端大模型后照常工作。

### 4. SearXNG 版 WebSearch
可用一个环境变量 `CLAUDE_CODE_SEARXNG_BASE_URL` 让内置 `WebSearch` 走你自己的 SearXNG 实例，而不是依赖提供方的服务端搜索；未设置时回退默认行为。

### 5. 移除安全提示词护栏
Anthropic 会向每条对话注入系统级指令（硬编码拒答模式、"网络风险"指令块、托管安全设置覆盖）。本构建移除这些注入层 —— 模型自身的安全训练仍然生效，只是去掉 CLI 额外包裹的那层提示词限制。

### 6. 解锁实验性功能
解锁所有能干净编译的 45+ 个功能开关：`ULTRAPLAN`、`ULTRATHINK`、`VOICE_MODE`、`AGENT_TRIGGERS`、`BRIDGE_MODE`、`TOKEN_BUDGET`、`VERIFICATION_AGENT`、`EXTRACT_MEMORIES`、`HISTORY_PICKER`、`MESSAGE_ACTIONS`、`QUICK_SEARCH`、`SHOT_STATS`、`COMPACTION_REMINDERS` 等。全部 88 个开关的审计见 [FEATURES.md](FEATURES.md)。

---

## 快速安装（一行命令，依赖全自动）

**macOS / Linux / Windows Git Bash：**
```bash
curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.sh | bash
```

**Windows（原生，PowerShell）：**
```powershell
irm https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.ps1 | iex
```

安装脚本会**先自动装齐所有依赖，再拉源码构建**：
1. 依赖：**git、Bun（>=1.3.11）、ripgrep** 全自动安装
   （Linux: apt/dnf/yum/pacman/zypper/apk；macOS: brew；
   Windows: winget/scoop/choco，Git Bash 下还可直接下载官方 rg 压缩包）
2. 克隆源码 → `bun install`（含 `@huggingface/transformers` 本地语义模型运行时）
   → 编译单文件可执行程序
3. 安装为 `cc-lite`（及 `cc-lite-bypass`）到 `~/.local/bin`，自动尝试加入 PATH

> 已装好 Bun + ripgrep 也可直接源码构建，见下文[构建](#构建)。

---

## 需求

- [Bun](https://bun.sh) >= 1.3.11
- macOS / Linux / Windows（原生构建，WSL 可选）
- 一个 API Key（[Anthropic Messages](#anthropic-messages-api) 或 [OpenAI 兼容 API](#openai-兼容-api)）

---

## 构建

```bash
git clone https://github.com/Flybicy/CC-lite.git
cd cc-lite
bun install

bun run build            # 生产二进制 ./cc-lite-cli（仅 VOICE_MODE）
bun run build:dev        # 开发版 ./cc-lite-cli-dev
bun run build:dev:full   # 解锁全部实验性功能 ./cc-lite-cli-dev
bun run compile          # 输出到 ./dist/cc-lite-cli
```

按需单独开启某个开关：
```bash
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK
```

---

## 运行

```bash
cc-lite                # 已安装版本（交互式 REPL，默认）
cc-lite-bypass         # 以 bypassPermissions 权限模式运行
./cc-lite-cli          # 或直接用构建产物
bun run dev             # 或从源码运行（启动较慢）
```

快速测试：
```bash
cc-lite -p "what files are in this directory?"
cc-lite -p "scan this repo and summarize risky scripts"   # bypass 权限模式
cc-lite --model claude-sonnet-4-6-20250514                # 指定模型
```

---

## Advisor 工具

内置 **Advisor** 工具：用更强的评审模型在你动手实现前审计方案（架构缺陷、安全问题、边界情况、正确性）。

```bash
export CLAUDE_CODE_ADVISOR_MODEL="claude-opus-4-6"   # 环境变量开启
/advisor claude-opus-4-6                             # 或会话内斜杠命令
/advisor off                                          # 关闭
```

### ReadConversationLog —— 语义与混合搜索

Advisor 通过 `ReadConversationLog` 工具读取主代理对话历史，支持三种搜索模式：

| 模式 | 说明 | 适用场景 |
|---|---|---|
| `keyword`（默认） | BM25 精确词匹配 | 标识符、文件名、错误码、确切 API 名 |
| `semantic` | 嵌入向量余弦相似度 | 话题用了不同措辞、需要语义联想 |
| `hybrid` | 关键词 + 语义的 RRF(k=60) 融合 | 宽泛问题，通用默认 |

搜索输出**始终标注所用嵌入后端**，不会静默降级。

#### 嵌入后端（全本地、零 API Key）

语义搜索**完全本地运行** —— 无需 API Key、无按量计费、对话文本不出本机。两级后端按优先级：

1. **local-semantic（默认，真语义）** —— 通过
   [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js)
   **进程内**运行真实嵌入模型（ONNX/WASM，mean-pool + L2 归一化），标记为
   `local-semantic:<model>`。`bun install`（或一行安装器）自动装好运行时
   —— **克隆、安装、完成**。首次使用时模型自动下载一次到磁盘缓存，之后完全离线。
   向量还有第二层磁盘缓存（每模型一个 JSONL），未变化的消息永不重复嵌入，重启也不丢。
   > 注意：`bun run compile` 的独立二进制无法内嵌 transformers 包，会清晰报错；
   > 此时设 `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0` 即可退回近似兜底。
2. **local-approximate（兜底）** —— 确定性的哈希词袋向量器，**不是**真语义；
   只提供 BM25 之上的模糊子词匹配。始终标记为 `local-approximate`，
   Advisor 看到该标记时会偏向 keyword 模式以求精确。

**模型下载大小**（q8 量化，一次性，含 tokenizer/config）：

| 模型 | 大小 | 说明 |
|---|---|---|
| `Xenova/all-MiniLM-L6-v2`（默认） | ~23 MB | 快，偏英文 |
| `Xenova/bge-small-zh-v1.5` | ~23 MB | **中文对话推荐** |
| `Xenova/multilingual-e5-small` | ~120 MB | 多语言召回最强 |

用 `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL` 切换模型。下载落在缓存目录，永久复用。

**嵌入环境变量：**

| 变量 | 说明 |
|---|---|
| `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL` | 本地语义模型 ID（默认 `Xenova/all-MiniLM-L6-v2`；中文用 `Xenova/bge-small-zh-v1.5`）。首次使用自动下载一次，之后离线。 |
| `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING` | 设为 `0`/`false`/`off` 跳过模型层，改用近似兜底。 |
| `CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH` | 设为 `0`/`false`/`off` 完全关闭语义/混合模式（忽略 mode，只用 keyword）。别名：`CLAUDE_CODE_SEMANTIC_SEARCH`。 |
| `CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR` | 覆盖模型与向量缓存目录（测试/临时 CI 用）。 |

**中文对话示例：**
```bash
export CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL="Xenova/bge-small-zh-v1.5"
# 首次语义搜索自动下载 ~23MB，之后完全离线
```

### ReadConversationLog —— 跨重启的项目记忆

Advisor 的对话日志还维护**按项目隔离的长期记忆**：每次快照按内容指纹去重后写入
JSONL 归档（按项目目录哈希分桶）。重启后、或同一项目的新会话里，Advisor 依然能
搜索/读取之前讨论过的内容 —— 历史条目在 `index` 中标记为 `(prior session)`，
使用高 id（`>= 1000000`），并适用于所有动作（`search`/`read`/`around`，含 keyword
与语义两种模式）。

| 变量 | 说明 |
|---|---|
| `CLAUDE_CODE_ADVISOR_PROJECT_MEMORY` | 设为 `0`/`false`/`off` 完全关闭项目归档。 |
| `CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR` | 覆盖归档目录（默认：系统缓存目录下按项目哈希分桶）。 |

归档 FIFO 上限（保留最新 4000 条），重复运行/恢复会话不会产生重复条目；持久化全程
尽力而为 —— 磁盘故障不会影响 Advisor 本身。

---

## 项目结构

```
scripts/build.ts          # 带功能开关系统的构建脚本
src/entrypoints/cli.tsx   # CLI 入口
src/commands.ts           # 斜杠命令注册
src/tools.ts              # 工具注册（代理工具）
src/QueryEngine.ts        # LLM 查询引擎
src/screens/REPL.tsx      # 主交互界面
src/tools/                # 代理工具实现（Bash、Read、Edit 等）
src/components/           # Ink/React 终端 UI 组件
src/services/             # API 客户端、MCP、分析
src/bridge/               # IDE 桥接
src/voice/                # 语音输入
```

## 技术栈

| | |
|---|---|
| 运行时 | [Bun](https://bun.sh) |
| 语言 | TypeScript |
| 终端 UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | [Commander.js](https://github.com/tj/commander.js) |
| 校验 | Zod v4 |
| 代码搜索 | ripgrep（需在 PATH） |
| 协议 | MCP、LSP |
| API | Anthropic Messages API / OpenAI 兼容 API |

---

## API 配置

CC-lite 同时支持 **Anthropic Messages API**（原生）与 **OpenAI 兼容 API**（适配层可用
Chat Completions 或新版 Responses API）。与上游不同：**不支持** claude.ai OAuth 登录，
全部通过 API Key 认证。

### Anthropic Messages API
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### OpenAI 兼容 API
```bash
export CLAUDE_CODE_USE_OPENAI=1
```

常用环境变量：

| 变量 | 说明 |
|---|---|
| `OPENAI_API_KEY` | API Key（云端必填，本地模型可选） |
| `OPENAI_BASE_URL` | API 地址（默认 `https://api.openai.com/v1`） |
| `OPENAI_MODEL` | 模型 ID（默认 `gpt-4o`） |
| `OPENAI_API_MODE` | 强制传输方式：`chat_completions` 或 `responses` |
| `CLAUDE_CODE_ADVISOR_MODEL` | 设置 Advisor 评审模型（provider 无关） |
| `CLAUDE_CODE_SEARXNG_BASE_URL` | 让 WebSearch 走你自己的 SearXNG 实例 |

**常用示例：**

OpenRouter：
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-or-v1-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL=openai/gpt-5.4
```

DeepSeek：
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat
```

Ollama / LM Studio（本地）：
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=llama3.3   # 或你的模型名
```

Azure OpenAI：
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-azure-key
export OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
export OPENAI_MODEL=gpt-4o
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

---

## 许可证

原始 Claude Code 源码归 Anthropic 所有。本分支因其源码通过 npm 分发被公开而存在。使用请自行斟酌。
