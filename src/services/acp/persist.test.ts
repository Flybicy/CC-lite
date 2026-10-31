import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInitialState } from 'acp-kernel'
import {
  isAcpSnapshotCompatible,
  loadAcpSnapshot,
  saveAcpSnapshot,
  type AcpSnapshot,
} from './persist.js'
import { _peekAcpSession, hydrateAcpSession, resetAcpSession } from './session.js'

let dir = ''
let previous: string | undefined
let previousStateDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-persist-'))
  previous = process.env.CLAUDE_CONFIG_DIR
  previousStateDir = process.env.CCLITE_ACP_STATE_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.CCLITE_ACP_STATE_DIR = join(dir, 'acp')
})

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previous
  if (previousStateDir === undefined) delete process.env.CCLITE_ACP_STATE_DIR
  else process.env.CCLITE_ACP_STATE_DIR = previousStateDir
  rmSync(dir, { recursive: true, force: true })
})

describe('ACP snapshot persistence', () => {
  it('round-trips state and content store', () => {
    const state = createInitialState()
    const contentStore = { version: 1 as const, byHash: { h: 'text' }, byRef: {} }
    saveAcpSnapshot('session-uuid-1', state, contentStore)

    const loaded = loadAcpSnapshot('session-uuid-1')
    expect(loaded?.version).toBe(1)
    expect(loaded?.state.blocks).toEqual(state.blocks)
    expect(loaded?.contentStore.byHash).toEqual({ h: 'text' })
  })

  it('returns null for unknown sessions', () => {
    expect(loadAcpSnapshot('nope')).toBeNull()
  })

  it('keeps snapshots whose blocks still resolve to replayed messages', () => {
    const snapshot = {
      version: 1,
      key: 'k',
      savedAt: 0,
      state: {
        ...createInitialState(),
        blocks: [{ active: true, effectiveMessageIds: ['a', 'b'] }],
      },
      contentStore: { version: 1, byHash: {}, byRef: {} },
    } as unknown as AcpSnapshot
    expect(isAcpSnapshotCompatible(snapshot, ['a', 'b', 'c'])).toBe(true)
  })

  it('drops snapshots when the transcript no longer carries a folded message', () => {
    const snapshot = {
      version: 1,
      key: 'k',
      savedAt: 0,
      state: {
        ...createInitialState(),
        blocks: [{ active: true, effectiveMessageIds: ['a', 'gone'] }],
      },
      contentStore: { version: 1, byHash: {}, byRef: {} },
    } as unknown as AcpSnapshot
    expect(isAcpSnapshotCompatible(snapshot, ['a', 'b'])).toBe(false)
  })

  it('accepts snapshots with no active blocks', () => {
    const snapshot = {
      version: 1,
      key: 'k',
      savedAt: 0,
      state: createInitialState(),
      contentStore: { version: 1, byHash: {}, byRef: {} },
    } as unknown as AcpSnapshot
    expect(isAcpSnapshotCompatible(snapshot, [])).toBe(true)
  })
})

describe('ACP snapshot hydration', () => {
  it('restores folded blocks when the replay still carries their messages', () => {
    const state = {
      ...createInitialState(),
      blocks: [
        {
          blockId: 'b1',
          active: true,
          effectiveMessageIds: ['u1#0', 'u2#0'],
          directMessageIds: ['u1#0', 'u2#0'],
          directBlockIds: [],
          summary: 'folded',
          tier: 1,
          runId: 'r1',
          compressedTokens: 100,
          createdAt: 0,
          survivedCount: 0,
          generation: 'initial',
        },
      ],
    } as unknown as ReturnType<typeof createInitialState>
    saveAcpSnapshot('u1', state, { version: 1, byHash: {}, byRef: {} })
    resetAcpSession()

    // resetAcpSession drops the file for the live key only; re-save for the test.
    saveAcpSnapshot('u1', state, { version: 1, byHash: {}, byRef: {} })
    hydrateAcpSession('u1', ['u1#0', 'u2#0', 'u3#0'])
    expect(_peekAcpSession()?.state.blocks).toHaveLength(1)
  })
})
