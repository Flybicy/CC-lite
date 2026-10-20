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
import { buildAcpConfig, getAcpContextLimit } from './config.js'

export type AcpSession = {
  core: CompressionCore
  state: CompressionState
  contentStore: unknown
  config: Config
  /** Cores as last rendered — the wire view the tools operate on. */
  lastCores: CoreMessage[]
  /** Token count of the last rendered view. */
  lastTokenCount: number
  /** Context limit the session was created with. */
  limit: number
}

let session: AcpSession | null = null

export function getAcpSession(): AcpSession {
  const limit = getAcpContextLimit()
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
    return session
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
  session = null
}

export function _peekAcpSession(): AcpSession | null {
  return session
}

export { defaultConfig }
