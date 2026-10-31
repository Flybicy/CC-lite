import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ACP_DEFAULT_OVERHEAD_TOKENS,
  ACP_MIN_CONVERSATION_BUDGET,
  getAcpConversationBudget,
  getAcpOverheadEstimate,
  getAcpTokenRatio,
  noteAcpRequestUsage,
  resetAcpOverheadEstimate,
} from './config.js'

const ENV = 'CCLITE_ACP_CONTEXT_LIMIT'

let dir = ''
let previousStateDir: string | undefined

describe('ACP conversation budget', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-budget-'))
    previousStateDir = process.env.CCLITE_ACP_STATE_DIR
    process.env.CCLITE_ACP_STATE_DIR = dir
    // Pin the window so the assertions do not depend on the user's settings.
    process.env[ENV] = '200000'
    resetAcpOverheadEstimate()
  })

  afterEach(() => {
    delete process.env[ENV]
    if (previousStateDir === undefined) delete process.env.CCLITE_ACP_STATE_DIR
    else process.env.CCLITE_ACP_STATE_DIR = previousStateDir
    rmSync(dir, { recursive: true, force: true })
    resetAcpOverheadEstimate()
  })

  test('starts from the raw window before any request is measured', () => {
    expect(getAcpOverheadEstimate()).toBe(ACP_DEFAULT_OVERHEAD_TOKENS)
    expect(getAcpTokenRatio()).toBe(1)
    expect(getAcpConversationBudget()).toBe(200_000)
  })

  test('learns the fixed overhead from a short session', () => {
    // A fresh ASCII session: billed 18,726, conversation estimate 3,200.
    noteAcpRequestUsage(18_726, 3_200)
    // delta 15,526 is capped at 60% of the bill (11,236).
    expect(getAcpOverheadEstimate()).toBe(11_236)
    // The ratio must stay untouched — 18,726 / 3,200 is overhead, not CJK.
    expect(getAcpTokenRatio()).toBe(1)
  })

  test('learns the tokenizer ratio only once the overhead is a minor share', () => {
    // The failing CJK session: ACP said 268,985 while the API billed 509,122.
    noteAcpRequestUsage(509_122, 268_985)
    expect(getAcpOverheadEstimate()).toBe(ACP_DEFAULT_OVERHEAD_TOKENS)
    expect(getAcpTokenRatio()).toBeCloseTo((509_122 - 35_000) / 268_985, 5)
    expect(getAcpConversationBudget()).toBe(
      Math.round(200_000 / ((509_122 - 35_000) / 268_985)),
    )
  })

  test('caps outliers and smooths instead of jumping', () => {
    noteAcpRequestUsage(18_726, 3_200) // -> 11,236
    // A 12,000-conversation sample billing 100,000: delta 88,000, capped at
    // 60% of the bill (60,000).
    noteAcpRequestUsage(100_000, 12_000)
    expect(getAcpOverheadEstimate()).toBe(
      Math.round(11_236 * 0.5 + 60_000 * 0.5),
    )
  })

  test('does not let the fixed overhead inflate a fresh session ratio', () => {
    // A short ASCII session bills ~18.7K of system prompt + schemas while the
    // conversation is only ~3K. Treating that as a ratio would clamp it at 4
    // and shrink the budget to window/4 — compression would fire at 10%.
    noteAcpRequestUsage(18_726, 3_200)
    expect(getAcpTokenRatio()).toBe(1)
    expect(getAcpConversationBudget()).toBe(200_000)
  })

  test('never hands the kernel a budget below the floor', () => {
    process.env[ENV] = '100000'
    // A 100K-token conversation billed at 400K is a 4x ratio -> budget 25K,
    // which must be floored.
    for (let i = 0; i < 10; i++) noteAcpRequestUsage(400_000, 100_000)
    expect(getAcpConversationBudget()).toBe(ACP_MIN_CONVERSATION_BUDGET)
  })

  test('ignores samples where nothing was reserved', () => {
    // A negative delta means the provider reported a smaller prompt than the
    // conversation itself; that is not a usable overhead sample.
    noteAcpRequestUsage(50_000, 55_000)
    expect(getAcpOverheadEstimate()).toBe(ACP_DEFAULT_OVERHEAD_TOKENS)
  })

  test('ignores non-finite and non-positive inputs', () => {
    noteAcpRequestUsage(Number.NaN, 1_000)
    noteAcpRequestUsage(0, 1_000)
    noteAcpRequestUsage(1_000, 0)
    expect(getAcpOverheadEstimate()).toBe(ACP_DEFAULT_OVERHEAD_TOKENS)
  })
})
