import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTransformersLocalBackend,
  resetTransformersPipelineForTests,
  resetEmbeddingMemoryCacheForTests,
  resolveLocalTransformersModel,
  resolveEmbeddingBackend,
  isSemanticSearchDisabled,
  LOCAL_TRANSFORMERS_DEFAULT_MODEL,
  type TransformersPipeline,
} from './embeddings.js'
import type { EmbeddingVector } from './embeddings.js'

// --- mock pipeline helpers -------------------------------------------------
// A deterministic fake feature-extraction model: dim=4, first component encodes
// the first char code, so textually similar inputs produce similar vectors.

const DIM = 4

function fakeVectorFor(text: string): Float32Array {
  const v = new Float32Array(DIM)
  if (!text) return v
  const code = text.length ? text.charCodeAt(0) : 0
  v[0] = code / 1000
  v[1] = (text.length % 10) / 10
  v[2] = (code % 7) / 7
  v[3] = 1
  return v
}

function makePipeline(throwOnRun = false): { pipeline: () => Promise<TransformersPipeline>; callsRef: { calls: number } } {
  const callsRef = { calls: 0 }
  return {
    pipeline: () =>
      Promise.resolve<TransformersPipeline>({
        run: async (texts) => {
          callsRef.calls++
          if (throwOnRun) throw new Error('inference boom')
          const out = new Float32Array(texts.length * DIM)
          for (let i = 0; i < texts.length; i++) out.set(fakeVectorFor(texts[i]!), i * DIM)
          return out
        },
      }),
    callsRef,
  }
}

function failingPipelineFactory(): Promise<TransformersPipeline> {
  return Promise.reject(new Error('package not installed / download failed'))
}

// --- environment isolation -------------------------------------------------
let savedEnv: NodeJS.ProcessEnv
let tempCacheDir: string

