// ---------------------------------------------------------------------------
// CC-lite fast-mode dynamic concurrency governor.
//
// Hardware is finite: unbounded hedging/fan-out saturates the local event
// loop (and provider quotas), and a frozen CLI defeats the whole point of a
// speed mode. This governor applies TCP-style congestion control on top of
// the user's configured ceilings:
//
//   - Additive increase: sustained successes outside cooldown raise the
//     allowance by 1 step toward the ceiling.
//   - Multiplicative decrease: 429/5xx/provider rejections halve it and open
//     a cooldown window; local event-loop pressure does the same.
//   - Floor of 1: the mode degrades to plain single-request behavior instead
//     of breaking.
//
// Pure bookkeeping plus one cheap sampler (event-loop drift every second);
// everything reads/writes module state synchronously, so callers can query
// per request without locks.
// ---------------------------------------------------------------------------

import { isCcliteTurboEnabled } from './hedgedRequest.js'

/** Ceiling used when the user hasn't pinned CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY. */
export const TURBO_TOOL_CONCURRENCY_CEILING = 20

const MIN_ALLOWANCE = 1
const SUCCESS_STREAK_PER_STEP = 3
const FAILURE_COOLDOWN_MS = 30_000
const PRESSURE_COOLDOWN_MS = 15_000

/** Event-loop drift above this (ms) counts as local saturation. */
const EVENT_LOOP_LAG_THRESHOLD_MS = 250
const SAMPLER_INTERVAL_MS = 1_000

export interface FastGovernorSnapshot {
  /** Current allowed parallel fast slots (>= MIN_ALLOWANCE). */
  allowance: number
  /** Configured maximum the allowance may grow back to. */
  ceiling: number
  /** Recent outcome ring buffer, newest last: 'ok' | 'rate_limited' | 'error' | 'pressure'. */
  recent: Array<{ kind: string; status?: number; at: number }>
  /** Latest sampled event-loop lag in ms (-1 when no sample yet). */
  eventLoopLagMs: number
  /** Timestamp (epoch ms) until which increases are frozen, 0 when active. */
  cooldownUntil: number
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allowance = Number.POSITIVE_INFINITY // resolved lazily against the ceiling
let successStreak = 0
let cooldownUntil = 0
const recent: NonNullable<FastGovernorSnapshot['recent']>[number][] = []
let samplerTimer: ReturnType<typeof setInterval> | null = null
let lastSampleAt = 0
let lastLagMs = -1

function nowMs(): number {
  return Date.now()
}

function recordRecent(kind: string, status?: number): void {
  recent.push({ kind, status, at: nowMs() })
  if (recent.length > 20) recent.shift()
}

function resolveCeiling(): number {
  const explicit = parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10)
  const ceiling =
    explicit > 0 ? explicit : TURBO_TOOL_CONCURRENCY_CEILING
  return Math.max(MIN_ALLOWANCE, ceiling)
}

function decrease(reason: 'rate_limited' | 'error' | 'pressure', status?: number): void {
  const ceiling = resolveCeiling()
  if (!Number.isFinite(allowance)) allowance = ceiling
  allowance = Math.max(MIN_ALLOWANCE, Math.floor(allowance / 2))
  successStreak = 0
  cooldownUntil =
    nowMs() + (reason === 'pressure' ? PRESSURE_COOLDOWN_MS : FAILURE_COOLDOWN_MS)
  recordRecent(reason, status)
}

function maybeIncrease(): void {
  const ceiling = resolveCeiling()
  if (!Number.isFinite(allowance)) allowance = ceiling
  if (nowMs() < cooldownUntil) return
  successStreak++
  if (successStreak >= SUCCESS_STREAK_PER_STEP) {
    successStreak = 0
    allowance = Math.min(ceiling, allowance + 1)
  }
}

/**
 * Report the outcome of one fast-mode request (or hedged attempt).
 * 429s and server errors trigger multiplicative decrease; clean successes
 * grow the allowance back once any cooldown has elapsed.
 */
export function reportTurboOutcome(ok: boolean, status?: number): void {
  if (!isCcliteTurboEnabled()) return
  if (ok) {
    recordRecent('ok', status)
    maybeIncrease()
    return
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    decrease('rate_limited', status)
  } else if (status === undefined) {
    // Network-level failure (connection refused, DNS, reset...).
    decrease('error')
  } else {
    // Other 4xx are user/config errors — they say nothing about headroom.
    recordRecent('client_error', status)
  }
}

/** Called when the local event loop is visibly stalling (also test-injectable). */
export function applyLocalPressure(lagMs: number): void {
  if (!isCcliteTurboEnabled()) return
  decrease('pressure')
  recordRecent('lag', Math.round(lagMs))
}

/**
 * Current safe parallel-slot count for fast-mode fan-out. Always >= 1, never
 * above the explicit env cap (or the built-in ceiling).
 */
export function getFastConcurrencyAllowance(): number {
  const ceiling = resolveCeiling()
  if (!Number.isFinite(allowance)) allowance = ceiling
  return Math.min(ceiling, Math.max(MIN_ALLOWANCE, allowance))
}

/** Effective tool-use parallelism for this instant (legacy value when fast is off). */
export function getTurboToolConcurrency(): number {
  return getFastConcurrencyAllowance()
}

export function getTurboGovernorSnapshot(): FastGovernorSnapshot {
  const ceiling = resolveCeiling()
  if (!Number.isFinite(allowance)) allowance = ceiling
  return {
    allowance: Math.min(ceiling, Math.max(MIN_ALLOWANCE, allowance)),
    ceiling,
    recent: [...recent],
    eventLoopLagMs: lastLagMs,
    cooldownUntil,
  }
}

/**
 * Sample event-loop drift once. Exported so tests (and exotic embedders) can
 * drive it manually; the interval sampler below calls the same function.
 */
export function sampleEventLoopLag(): number {
  const start = performance.now()
  awaitMacroTask().then(() => {
    const drift = performance.now() - start - SAMPLER_INTERVAL_MS
    lastLagMs = Math.max(0, Math.round(drift))
    if (lastLagMs > EVENT_LOOP_LAG_THRESHOLD_MS) {
      applyLocalPressure(lastLagMs)
    }
  })
  return lastLagMs
}

function awaitMacroTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, SAMPLER_INTERVAL_MS))
}

/** Lazily started; runs only while fast mode is enabled. Cheap (1s cadence). */
export function ensureTurboGovernorSampler(): void {
  if (samplerTimer || !isCcliteTurboEnabled()) return
  lastSampleAt = performance.now()
  samplerTimer = setInterval(() => {
    if (!isCcliteTurboEnabled()) {
      clearInterval(samplerTimer!)
      samplerTimer = null
      return
    }
    void sampleEventLoopLag()
    lastSampleAt = performance.now()
  }, SAMPLER_INTERVAL_MS)
  // Never hold the process open just for the sampler.
  samplerTimer.unref?.()
}

/** Test-only: reset all governor state. */
export function resetTurboGovernorForTests(): void {
  allowance = Number.POSITIVE_INFINITY
  successStreak = 0
  cooldownUntil = 0
  recent.length = 0
  lastLagMs = -1
  if (samplerTimer) {
    clearInterval(samplerTimer)
    samplerTimer = null
  }
}

/** Test-only: pretend the current cooldown window has fully elapsed. */
export function expireCooldownForTests(): void {
  cooldownUntil = 0
}
