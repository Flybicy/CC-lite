# CC-lite — 上传/安装说明

仓库：https://github.com/Flybicy/CC-lite （public，main 分支）
本目录是 `git archive HEAD` 的快照。

## 一键安装（命令为 cclite，无连字符）

Linux / macOS:
    curl -fsSL https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.sh | bash

Windows (PowerShell):
    irm https://raw.githubusercontent.com/Flybicy/CC-lite/main/install.ps1 | iex

安装顺序（脚本内已全自动）：
1. 先装依赖：git / Bun>=1.3.11 / ripgrep
2. 拉源码 → bun install → 构建 JS bundle cclite.js
3. 语义小模型一步到位：装嵌入运行时到 ~/.local/lib/cclite（裁剪后约126MB），
   预下载 ~23MB 模型，并跑真实相似度自检
4. 安装 cclite / cclite-bypass / cclite-verify-embeddings 到 ~/.local/bin，
   并自动写入 PATH（~/.bashrc / ~/.zshrc / ~/.profile）

## 启动
    cclite                     # 交互式 REPL
    cclite-bypass              # bypassPermissions 模式
    cclite -p "prompt"         # 一次性模式
    ccliteweb              # 本地 WebUI(127.0.0.1:1511):配供应商与 pro/plus/se
    cclite-verify-embeddings   # 复检本地语义模型

## 确认语义模型正常工作
    cclite-verify-embeddings
正常输出：backend: local-semantic:Xenova/all-MiniLM-L6-v2，dimensions: 384,
related 约 0.66 / unrelated 约 0.09。
对话记录搜索默认 hybrid 模式——本地小模型参与每次检索(无需任何开关)。

中文环境(LANG=zh*)自动改用 Xenova/bge-small-zh-v1.5(CLS 池化+查询前缀,
中文检索质量更好)；首次下载 ~23MB 有实时进度显示，之后完全离线。
可用 CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL 显式指定模型。

## 会话选择器语义检索 + 复制粘贴
- /resume 搜索: 关键词搜不到时,主题相关的会话仍会出现(本地小模型,离线)。
- 对话内容选中即复制(可 /config 关闭 copyOnSelect);ctrl+y 把最近复制
  的内容粘贴进输入框——不依赖系统剪贴板,SSH/tmux/无 xclip 环境都可用。

## API 配置(推荐用 WebUI)
    ccliteweb   # 打开 http://127.0.0.1:1511
  可注册并保存多个供应商(OpenAI 兼容 / Anthropic 兼容,本地服务免 key),
  一键拉取模型列表,并把三个代号分别绑定到某个供应商+模型:
    pro   主档位——默认主对话(建议最强模型)
    plus  第二档——pro 失败时的顺位
    se    兜底档——plus 失败时的顺位(不再降级)
  主体代码统一按代号调用(/model pro、--model se),代号指向谁由 WebUI 决定。
  配置保存在 ~/.claude/providers.json,仅本机监听(带 Host/Origin 校验),
  保存后热更新——下次请求即生效,无需重启。
  主请求重试全失败时(超时/5xx/429)自动降级:pro → plus → se;
  400/401/403/404 属配置错,不降级直接报错。可用 --fallbackModel 覆盖。
  端口优先级:--port > CCLITE_CONFIG_PORT > 1511;被占用时自动向上找可用端口。

  也可纯环境变量(与 WebUI 互斥优先级:三档绑定 > env > 默认):
    export ANTHROPIC_API_KEY="sk-ant-..."
    export CLAUDE_CODE_USE_OPENAI=1
    export OPENAI_BASE_URL=http://.../v1

## 布局
默认全屏（alt-screen），输入框锁定终端底部。
回退内联滚动布局：export CLAUDE_CODE_NO_FLICKER=0

## 重要说明
单文件编译产物（cclite-cli / cclite-cli-dev）无法加载 ONNX Runtime 原生库，
语义搜索会退回近似兜底。安装器因此分发 cclite.js bundle + 小运行时目录。
