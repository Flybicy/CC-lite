// CC-lite VS Code extension — thin local launcher around the cclite CLI.
// No build step: plain CommonJS, no dependencies.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Absolute path to providers.json (honors CLAUDE_CONFIG_DIR, like the CLI). */
function providersConfigPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'providers.json');
}

function readProviderConfig() {
  try {
    return JSON.parse(fs.readFileSync(providersConfigPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** Currently active tier model for the status bar: pro binding, else env default. */
function readCurrentModelLabel() {
  const cfg = readProviderConfig();
  const pro = cfg && cfg.tiers && cfg.tiers.pro;
  if (pro) {
    const provider = (cfg.providers || []).find(p => p.id === pro.providerId);
    const pname = provider ? provider.label : pro.providerId;
    return `pro · ${pro.model} (${pname})`;
  }
  return process.env.ANTHROPIC_MODEL || 'default';
}

/** Shell-safe single-quoted argument for POSIX shells and Git Bash. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function cliName() {
  const configured = vscode.workspace.getConfiguration('cclite').get('cliPath');
  return configured || 'cclite';
}

function runInTerminal(name, command) {
  const term = vscode.window.createTerminal(name);
  term.sendText(command);
  term.show();
  return term;
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'cclite.webui';

  function refreshStatusBar() {
    statusBar.text = `$(hubot) CC-lite: ${readCurrentModelLabel()}`;
    statusBar.tooltip = 'CC-lite — 点击打开配置 WebUI (ccliteweb)';
  }
  refreshStatusBar();
  statusBar.show();

  // Follow WebUI saves live: re-read providers.json on change.
  const cfgPath = providersConfigPath();
  let watcher;
  try {
    watcher = fs.watch(path.dirname(cfgPath), (_event, filename) => {
      if (filename === path.basename(cfgPath)) refreshStatusBar();
    });
  } catch { /* config dir may not exist yet */ }

  const windowFocusListener = vscode.window.onDidChangeWindowState(e => {
    if (e.focused) refreshStatusBar();
  });

  context.subscriptions.push(
    statusBar,
    windowFocusListener,
    { dispose: () => watcher && watcher.close() },

    vscode.commands.registerCommand('cclite.chat', () => {
      runInTerminal('CC-lite', cliName());
    }),

    vscode.commands.registerCommand('cclite.oneShot', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'CC-lite 一次性模式',
        placeHolder: '输入提示词',
      });
      if (!input) return;
      runInTerminal('CC-lite -p', `${cliName()} -p ${shellQuote(input)}`);
    }),

    vscode.commands.registerCommand('cclite.fileAnalysis', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('请先打开一个文件');
        return;
      }
      const filePath = editor.document.uri.fsPath;
      await editor.document.save();
      const selection = editor.selection && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection)
        : '';
      const ask = selection
        ? `请分析文件 ${filePath} 中这段选中的代码:\n\n${selection}`
        : `请分析这个文件: ${filePath}`;
      runInTerminal('CC-lite 文件分析', `${cliName()} -p ${shellQuote(ask)}`);
    }),

    vscode.commands.registerCommand('cclite.webui', () => {
      runInTerminal('CC-lite WebUI', 'ccliteweb');
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
