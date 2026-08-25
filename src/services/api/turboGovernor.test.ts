import { beforeEach, describe, expect, it } from 'bun:test'
import {
  applyLocalPressure,
  expireCooldownForTests,
  TURBO_TOOL_CONCURRENCY_CEILING,
  getFastConcurrencyAllowance,
  getTurboGovernorSnapshot,
  reportTurboOutcome,
  resetTurboGovernorForTests,
} from './turboGovernor.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function enableFast(): void {
  process.env.CCLITE_TURBO = '1'
}

describe('turboGovernor (dynamic concurrency)', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
    resetTurboGovernorForTests()
  })

  it('starts at the ceiling and never exceeds an explicit env cap', () => {
    enableFast()
    expect(getFastConcurrencyAllowance()).toBe(TURBO_TOOL_CONCURRENCY_CEILING)
    process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '5'
    expect(getFastConcurrencyAllowance()).toBe(5)
  })

  it('grows by one step per 3 clean successes until the ceiling', () => {
    enableFast()
    // Force the allowance below the ceiling via a pressure event first.
    applyLocalPressure(999)
    const afterDrop = getFastConcurrencyAllowance()
    expect(afterDrop).toBeLessThan(TURBO_TOOL_CONCURRENCY_CEILING)
    expireCooldownForTests()
    for (let i = 0; i < (TURBO_TOOL_CONCURRENCY_CEILING - afterDrop) * 3; i++) {
      reportTurboOutcome(true)
    }
    expect(getFastConcurrencyAllowance()).toBe(TURBO_TOOL_CONCURRENCY_CEILING)
  })

  it('halves on 429/5xx and freezes increases during cooldown', () => {
    enableFast()
    const before = getFastConcurrencyAllowance()
    reportTurboOutcome(false, 429)
    expect(getFastConcurrencyAllowance()).toBe(Math.max(1, Math.floor(before / 2)))
    // Successes during cooldown must not raise the allowance.
    for (let i = 0; i < 10; i++) reportTurboOutcome(true)
    expect(getFastConcurrencyAllowance()).toBe(Math.max(1, Math.floor(before / 2)))
  })

  it('never drops below 1 — the mode degrades instead of dying', () => {
    enableFast()
    for (let i = 0; i < 20; i++) reportTurboOutcome(false, 503)
    expect(getFastConcurrencyAllowance()).toBe(1)
  })

  it('treats client errors as neutral', () => {
    enableFast()
    const before = getFastConcurrencyAllowance()
    reportTurboOutcome(false, 400)
    reportTurboOutcome(false, 401)
    expect(getTurboGovernorSnapshot().recent.at(-1)?.kind).toBe('client_error')
    expect(getFastConcurrencyAllowance()).toBe(before)
  })

  it('reacts to local event-loop pressure', () => {
    enableFast()
    applyLocalPressure(500)
    expect(getTurboGovernorSnapshot().eventLoopLagMs).not.toBeGreaterThan(0)
    expect(getFastConcurrencyAllowance()).toBe(
      Math.max(1, Math.floor(TURBO_TOOL_CONCURRENCY_CEILING / 2)),
    )
  })

  it('is inert when fast mode is off', () => {
    delete process.env.CCLITE_TURBO
    expect(isEnvTruthy(process.env.CCLITE_TURBO)).toBe(false)
    const before = getFastConcurrencyAllowance()
    reportTurboOutcome(false, 429)
    applyLocalPressure(900)
    expect(getFastConcurrencyAllowance()).toBe(before)
  })
})
