// ---------------------------------------------------------------------------
// cclite trash — view and restore deletions made through the trash guard.
// Entries live in ~/.claude/trash/<stamp>-<pid>/ and are catalogued in
// ~/.claude/trash/manifest.jsonl by rewriteDeletionToTrash.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, renameSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export async function runTrash(restoreIndex?: string): Promise<number> {
  const trashRoot = join(homedir(), '.claude', 'trash')
  const manifestPath = join(trashRoot, 'manifest.jsonl')

  if (!existsSync(trashRoot) || readdirSync(trashRoot).filter(d => d !== 'manifest.jsonl').length === 0) {
    console.log('回收站为空。（删除操作会先移入这里，可用 cclite trash --restore <编号> 还原）')
    return 0
  }

  type Entry = { time: string; cwd: string; dest: string; idx: number; gone?: boolean }
  const entries: Entry[] = []
  if (existsSync(manifestPath)) {
    readFileSync(manifestPath, 'utf8').split('\n').forEach((line, i) => {
      try {
        const e = JSON.parse(line)
        entries.push({ ...e, idx: entries.length + 1, gone: !existsSync(e.dest) })
      } catch { /* skip malformed line */ }
    })
  }
  // Entries whose manifest write failed can still be listed.
  for (const d of readdirSync(trashRoot)) {
    const full = join(trashRoot, d)
    if (d === 'manifest.jsonl' || entries.some(e => e.dest === full)) continue
    entries.push({ time: d, cwd: '?', dest: full, idx: entries.length + 1, gone: false })
  }

  if (restoreIndex === undefined) {
    console.log('CC-lite 回收站：')
    for (const e of [...entries].reverse()) {
      console.log(`  [${e.idx}] ${e.time}  原位置: ${e.cwd}  (${e.dest})${e.gone ? '  [已清空]' : ''}`)
    }
    console.log('\n还原：cclite trash --restore <编号>   清空请手动删除 ~/.claude/trash')
    return 0
  }

  const target = entries.find(e => e.idx === Number(restoreIndex))
  if (!target || target.gone) {
    console.error(`找不到编号 ${restoreIndex} 对应的回收站内容。`)
    return 1
  }
  const filesPath = join(target.dest, 'files.txt')
  const names = existsSync(filesPath)
    ? readFileSync(filesPath, 'utf8').split('\n').filter(Boolean).map(basename)
    : readdirSync(target.dest).filter(n => n !== 'files.txt')
  for (const name of names) {
    const from = join(target.dest, name)
    if (!existsSync(from)) continue
    const to = resolve(target.cwd, name)
    try {
      renameSync(from, to)
      console.log(`已还原: ${to}`)
    } catch (err) {
      console.error(`还原失败 ${name}: ${err instanceof Error ? err.message : err}`)
    }
  }
  try {
    appendFileSync(manifestPath, JSON.stringify({ time: new Date().toISOString(), restoredFrom: target.dest }) + '\n')
  } catch { /* non-fatal */ }
  return 0
}
