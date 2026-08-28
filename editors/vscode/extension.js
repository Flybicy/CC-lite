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

let _cliResolved;
// Where the plugin ships its own cclite.exe; windows-only for now, with a
// graceful PATH fallback elsewhere. This makes "install extension and talk"
// work even when the user never ran install.ps1.
function bundledCliPath(context) {
  if (process.platform !== 'win32') return null;
  const p = path.join(context.extensionPath, 'bin', 'cclite-win32-x64.exe');
  return fs.existsSync(p) ? p : null;
}
let _bundledCli;
let _extensionContext;
function currentContext() { return _extensionContext; }
function cliPath() {
  if (_cliResolved !== undefined) return _cliResolved;
  const bundled = currentContext() && bundledCliPath(currentContext());
  if (bundled) { _cliResolved = bundled; return bundled; }
  const configured = vscode.workspace.getConfiguration('cclite').get('cliPath');
  if (configured) { _cliResolved = configured; return configured; }
  // PATH probe first (covers fresh installs only after a window reload).
  try {
    const probe = require('child_process').spawnSync('cclite', ['--version'],
      { shell: process.platform === 'win32', timeout: 5000, stdio: 'ignore' });
    if (probe.status === 0) { _cliResolved = 'cclite'; return 'cclite'; }
  } catch { /* not on PATH */ }
  // Common install locations (installer PATH changes need a VS Code reload —
  // these candidates work around a stale process environment).
  const candidates = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'cclite.cmd'),
       path.join(os.homedir(), '.local', 'bin', 'cclite.cmd'),
       path.join(os.homedir(), '.bun', 'bin', 'cclite.cmd')].filter(Boolean)
    : [path.join(os.homedir(), '.local', 'bin', 'cclite'),
       '/usr/local/bin/cclite'];
  for (const c of candidates) {
    if (fs.existsSync(c)) { _cliResolved = c; return c; }
  }
  _cliResolved = null;
  return null;
}

