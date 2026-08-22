import { describe, expect, it } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { isBalanceError } from './withRetry.js'

function makeApiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, new Headers())
}

describe('isBalanceError', () => {
  it('flags HTTP 402 as a balance error', () => {
    expect(isBalanceError(makeApiError(402, 'Payment Required'))).toBe(true)
  })

  it('flags English credit-balance messaging on 400', () => {
    expect(
      isBalanceError(
        makeApiError(
          400,
          'Your credit balance is too low to access the Anthropic API. Please purchase more credits.',
        ),
      ),
    ).toBe(true)
  })

  it('flags Chinese balance wording used by domestic relays', () => {
    expect(isBalanceError(makeApiError(403, '账户余额不足，请充值'))).toBe(true)
  })

  it('flags insufficient-quota wording', () => {
    expect(isBalanceError(makeApiError(429, 'insufficient_quota'))).toBe(true)
  })

  it('does not flag a plain rate limit', () => {
    expect(isBalanceError(makeApiError(429, 'rate limit reached'))).toBe(false)
  })

  it('does not flag auth failures', () => {
    expect(isBalanceError(makeApiError(401, 'invalid x-api-key'))).toBe(false)
  })

  it('does not flag non-API errors', () => {
    expect(isBalanceError(new Error('socket hang up'))).toBe(false)
  })
})
