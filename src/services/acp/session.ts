/**
 * Per-process ACP session: kernel instance, compression state, CCR content
 * store. The kernel is stateless w.r.t. storage, so cclite holds the state
 * for the lifetime of the session.
 */
import {
  createCore,
  createContentStore,
  createInitialState,
  defaultConfig,
  type CompressionCore,
  type CompressionState,
  type Config,
  type CoreMessage,
} from 'acp-kernel'
import type { MessageContentStore } from 'acp-kernel'
import { buildAcpConfig, getAcpConversationBudget } from './config.js'
import { deleteAcpSnapshot, isAcpSnapshotCompatible, loadAcpSnapshot, saveAcpSnapshot } from './persist.js'

export type AcpSession = {
  core: CompressionCore
  state: CompressionState
  contentStore: MessageContentStore
  config: Config
  /** Cores as last rendered — the wire view the tools operate on. */
  lastCores: CoreMessage[]
  /** Token count of the last rendered view. */
  lastTokenCount: number
  /** Context limit the session was created with. */
  limit: number
  /** Persistence key (first message uuid) once known. */
  key?: string
  /** True once the on-disk snapshot has been consulted for this session. */
  hydrated?: boolean
  /** Signature of the last persisted block set (avoids rewriting big stores). */
  persistedSignature?: string
}

let session: AcpSession | null = null

export function getAcpSession(key?: string): AcpSession {
  const limit = getAcpConversationBudget()
  if (!session) {
    session = {
      core: createCore(),
      state: createInitialState(),
      contentStore: createContentStore(),
      config: buildAcpConfig(limit),
      lastCores: [],
      lastTokenCount: 0,
      limit,
    }
  }
  if (key && !session.key) {
    session.key = key
  }
  if (session.limit !== limit) {
    // The model window changed (model switch, settings edit). The folded
    // blocks are still valid prose, so keep them and only re-derive the
    // thresholds — dropping them would throw away real compression work.
    session.config = buildAcpConfig(limit)
    session.limit = limit
  }
  return session
}

/** Drop all compression state (new session, /clear, manual compact). */
export function resetAcpSession(): void {
  if (session?.key) {
    deleteAcpSnapshot(session.key)
  }
  session = null
}

/**
 * Attach a persistence key and restore the snapshot when it still matches the
 * replayed conversation. `rawIds` are the kernel core ids for this turn — the
 * blocks' covered ids must all be present, otherwise the transcript changed
 * and the snapshot is stale.
 */
export function hydrateAcpSession(key: string, rawIds: readonly string[]): void {
  const current = getAcpSession()
  if (current.hydrated) {
    return
  }
  if (current.key && current.key !== key) {
    return
  }
  current.key = key
  current.hydrated = true
  const snapshot = loadAcpSnapshot(key)
  if (snapshot && isAcpSnapshotCompatible(snapshot, rawIds)) {
    current.state = snapshot.state
    current.contentStore = snapshot.contentStore
  }
}

/**
 * Persist the live session state (called once per ACP stage turn).
 *
 * The content store holds folded originals, so rewriting it every turn would
 * cost megabytes of I/O for no benefit: the snapshot only changes when the
 * set of blocks changes (fold / decompress / truncate). Nudge counters and
 * per-turn stats are recomputed on resume anyway.
 */
export function persistAcpSession(): void {
  if (!session?.key) {
    return
  }
  const signature = session.state.blocks
    .map(block => `${block.blockId}:${block.active ? 1 : 0}`)
    .join(',')
  if (session.persistedSignature === signature) {
    return
  }
  session.persistedSignature = signature
  saveAcpSnapshot(session.key, session.state, session.contentStore)
}

export function _peekAcpSession(): AcpSession | null {
  return session
}

export { defaultConfig }
