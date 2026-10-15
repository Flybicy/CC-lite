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
  if (!session || session.limit !== limit) {
    session = {
      core: createCore(),
      state: createInitialState(),
      contentStore: createContentStore(),
      config: buildAcpConfig(),
      lastCores: [],
      lastTokenCount: 0,
      limit,
    }
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
