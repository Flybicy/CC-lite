# CC-lite

> **English** · [简体中文](README.zh-CN.md)

All Anthropic OAuth stripped. All telemetry stripped. All injected security-prompt guardrails removed. All experimental features unlocked. One binary, zero callbacks home.

### Stable (main branch)

```bash
curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.sh | bash
```

> One command installs all dependencies first (git, Bun >= 1.3.11, ripgrep), then clones the source, builds, provisions the **local semantic embedding runtime and pre-downloads the model (~23 MB)**, and installs `cclite`, `cclite-bypass` (bypass permission mode), and `cclite-verify-embeddings` (re-checks the semantic model). See [API Configuration](#api-configuration) for API setup.

### Dev (bleeding edge)

```bash
curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install_dev.sh | bash
```

> Installs from the `dev` branch as `cclite` (plus `cclite-bypass` and `cclite-verify-embeddings`). Same command names as the stable installer — only the source branch differs.

---

## What is this

This is a clean, buildable fork of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI -- the terminal-native AI coding agent. The upstream source became publicly available on March 31, 2026 through a source map exposure in the npm distribution.

This fork applies six categories of changes on top of that snapshot:

### 1. Privacy-First

Eliminates all tracking and remote-control mechanisms present in the original Claude Code:

- No telemetry -- No unnecessary data is transmitted to Anthropic servers
- No analytics -- No usage tracking or event logging
- No fingerprinting -- No user or environment identification
- No auto-updates -- No remote version control or forced updates

### 2. OAuth and Cloud Services Stripped

Unlike the upstream Claude Code, CC-lite has no OAuth login, no claude.ai remote sessions, and no cloud provider integration:

- No `/login` command -- authenticating with claude.ai OAuth is removed
- No remote CCR sessions -- all bridge/remote session code is stripped
- No GrowthBook server-side feature flag dependency
- No auto-update infrastructure
- No settings sync to/from cloud

All authentication is done via API keys (see [API Configuration](#api-configuration)).

### 3. OpenAI-compatible API support

Added an API shim layer (`src/services/api/openaiShim.ts`) that transparently translates between Anthropic message format and OpenAI-compatible APIs. It supports both Chat Completions and the newer Responses API, so all CC-lite tools (bash, file read/write, grep, glob, agents, MCP, etc.) keep working while you swap in a different backend LLM.

### 4. SearXNG-backed WebSearch

Added an optional override for the built-in `WebSearch` tool so it can query your own SearXNG instance instead of relying on provider-side web search.

- Configured with one env var: `CLAUDE_CODE_SEARXNG_BASE_URL`
- Keeps the existing `WebSearch` tool contract and UI intact
- Preserves `allowed_domains` / `blocked_domains` semantics with local filtering
- Falls back to the default provider behavior when the env var is unset

### 5. Security-prompt guardrails removed

Anthropic injects system-level instructions into every conversation that constrain Claude's behavior beyond what the model itself enforces. These include:

- Hardcoded refusal patterns for certain categories of prompts
- Injected "cyber risk" instruction blocks
- Managed-settings security overlays pushed from Anthropic's servers

This build strips those injections. The model's own safety training still applies -- this just removes the extra layer of prompt-level restrictions that the CLI wraps around it.

### 6. Experimental features enabled

Claude Code ships with dozens of feature flags gated behind `bun:bundle` compile-time switches. Most are disabled in the public npm release. This build unlocks all 45+ flags that compile cleanly, including:

| Feature | What it does |
|---|---|
| `ULTRAPLAN` | Remote multi-agent planning on Claude Code web (Opus-class) |
| `ULTRATHINK` | Deep thinking mode -- type "ultrathink" to boost reasoning effort |
| `VOICE_MODE` | Push-to-talk voice input and dictation |
| `AGENT_TRIGGERS` | Local cron/trigger tools for background automation |
| `BRIDGE_MODE` | IDE remote-control bridge (VS Code, JetBrains) |
| `TOKEN_BUDGET` | Token budget tracking and usage warnings |
| `BUILTIN_EXPLORE_PLAN_AGENTS` | Built-in explore/plan agent presets |
| `VERIFICATION_AGENT` | Verification agent for task validation |
| `BASH_CLASSIFIER` | Classifier-assisted bash permission decisions |
| `EXTRACT_MEMORIES` | Post-query automatic memory extraction |
| `HISTORY_PICKER` | Interactive prompt history picker |
| `MESSAGE_ACTIONS` | Message action entrypoints in the UI |
| `QUICK_SEARCH` | Prompt quick-search |
| `SHOT_STATS` | Shot-distribution stats |
| `COMPACTION_REMINDERS` | Smart reminders around context compaction |
| `CACHED_MICROCOMPACT` | Cached microcompact state through query flows |

See [FEATURES.md](FEATURES.md) for the full audit of all 88 flags and their status.

---

## Repository (clone / pull / push)

This repo ships ready for GitHub. To publish your own copy:

```bash
# 1) Create an empty repo on GitHub (e.g. github.com/you/cclite), then:
cd cclite
git remote set-url origin https://github.com/you/cclite.git
git push -u origin main
```

To pull updates and rebuild:

```bash
git pull --ff-only                  # fast-forward only; never auto-merge
bun install                         # sync deps if package.json/lock changed
bun run build:dev:cclite          # rebuild cclite-cli-dev
```

If you have local changes and want to re-sync with upstream cleanly:

```bash
git stash                           # park your edits
git pull --ff-only
git stash pop                       # reapply
```

---

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.sh | bash
```

One command does everything, in this order:

1. **Dependencies first** -- git, Bun >= 1.3.11, and ripgrep, via your system
   package manager (apt / dnf / yum / pacman / zypper / apk / brew; on Windows
   Git Bash: scoop / choco / winget or a direct release download).
2. **Clone + build** -- clones the repo source, runs `bun install`, and builds
   the JS bundle `cclite.js` with all experimental features enabled.
3. **Semantic model, in one step** -- installs the embedding runtime
   (Transformers.js + ONNX Runtime) into `~/.local/lib/cclite`, trims it to
   the host platform (~130 MB), **pre-downloads the ~23 MB model, and runs a
   real similarity smoke test** so you see semantic search verified during
   install. No manual setup, no first-run download stall.
4. **Launchers + PATH** -- installs `cclite`, `cclite-bypass`, and
   `cclite-verify-embeddings` into `~/.local/bin`, and adds that directory to
   your shell profiles (`~/.bashrc` / `~/.zshrc` / `~/.profile`) so the
   command works immediately in new terminals.

> **Why a bundle instead of one compiled binary?** `bun build --compile`
> places ONNX Runtime's native `.node` library inside the executable's
> virtual filesystem, where `dlopen()` cannot load it -- so a single-file
> binary can only ever use the *approximate* fallback, silently. Shipping
> `cclite.js` plus a small runtime directory is what makes the **real**
> semantic model work. Startup cost is negligible (~0.5s).

### Windows (native)

CC-lite builds and runs natively on Windows (no WSL needed). Use the
PowerShell installer, which follows the same order: **all dependencies first**
(git, Bun, and ripgrep -- via winget/choco/scoop), then clone + `bun install`
+ build the bundle, then provision the semantic embedding runtime and
pre-download/verify the model, then install `cclite.cmd`,
`cclite-bypass.cmd`, and `cclite-verify-embeddings.cmd`:

```powershell
irm https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.ps1 | iex
```

Or, if you already have Bun + ripgrep, build from source as on any other OS
(see [Build](#build)). **ripgrep (`rg`) must be on your PATH** -- CC-lite
does NOT bundle it; install it with `scoop install ripgrep`,
`winget install BurntSushi.ripgrep.MSVC`, or `choco install ripgrep`.

> Note: ripgrep is not bundled by CC-lite; it's a system dependency on all
> platforms (brew/apt install ripgrep on macOS/Linux).

---

## Requirements

- [Bun](https://bun.sh) >= 1.3.11
- macOS, Linux, or Windows (native build; WSL optional but not required)
- An API key ([Anthropic Messages](#anthropic-messages-api) or [OpenAI-compatible APIs](#openai-compatible-apis))

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

---

## Build

```bash
# Clone the repo
git clone https://github.com/Flybicy/CC-lite.git
cd cclite

# Install dependencies
bun install

# Standard build -- produces ./cclite-cli
bun run build

# Dev build -- dev version stamp, experimental GrowthBook key
bun run build:dev

# Dev build with ALL experimental features enabled -- produces ./cclite-cli-dev
bun run build:dev:full

# Compiled build (alternative output path) -- produces ./dist/cclite-cli
bun run compile

# Bundle build -- produces ./cclite.js, the variant the installers ship.
# Keeps the embedding stack external so the REAL semantic model works.
bun run build:bundle:cclite

# Verify the local semantic model end-to-end (downloads it on first run)
bun run verify:embeddings
```

### Build variants

| Command | Output | Features | Notes |
|---|---|---|---|
| `bun run build` | `./cclite-cli` | `VOICE_MODE` only | Production-like binary |
| `bun run build:dev` | `./cclite-cli-dev` | `VOICE_MODE` only | Dev version stamp |
| `bun run build:dev:full` | `./cclite-cli-dev` | All 45+ experimental flags | The full unlock build |
| `bun run compile` | `./dist/cclite-cli` | `VOICE_MODE` only | Alternative output directory |
| `bun run build:bundle:cclite` | `./cclite.js` | cclite feature set | **What the installers ship.** Needs a sibling `node_modules` for the embedding stack; the only variant where the real semantic model runs |

> The compiled single-file variants (`cclite-cli`, `cclite-cli-dev`) cannot
> load ONNX Runtime's native library out of their virtual filesystem, so
> semantic search degrades to the approximate fallback there. Use the bundle
> build (or `bun run dev`) for true semantic search.

### Individual feature flags

You can enable specific flags without the full bundle:

```bash
# Enable just ultraplan and ultrathink
bun run ./scripts/build.ts --feature=ULTRAPLAN --feature=ULTRATHINK

# Enable a specific flag on top of the dev build
bun run ./scripts/build.ts --dev --feature=BRIDGE_MODE
```

---

## Run

```bash
# Run the installed command
cclite

# Run in bypass permission mode
cclite-bypass

# Re-check the local semantic embedding model
cclite-verify-embeddings

# Or the bundle you built yourself (real semantic search)
bun ./cclite.js

# Or a compiled binary (semantic search falls back to approximate)
./cclite-cli-dev

# Or run from source without building (slower startup)
bun run dev

# See [API Configuration](#api-configuration) for API setup.
```

`cclite-bypass` is installed by `install.sh`. It exports `IS_SANDBOX=1` and runs `cclite` with `--permission-mode bypassPermissions`. `cclite-verify-embeddings` re-runs the local semantic model check (see [Verifying the semantic model](#verifying-the-semantic-model)).

### Quick test

```bash
# One-shot mode
cclite -p "what files are in this directory?"

# One-shot mode with bypass permission mode enabled
cclite-bypass -p "scan this repo and summarize risky scripts"

# Interactive REPL (default)
cclite

# Interactive REPL (bypassPermissions)
cclite-bypass

# With specific model
cclite --model claude-sonnet-4-6-20250514

# Set advisor model
cclite --advisor-model claude-sonnet-4-6-20250514
```

## Advisor Tool

CC-lite includes a built-in **Advisor** tool that runs a stronger reviewer model
to audit your approach before you commit to implementation. The advisor checks for
architecture flaws, security issues, edge cases, and correctness.

- Configured via `CLAUDE_CODE_ADVISOR_MODEL` or the `/advisor <model>` slash command
- Provider-agnostic — works with any model, including OpenAI-compatible backends
- Automatically called by the executor model on the first significant action of each task
- Also available for manual review: call the `Advisor` tool with your question

```bash
# Enable via env var
export CLAUDE_CODE_ADVISOR_MODEL="claude-opus-4-6"

# Enable via slash command (interactive session)
/advisor claude-opus-4-6

# Disable
/advisor off
```

### ReadConversationLog -- semantic & hybrid search

The Advisor reads the main agent's conversation history through its
`ReadConversationLog` tool. It now supports three search **modes** when using
`action: "search"`:

| mode | what it does | when to use |
|---|---|---|
| `hybrid` (**default**) | reciprocal-rank fusion (RRF, k=60) of keyword + semantic — the local embedding model participates on every search | best for most questions |
| `keyword` | BM25 exact-term search | identifiers, file names, error codes, exact API names |
| `semantic` | embedding-vector cosine similarity only | the topic may be discussed using different words than your query |

The Advisor is actively prompted to pick a mode deliberately: keyword for
exactness, semantic for paraphrase/concept recall, hybrid for broad recall.
Search output always **labels the embedding backend in use**, so the Advisor
knows which one ran and never gets silent fallback.

#### Embedding backends

Semantic and hybrid modes need embeddings. CC-lite runs them **fully local**
-- no API key, no per-token cost, your conversation text never leaves the
machine. Two backends, resolved in this priority order:

1. **local-semantic** (default, true semantics) -- a real embedding model
   running **in-process** via
   [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js)
   (ONNX/WASM, mean-pooled + L2-normalized), labeled
   `local-semantic:<model>`. **The installer sets this up completely**: it
   provisions the runtime, pre-downloads the model, and verifies real
   inference before finishing -- nothing to configure. From source,
   `bun install` is enough. Everything after the one-time ~23 MB download
   works fully offline. Vectors are additionally cached on disk (JSONL per
   model), so unchanged messages are never re-embedded, even across restarts.
   Note: the standalone `--compile` binary cannot load ONNX Runtime's native
   library from its virtual filesystem, so semantic search degrades there --
   this is exactly why the installers ship the `cclite.js` bundle instead.
2. **local-approximate** (fallback) -- a deterministic, offline, free,
   hashed bag-of-features vectorizer. It is **NOT** true semantics; it
   provides fuzzy sub-word matching on top of what BM25 already does. Always
   labeled `local-approximate` in tool output, so the Advisor is told to
   lean toward keyword mode for exactness when it sees this label. Used when
   you opt out of the model tier (`CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0`).

**Model download sizes** (quantized q8, one-time, includes tokenizer/config):

| Model | Size | Notes |
|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (default) | ~23 MB | fast, English-leaning |
| `Xenova/bge-small-zh-v1.5` | ~23 MB | **recommended for Chinese** conversations |
| `Xenova/multilingual-e5-small` | ~120 MB | strongest multilingual recall |

Pick a model with `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL`. The download
lands in the cache dir (next to the vector cache) and is reused forever.

#### Embedding environment variables

| Variable | Description |
|---|---|
| `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL` | Transformers.js/ONNX model id for the local-semantic tier (default `Xenova/all-MiniLM-L6-v2`; use `Xenova/bge-small-zh-v1.5` for Chinese). Downloaded once on first use, then offline. |
| `CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING` | Set to `0`, `false`, or `off` to skip the model tier and use the approximate local fallback instead. |
| `CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH` | Set to `0`, `false`, or `off` to disable semantic/hybrid modes entirely (mode then ignored, keyword used). Alias: `CLAUDE_CODE_SEMANTIC_SEARCH`. |
| `CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR` | Override the on-disk cache directory for models and vectors (useful for tests / ephemeral CI). |

**Example (Chinese conversations):**
```bash
export CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL="Xenova/bge-small-zh-v1.5"
# first semantic search downloads ~23 MB once; everything is offline after that
```

If the model tier is unavailable (e.g. inside the compiled binary without
the opt-out), semantic/hybrid modes report a clear error and hybrid degrades
to keyword-only; keyword mode is always available regardless.

#### Verifying the semantic model

The installer already runs this check and prints the result, but you can
re-run it any time:

```bash
cclite-verify-embeddings          # installed alongside cclite
# or, from a source checkout:
bun run verify:embeddings
```

Expected output on a healthy install:

```
[+] Model ready in 1.2s - backend: local-semantic:Xenova/all-MiniLM-L6-v2
    dimensions: 384
    similarity  related: 0.659  unrelated: 0.089
[+] Semantic search verified: real embeddings are working
```

The check embeds a query plus one related and one unrelated sentence and
asserts the related score clearly outranks the unrelated one -- the
approximate fallback cannot pass it. A second source of truth: the Advisor's
search output always prints `[embedding backend: ...]`, which reads
`local-semantic:<model>` when the real model is active and
`local-approximate` when it is not.

### ReadConversationLog -- project memory across restarts

The Advisor's conversation log also keeps a **per-project long-term memory**:
every snapshot is persisted (de-duplicated by content fingerprint) to a small
JSONL archive keyed by the project directory. After a restart, or in a
brand-new session in the same project, the Advisor can still search and read
what was discussed before -- prior entries appear in `index` tagged
`(prior session)` with high ids (`>= 1000000`), and work with every action
(`search`, `read`, `around`, both keyword and semantic modes).

| Variable | Description |
|---|---|
| `CLAUDE_CODE_ADVISOR_PROJECT_MEMORY` | Set to `0`, `false`, or `off` to disable the per-project archive entirely. |
| `CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR` | Override the archive directory (default: a per-project hash dir under the OS cache dir). |

The archive is FIFO-bounded (newest 4000 entries), never duplicates unchanged
messages across runs/resumes, and all persistence is best-effort -- a failing
disk never breaks the Advisor.

---

## Project structure

```
scripts/
  build.ts              # Build script with feature flag system

src/
  entrypoints/cli.tsx   # CLI entrypoint
  commands.ts           # Command registry (slash commands)
  tools.ts              # Tool registry (agent tools)
  QueryEngine.ts        # LLM query engine
  screens/REPL.tsx      # Main interactive UI

  commands/             # /slash command implementations
  tools/                # Agent tool implementations (Bash, Read, Edit, etc.)
  components/           # Ink/React terminal UI components
  hooks/                # React hooks
  services/             # API client, MCP, analytics
  state/                # App state store
  utils/                # Utilities
  skills/               # Skill system
  plugins/              # Plugin system
  bridge/               # IDE bridge
  voice/                # Voice input
  tasks/                # Background task management
```

---

## Tech stack

| | |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | [Commander.js](https://github.com/tj/commander.js) |
| Schema validation | Zod v4 |
| Code search | ripgrep (required on PATH) |
| Protocols | MCP, LSP |
| API | Anthropic Messages API / OpenAI-compatible APIs |

---

## API Configuration

CC-lite supports both **Anthropic Messages API** (natively) and **OpenAI-compatible APIs**. The shim can use either Chat Completions or the newer Responses API depending on the provider and model you configure.

### Multi-provider WebUI (`cclite config`) — recommended

The easiest way to configure providers is the local WebUI:

```bash
cclite config   # opens http://127.0.0.1:1511
```

The page lets you:

- register and keep any number of providers (OpenAI-compatible or Anthropic-compatible; local servers like Ollama/LM Studio work too — API key optional there),
- pull each provider's model list with one click (`GET /models`),
- bind the **pro / plus / se** codenames to a provider + model each:
  | codename | role | suggestion |
  |---|---|---|
  | `pro` | planner — main loop and planning | your strongest cloud model |
  | `plus` | mid tier — Advisor review / second opinion | a mid-priced model |
  | `se` | economy — subagents and tool grunt work | a cheap or local small model |

  The codebase always calls models by codename (`/model pro`, `--model se`), so
  what a codename points at is decided entirely in the WebUI — mix vendors freely.

Configuration is stored at `~/.claude/providers.json` (plain JSON, `0600`
permissions). The server binds **127.0.0.1 only** (with Host/Origin checks that
reject DNS rebinding) and stops when the `cclite config` command exits. Saves
are **hot-reloaded**: a running CLI picks up edits on its next request, no
restart. Port precedence is `--port <n>` > `CCLITE_CONFIG_PORT` > `1511`; if the
port is taken the server scans upward for a free one and prints the real URL.
`--no-open` skips the browser, and it is skipped automatically on headless
Linux/SSH sessions.

Tier bindings win over the env vars below; unbound tiers fall back to the
env-driven behavior, so existing setups keep working unchanged.

Note: Unlike the upstream Claude Code, CC-lite does **not** support OAuth login via claude.ai. All authentication is done via API keys.

### Anthropic Messages API

Use the official Anthropic Messages API with your Anthropic API key.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

### OpenAI-compatible APIs

Enable OpenAI-compatible mode and configure your preferred provider:

```bash
export CLAUDE_CODE_USE_OPENAI=1
```

#### Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | API key (required for cloud APIs, optional for local models) |
| `OPENAI_BASE_URL` | API base URL (default: `https://api.openai.com/v1`) |
| `OPENAI_MODEL` | Model ID (default: `gpt-4o`) |
| `OPENAI_API_MODE` | Force transport selection: `chat_completions` or `responses` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override which concrete model the `opus` alias resolves to |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override which concrete model the `sonnet` alias resolves to |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override which concrete model the `haiku` alias resolves to |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Override max context window size |
| `CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS` | Override token limit for summarized context |
| `CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS` | Override auto-compact buffer size |
| `CLAUDE_CODE_ADVISOR_MODEL` | Set the advisor/reviewer model (provider-agnostic) |
| `CLAUDE_CODE_SUBAGENT_MAX_CONTEXT_TOKENS` | Override max context window size for subagents |
| `CLAUDE_CODE_SUBAGENT_BUFFER_TOKENS` | Override auto-compact buffer size for subagents |
| `CLAUDE_CODE_SUBAGENT_SUMMARY_OUTPUT_TOKENS` | Override summary output token reservation for subagents |
| `CLAUDE_CODE_ADVISOR_MAX_CONTEXT_TOKENS` | Override max context window size for the advisor tool |
| `CLAUDE_CODE_ADVISOR_BUFFER_TOKENS` | Override auto-compact buffer size for the advisor tool |
| `CLAUDE_CODE_ADVISOR_SUMMARY_OUTPUT_TOKENS` | Override summary output token reservation for the advisor tool |

**Autocompact buffer** = `CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS` + `CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS`

#### Subagent & Advisor Context Configuration

Subagents (spawned via the `Agent` tool) and the `Advisor` tool each run their own
query loops with independent context management. By default they inherit the same
context window, auto-compact buffer, and summary output reservation as the main
agent. You can override these independently using env vars or `settings.json`.

**Env vars (highest priority):**
```bash
# Subagent overrides
export CLAUDE_CODE_SUBAGENT_MAX_CONTEXT_TOKENS=100000
export CLAUDE_CODE_SUBAGENT_BUFFER_TOKENS=5000
export CLAUDE_CODE_SUBAGENT_SUMMARY_OUTPUT_TOKENS=8000

# Advisor overrides
export CLAUDE_CODE_ADVISOR_MAX_CONTEXT_TOKENS=150000
export CLAUDE_CODE_ADVISOR_BUFFER_TOKENS=10000
export CLAUDE_CODE_ADVISOR_SUMMARY_OUTPUT_TOKENS=16000
```

**settings.json (persistent config):**
```json
{
  "subagentContextWindow": 100000,
  "subagentBufferTokens": 5000,
  "subagentSummaryOutputTokens": 8000,
  "advisorContextWindow": 150000,
  "advisorBufferTokens": 10000,
  "advisorSummaryOutputTokens": 16000
}
```

**Priority chain** (each parameter independently):
1. context-specific env var (e.g. `CLAUDE_CODE_SUBAGENT_MAX_CONTEXT_TOKENS`)
2. context-specific `settings.json` field (e.g. `subagentContextWindow`)
3. general env var (e.g. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`)
4. model default

Context window overrides use `min()` semantics — they only cap downward, never
expand beyond what the model supports.

**Calculation reminder:**
```
effectiveWindow = min(modelContextWindow, contextWindowOverride, AUTO_COMPACT_WINDOW)
                   - summaryOutputTokens
compactThreshold = effectiveWindow - bufferTokens
totalBuffer       = summaryOutputTokens + bufferTokens  (default: 20000 + 13000 = 33000)
```

Use `OPENAI_MODEL` when you want to pin the whole session to one exact model. Use `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` when you want aliases such as `opus`, `sonnet`, and `haiku` to resolve to your own provider-specific model IDs.

#### Transport selection

- Codex aliases such as `codexplan` and `codexspark` also use the unified Responses transport, but through the ChatGPT Codex auth/backend path.
- Other OpenAI-compatible backends stay on Chat Completions by default for maximum compatibility unless you explicitly select Responses.
- Official OpenAI requests that include reasoning still use the Responses API.
- Set `OPENAI_API_MODE=responses` to force `/responses` on providers that support it, or `OPENAI_API_MODE=chat_completions` to force the legacy path.

#### Provider Examples

**OpenAI (Responses API, explicit):**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5.4
export OPENAI_API_MODE=responses
```

**OpenAI ChatGPT:**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o
export OPENAI_API_MODE=chat_completions
```

**OpenAI ChatGPT Codex:**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export CODEX_API_KEY=eyJ...
export CHATGPT_ACCOUNT_ID=account_...
export OPENAI_MODEL=codexplan
```

**OpenRouter:**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-or-v1-...
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL=openai/gpt-5.4
```

**DeepSeek:**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat
```

**LLaMA.CPP (local):**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-model-name
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536
export CLAUDE_CODE_SUMMARY_OUTPUT_TOKENS=12000
export CLAUDE_CODE_AUTO_COMPACT_BUFFER_TOKENS=4000
```

**Ollama (local):**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=llama3.3
```

**LM Studio (local):**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL=http://localhost:1234/v1
export OPENAI_MODEL=your-model-name
```

**Azure OpenAI:**
```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_API_KEY=your-azure-key
export OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment
export OPENAI_MODEL=gpt-4o
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
```

### SearXNG-backed WebSearch

You can route CC-lite's built-in `WebSearch` tool through your own SearXNG instance by setting one environment variable:

```bash
export CLAUDE_CODE_SEARXNG_BASE_URL=http://localhost:8888/
```

When this variable is set, `WebSearch` no longer relies on the provider's server-side web search. Instead, CC-lite calls your SearXNG instance directly at:

```text
GET {CLAUDE_CODE_SEARXNG_BASE_URL}/search?q=<query>&format=json
```

Notes:

- This only changes the `WebSearch` tool. `WebFetch` still fetches page content directly.
- `allowed_domains` and `blocked_domains` are still supported, but filtering is applied locally after SearXNG returns results.
- If `CLAUDE_CODE_SEARXNG_BASE_URL` is unset, CC-lite falls back to the default provider behavior.

---

## License

The original Claude Code source is the property of Anthropic. This fork exists because the source was publicly exposed through their npm distribution. Use at your own discretion.
