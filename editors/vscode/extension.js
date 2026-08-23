// CC-lite VS Code sidebar extension.
// Sidebar chat panel driving the cclite CLI over its stream-json protocol
// (`cclite -p --output-format stream-json --input-format stream-json`).
// Pure local: no build step, no dependencies, no network beyond the CLI.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cliPath() {
  const configured = vscode.workspace.getConfiguration('cclite').get('cliPath');
  return configured || 'cclite';
}

function permissionMode() {
  return vscode.workspace.getConfiguration('cclite').get('permissionMode') || 'acceptEdits';
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : os.homedir();
}

function providersConfigPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'providers.json');
}

function readCurrentModelLabel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(providersConfigPath(), 'utf8'));
    const pro = cfg.tiers && cfg.tiers.pro;
    if (pro) {
      const provider = (cfg.providers || []).find(p => p.id === pro.providerId);
      return `pro · ${pro.model} (${provider ? provider.label : pro.providerId})`;
    }
  } catch { /* no config yet */ }
  return process.env.ANTHROPIC_MODEL || 'default';
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Chat session: one cclite process per chat, multi-turn via stream-json stdin.
// ---------------------------------------------------------------------------

class ChatSession {
  constructor(opts, onEvent) {
    this.onEvent = onEvent; // (event) => void, events: {type:'delta'|'message'|'tool'|'system'|'error'|'done', ...}
    this.opts = opts;       // { tier, effort, cwd }
    this.proc = null;
    this.lineBuffer = '';
    this.currentMessageId = null;
    this.currentText = '';
    this.closed = false;
  }

  start() {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', permissionMode(),
    ];
    if (this.opts.tier) args.push('--model', this.opts.tier);
    const env = { ...process.env };
    if (this.opts.effort && this.opts.effort !== 'auto') {
      env.CLAUDE_CODE_EFFORT_LEVEL = this.opts.effort;
    }
    this.proc = spawn(cliPath(), args, {
      cwd: this.opts.cwd,
      env,
      shell: process.platform === 'win32', // cclite is a .cmd shim on Windows
    });
    this.proc.stdout.on('data', d => this.onStdout(d.toString('utf8')));
    this.proc.stderr.on('data', d => {
      const text = d.toString('utf8').trim();
      if (text) this.onEvent({ type: 'error', text });
    });
    this.proc.on('error', err => {
      this.onEvent({ type: 'error', text: `cclite 启动失败: ${err.message}` });
    });
    this.proc.on('close', code => {
      if (!this.closed && this.lineBuffer.trim()) this.handleLine(this.lineBuffer);
      this.closed = true;
      this.onEvent({ type: 'closed', code });
    });
  }

  send(text) {
    if (!this.proc || this.closed) return false;
    const frame = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.proc.stdin.write(JSON.stringify(frame) + '\n');
    this.currentMessageId = null;
    this.currentText = '';
    return true;
  }

  dispose() {
    this.closed = true;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* already closed */ }
      try { this.proc.kill(); } catch { /* already dead */ }
    }
  }

  onStdout(chunk) {
    this.lineBuffer += chunk;
    let idx;
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  handleLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // non-JSON noise (banners, debug)
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.onEvent({ type: 'system', sessionId: ev.session_id, model: ev.model });
        }
        return;
      case 'stream_event': {
        const inner = ev.event || {};
        if (inner.type === 'content_block_start' && inner.content_block && inner.content_block.type === 'tool_use') {
          this.onEvent({ type: 'tool', name: inner.content_block.name });
        }
        if (inner.type === 'content_block_delta' && inner.delta) {
          if (inner.delta.type === 'text_delta' && inner.delta.text) {
            this.currentText += inner.delta.text;
            this.onEvent({ type: 'delta', text: this.currentText, streaming: true });
          }
        }
        return;
      }
      case 'assistant': {
        // Full message — replaces the streamed buffer for the same id.
        const msg = ev.message || {};
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        this.currentMessageId = msg.id || this.currentMessageId;
        this.currentText = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        for (const b of blocks) {
          if (b.type === 'tool_use') this.onEvent({ type: 'tool', name: b.name });
        }
        this.onEvent({ type: 'delta', text: this.currentText, streaming: false });
        return;
      }
      case 'result': {
        const isError = ev.is_error || (ev.subtype && ev.subtype.startsWith('error'));
        this.onEvent({
          type: 'done',
          ok: !isError,
          text: typeof ev.result === 'string' ? ev.result : '',
          costUsd: ev.total_cost_usd,
          numTurns: ev.num_turns,
        });
        return;
      }
      default:
        return; // 'user' tool-result echoes, rate_limit, etc.
    }
  }
}

// ---------------------------------------------------------------------------
// Sidebar webview provider
// ---------------------------------------------------------------------------

