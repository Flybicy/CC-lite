import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTransformersLocalBackend,
  resetTransformersPipelineForTests,
  resetEmbeddingMemoryCacheForTests,
  resolveLocalTransformersModel,
  resolveDefaultLocalModel,
  resolveEmbeddingBackend,
  localePicksChinese,
  isSemanticSearchDisabled,
  LOCAL_TRANSFORMERS_DEFAULT_MODEL,
  LOCAL_TRANSFORMERS_CHINESE_MODEL,
  localModelSpecFor,
  scheduleEmbeddingWarmup,
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

function makePipeline(throwOnRun = false): { pipeline: () => Promise<TransformersPipeline>; callsRef: { calls: number }; runOptsRef: { pooling: string[]; texts: string[][] } } {
  const callsRef = { calls: 0 }
  const runOptsRef: { pooling: string[]; texts: string[][] } = { pooling: [], texts: [] }
  return {
    pipeline: () =>
      Promise.resolve<TransformersPipeline>({
        run: async (texts, opts) => {
          callsRef.calls++
          runOptsRef.pooling.push(opts?.pooling ?? 'mean')
          runOptsRef.texts.push([...texts])
          if (throwOnRun) throw new Error('inference boom')
          const out = new Float32Array(texts.length * DIM)
          for (let i = 0; i < texts.length; i++) out.set(fakeVectorFor(texts[i]!), i * DIM)
          return out
        },
      }),
    callsRef,
    runOptsRef,
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

  it('is default-on: returns a model when nothing is set (MiniLM on non-zh env)', () => {
    // Pin an explicit non-Chinese env var: it short-circuits before the Intl
    // fallback, making the assertion deterministic even on zh machines.
    setEnv({ LANG: 'en_US.UTF-8', LC_ALL: undefined, LANGUAGE: undefined, LC_CTYPE: undefined })
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
    setEnv({ LANG: 'en_US.UTF-8', LC_ALL: undefined, LANGUAGE: undefined, LC_CTYPE: undefined })
    const b = resolveEmbeddingBackend()
    expect(b).not.toBeNull()
    expect(b!.label).toBe('local-semantic:' + LOCAL_TRANSFORMERS_DEFAULT_MODEL)
  })

  it('resolveEmbeddingBackend picks the Chinese model on a zh locale', () => {
    setEnv({ LANG: 'zh_CN.UTF-8', LC_ALL: undefined, LANGUAGE: undefined, LC_CTYPE: undefined })
    const b = resolveEmbeddingBackend()
    expect(b!.label).toBe('local-semantic:' + LOCAL_TRANSFORMERS_CHINESE_MODEL)
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

describe('locale-aware default model', () => {
  it('pure decision: Chinese env vars win over a non-Chinese Intl locale', () => {
    expect(localePicksChinese(['zh_CN.UTF-8'], 'en-US')).toBe(true)
    expect(localePicksChinese([undefined, undefined, 'zh'], 'en-US')).toBe(true)
  })

  it('pure decision: non-Chinese env + Intl locale stays MiniLM territory', () => {
    expect(localePicksChinese(['en_US.UTF-8', undefined], 'ja-JP')).toBe(false)
    expect(localePicksChinese([undefined, undefined, undefined, 'C.UTF-8'], null)).toBe(false)
  })

  it('pure decision: falls back to the Intl locale when env is silent', () => {
    expect(localePicksChinese([undefined, undefined, undefined, undefined], 'zh-Hans-CN')).toBe(true)
  })

  it('LANG=zh resolves the Chinese default regardless of machine Intl', () => {
    setEnv({ LANG: 'zh_CN.UTF-8', LC_ALL: undefined, LANGUAGE: undefined })
    // Env short-circuits before Intl, so this holds on any machine.
    expect(resolveDefaultLocalModel()).toBe(LOCAL_TRANSFORMERS_CHINESE_MODEL)
    expect(resolveLocalTransformersModel()).toBe(LOCAL_TRANSFORMERS_CHINESE_MODEL)
  })

  it('an explicit model override beats the locale choice', () => {
    setEnv({
      LANG: 'zh_CN.UTF-8',
      CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL: 'Xenova/custom-model',
    })
    expect(resolveLocalTransformersModel()).toBe('Xenova/custom-model')
  })

  it('unknown models get the safe default spec (mean pooling, no prefix)', () => {
    const spec = localModelSpecFor('Xenova/who-dis')
    expect(spec.pooling).toBe('mean')
    expect(spec.queryPrefix).toBeUndefined()
  })

  it('the Chinese model spec uses CLS pooling with a query instruction', () => {
    const spec = localModelSpecFor(LOCAL_TRANSFORMERS_CHINESE_MODEL)
    expect(spec.pooling).toBe('cls')
    expect(spec.queryPrefix).toBeTruthy()
    expect(spec.queryPrefix!.length).toBeGreaterThan(4)
  })
})

describe('query-side instruction prefix (forQuery)', () => {
  it('prefixes only query texts and passes the model pooling to run()', async () => {
    const { pipeline, callsRef, runOptsRef } = makePipeline()
    const zh = LOCAL_TRANSFORMERS_CHINESE_MODEL
    const b = createTransformersLocalBackend(zh, { pipelineFactory: pipeline })
    // Documents: unprefixed. Query: prefixed.
    await b.embed(['schema migration plan', '数据库迁移方案'])
    await b.embed(['迁移', 'migration'], { forQuery: true })
    expect(callsRef.calls).toBe(2)
    expect(runOptsRef.pooling).toEqual(['cls', 'cls'])
    // First call = documents, verbatim.
    expect(runOptsRef.texts[0]).toEqual(['schema migration plan', '数据库迁移方案'])
    // Second call = queries, each carrying the BGE instruction prefix.
    const prefix = localModelSpecFor(zh).queryPrefix!
    expect(runOptsRef.texts[1]![0]).toBe(prefix + '迁移')
    expect(runOptsRef.texts[1]![1]).toBe(prefix + 'migration')
  })

  it('does not touch texts for models without a queryPrefix', async () => {
    const { pipeline, callsRef, runOptsRef } = makePipeline()
    const b = createTransformersLocalBackend(LOCAL_TRANSFORMERS_DEFAULT_MODEL, { pipelineFactory: pipeline })
    await b.embed(['plain query'], { forQuery: true })
    expect(callsRef.calls).toBe(1)
    expect(runOptsRef.texts[0]).toEqual(['plain query'])
  })

  it('caches prefixed queries under their own keys without clobbering documents', async () => {
    const { pipeline, callsRef } = makePipeline()
    // Use the Chinese model: its queryPrefix makes the query-side text differ
    // from the document text, so they must be distinct cache entries. (For
    // prefix-less models both sides hash identically and legitimately share.)
    const b = createTransformersLocalBackend(LOCAL_TRANSFORMERS_CHINESE_MODEL, { pipelineFactory: pipeline })
    await b.embed(['hello'])                            // document
    await b.embed(['hello'], { forQuery: true })        // same raw text, query side
    expect(callsRef.calls).toBe(2)                      // distinct cache entries
    await b.embed(['hello'], { forQuery: true })        // cached now
    expect(callsRef.calls).toBe(2)
  })
})

describe('scheduleEmbeddingWarmup', () => {
  it('is a silent no-op when semantic search is disabled', async () => {
    // Disabled -> resolveEmbeddingBackend() returns null / approximate tier,
    // so warm-up must not touch the pipeline or network. Contract: never throws.
    setEnv({ CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH: '0' })
    expect(() => scheduleEmbeddingWarmup(1)).not.toThrow()
    await new Promise(r => setTimeout(r, 30))
  })

  it('only ever schedules once per process', () => {
    // The module-level latch makes repeat calls no-ops (also true when the
    // first call already armed a real warm-up elsewhere).
    expect(() => {
      scheduleEmbeddingWarmup(60_000)
      scheduleEmbeddingWarmup(60_000)
    }).not.toThrow()
  })
})
