import { beforeEach, describe, expect, it } from 'bun:test'
import {
  sseDataLineProgress,
  hedgedRequest,
} from './hedgedRequest.js'
import {
  getFastConcurrencyAllowance,
  getTurboGovernorSnapshot,
  reportTurboOutcome,
  resetTurboGovernorForTests,
} from './turboGovernor.js'

function sseResponse(chunks: unknown[], delayMs = 0): Response {
  const body = chunks
    .map(c => `data: ${JSON.stringify(c)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const baseOpts = (attempts: number, delayMs = 5) => ({
  attempts,
  delayMs,
  probe: sseDataLineProgress,
})

describe('hedgedRequest dynamic concurrency', () => {
  beforeEach(() => {
    process.env.CCLITE_TURBO = '1' // outcome reporting is active
    delete process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY
    resetTurboGovernorForTests()
  })

  it('respects the governor allowance — clamps launched attempts', async () => {
    for (let i = 0; i < 10; i++) reportTurboOutcome(false, 503) // allowance -> 1
    expect(getFastConcurrencyAllowance()).toBe(1)
    let started = 0
    const response = await hedgedRequest(
      async () => {
        started++
        return sseResponse([{ choices: [{ index: 0, delta: { content: 'x' } }] }])
      },
      baseOpts(4),
    )
    await response.text()
    expect(started).toBe(1)
  })

  it('a losing attempt aborted mid-race is not reported as a provider fault', async () => {
    const aborted = [false, false]
    let call = 0
    const response = await hedgedRequest(
      async signal => {
        const idx = call++
        return new Promise<Response>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted[idx] = true
            reject(new Error('aborted'))
          })
          if (idx === 0) {
            // First attempt wins after a short delay.
            setTimeout(
              () =>
                resolve(
                  sseResponse([{ choices: [{ index: 0, delta: { content: 'win' } }] }]),
                ),
              30,
            )
          }
          // Second attempt hangs until the race aborts it.
        })
      },
      baseOpts(2, 5),
    )
    await response.text()
    expect(aborted[1]).toBe(true)
    expect(aborted[0]).toBe(false)
    const kinds = getTurboGovernorSnapshot().recent.map(r => r.kind)
    expect(kinds).toEqual(['ok'])
  })

  it('a 429/500 on one attempt is penalized even while another wins', async () => {
    const response = await hedgedRequest(
      async signal => {
        void signal
        return sseResponse([{ choices: [{ index: 0, delta: { content: 'slow-win' } }] }], 40)
      },
      {
        ...baseOpts(2, 1),
        // First launch errors immediately with a server failure.
      },
    )
    void response

    // Deterministic variant: first start returns HTTP 500, second (staggered)
    // streams fine and wins.
    resetTurboGovernorForTests()
    let call = 0
    const res2 = await hedgedRequest(async () => {
      call++
      if (call === 1) return new Response('{"error":"boom"}', { status: 500 })
      return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' } }] }], 10)
    }, baseOpts(2, 5))
    expect(await res2.text()).toContain('ok')
    const kinds = getTurboGovernorSnapshot().recent.map(r => r.kind)
    expect(kinds).toContain('rate_limited')
    expect(kinds).toContain('ok')
    expect(getFastConcurrencyAllowance()).toBeLessThan(20)
  })

  it('attempt timeout aborts a silent attempt without killing the race', async () => {
    let timedOutSeen = false
    let call = 0
    const response = await hedgedRequest(
      async signal =>
        new Promise<Response>((resolve, reject) => {
          const idx = call++
          signal.addEventListener('abort', () => {
            if (idx === 0) timedOutSeen = true
            reject(new Error('aborted'))
          })
          if (idx === 1) {
            // Launches at t≈30ms, delivers at t≈80ms — after the first
            // attempt was reaped (t=60ms) but before its own timeout
            // (t=90ms).
            setTimeout(
              () =>
                resolve(
                  sseResponse([{ choices: [{ index: 0, delta: { content: 'late-win' } }] }]),
                ),
              50,
            )
          }
          // First attempt NEVER produces progress — must be reaped.
        }),
      {
        attempts: 2,
        delayMs: 30,
        attemptTimeoutMs: 60,
        probe: sseDataLineProgress,
      },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('late-win')
    expect(timedOutSeen).toBe(true)
    // The silent attempt was reported as a failure to the governor.
    const kinds = getTurboGovernorSnapshot().recent.map(r => r.kind)
    expect(kinds).toContain('error')
    expect(kinds).toContain('ok')
  })

  it('rejects when the parent signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      hedgedRequest(async () => sseResponse([]), { ...baseOpts(2), parentSignal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
  })
})
