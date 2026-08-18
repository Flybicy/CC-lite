import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRemoteEmbeddingBackend,
  resetEmbeddingMemoryCacheForTests,
  resolveEffectiveProtocol,
  resolveEmbeddingConfig,
} from './embeddings.js'

describe('resolveEffectiveProtocol', () => {
  it('honours an explicit protocol', () => {
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'https://x/v1', apiKey: '', protocol: 'ollama' })).toBe('ollama')
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'http://h:11434/api', apiKey: '', protocol: 'openai' })).toBe('openai')
  })

  it('auto-detects Ollama by /api path or port 11434', () => {
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'http://localhost:11434/api', apiKey: '' })).toBe('ollama')
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'http://localhost:11434', apiKey: '' })).toBe('ollama')
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'https://api.openai.com/v1', apiKey: '' })).toBe('openai')
    expect(resolveEffectiveProtocol({ model: 'm', baseUrl: 'https://embed.example.com/v1', apiKey: '' })).toBe('openai')
  })
})

describe('resolveEmbeddingConfig protocol env', () => {
  const saved: Record<string, string | undefined> = {}
  const names = [
    'CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL',
    'CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL',
    'CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL',
  ]
  beforeEach(() => {
    for (const n of names) saved[n] = process.env[n]
    process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL = 'test-model'
  })
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n]
      else process.env[n] = saved[n]
    }
  })

  it('defaults to auto when unset', () => {
    delete process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL
    expect(resolveEmbeddingConfig()!.protocol).toBe('auto')
  })

  it('reads explicit openai/ollama values case-insensitively', () => {
    process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL = 'Ollama'
    expect(resolveEmbeddingConfig()!.protocol).toBe('ollama')
    process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL = 'openai'
    expect(resolveEmbeddingConfig()!.protocol).toBe('openai')
  })

  it('treats unknown values as auto', () => {
    process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL = 'weird'
    expect(resolveEmbeddingConfig()!.protocol).toBe('auto')
  })
})

describe('remote backend over the Ollama native protocol', () => {
  const originalFetch = globalThis.fetch
  let cacheDir: string
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'claudium-embed-ollama-'))
    process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR = cacheDir
    resetEmbeddingMemoryCacheForTests()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('posts to /api/embed and parses {embeddings}', async () => {
    const seen: Array<{ url: string; body: any }> = []
    globalThis.fetch = (async (url: any, init: any) => {
      const body = JSON.parse(String(init.body))
      seen.push({ url: String(url), body })
      return new Response(JSON.stringify({
        embeddings: body.input.map((t: string) => [t.length, 1]),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const backend = createRemoteEmbeddingBackend({
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      protocol: 'auto',
    })
    const vectors = await backend.embed(['ab', 'c'])
    expect(vectors).toHaveLength(2)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('http://localhost:11434/api/embed')
    expect(seen[0]!.body.model).toBe('nomic-embed-text')
    expect(seen[0]!.body.input).toEqual(['ab', 'c'])
    // first vector raw [2,1] normalized
    const norm = Math.sqrt(5)
    expect(vectors[0]![0]!).toBeCloseTo(2 / norm, 5)
  })

  it('uses {base}/embed when the base already ends in /api', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push(String(url))
      const body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        embeddings: body.input.map(() => [1, 0]),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const backend = createRemoteEmbeddingBackend({
      model: 'm',
      baseUrl: 'http://localhost:11434/api',
      apiKey: '',
    })
    await backend.embed(['x'])
    expect(seen[0]).toBe('http://localhost:11434/api/embed')
  })

  it('surfaces Ollama error payloads', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: 'model not found' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const backend = createRemoteEmbeddingBackend({
      model: 'missing',
      baseUrl: 'http://localhost:11434',
      apiKey: '',
    })
    await expect(backend.embed(['x'])).rejects.toThrow(/model not found/)
  })

  it('explicit openai protocol on an Ollama host still hits /embeddings', async () => {
    const seen: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push(String(url))
      const body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({
        data: body.input.map((t: string, index: number) => ({ index, embedding: [1, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const backend = createRemoteEmbeddingBackend({
      model: 'm',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      protocol: 'openai',
    })
    await backend.embed(['x'])
    expect(seen[0]).toBe('http://localhost:11434/v1/embeddings')
  })
})
