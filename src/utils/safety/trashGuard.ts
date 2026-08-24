// ---------------------------------------------------------------------------
// Trash guard — CC-lite
//
// Rewrites direct file deletions into a recoverable move into the trash
// directory (~/.claude/trash/<stamp>-<pid>/), each entry catalogued in
// manifest.jsonl (see src/cli/handlers/trash.ts for `cclite trash` restore).
//
// Only single-statement `rm ...` commands are rewritten. Anything compound
// (pipes, substitutions, control operators, redirections) is left untouched
// because we cannot safely re-scope its side effects; the hard guards cover
// the catastrophic subset of those. rm flags are dropped on purpose: `mv`
// does not accept them and the guarded move only targets literal paths.
// ---------------------------------------------------------------------------

import { isEnvTruthy } from '../envUtils.js'

export const TRASH_DIR_REL = '.claude/trash'
export const TRASH_MANIFEST = 'manifest.jsonl'

const SIMPLE_RM = /^\s*(?:(sudo)\s+)?rm\s+((?:-[a-zA-Z]+\s+)*)((?:(?![;&|`$()<>\\]).)+?)\s*$/

/** Shell-quote a value for embedding in the rewritten command. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * If `command` is a bare `rm` of literal paths, return a rewritten command
 * that moves the targets into the trash and records a manifest entry.
 * Returns null when the command should run unchanged (non-deletion, gated
 * off, or too complex to rewrite safely).
 */
export function rewriteDeletionToTrash(command: string, cwd: string): string | null {
  if (isEnvTruthy(process.env.CCLITE_NO_TRASH_GUARD)) return null
  const m = SIMPLE_RM.exec(command)
  if (!m) return null
  const sudo = m[1] ? 'sudo ' : ''
  const flags = (m[2] || '').trim()
  const args = m[3].trim()
  if (!args) return null
  // Options must be plain single-dash flags (no long options with values).
  if (flags && !/^-[a-zA-Z]+$/.test(flags)) return null

  const stamp = '$(date +%Y%m%d-%H%M%S)-$$'
  return [
    `__cclite_trash="$HOME/${TRASH_DIR_REL}/${stamp}"`,
    `mkdir -p "$__cclite_trash"`,
    // Record what will be moved (globs expand inside the loop).
    `for __f in ${args}; do printf '%s\\n' "$__f" >> "$__cclite_trash/files.txt" 2>/dev/null; done`,
    // rm flags are dropped: mv has no -r/-f and they must not leak through.
    `${sudo}mv -- ${args} "$__cclite_trash/"`,
    // Manifest line; failure here must not fail the move (already done).
    `printf '%s\\n' '{"time":"'"$(date -Is)"'","cwd":${shq(cwd)},"dest":"'"$__cclite_trash"'"}' >> "$HOME/${TRASH_DIR_REL}/${TRASH_MANIFEST}" 2>/dev/null || true`,
    `echo "[cclite] 已移入回收站: $__cclite_trash （运行 cclite trash 查看，cclite trash --restore <编号> 还原）"`,
  ].join(' && ')
}
