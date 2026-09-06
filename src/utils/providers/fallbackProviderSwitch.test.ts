// ---------------------------------------------------------------------------
// Regression tests: tier fallback (opus→sonnet→haiku) must swap the WHOLE provider
// connection — baseURL + apiKey + per-provider headers — not just the model
// string. Also pins down the OpenAI-shim transport selection rules that apply
// to WebUI-configured ("openai 兼容") providers.
// ---------------------------------------------------------------------------

// Build-time MACRO shim must come first — client.ts → getUserAgent() reads
// MACRO.VERSION, which only exists once this has run.
import '../../macrosFallback.js'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Must be set before first registry access (lazy reads, but be explicit).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cclite-fallback-'))

import {
  saveProviderConfig,
  type ProviderConfig,
} from './providerRegistry.js'
import { resolveTierConnectionByTier } from './tierResolver.js'
import { getAnthropicClient } from '../../services/api/client.js'
import { resolveProviderRequest } from '../../services/api/providerConfig.js'

const config: ProviderConfig = {
  version: 2,
  providers: [
    {
      id: 'relay-a',
      label: 'Relay A (openai)',
      type: 'openai',
      baseURL: 'https://relay-a.example/v1',
      apiKey: 'key-a',
      models: ['m-a'],
      headers: { 'User-Agent': 'agent-a/1' },
    },
    {
      id: 'relay-b',
      label: 'Relay B (anthropic)',
      type: 'anthropic',
      baseURL: 'https://relay-b.example',
      apiKey: 'key-b',
      models: ['m-b'],
      headers: { 'x-app': 'b-app' },
    },
    {
      id: 'relay-a2',
      label: 'Relay A duplicate binding',
      type: 'openai',
      baseURL: 'https://relay-a.example/v1',
      apiKey: 'key-a',
      models: ['m-a'],
    },
  ],
  tiers: {
    opus: { providerId: 'relay-a', model: 'm-a' },
    sonnet: { providerId: 'relay-b', model: 'm-b' },
    haiku: { providerId: 'relay-a2', model: 'm-a' },
  },
}
saveProviderConfig(config)

type Captured = { url: string; headers: Record<string, string> }
const captured: Captured[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : ((input as Request)?.url ?? String(input))
  const hdrs: Record<string, string> = {}
  new Headers(
    init?.headers ?? (input as Request | undefined)?.headers,
  ).forEach((v, k) => {
    hdrs[k] = v
  })
  captured.push({ url: String(url), headers: hdrs })
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      model: 'm-a',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}) as typeof fetch

function lastCapture(): Captured {
  const c = captured.at(-1)
  if (!c) throw new Error('no request was captured')
  return c
}

