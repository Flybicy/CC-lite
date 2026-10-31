/**
 * Per-request cache ledger.
 *
 * `noteAcpRequestUsage()` already keeps a running estimate of the fixed
 * overhead (system prompt + tool schemas); this module keeps the raw billing
 * facts so `acp_status` can answer the question that actually matters when
 * tuning compression: is the prefix cache doing its job, and did the last
 * fold pay for itself?
 *
 * One JSON line per API response, appended next to the session snapshot
 * (`<project>/.cclite/acp/cache-log.jsonl`). Reads are bounded to the last
 * few thousand lines so a long-lived project cannot make `acp_status` slow.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAcpSnapshotDir } from './persist.js'

export type AcpRequestRecord = {
  /** epoch ms */
  ts: number
  /** prompt tokens billed at full price (cache reads excluded) */
  input: number
  cacheRead: number
  cacheCreate: number
  /** conversation tokens ACP saw when the request was assembled */
  conversation: number
}

export type AcpCacheSummary = {
  requests: number
  input: number
  cacheRead: number
  cacheCreate: number
  /** share of prompt tokens served from cache, 0..1 */
  hitRate: number
}

const MAX_RECORDS = 2000

function ledgerPath(): string {
  return join(getAcpSnapshotDir(), 'cache-log.jsonl')
}

export function recordAcpRequest(record: AcpRequestRecord): void {
  try {
    mkdirSync(getAcpSnapshotDir(), { recursive: true })
    appendFileSync(ledgerPath(), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // Best effort: never fail a turn because the ledger is unwritable.
  }
}

export function readAcpLedger(limit = MAX_RECORDS): AcpRequestRecord[] {
  try {
    const lines = readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map(line => {
        try {
          return JSON.parse(line) as AcpRequestRecord
        } catch {
          return null
        }
      })
      .filter((record): record is AcpRequestRecord => record !== null)
  } catch {
    return []
  }
}

export function summarizeAcpCache(records: AcpRequestRecord[]): AcpCacheSummary {
  const summary: AcpCacheSummary = {
    requests: records.length,
    input: 0,
    cacheRead: 0,
    cacheCreate: 0,
    hitRate: 0,
  }
  for (const record of records) {
    summary.input += record.input
    summary.cacheRead += record.cacheRead
    summary.cacheCreate += record.cacheCreate
  }
  const prompt = summary.input + summary.cacheRead
  summary.hitRate = prompt > 0 ? summary.cacheRead / prompt : 0
  return summary
}

export function formatAcpCacheLine(summary: AcpCacheSummary): string | null {
  if (summary.requests === 0) {
    return null
  }
  const pct = Math.round(summary.hitRate * 1000) / 10
  return `Cache: ${pct}% of prompt tokens served from cache (${summary.requests} requests, ${summary.cacheRead} read / ${summary.input} billed)`
}
