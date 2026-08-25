// ---------------------------------------------------------------------------
// CC-lite "fast" high-concurrency mode: hedged requests.
//
// Some providers are slow per-request but tolerate high concurrency. A hedged
// request fires duplicates of the SAME request staggered `delayMs` apart; the
// first attempt to show real stream progress wins and every other attempt is
// aborted. This cuts first-token tail latency dramatically on slow relays at
// the cost of extra billed input tokens for the losing attempts.
//
// Enabled with CCLITE_TURBO=1 (or the --fast flag / /fast command). Tunables:
//   CCLITE_TURBO_HEDGES       total attempts including the original (default 2, max 4)
//   CCLITE_TURBO_HEDGE_DELAY_MS  stagger between attempts (default 8000)
//
// Transport-agnostic: operates on plain Response objects, so both the Chat
// Completions and Responses paths through openaiShim benefit.
// ---------------------------------------------------------------------------

import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  ensureTurboGovernorSampler,
  getFastConcurrencyAllowance,
  reportTurboOutcome,
} from './turboGovernor.js'

export const FAST_ENV_VAR = 'CCLITE_TURBO'
export const FAST_HEDGES_ENV_VAR = 'CCLITE_TURBO_HEDGES'
export const FAST_HEDGE_DELAY_MS_ENV_VAR = 'CCLITE_TURBO_HEDGE_DELAY_MS'
export const FAST_ATTEMPT_TIMEOUT_MS_ENV_VAR = 'CCLITE_TURBO_ATTEMPT_TIMEOUT_MS'

const MAX_HEDGE_ATTEMPTS = 4
const DEFAULT_HEDGE_ATTEMPTS = 2
const DEFAULT_HEDGE_DELAY_MS = 8_000
// Pre-win drain cap: before any attempt has shown progress, nobody is
// consuming the wrapped stream yet, so the tap self-drives reads and buffers
// chunks in order. A real provider emits its first `data:` line within a few
// bytes; if an upstream streams only filler (SSE comments/heartbeats) past
// this many bytes without a data line, the attempt is failed instead of
// buffering without bound.
const PRE_WIN_DRAIN_CAP_BYTES = 1_000_000

/** Whether fast mode is currently enabled (checked per request, hot-toggleable via /fast). */
export function isCcliteTurboEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvTruthy(env[FAST_ENV_VAR])
}

export interface FastHedgeConfig {
  /** Total attempts including the original request (>= 2 when hedging). */
  attempts: number
  /** Stagger between attempt starts, in milliseconds. */
  delayMs: number
  /** Per-attempt no-progress abort guard, ms (0 = off). */
  attemptTimeoutMs: number
}

/**
 * Resolve the hedge configuration, or null when fast mode is off/disabled.
 * Read per request so /fast toggles apply without a restart. The governor
 * may further reduce `attempts` at launch time under pressure.
 */
export function resolveFastHedgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): FastHedgeConfig | null {
  if (!isCcliteTurboEnabled(env)) return null

  const parsedAttempts = parseInt(env[FAST_HEDGES_ENV_VAR] ?? '', 10)
  const attempts = Number.isFinite(parsedAttempts)
    ? Math.min(Math.max(parsedAttempts, 1), MAX_HEDGE_ATTEMPTS)
    : DEFAULT_HEDGE_ATTEMPTS

  const parsedDelay = parseInt(env[FAST_HEDGE_DELAY_MS_ENV_VAR] ?? '', 10)
  const delayMs =
    Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : DEFAULT_HEDGE_DELAY_MS

  const parsedTimeout = parseInt(env[FAST_ATTEMPT_TIMEOUT_MS_ENV_VAR] ?? '', 10)
  const attemptTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 0

  if (attempts <= 1) return null
  return { attempts, delayMs, attemptTimeoutMs }
}

/** Human-readable one-liner describing the active hedge settings. */
export function describeFastHedge(config: FastHedgeConfig): string {
  const timeoutNote =
    config.attemptTimeoutMs > 0
      ? `, per-attempt stall timeout ${config.attemptTimeoutMs}ms`
      : ''
  return (
    `${config.attempts} concurrent attempts, staggered ${config.delayMs}ms${timeoutNote}; ` +
    `fastest stream wins, losers are aborted; concurrency auto-adapts to load`
  )
}

/**
 * SSE progress probe: a chunk counts as progress once it contains a complete
 * `data:` line (server heartbeats are comment lines starting with ':' and do
 * not count).
 */
