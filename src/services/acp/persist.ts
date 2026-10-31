/**
 * ACP snapshot persistence.
 *
 * The kernel keeps compression state in memory; without a snapshot every
 * `--resume` / process restart falls back to the raw transcript and the
 * folded blocks are lost — the next request then pays a full cold prefix.
 * The kernel's state and content store are pure data (see
 * `acp-kernel/dist/content-store.d.ts`), so the host owns persistence:
 * this module writes one JSON envelope per session key and restores it when
 * the conversation resumes.
 *
 * Keys are the first message's cclite uuid, which survives `--resume`
 * because transcripts are replayed verbatim. A snapshot is only trusted when
 * every folded block still points at messages that exist in the replay —
 * otherwise the transcript was rewritten and the snapshot is dropped.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompressionState, MessageContentStore } from 'acp-kernel'

export const ACP_SNAPSHOT_VERSION = 1

export type AcpSnapshot = {
  version: number
  key: string
  savedAt: number
  state: CompressionState
  contentStore: MessageContentStore
}

/**
 * Where per-session ACP state lives.
 *
 * Default: `<project>/.cclite/acp/` — the state belongs to the project the
 * conversation is about, travels with it (copy the folder, keep the folded
 * blocks), and keeps `~/.claude` from growing one blob per conversation.
 * `CCLITE_ACP_STATE_DIR` overrides it (tests, shared caches).
 */
export function getAcpSnapshotDir(): string {
  const configured = process.env.CCLITE_ACP_STATE_DIR
  if (configured) {
    return configured
  }
  return join(process.cwd(), '.cclite', 'acp')
}

/** Pre-project-folder location; read-only fallback for existing sessions. */
export function getLegacySnapshotDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'acp')
}

function snapshotFile(dir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return join(dir, `${safe}.json`)
}

/** Keep the project's own git status clean — state is machine-local. */
function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const ignore = join(dir, '..', '.gitignore')
  try {
    writeFileSync(ignore, '*\n', { flag: 'wx' })
  } catch {
    // already present (or read-only): nothing to do
  }
}

function readSnapshotFile(path: string): AcpSnapshot | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as AcpSnapshot
    if (parsed?.version !== ACP_SNAPSHOT_VERSION) return null
    if (!parsed.state || !Array.isArray(parsed.state.blocks)) return null
    if (!parsed.contentStore || typeof parsed.contentStore !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Read the project snapshot first, then the legacy `~/.claude/acp` copy, so a
 * session started before this change keeps its folded blocks.
 */
export function loadAcpSnapshot(key: string): AcpSnapshot | null {
  const local = readSnapshotFile(snapshotFile(getAcpSnapshotDir(), key))
  if (local) return local
  const legacy = snapshotFile(getLegacySnapshotDir(), key)
  return readSnapshotFile(legacy)
}

export function saveAcpSnapshot(
  key: string,
  state: CompressionState,
  contentStore: MessageContentStore,
): void {
  try {
    const target = snapshotFile(getAcpSnapshotDir(), key)
    ensureStateDir(getAcpSnapshotDir())
    const payload: AcpSnapshot = {
      version: ACP_SNAPSHOT_VERSION,
      key,
      savedAt: Date.now(),
      state,
      contentStore,
    }
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, target)
  } catch {
    // Persistence is best-effort: never break a turn because the disk is full
    // or the config directory is read-only.
  }
}

export function deleteAcpSnapshot(key: string): void {
  try {
    rmSync(snapshotFile(getAcpSnapshotDir(), key), { force: true })
  } catch {
    // ignore
  }
  try {
    rmSync(snapshotFile(getLegacySnapshotDir(), key), { force: true })
  } catch {
    // ignore
  }
}

/**
 * A snapshot is usable when every active block still resolves to messages the
 * replay actually contains. Message ids are stable uuids, so this is a cheap
 * set-membership check rather than a rewrite.
 */
export function isAcpSnapshotCompatible(
  snapshot: AcpSnapshot,
  rawIds: readonly string[],
): boolean {
  const present = new Set(rawIds)
  const blocks = snapshot.state.blocks.filter(b => b.active)
  if (blocks.length === 0) return true
  for (const block of blocks) {
    for (const id of block.effectiveMessageIds ?? []) {
      if (!present.has(id)) return false
    }
  }
  return true
}