function requireCli() {
  const cli = cliPath();
  if (!cli) {
    _cliResolved = undefined; // don't cache failures; user may finish installing
    vscode.window.showErrorMessage('未找到 cclite：请先在仓库根目录运行安装脚本，然后 Developer: Reload Window（安装脚本改 PATH 后 VS Code 需要重载）。也可以在设置 cclite.cliPath 中手动指定路径。');
  }
  return cli;
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

// The ccliteweb shim is only created by some installers; `cclite config` is
// the always-present alias, so the button survives PATH gaps.
// Platform-aware CLI invocation string for a terminal (PowerShell on Windows
// needs the call operator when the path is quoted).
function cliInvoke(args) {
  const cli = cliPath() || 'cclite';
  const joined = args.join(' ');
  return process.platform === 'win32' ? `& "${cli}" ${joined}` : `"${cli}" ${joined}`;
}

function cliWebuiCmd() {
  const cli = cliPath() || 'cclite';
  return process.platform === 'win32' ? `& "${cli}" config` : `"${cli}" config`;
}

function shellQuote(s) {
  const escaped = process.platform === 'win32'
    ? String(s).replace(/'/g, "''")       // PowerShell single-quote escape
    : String(s).replace(/'/g, "'\\''");
  return '\'' + escaped + '\'';
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
    const cli = cliPath();
    if (!cli) {
      requireCli();
      this.closed = true;
      this.onEvent({ type: 'closed', code: -1 });
      return;
    }
    this.proc = spawn(cli, args, {
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
          this.post({ type: 'error', text: '会话已结束，请点视图右上 ➕ 开新会话' });
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
      case 'attachFile':
        void this.pickFiles();
        return;
      case 'attachSelection':
        void this.attachSelection();
        return;
      case 'attachSkill':
        void this.attachSkill();
        return;
      case 'pickMode':
        void this.pickMode();
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

  async pickFiles() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: '引用',
    });
    if (!uris || !uris.length) return;
    const text = uris.map(u => '@' + vscode.workspace.asRelativePath(u)).join(' ') + ' ';
    this.post({ type: 'insertText', text });
  }

  async attachSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage('请先在编辑器中选中一段代码');
      return;
    }
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const start = editor.selection.start.line + 1;
    const end = editor.selection.end.line + 1;
    const range = start === end ? `L${start}` : `L${start}-L${end}`;
    const snippet = editor.document.getText(editor.selection);
    this.post({ type: 'insertText', text: `@${rel}:${range}\n\`\`\`\n${snippet}\n\`\`\` ` });
  }

  async attachSkill() {
    const roots = [path.join(os.homedir(), '.claude', 'skills')];
    const ws = workspaceRoot();
    if (ws) roots.push(path.join(ws, '.claude', 'skills'));
    const skills = [];
    for (const root of roots) {
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        try { if (fs.existsSync(path.join(root, e.name, 'SKILL.md'))) skills.push(e.name); } catch {}
      }
    }
    if (!skills.length) {
      vscode.window.showInformationMessage('没有找到技能（~/.claude/skills 或 项目/.claude/skills）');
      return;
    }
    const picked = await vscode.window.showQuickPick(skills, { placeHolder: '选择要插入的技能' });
    if (picked) this.post({ type: 'insertText', text: `/${picked} ` });
  }

  async pickMode() {
    const modes = [
      { label: 'default', description: '每步询问' },
      { label: 'acceptEdits', description: '自动接受编辑（默认，推荐）' },
      { label: 'plan', description: '先规划，只读不改动' },
      { label: 'bypassPermissions', description: '全部放行（仍有硬安全兜底）' },
    ];
    const current = permissionMode();
    const picked = await vscode.window.showQuickPick(
      modes.map(m => ({ ...m, label: m.label === current ? `$(check) ${m.label}` : m.label })),
      { placeHolder: '选择会话权限模式（切换后会重开会话）' },
    );
    if (!picked) return;
    const mode = picked.label.replace(/^(\$\(check\) )/, '');
    await vscode.workspace.getConfiguration('cclite').update('permissionMode', mode, vscode.ConfigurationTarget.Global);
    this.newSession();
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
  #msgs { flex:1; overflow-y:auto; padding:10px; }
  html, body { overflow:hidden; }
  #msgs { scrollbar-width:thin; scrollbar-color:transparent transparent; }
  #msgs:hover { scrollbar-color:var(--vscode-scrollbarSlider-background) transparent; }
  #msgs::-webkit-scrollbar { width:8px; }
  #msgs::-webkit-scrollbar-thumb { background:transparent; border-radius:4px; }
  #msgs:hover::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); }
  .msg { margin:6px 0; padding:8px 10px; border-radius:8px; white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.5; }
  .user { background: var(--vscode-input-background); border:1px solid var(--vscode-input-border); margin-left:12%; }
  .assistant { background: var(--vscode-sideBar-background); }
  .tool, .sys { color: var(--vscode-descriptionForeground); font-size:12px; padding:2px 10px; }
  .tool { font-style:italic; }
  .err { color: var(--vscode-errorForeground); font-size:12px; padding:2px 10px; white-space:pre-wrap; }
  #composer { margin:8px; border:1px solid var(--vscode-input-border); border-radius:14px; background: var(--vscode-input-background); padding:8px 8px 6px; }
  #input { width:100%; box-sizing:border-box; background:transparent; color: var(--vscode-input-foreground);
    border:none; outline:none; resize:none; font-family:inherit; font-size:13px; min-height:36px; }
  #controls { display:flex; align-items:center; gap:6px; margin-top:4px; }
  .pill { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:999px; padding:3px 10px; font-size:12px; cursor:pointer; }
  .pill:hover { filter:brightness(1.15); }
  #attachWrap { position:relative; order:1; }
  #controls .spacer { order:2; }
  #drawerWrap { order:3; }
  #send { order:4; }
  .pop { position:absolute; bottom:38px; left:0; min-width:170px; padding:6px; z-index:10;
    background: var(--vscode-quickInput-background); border:1px solid var(--vscode-panel-border);
    border-radius:10px; box-shadow: 0 4px 16px rgba(0,0,0,.35); display:flex; flex-direction:column; gap:2px; }
  .pop-item { text-align:left; background:transparent; color: var(--vscode-foreground); border:none;
    border-radius:6px; padding:6px 8px; font-size:12px; cursor:pointer; }
  .pop-item:hover { background: var(--vscode-list-hoverBackground); }
  .pop-sep { height:1px; background: var(--vscode-panel-border); margin:2px 4px; }

  select.pill { appearance:none; -webkit-appearance:none; text-align:center; }
  #controls .spacer { flex:1; }
  #send { width:30px; height:30px; border-radius:50%; border:none; cursor:pointer; font-size:15px; line-height:1;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #send:disabled { opacity:.4; cursor:default; }
  .spinner { color: var(--vscode-descriptionForeground); font-size:12px; padding:0 12px 6px; display:none; }
  #drawerWrap { position:relative; }
  #drawer { position:absolute; bottom:38px; right:0; min-width:220px; padding:10px; z-index:10;
    background: var(--vscode-quickInput-background); border:1px solid var(--vscode-panel-border);
    border-radius:10px; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  #drawer .drawer-title { font-size:11px; color: var(--vscode-descriptionForeground); margin:6px 0 3px; }
  #drawer select { width:100%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border); border-radius:4px; padding:3px 6px; font-size:12px; }
  #drawer .wide { width:100%; margin-top:10px; }
  #drawer .drawer-note { font-size:11px; color: var(--vscode-descriptionForeground); margin-top:8px; }