export function sseDataLineProgress(chunk: string): boolean {
  return /(^|\n)data:/.test(chunk)
}

/** Probe for non-streaming bodies: any byte is progress. */
export function anyBytesProgress(chunk: string): boolean {
  return chunk.length > 0
}

export interface HedgedRequestOptions {
  attempts: number
  delayMs: number
  /** Caller's signal; when aborted, all attempts abort and the request fails. */
  parentSignal?: AbortSignal
  /** Decides whether a decoded body chunk counts as "real progress". */
  probe?: (chunk: string) => boolean
  /**
   * Anti-freeze guard: abort an attempt that has produced no progress within
   * this many milliseconds (the race continues on the remaining attempts).
   * 0 disables. Fed from CCLITE_TURBO_ATTEMPT_TIMEOUT_MS.
   */
  attemptTimeoutMs?: number
}

interface AttemptState {
  controller: AbortController
  won: boolean
  failed: boolean
  timedOut?: boolean
  timeoutTimer?: ReturnType<typeof setTimeout>
  reported?: boolean
}

/**
 * Run the same request up to `attempts` times, `delayMs` apart. Resolves with
 * a wrapped Response of the FIRST attempt that produces progress; all other
 * attempts are aborted. Rejects only when every attempt fails (or the parent
 * signal aborts). The winner's body is fully preserved — chunks already read
 * while racing are buffered inside the returned stream.
 */