describe('tier fallback swaps the provider connection, not just the model', () => {
  test('chain targets resolve to different providers', () => {
    const opus = resolveTierConnectionByTier('opus')
    const sonnet = resolveTierConnectionByTier('sonnet')
    expect(opus.source).toBe('routing')
    expect(sonnet.source).toBe('routing')
    if (opus.source !== 'routing' || sonnet.source !== 'routing') return
    // Different baseURL AND apiKey AND headers — i.e. a real provider hop.
    expect(opus.baseURL).not.toBe(sonnet.baseURL)
    expect(opus.apiKey).not.toBe(sonnet.apiKey)
    expect(opus.headers).toEqual({ 'User-Agent': 'agent-a/1' })
    expect(sonnet.headers).toEqual({ 'x-app': 'b-app' })
  })

  test('haiku bound identically to opus → identical connection (no-op hop premise)', () => {
    const opus = resolveTierConnectionByTier('opus')
    const haiku = resolveTierConnectionByTier('haiku')
    if (opus.source !== 'routing' || haiku.source !== 'routing') return
    expect(haiku.baseURL).toBe(opus.baseURL)
    expect(haiku.apiKey).toBe(opus.apiKey)
    expect(haiku.model).toBe(opus.model)
  })

  test('request follows the switched tier end-to-end (baseURL + key + headers)', async () => {
    // "opus" request → Relay A, openai shim, provider headers applied.
    const proClient = (await getAnthropicClient({
      maxRetries: 0,
      tierOverride: 'opus',
    })) as unknown as {
      beta: { messages: { create: (p: unknown) => Promise<unknown> } }
    }
    await proClient.beta.messages.create({
      model: 'm-a',
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    })
    const proReq = lastCapture()
    expect(proReq.url).toBe('https://relay-a.example/v1/chat/completions')
    expect(proReq.headers['authorization']).toBe('Bearer key-a')
    expect(proReq.headers['user-agent']).toBe('agent-a/1')

    // Simulated fallback hop → "sonnet": SAME call site, different provider.
    const plusClient = (await getAnthropicClient({
      maxRetries: 0,
      tierOverride: 'sonnet',
    })) as unknown as {
      beta: { messages: { create: (p: unknown) => Promise<unknown> } }
    }
    try {
      await plusClient.beta.messages.create({
        model: 'm-b',
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      })
    } catch {
      // Anthropic-format parse of the stubbed OpenAI body may throw; the
      // captured request is what this test asserts on.
    }
    const plusReq = lastCapture()
    expect(plusReq.url.startsWith('https://relay-b.example')).toBe(true)
    expect(plusReq.url.split('?')[0].endsWith('/messages')).toBe(true)
    expect(plusReq.headers['x-api-key']).toBe('key-b')
    // Provider-specific headers swapped with the tier…
    expect(plusReq.headers['x-app']).toBe('b-app')
    // …and Relay A's User-Agent did NOT leak into Relay B's request.
    expect(plusReq.headers['user-agent']).not.toBe('agent-a/1')
    expect(plusReq.headers['authorization']).toBeUndefined()
  })
})

describe('openai-compatible transport selection (WebUI providers)', () => {
  test('third-party baseURL defaults to chat_completions', () => {
    expect(
      resolveProviderRequest({
        model: 'm-a',
        baseUrl: 'https://relay-a.example/v1',
      }).transport,
    ).toBe('chat_completions')
  })

  test('reasoning-suffix model only upgrades to responses on official OpenAI', () => {
    expect(
      resolveProviderRequest({
        model: 'gpt-5.1?reasoning=high',
        baseUrl: 'https://api.openai.com/v1',
      }).transport,
    ).toBe('responses')
    expect(
      resolveProviderRequest({
        model: 'gpt-5.1?reasoning=high',
        baseUrl: 'https://relay-a.example/v1',
      }).transport,
    ).toBe('chat_completions')
  })

  test('OPENAI_API_MODE=responses forces /responses even for third-party relays', () => {
    const prev = process.env.OPENAI_API_MODE
    try {
      process.env.OPENAI_API_MODE = 'responses'
      const resolved = resolveProviderRequest({
        model: 'm-a',
        baseUrl: 'https://relay-a.example/v1',
      })
      expect(resolved.transport).toBe('responses')
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_MODE
      else process.env.OPENAI_API_MODE = prev
    }
  })

  test('forced responses mode changes the actual request URL', async () => {
    const prev = process.env.OPENAI_API_MODE
    try {
      process.env.OPENAI_API_MODE = 'responses'
      const client = (await getAnthropicClient({
        maxRetries: 0,
        tierOverride: 'opus',
      })) as unknown as {
        beta: { messages: { create: (p: unknown) => Promise<unknown> } }
      }
      try {
        await client.beta.messages.create({
          model: 'm-a',
          max_tokens: 16,
          stream: false,
          messages: [{ role: 'user', content: 'hi' }],
        })
      } catch {
        // codex-style response parsing of the chat-completions stub may throw;
        // only the captured URL matters here.
      }
      expect(lastCapture().url).toBe('https://relay-a.example/v1/responses')
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_MODE
      else process.env.OPENAI_API_MODE = prev
    }
  })
})