</style>
</head>
<body>
  <div id="msgs"></div>
  <div class="spinner" id="spin">思考中…</div>
  <div id="composer">
    <textarea id="input" placeholder="Do anything… (Enter 发送, Shift+Enter 换行)"></textarea>
    <div id="controls">
      <div id="attachWrap">
        <button class="pill" id="attach" title="添加引用 / 技能 / 模式">＋</button>
        <div id="attachMenu" class="pop" hidden>
          <button class="pop-item" data-act="attachFile">📄 引用文件…</button>
          <button class="pop-item" data-act="attachSelection">✂ 引用选中代码</button>
          <button class="pop-item" data-act="attachSkill">🧩 插入技能…</button>
          <div class="pop-sep"></div>
          <button class="pop-item" data-act="pickMode">🛡 权限模式…</button>
        </div>
      </div>
      <div id="drawerWrap">
        <button class="pill" id="drawerBtn" title="模型与思考">pro · auto</button>
        <div id="drawer" hidden>
          <div class="drawer-title">模型</div>
          <select id="tier">
            <option value="pro">pro（主档 · 失败自动降级）</option>
            <option value="plus">plus（第二档）</option>
            <option value="se">se（兜底档）</option>
          </select>
          <div class="drawer-title">思考等级</div>
          <select id="effort">
            <option value="auto">Auto（模型默认）</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
          <button id="webui" class="pill wide">⚙ 打开 WebUI 配置供应商</button>
          <div class="drawer-note">切换档位/等级会以新配置重开会话</div>
        </div>
      </div>
      <div class="spacer"></div>
      <button id="send" title="发送">↑</button>
    </div>
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
  const drawer = document.getElementById('drawer');
  const drawerBtn = document.getElementById('drawerBtn');
  const tierSel = document.getElementById('tier');
  const effortSel = document.getElementById('effort');
  function syncDrawerLabel() { drawerBtn.textContent = tierSel.value + ' · ' + effortSel.value; }
  drawerBtn.onclick = ev => { ev.stopPropagation(); drawer.hidden = !drawer.hidden; };
  document.addEventListener('click', ev => { if (!drawer.hidden && !drawer.contains(ev.target) && ev.target !== drawerBtn) drawer.hidden = true; });
  const attachBtn = document.getElementById('attach');
  const attachMenu = document.getElementById('attachMenu');
  attachBtn.onclick = ev => { ev.stopPropagation(); attachMenu.hidden = !attachMenu.hidden; drawer.hidden = true; };
  drawerBtn.addEventListener('click', () => { attachMenu.hidden = true; });
  document.addEventListener('click', ev => { if (!attachMenu.hidden && !attachMenu.contains(ev.target) && ev.target !== attachBtn) attachMenu.hidden = true; });
  attachMenu.addEventListener('click', ev => {
    const act = ev.target && ev.target.dataset ? ev.target.dataset.act : null;
    if (!act) return;
    attachMenu.hidden = true;
    vscode.postMessage({ type: act });
  });
  document.getElementById('webui').onclick = () => vscode.postMessage({ type: 'openWebui' });
  tierSel.onchange = e => { syncDrawerLabel(); vscode.postMessage({ type: 'setTier', tier: e.target.value }); };
  effortSel.onchange = e => { syncDrawerLabel(); vscode.postMessage({ type: 'setEffort', effort: e.target.value }); };
  syncDrawerLabel();

  window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
      case 'reset':
        msgs.innerHTML = '';
        tierSel.value = m.tier;
        effortSel.value = m.effort;
        syncDrawerLabel();
        currentAssistantEl = null;
        el('sys', '新会话（' + m.tier + ' · ' + m.effort + '）');
        break;
      case 'userMessage':
        el('user', m.text);
        currentAssistantEl = null;
        break;
      case 'assistantDelta':
        if (!currentAssistantEl || currentAssistantEl.dataset.final === '1') {
          currentAssistantEl = el('assistant', '');
          currentAssistantEl.dataset.final = '0';
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
      case 'focusInput':
        input.focus();
        break;
      case 'clearInput':
        input.value = '';
        break;
      case 'insertText':
        input.value = (input.value ? input.value + ' ' : '') + m.text;
        input.focus();
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
  _extensionContext = context;
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
    vscode.commands.registerCommand('cclite.newChat', () => provider.newSession()),
    vscode.commands.registerCommand('cclite.exportChat', () => provider.exportTranscript()),
    vscode.commands.registerCommand('cclite.chat', () => {
      const cli = requireCli();
      if (cli) runInTerminal('CC-lite', process.platform === 'win32' ? `& "${cli}"` : cli);
    }),
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
    vscode.commands.registerCommand('cclite.webui', () => runInTerminal('CC-lite WebUI', cliWebuiCmd())),
    // Claude Code has ctrl+esc = focus input: reveal the view then focus the
    // composer inside the webview.
    vscode.commands.registerCommand('cclite.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.cclite');
      setTimeout(() => provider.post({ type: 'focusInput' }), 100);
    }),
    // Claude Code / Codex both have "@mention" — insert a relative reference
    // of the open file / selection into the composer without attaching it as
    // a separate block. That's the everyday "talk about this file" gesture.
    vscode.commands.registerCommand('cclite.insertAtMention', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showInformationMessage('请先打开一个文件'); return; }
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      const range = start === end ? `L${start}` : `L${start}-L${end}`;
      void vscode.commands.executeCommand('workbench.view.extension.cclite').then(() => {
        setTimeout(() => provider.post({ type: 'insertText', text: `@${rel}:${range} ` }), 100);
      });
    }),
    vscode.commands.registerCommand('cclite.clearComposer', () => provider.post({ type: 'clearInput' })),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