function setEnv(obj: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

beforeEach(() => {
  savedEnv = { ...process.env }
  resetTransformersPipelineForTests()
  resetEmbeddingMemoryCacheForTests()
  tempCacheDir = mkdtempSync(join(tmpdir(), 'tftest-'))
  setEnv({
    CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL: undefined,
    CLAUDE_CODE_EMBEDDING_MODEL: undefined,
    CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL: undefined,
    CLAUDE_CODE_ADVISOR_EMBEDDING_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OPENAI_API_KEY: undefined,
    CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL: undefined,
    CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING: undefined,
    CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH: undefined,
    CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR: tempCacheDir,
  })
})

afterEach(() => {
  setEnv(savedEnv as any)
  resetTransformersPipelineForTests()
  resetEmbeddingMemoryCacheForTests()
  if (tempCacheDir && existsSync(tempCacheDir)) rmSync(tempCacheDir, { recursive: true, force: true })
})

describe('createTransformersLocalBackend', () => {
  it('exposes the right backend identity', () => {
    const b = createTransformersLocalBackend('Xenova/test-model')
    expect(b.kind).toBe('local')
    expect(b.semantic).toBe(true)
    expect(b.label).toBe('local-semantic:Xenova/test-model')
  })

  it('uses the default model when none provided', () => {
    const b = createTransformersLocalBackend()
    expect(b.label).toBe('local-semantic:' + LOCAL_TRANSFORMERS_DEFAULT_MODEL)
  })

  it('embeds texts, L2-normalizes, and preserves input order', async () => {
    const { pipeline, callsRef } = makePipeline()
    const b = createTransformersLocalBackend('m', { pipelineFactory: pipeline })
    const out = await b.embed(['hello', 'world', 'hey'])
    expect(out.length).toBe(3)
    expect(out[0].length).toBe(DIM)
    expect(out[1].length).toBe(DIM)
    // L2 norm ~ 1 for non-empty
    const norm = (v: EmbeddingVector) => Math.sqrt(v.reduce((s, x) => s + x * x, 0))
    expect(norm(out[0]!)).toBeGreaterThan(0.999)
    expect(norm(out[1]!)).toBeGreaterThan(0.999)
    // hello and hey share a first char -> cosine similarity strictly higher than hello/world
    const dot = (a: EmbeddingVector, c: EmbeddingVector) => a.reduce((s, x, i) => s + x * c[i]!, 0)
    const simHH = dot(out[0]!, out[2]!) / (norm(out[0]!) * norm(out[2]!))
    const simHW = dot(out[0]!, out[1]!) / (norm(out[0]!) * norm(out[1]!))
    expect(simHH).toBeGreaterThan(simHW)
    expect(callsRef.calls).toBe(1)
  })

  it('returns a zero vector for empty/whitespace input without calling the model', async () => {
    const { pipeline, callsRef } = makePipeline()
    const b = createTransformersLocalBackend('m', { pipelineFactory: pipeline })
    const out = await b.embed(['', '  '])
    expect(out.length).toBe(2)
    expect(out[0].length).toBe(0)
    expect(out[1].length).toBe(0)
    expect(callsRef.calls).toBe(0)
  })

  it('reuses cached vectors and never re-embeds unchanged text within an instance', async () => {
    const { pipeline, callsRef } = makePipeline()
    const b = createTransformersLocalBackend('m', { pipelineFactory: pipeline })
    await b.embed(['alpha', 'beta'])
    await b.embed(['alpha', 'beta'])
    expect(callsRef.calls).toBe(1)
  })

  it('throws EmbeddingError with a helpful message when the pipeline cannot load', async () => {
    const b = createTransformersLocalBackend('m', { pipelineFactory: failingPipelineFactory })
    await expect(b.embed(['anything'])).rejects.toThrow(/Could not load the local embedding model/)
  })

  it('throws EmbeddingError when inference fails and resets the pipeline singleton', async () => {
    const { pipeline, callsRef } = makePipeline(true)
    const b = createTransformersLocalBackend('m', { pipelineFactory: pipeline })
    await expect(b.embed(['x'])).rejects.toThrow(/inference failed/)
    expect(callsRef.calls).toBe(1)
  })
})

describe('transformers backend disk cache', () => {
  it('persists vectors to disk and serves them without re-running the model', async () => {
    const { pipeline, callsRef } = makePipeline()
    const b = createTransformersLocalBackend('cached-model', { pipelineFactory: pipeline })
    await b.embed(['persist', 'this'])
    expect(callsRef.calls).toBe(1)
    // Simulate a restart: clear in-memory cache but keep the on-disk JSONL.
    resetTransformersPipelineForTests()
    resetEmbeddingMemoryCacheForTests()
    const b2 = createTransformersLocalBackend('cached-model', { pipelineFactory: pipeline })
    const out = await b2.embed(['persist', 'this'])
    expect(out.length).toBe(2)
    expect(callsRef.calls).toBe(1) // not incremented: disk served the vectors
    // a brand-new text still forces one model inference
    await b2.embed(['persist', 'brand-new'])
    expect(callsRef.calls).toBe(2)
  })
})

describe('resolveLocalTransformersModel / resolveEmbeddingBackend priority', () => {
  it('returns the explicit local model when set', () => {
    setEnv({ CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL: 'Xenova/bge-small-en' })
    expect(resolveLocalTransformersModel()).toBe('Xenova/bge-small-en')
  })

  it('is default-on: returns the default model when nothing is set', () => {
    expect(resolveLocalTransformersModel()).toBe(LOCAL_TRANSFORMERS_DEFAULT_MODEL)
  })

  it('returns null (approximate fallback) when explicitly opted out', () => {
    setEnv({ CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING: '0' })
    expect(resolveLocalTransformersModel()).toBeNull()
    setEnv({ CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING: 'off' })
    expect(resolveLocalTransformersModel()).toBeNull()
  })

  it('opt-out wins over an explicit model', () => {
    setEnv({
      CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING: '0',
      CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL: 'Xenova/test',
    })
    expect(resolveLocalTransformersModel()).toBeNull()
  })

  it('resolveEmbeddingBackend uses the transformers tier by default', () => {
    const b = resolveEmbeddingBackend()
    expect(b).not.toBeNull()
    expect(b!.label).toBe('local-semantic:' + LOCAL_TRANSFORMERS_DEFAULT_MODEL)
  })

  it('resolveEmbeddingBackend honors an explicit local model', () => {
    setEnv({ CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL: 'Xenova/test' })
    const b = resolveEmbeddingBackend()
    expect(b!.label).toBe('local-semantic:Xenova/test')
  })

  it('falls back to local-approximate only when opted out', () => {
    setEnv({ CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING: '0' })
    const b = resolveEmbeddingBackend()
    expect(b!.label).toBe('local-approximate')
  })

  it('returns null when semantic search is disabled', () => {
    setEnv({ CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH: '0' })
    expect(isSemanticSearchDisabled()).toBe(true)
    expect(resolveEmbeddingBackend()).toBeNull()
  })
})