export async function hedgedRequest(
  start: (signal: AbortSignal) => Promise<Response>,
  opts: HedgedRequestOptions,
): Promise<Response> {
  const probe = opts.probe ?? anyBytesProgress
  // Dynamic concurrency: never launch more attempts than the governor's
  // current allowance says are safe for local resources / provider quota.
  const ceiling = Math.max(1, opts.attempts)
  const total = Math.max(1, Math.min(ceiling, getFastConcurrencyAllowance()))
  if (total > 1) ensureTurboGovernorSampler()

  return new Promise<Response>((resolve, reject) => {
    const attempts: AttemptState[] = []
    const timers: ReturnType<typeof setTimeout>[] = []
    let done = false
    let launched = 0
    let failedCount = 0
    let lastError: unknown

    const cleanupTimers = () => {
      for (const t of timers) clearTimeout(t)
      timers.length = 0
    }
    const onParentAbort = () => {
      finishReject(new Error('Hedged request aborted'))
    }

    function upstreamStatus(error: unknown): number | undefined {
      const status = (error as { status?: unknown } | null)?.status
      return typeof status === 'number' ? status : undefined
    }

    /** Our own aborts (lost the race) are not provider faults; timeouts are. */
    function wasSelfAborted(attempt: AttemptState): boolean {
      return attempt.controller.signal.aborted && !attempt.timedOut
    }

    /**
     * Anti-freeze: give up on an attempt showing no progress within N ms —
     * armed at launch so it covers connect + headers + first byte, not just
     * body streaming. The race continues on the remaining attempts.
     */
    function armAttemptTimeout(attempt: AttemptState): void {
      const ms = opts.attemptTimeoutMs ?? 0
      if (ms <= 0 || done) return
      const timer = setTimeout(() => {
        if (done || attempt.won || attempt.failed) return
        attempt.timedOut = true
        penalize(attempt)
        attempt.controller.abort()
      }, ms)
      attempt.timeoutTimer = timer
      timers.push(timer)
    }

    /** Report one provider-side failure to the governor (dedup + self-abort aware). */
    function penalize(attempt: AttemptState, status?: number): void {
      if (attempt.reported || attempt.won || wasSelfAborted(attempt)) return
      attempt.reported = true
      reportTurboOutcome(false, status)
    }

    function disarmAttemptTimeout(attempt: AttemptState): void {
      if (attempt.timeoutTimer !== undefined) {
        clearTimeout(attempt.timeoutTimer)
        attempt.timeoutTimer = undefined
      }
    }

    if (opts.parentSignal?.aborted) {
      reject(new Error('Hedged request aborted before start'))
      return
    }
    opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

    function finishReject(error: unknown): void {
      if (done) return
      done = true
      cleanupTimers()
      opts.parentSignal?.removeEventListener('abort', onParentAbort)
      for (const attempt of attempts) attempt.controller.abort()
      reject(error)
    }

    function finishResolve(response: Response): void {
      if (done) return
      done = true
      cleanupTimers()
      opts.parentSignal?.removeEventListener('abort', onParentAbort)
      // Abort everything except the winner.
      for (const attempt of attempts) {
        if (!attempt.won) attempt.controller.abort()
      }
      reportTurboOutcome(true)
      resolve(response)
    }

    function checkAllFailed(): void {
      if (done) return
      if (launched === total && failedCount === total) {
        finishReject(
          lastError instanceof Error
            ? lastError
            : new Error(`All ${total} hedged attempts failed`),
        )
      }
    }

    /**
     * Wrap the ok Response in a pass-through stream that watches decoded text.
     * The attempt wins as soon as the accumulated body matches `probe`. If the
     * upstream ends or errors without ever producing progress, the attempt
     * counts as failed.
     *
     * Before this attempt wins, NO consumer is reading `wrapped` yet (the
     * caller only starts reading the Response `hedgedRequest` resolves with),
     * so a single `enqueue` per `pull` would fill the queue to its high-water
     * mark and `pull` would never be called again — the promise could hang
     * forever on a stream whose first chunk is an SSE comment/heartbeat. To
     * avoid that, pre-win reads are self-driven in a loop and every chunk is
     * enqueued in order; once the attempt wins we revert to one read per pull
     * so normal backpressure resumes for the real consumer.
     */
    function tapResponse(attempt: AttemptState, response: Response): Response {
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let acc = ''
      let drainedBytes = 0
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (!attempt.won) {
              const { done: readerDone, value } = await reader.read()
              if (readerDone) {
                if (!attempt.won) {
                  attempt.failed = true
                  failedCount++
                  penalize(attempt)
                  checkAllFailed()
                }
                controller.close()
                return
              }
              drainedBytes += value.byteLength
              acc += decoder.decode(value, { stream: true })
              // Probe accumulated text (not just this chunk) so a `data:` line
              // split across a chunk boundary still counts as progress.
              if (probe(acc)) {
                attempt.won = true
                disarmAttemptTimeout(attempt)
                // Resolve BEFORE enqueueing so no winner byte is ever lost.
                finishResolve(wrapped)
                controller.enqueue(value)
                return
              }
              controller.enqueue(value)
              // Retain only the current partial line: text after the last
              // newline genuinely starts a line, so the probe's `^` anchor
              // stays correct while the buffer can't grow past one line.
              const lastNewline = acc.lastIndexOf('\n')
              if (lastNewline !== -1) acc = acc.slice(lastNewline + 1)
              // A stream that emits only filler forever would otherwise buffer
              // without bound (nobody is draining a not-yet-won attempt). Fail
              // it instead so the race continues / rejects cleanly.
              if (drainedBytes > PRE_WIN_DRAIN_CAP_BYTES) {
                attempt.failed = true
                failedCount++
                penalize(attempt)
                checkAllFailed()
                void reader.cancel().catch(() => {})
                controller.close()
                return
              }
            }
            // Post-win: one read per pull, so the real consumer's backpressure
            // governs the pace.
            const { done: readerDone, value } = await reader.read()
            if (readerDone) {
              controller.close()
              return
            }
            controller.enqueue(value)
          } catch (error) {
            if (!attempt.won) {
              attempt.failed = true
              failedCount++
              lastError = error
              penalize(attempt, upstreamStatus(error))
              checkAllFailed()
            }
            controller.error(error)
          }
        },
        cancel(reason) {
          void reader.cancel(reason).catch(() => {})
        },
      })
      const wrapped = new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      return wrapped
    }

    async function run(): Promise<void> {
      launched++
      const attempt: AttemptState = {
        controller: new AbortController(),
        won: false,
        failed: false,
      }
      attempts.push(attempt)
      armAttemptTimeout(attempt)
      try {
        const response = await start(attempt.controller.signal)
        if (!response.ok || !response.body) {
          // Drain what we can so the socket is released, then count as failed.
          await response.body?.cancel().catch(() => {})
          penalize(attempt, response.status)
          throw new Error(`upstream returned HTTP ${response.status}`)
        }
        tapResponse(attempt, response)
      } catch (error) {
        if (!attempt.won) {
          attempt.failed = true
          failedCount++
          lastError = error
          penalize(attempt, upstreamStatus(error))
          checkAllFailed()
        }
      }
    }

    for (let i = 0; i < total; i++) {
      const delay = i * Math.max(0, opts.delayMs)
      if (delay === 0) {
        void run()
      } else {
        timers.push(setTimeout(() => void run(), delay))
      }
    }
  })
}
