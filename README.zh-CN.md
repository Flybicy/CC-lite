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

安装脚本会**先自动装齐所有依赖，再拉源码构建，最后把语义小模型一步装好**：

1. **依赖优先**：**git、Bun（>=1.3.11）、ripgrep** 全自动安装
   （Linux: apt/dnf/yum/pacman/zypper/apk；macOS: brew；
   Windows: winget/scoop/choco，Git Bash 下还可直接下载官方 rg 压缩包）
2. **拉源码 + 构建**：克隆仓库 → `bun install` → 构建 JS bundle `cclite.js`
   （解锁全部实验性功能）
3. **语义小模型一步到位**：把嵌入运行时（Transformers.js + ONNX Runtime）安装到
   `~/.local/lib/cclite`，按当前平台裁剪（约 130MB），**预下载 ~23MB 模型并跑一次
   真实相似度自检**，安装过程中你就能看到"语义搜索已验证"。无需任何手动配置，
   首次使用也不会卡在下载上。
4. **命令 + PATH**：安装 `cclite`、`cclite-bypass`、`cclite-verify-embeddings`
   到 `~/.local/bin`，并自动把该目录写入 `~/.bashrc` / `~/.zshrc` / `~/.profile`。

> **为什么不是单文件二进制？** `bun build --compile` 会把 ONNX Runtime 的原生
> `.node` 库放进可执行文件的虚拟文件系统，而 `dlopen()` 无法从那里加载 ——
> 所以单文件二进制只能静默退回**近似**兜底。改为分发 `cclite.js` + 一个小运行时
> 目录，才能让**真正的**语义模型工作。启动开销可忽略（约 0.5 秒）。

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
cd cclite
bun install

bun run build            # 生产二进制 ./cclite-cli（仅 VOICE_MODE）
bun run build:dev        # 开发版 ./cclite-cli-dev
bun run build:dev:full   # 解锁全部实验性功能 ./cclite-cli-dev
bun run compile          # 输出到 ./dist/cclite-cli

bun run build:bundle:cclite   # ./cclite.js —— 安装器实际分发的形态
                              # 保持嵌入依赖外置，真语义模型唯一可用的构建
bun run verify:embeddings      # 端到端验证本地语义模型（首次会下载）
```

> 单文件编译产物（`cclite-cli` / `cclite-cli-dev`）无法从虚拟文件系统加载
> ONNX Runtime 原生库，语义搜索在那里会退回近似兜底。要真语义请用 bundle
> 构建或 `bun run dev`。

按需单独开启某个开关：
```bash
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK
```

---

## 运行

```bash
cclite                    # 已安装版本（交互式 REPL，默认）
cclite-bypass             # 以 bypassPermissions 权限模式运行
cclite-verify-embeddings  # 复检本地语义模型
bun ./cclite.js           # 自己构建的 bundle（真语义搜索）
./cclite-cli-dev          # 单文件编译产物（语义退回近似）
bun run dev               # 或从源码运行（启动较慢）
```

快速测试：
```bash
cclite -p "what files are in this directory?"
cclite -p "scan this repo and summarize risky scripts"   # bypass 权限模式
cclite --model claude-sonnet-4-6-20250514                # 指定模型
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
| `hybrid`（**默认**） | 关键词 + 语义的 RRF(k=60) 融合 —— 每次检索都有本地语义小模型参与 | 大多数问题 |
| `keyword` | BM25 精确词匹配 | 标识符、文件名、错误码、确切 API 名 |
| `semantic` | 嵌入向量余弦相似度 | 话题用了不同措辞、需要语义联想 |

搜索输出**始终标注所用嵌入后端**，不会静默降级。

#### 嵌入后端（全本地、零 API Key）

语义搜索**完全本地运行** —— 无需 API Key、无按量计费、对话文本不出本机。两级后端按优先级：

