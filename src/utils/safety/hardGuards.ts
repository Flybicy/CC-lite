// ---------------------------------------------------------------------------
// Hard safety guards — CC-lite
//
// Third-party gateways give us no server-side auto review, so the client is
// the only line of defense. These checks are ABSOLUTE: they run in every
// permission mode including bypassPermissions, cannot be allowlisted away,
// and have no settings escape hatch. Two rules:
//
//  1. checkHardBlockedCommand: catastrophic, unrecoverable operations are
//     refused outright (wiping / or $HOME, formatting disks, fork bombs...).
//  2. rewriteDeletionToTrash: ordinary file deletions (rm/del) are rewritten
//     into a move into ~/.claude/trash/<stamp>/ so nothing is ever
//     unrecoverable. Opt out per-session with CCLITE_NO_TRASH_GUARD=1; the
//     hard block above is NOT affected by that switch.
// ---------------------------------------------------------------------------

import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'
import { isEnvTruthy } from '../envUtils.js'

/** Paths that must never be targeted by a deletion, resolved lowercase. */
function catastrophicTargets(cwd: string): string[] {
  const home = homedir().toLowerCase()
  const roots = ['/', home]
  if (process.platform === 'win32') {
    const sys = (process.env.SystemDrive || 'C:').toLowerCase() + '\\'
    roots.push(sys, sys.replace(/\\$/, ''), 'c:\\windows', 'c:\\program files')
    if (process.env.USERPROFILE) roots.push(process.env.USERPROFILE.toLowerCase())
  } else {
    roots.push('/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc',
      '/root', '/sbin', '/sys', '/usr', '/var', '/home')
  }
  return roots
}

function normalizeDeletionTarget(target: string, cwd: string): string {
  let t = target.trim().replace(/^['"]|['"]$/g, '')
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) {
    t = homedir() + t.slice(1)
  }
  if (t === '$HOME' || t === '$USERPROFILE') t = homedir()
  const abs = isAbsolute(t) ? t : resolve(cwd, t)
  return abs.replace(/[\\/]+$/, '').toLowerCase() || '/'
}

/** Regex finding bare rm/rmdir invocations and their argument lists. */
const RM_INVOKE = /(?:^|[;&|\n`]\s*|&&\s*)(?:sudo\s+)?(rm|rmdir)\s+([^;&|\n`]*)/g
/** Patterns that are catastrophic regardless of target. */
const GLOBAL_BLOCK: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: '低级格式化命令 (mkfs)' },
  { pattern: /\bdd\b[^;&|\n]*\bof=\/dev\//i, reason: '直接覆写磁盘设备 (dd of=/dev/...)' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork 炸弹 (:(){ :|:& };:)' },
  { pattern: /\b(format|diskpart)\s+[a-z]:/i, reason: 'Windows 磁盘格式化/分区' },
  { pattern: /\bbcdedit\b|\bbootrec\b/i, reason: '引导记录修改' },
  { pattern: /\brd\s+\/s[^;&|\n]*(%SystemDrive%|[A-Za-z]:\\"?\s*$)/i, reason: 'Windows 根目录递归删除 (rd /s)' },
  { pattern: /\bRemove-Item\b[^;&|\n]*-Recurse[^;&|\n]*((%SystemDrive%|\$env:SystemDrive|\$HOME|~)([\\/]|$)|[A-Za-z]:\\"?\s*[,)\s])/i, reason: 'PowerShell 递归删除系统/用户目录' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b[^;&|\n]*(--force|-f)?\s*$/im, reason: '关机/重启命令' },
]

/**
 * Returns a refusal reason (Chinese, model-facing) or null when safe.
 * cwd is the shell's working directory, used to resolve relative targets.
 */
export function checkHardBlockedCommand(command: string, cwd: string): string | null {
  for (const { pattern, reason } of GLOBAL_BLOCK) {
    if (pattern.test(command)) {
      return `已阻止：${reason}。这类操作不可恢复，CC-lite 在任何权限模式（包括 bypass）下都拒绝执行。`
    }
  }

  const targets = catastrophicTargets(cwd)
  RM_INVOKE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = RM_INVOKE.exec(command)) !== null) {
    const argText = match[2]
    if (!/-[a-zA-Z]*[rR]/.test(argText)) continue // only recursive deletes are catastrophic
    for (const raw of argText.split(/\s+/)) {
      if (!raw || raw.startsWith('-')) continue
      const norm = normalizeDeletionTarget(raw, cwd)
      if (targets.includes(norm)) {
        return `已阻止：递归删除系统/用户根目录（${norm}）。CC-lite 在任何权限模式（包括 bypass）下都拒绝执行。`
      }
    }
  }
  return null
}