class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.session = null;
    this.tier = 'pro';
    this.effort = 'auto';
    this.busy = false;
    this.pendingAssistant = '';
    this.transcript = []; // { role: 'user'|'assistant', text }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.newSession();
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  newSession() {
    if (this.session) this.session.dispose();
    this.session = new ChatSession(
      { tier: this.tier, effort: this.effort, cwd: workspaceRoot() },
      ev => this.onSessionEvent(ev),
    );
    this.transcript = [];
    this.busy = false;
    this.session.start();
    this.post({ type: 'reset', tier: this.tier, effort: this.effort });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'send': {
        const text = (msg.text || '').trim();
        if (!text || this.busy || !this.session) return;
        if (!this.session.send(text)) {
          this.post({ type: 'error', text: '会话已结束，请点击「新会话」' });
          return;
        }
        this.busy = true;
        this.transcript.push({ role: 'user', text });
        this.post({ type: 'userMessage', text });
        this.post({ type: 'busy', busy: true });
        return;
      }
      case 'newChat':
        this.newSession();
        return;
      case 'setTier':
        this.tier = msg.tier;
        this.newSession();
        return;
      case 'setEffort':
        this.effort = msg.effort;
        this.newSession();
        return;
      case 'export':
        this.exportTranscript();
        return;
      case 'openWebui':
        vscode.commands.executeCommand('cclite.webui');
        return;
    }
  }

  onSessionEvent(ev) {
    switch (ev.type) {
      case 'system':
        this.post({ type: 'info', text: `会话就绪 · ${ev.model || this.tier}` });
        return;
      case 'delta':
        if (!ev.streaming) this.pendingAssistant = ev.text;
        this.post({ type: 'assistantDelta', text: ev.text, streaming: ev.streaming });
        return;
      case 'tool':
        this.post({ type: 'tool', name: ev.name });
        return;
      case 'done': {
        this.busy = false;
        if (this.pendingAssistant) {
          this.transcript.push({ role: 'assistant', text: this.pendingAssistant });
          this.pendingAssistant = '';
        }
        this.post({ type: 'busy', busy: false });
        if (!ev.ok && ev.text) this.post({ type: 'error', text: ev.text });
        this.post({ type: 'finalize' });
        return;
      }
      case 'error':
        this.post({ type: 'error', text: ev.text });
        return;
      case 'closed':
        if (this.busy) {
          this.busy = false;
          this.post({ type: 'busy', busy: false });
        }
        this.post({ type: 'info', text: `会话进程已退出 (code ${ev.code})` });
        return;
    }
  }

  /** Called from the webview 'finalize' path after the last delta. */
  noteAssistantText(text) {
    this.transcript.push({ role: 'assistant', text });
  }

  async exportTranscript() {
    if (!this.transcript.length) {
      vscode.window.showInformationMessage('还没有对话内容可导出');
      return;
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(workspaceRoot(), `cclite-chat-${Date.now()}.md`)),
      filters: { Markdown: ['md'] },
    });
    if (!uri) return;
    const body = this.transcript
      .map(m => (m.role === 'user' ? `## 你\n\n${m.text}` : `## CC-lite\n\n${m.text}`))
      .join('\n\n');
    fs.writeFileSync(uri.fsPath, `# CC-lite 对话导出\n\n- 档位: ${this.tier} · 思考: ${this.effort}\n- 时间: ${new Date().toLocaleString()}\n\n${body}\n`, 'utf8');
    vscode.window.showInformationMessage(`已导出: ${uri.fsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Webview HTML (inline, no bundler; all JS runs under the script nonce)
// ---------------------------------------------------------------------------

function renderHtml(cspSource) {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); margin:0; padding:0; display:flex; flex-direction:column; height:100vh; }
  #toolbar { display:flex; gap:6px; padding:6px; border-bottom:1px solid var(--vscode-panel-border); align-items:center; flex-wrap:wrap; }
  #toolbar select, #toolbar button {
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:3px; padding:2px 6px; font-size:12px; cursor:pointer;
  }
  #msgs { flex:1; overflow-y:auto; padding:8px; }
  .msg { margin:6px 0; padding:8px 10px; border-radius:8px; white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.5; }
  .user { background: var(--vscode-input-background); border:1px solid var(--vscode-input-border); }
  .assistant { background: var(--vscode-sideBar-background); }
  .tool { color: var(--vscode-descriptionForeground); font-style:italic; font-size:12px; padding:2px 10px; }
  .sys { color: var(--vscode-descriptionForeground); font-size:12px; padding:2px 10px; }
  .err { color: var(--vscode-errorForeground); font-size:12px; padding:2px 10px; white-space:pre-wrap; }
  #inputbar { display:flex; gap:6px; padding:8px; border-top:1px solid var(--vscode-panel-border); }
  #input { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius:4px; padding:6px; resize:none; font-family:inherit; font-size:13px; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; border-radius:4px; padding:6px 14px; cursor:pointer; }
  #send:disabled { opacity:.5; cursor:default; }
  .spinner { color: var(--vscode-descriptionForeground); font-size:12px; padding:4px 10px; display:none; }
</style>
</head>
<body>
  <div id="toolbar">
    <select id="tier" title="模型档位">
      <option value="pro">pro</option>
      <option value="plus">plus</option>
      <option value="se">se</option>
    </select>
    <select id="effort" title="思考等级">
      <option value="auto">auto</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="max">max</option>
    </select>
    <button id="newchat" title="新会话">＋ 新会话</button>
    <button id="export" title="导出对话为 Markdown">导出</button>
    <button id="webui" title="配置供应商">WebUI</button>
  </div>
  <div id="msgs"></div>
  <div class="spinner" id="spin">思考中…</div>
  <div id="inputbar">
    <textarea id="input" rows="2" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
    <button id="send">发送</button>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const msgs = document.getElementById('msgs');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const spin = document.getElementById('spin');
  let currentAssistantEl = null;

  function el(cls, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function send() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }

  sendBtn.onclick = send;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.getElementById('newchat').onclick = () => vscode.postMessage({ type: 'newChat' });
  document.getElementById('export').onclick = () => vscode.postMessage({ type: 'export' });
  document.getElementById('webui').onclick = () => vscode.postMessage({ type: 'openWebui' });
  document.getElementById('tier').onchange = e => vscode.postMessage({ type: 'setTier', tier: e.target.value });
  document.getElementById('effort').onchange = e => vscode.postMessage({ type: 'setEffort', effort: e.target.value });

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'reset':
        msgs.innerHTML = '';
        document.getElementById('tier').value = m.tier;
        document.getElementById('effort').value = m.effort;
        currentAssistantEl = null;
        el('sys', '新会话已开始（' + m.tier + ' · ' + m.effort + '）');
        break;
      case 'userMessage':
        el('user', m.text);
        currentAssistantEl = null;
        break;
      case 'assistantDelta':
        if (!currentAssistantEl || !m.streaming) {
          if (!currentAssistantEl || currentAssistantEl.dataset.final === '1') {
            currentAssistantEl = el('assistant', '');
            currentAssistantEl.dataset.final = '0';
          }
        }
        currentAssistantEl.textContent = m.text;
        if (!m.streaming) currentAssistantEl.dataset.final = '1';
        msgs.scrollTop = msgs.scrollHeight;
        break;
      case 'tool':
        el('tool', '⚙ ' + m.name);
        break;
      case 'info':
        el('sys', m.text);
        break;
      case 'error':
        el('err', m.text);
        break;
      case 'busy':
        spin.style.display = m.busy ? 'block' : 'none';
        sendBtn.disabled = m.busy;
        break;
      case 'finalize':
        currentAssistantEl = null;
        break;
    }
  });
</script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cclite.chatView', provider)
  );

  // Status bar: active pro tier, refreshed when providers.json changes.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const refreshStatus = () => {
    statusBar.text = `$(hubot) CC-lite: ${readCurrentModelLabel()}`;
    statusBar.tooltip = 'CC-lite — 点击打开侧边栏';
    statusBar.command = 'workbench.view.extension.cclite';
  };
  refreshStatus();
  statusBar.show();
  const cfgPath = providersConfigPath();
  let watcher;
  try {
    watcher = fs.watch(path.dirname(cfgPath), (_e, name) => {
      if (name === path.basename(cfgPath)) refreshStatus();
    });
  } catch { /* config dir may not exist yet */ }

  const runInTerminal = (name, command) => {
    const term = vscode.window.createTerminal(name);
    term.sendText(command);
    term.show();
  };

  context.subscriptions.push(
    statusBar,
    { dispose: () => watcher && watcher.close() },
    vscode.commands.registerCommand('cclite.chat', () => runInTerminal('CC-lite', cliPath())),
    vscode.commands.registerCommand('cclite.oneShot', async () => {
      const input = await vscode.window.showInputBox({ prompt: 'CC-lite 一次性模式', placeHolder: '输入提示词' });
      if (input) runInTerminal('CC-lite -p', `${cliPath()} -p ${shellQuote(input)}`);
    }),
    vscode.commands.registerCommand('cclite.fileAnalysis', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showErrorMessage('请先打开一个文件'); return; }
      await editor.document.save();
      const filePath = editor.document.uri.fsPath;
      const selection = editor.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      const ask = selection
        ? `请分析文件 ${filePath} 中这段选中的代码:\n\n${selection}`
        : `请分析这个文件: ${filePath}`;
      runInTerminal('CC-lite 分析', `${cliPath()} -p ${shellQuote(ask)}`);
    }),
    vscode.commands.registerCommand('cclite.webui', () => runInTerminal('CC-lite WebUI', 'ccliteweb')),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
