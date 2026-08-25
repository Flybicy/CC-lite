import { describe, expect, it } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { performCodexRequest } from './codexShim.js'
import { isBalanceError } from './withRetry.js'

function makeRequest(overrides?: Partial<Parameters<typeof performCodexRequest>[0]['request']>) {
  return {
    transport: 'responses' as const,
    backend: 'codex' as const,
    requestedModel: 'codexplan',
    resolvedModel: 'gpt-5.4',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    reasoning: { effort: 'high' as const },
    ...overrides,
  }
}

const credentials = { apiKey: 'test-key', accountId: 'acct_test', source: 'env' as const }

const params = {
  model: 'codexplan',
  messages: [{ role: 'user', message: { role: 'user', content: 'hi' } }],
  max_tokens: 100,
  stream: false,
}

describe('performCodexRequest error classification', () => {
  it('throws an APIError (not a plain Error) on upstream non-2xx so withRetry can classify it', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 503,
        statusText: 'Service Unavailable',
      })) as typeof fetch
    try {
      let err: unknown
      try {
        await performCodexRequest({ request: makeRequest(), credentials, params })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(APIError)
      expect((err as APIError).status).toBe(503)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('surfaces a balance-style Codex failure in a shape isBalanceError recognizes', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: '预扣费额度失败, 用户剩余额度不足' } }), {
        status: 403,
        statusText: 'Forbidden',
      })) as typeof fetch
    try {
      let err: unknown
      try {
        await performCodexRequest({ request: makeRequest(), credentials, params })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(APIError)
      expect(isBalanceError(err)).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
