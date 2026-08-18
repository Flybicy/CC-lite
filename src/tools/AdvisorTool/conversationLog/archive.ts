// ---------------------------------------------------------------------------
// Per-project conversation archive (advisor long-term memory).
//
// CC-lite persists the advisor's conversation-log entries to a per-project
// JSONL archive so that, after a restart or in a brand-new session in the same
// project directory, the advisor can still search/read what was discussed
// before instead of starting from a blank slate.
//
// Storage shape: one JSONL record per entry { v, fp, ts, entry }, where
// `fp` is a content fingerprint (over role/text/lengths/metadata, NOT the
// volatile `id`). Writes are de-duplicated by `fp`, so re-running the advisor
// in the same session, resuming a session, or re-reading an unchanged message
// never duplicates records. Loaded entries are renumbered into a high id
// range (ARCHIVE_ID_BASE) so they never collide with the live session's
// 0..N-1 ids and remain addressable through the existing read/around/search
// schema (message_ids, after_id, before_id all accept these ids).
//
// This is the advisor's own compact project memory, decoupled from the heavy
// session transcript store. It is bounded (FIFO) and opt-out via
// CLAUDE_CODE_ADVISOR_PROJECT_MEMORY.
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import envPaths from 'env-paths'
import type { ConversationEntry } from '../types.js'

export const ARCHIVE_ID_BASE = 1_000_000
export const MAX_ARCHIVE_ENTRIES = 4_000
const ARCHIVE_FORMAT_VERSION = 1
// Keep a little slack so we only rewrite on the bound, not on every write.
const ARCHIVE_FILE_SOFT_RECORDS = 2 * MAX_ARCHIVE_ENTRIES

function env(name: string): string | undefined {
  return process.env[name]?.trim()
}

/** Explicit opt-out of the project-memory feature. */
export function isProjectMemoryDisabled(): boolean {
  const flag = env('CLAUDE_CODE_ADVISOR_PROJECT_MEMORY')
  return flag === '0' || flag === 'false' || flag === 'off'
}

/**
 * Per-project archive directory, keyed by a hash of the current working
 * directory so each project keeps an isolated memory. Overridable via
 * CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR (used by tests).
 */
export function getProjectMemoryDir(): string {
  const override = env('CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR')
  if (override) return override
  const cwd = process.cwd()
  const cwdHash = createHash('sha256').update(cwd).digest('hex').slice(0, 24)
  return join(envPaths('claude-cli', { suffix: '' }).cache, 'advisor-project-memory', cwdHash)
}

export function getProjectMemoryFile(): string {
  return join(getProjectMemoryDir(), 'archive.jsonl')
}

// Projection used for the content fingerprint. Deliberately excludes the
// volatile `id` field (reassigned on load) and any field that is recomputed.
function entryProjection(e: ConversationEntry): unknown {
  return [
    e.role,
    e.charLength,
    e.text.length,
    e.searchBody.length,
    (e.searchText?.length ?? 0),
    e.truncated,
    (e.hasThinking ?? null),
    (e.tools ?? null),
    (e.toolResults ?? null),
    // Cheap-but-unique tail anchors so distinct long messages differ even when
    // the structured projection collides, without hashing the full text.
    e.text.slice(0, 64),
    e.text.slice(-64),
  ]
}

export function entryFingerprint(e: ConversationEntry): string {
  return createHash('sha256').update(JSON.stringify(entryProjection(e))).digest('hex').slice(0, 40)
}

interface ArchiveRecord {
  v: number
  fp: string
  ts: number
  entry: ConversationEntry
}

function readRecords(file: string): ArchiveRecord[] {
  const out: ArchiveRecord[] = []
  if (!existsSync(file)) return out
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed) as Partial<ArchiveRecord>
        if (rec.entry && typeof rec.fp === 'string' && rec.entry.role) {
          out.push(rec as ArchiveRecord)
        }
      } catch {
        // skip corrupt line
      }
    }
  } catch {
    return []
  }
  return out
}

function rewriteRecords(file: string, records: ArchiveRecord[]): void {
  // Fresh rewrite with the surviving records (FIFO head-trimmed).
  const body = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFileSync(file, body, { flag: 'w' })
}

/**
 * Persist the given (live-session) entries to the archive. Records are
 * de-duplicated by content fingerprint, so unchanged messages are never
 * stored twice. The archive is FIFO-bounded to MAX_ARCHIVE_ENTRIES records.
 */
export async function persistProjectMemory(entries: readonly ConversationEntry[]): Promise<void> {
  if (isProjectMemoryDisabled() || entries.length === 0) return
  try {
    mkdirSync(getProjectMemoryDir(), { recursive: true })
    const file = getProjectMemoryFile()
    const existing = readRecords(file)
    const known = new Set(existing.map(r => r.fp))
    const now = Date.now()
    const fresh: ArchiveRecord[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      // Skip entries with no real content (e.g. role-only placeholders).
      if ((entry.text ?? '').trim().length === 0 && (entry.searchBody ?? '').trim().length === 0) {
        continue
      }
      const fp = entryFingerprint(entry)
      if (known.has(fp)) continue
      known.add(fp)
      // Store with a local id that is ignored on load (ids are reassigned).
      fresh.push({ v: ARCHIVE_FORMAT_VERSION, fp, ts: now, entry: { ...entry, id: i } })
    }
    if (fresh.length === 0) return
    // Append only the genuinely-new records, then compound-trim if needed.
    appendFileSync(
      file,
      fresh.map(r => JSON.stringify(r)).join('\n') + '\n',
    )
    const allReads = readRecords(file)
    if (allReads.length > ARCHIVE_FILE_SOFT_RECORDS) {
      rewriteRecords(file, allReads.slice(allReads.length - MAX_ARCHIVE_ENTRIES))
    }
  } catch {
    // Archive write failure is non-fatal — the tool still works without memory.
  }
}

/**
 * Load the prior project memory as conversation entries, renumbered into the
 * high archive id range (ARCHIVE_ID_BASE..) and capped to the newest
 * MAX_ARCHIVE_ENTRIES. Returns [] when the feature is disabled or no
 * archive exists.
 */
export async function loadProjectMemory(): Promise<ConversationEntry[]> {
  if (isProjectMemoryDisabled()) return []
  let records: ArchiveRecord[]
  try {
    records = readRecords(getProjectMemoryFile())
  } catch {
    return []
  }
  if (records.length === 0) return []
  // Newest last (append order); keep the most recent MAX_ARCHIVE_ENTRIES.
  const kept = records.slice(Math.max(0, records.length - MAX_ARCHIVE_ENTRIES))
  // Sanitize: ignore records without a role, strip volatile id.
  const entries: ConversationEntry[] = []
  for (const r of kept) {
    const e = r.entry
    if (!e || (e.role !== 'user' && e.role !== 'assistant' && e.role !== 'tool_result')) continue
    entries.push({ ...e })
  }
  return entries.map((e, i) => ({ ...e, id: ARCHIVE_ID_BASE + i }))
}

/** Test-only helper: clear the in-memory know-set is unnecessary (stateless). */
export function resetProjectMemoryForTests(): void {
  // Module keeps no in-memory state across calls; provided for symmetry/tests.
}