1. **local-semantic（默认，真语义）** —— 通过
   [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js)
   **进程内**运行真实嵌入模型（ONNX/WASM，mean-pool + L2 归一化），标记为
   `local-semantic:<model>`。**安装器已经全部配好**：装运行时、预下载模型、
   跑真实推理自检，全部在安装过程内完成，无需任何配置。源码运行只需
   `bun install`。一次性 ~23MB 下载之后完全离线。向量还有第二层磁盘缓存
   （每模型一个 JSONL），未变化的消息永不重复嵌入，重启也不丢。
   > 注意：`bun run compile` 的单文件二进制无法从虚拟文件系统加载 ONNX Runtime
   > 原生库，语义会退回近似兜底 —— 这正是安装器改为分发 `cclite.js` bundle 的原因。
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

#### 如何确认语义模型正常工作

安装器已经自动跑过这个检查并打印结果，你也可以随时复检：

```bash
cclite-verify-embeddings      # 随 cclite 一起安装
# 或在源码目录下：
bun run verify:embeddings
```

正常输出：

```
[+] Model ready in 1.2s - backend: local-semantic:Xenova/all-MiniLM-L6-v2
    dimensions: 384
    similarity  related: 0.659  unrelated: 0.089
[+] Semantic search verified: real embeddings are working
```

该检查会嵌入「一个查询 + 一句相关 + 一句无关」，并断言相关分明显高于无关分 ——
近似兜底通不过这个断言。第二个判断依据：Advisor 的搜索输出始终打印
`[embedding backend: ...]`，真模型工作时显示 `local-semantic:<模型名>`，
否则显示 `local-approximate`。

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

### 多供应商 WebUI（`ccliteweb`）——推荐

最省事的配置方式是本地 WebUI：

```bash
ccliteweb   # 打开 http://127.0.0.1:1511
#(别名：`cclite config`、`cclite web` 仍然有效)
```

页面上可以：

- 注册并保存任意多个提供商（OpenAI 兼容或 Anthropic 兼容；Ollama / LM Studio 等本地服务也支持，API Key 可留空）；
- 一键拉取各提供商的模型列表（`GET /models`）；
- 把 **pro / plus / se** 三个代号分别绑定到不同的提供商 + 模型：
  | 代号 | 降级顺位 | 建议 |
  |---|---|---|
  | `pro` | 主档位 —— 默认服务主对话 | 最强的模型 |
  | `plus` | pro 失败时的第一顺位 | 中等价位模型 |
  | `se` | plus 也失败时的兜底 | 便宜或本地模型 |

  主体代码统一按代号调用（`/model pro`、`--model se` 都可以），代号背后指向哪个
  供应商和模型完全由 WebUI 决定，跨供应商随意组合。

配置保存在 `~/.claude/providers.json`（纯 JSON，0600 权限）。服务仅监听
**127.0.0.1**（带 Host/Origin 校验，拒绝 DNS rebinding）。修改保存后**热更新**：
正在运行的 CLI 下一次请求即读取新配置，无需重启。端口优先级为
`--port <n>` > `CCLITE_CONFIG_PORT` > `1511`；端口被占用时会自动向上找可用端口
并在终端打印实际地址。`--no-open` 不自动打开浏览器；在没有图形界面的
Linux/SSH 环境下会自动跳过开浏览器，只打印地址。

三档绑定生效时优先于下面的环境变量；没绑定的档位完全走原有 env 逻辑，
存量用法不受影响。

主请求重试全部失败（超时 / 5xx / 429）时，会自动沿档降级：pro → plus → se。
临时性错误降级成功后，下一轮自动换回原来的档；自动降级有 5 次上限，
超过就直接报错不再兜底。余额不足 / 额度用尽（402 或提示 credit balance）的
降级是粘性的——本会话内不再切回，充值后用 `/model` 手动恢复。
4xx 参数错误、401/403 认证、404 模型不存在不会触发降级 —— 这些错换一家
还是同样错，降级只是把真错埋在第二个供应商之下。命令行 `--fallbackModel <id>`
可覆盖这条链。

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
