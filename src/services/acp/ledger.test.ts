import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatAcpCacheLine, readAcpLedger, recordAcpRequest, summarizeAcpCache } from './ledger.js'

let dir = ''
let previous: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-ledger-'))
  previous = process.env.CCLITE_ACP_STATE_DIR
  process.env.CCLITE_ACP_STATE_DIR = dir
})

afterEach(() => {
  if (previous === undefined) delete process.env.CCLITE_ACP_STATE_DIR
  else process.env.CCLITE_ACP_STATE_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

describe('ACP cache ledger', () => {
  it('round-trips records and skips malformed lines', () => {
    recordAcpRequest({ ts: 1, input: 100, cacheRead: 900, cacheCreate: 0, conversation: 1000 })
    recordAcpRequest({ ts: 2, input: 50, cacheRead: 950, cacheCreate: 120, conversation: 1100 })
    const records = readAcpLedger()
    expect(records).toHaveLength(2)
    expect(records[1].cacheRead).toBe(950)
  })

  it('summarizes the hit rate over billed and cached prompt tokens', () => {
    const summary = summarizeAcpCache([
      { ts: 1, input: 100, cacheRead: 900, cacheCreate: 0, conversation: 1000 },
      { ts: 2, input: 100, cacheRead: 900, cacheCreate: 0, conversation: 1000 },
    ])
    expect(summary.requests).toBe(2)
    expect(summary.hitRate).toBeCloseTo(0.9, 5)
    expect(formatAcpCacheLine(summary)).toContain('90%')
  })

  it('returns an empty summary when nothing was recorded', () => {
    const summary = summarizeAcpCache(readAcpLedger())
    expect(summary.requests).toBe(0)
    expect(formatAcpCacheLine(summary)).toBeNull()
  })
})
