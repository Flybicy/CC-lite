// ---------------------------------------------------------------------------
// Embedding backends for ReadConversationLog semantic search.
//
// Two backends:
//   - local-semantic (default): a true in-process embedding model via
//     Transformers.js (ONNX/WASM, mean-pooled + L2-normalized). The model
//     auto-downloads once to the on-disk cache on first use and works fully
//     offline afterwards. Vectors share the persistent JSONL disk cache, so
//     unchanged messages are never re-embedded, even across restarts.
//   - local-approximate (fallback): a deterministic hashed bag-of-features
//     vectorizer. No model, no network, always available. It is NOT true
//     semantics - fuzzy sub-word matching on top of BM25 only. Always
//     labeled "local-approximate" so the advisor knows which one ran.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import envPaths from 'env-paths'
import { tokenize } from './tokenizer.js'

/** L2-normalized embedding vector. Zero-length input yields a zero vector. */
export type EmbeddingVector = Float32Array

export interface EmbeddingBackend {
  /** 'local' for all built-in backends ('remote' kept for test mocks). */
  kind: 'remote' | 'local'
  /** Human-readable label included in search output, e.g. "local-semantic:Xenova/all-MiniLM-L6-v2". */
  label: string
  /** True semantic understanding (real embedding model, not the fallback). */
  semantic: boolean
  /** Embed texts; result order matches input order. */
  embed(
    texts: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<EmbeddingVector[]>
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** Explicit opt-out of semantic search modes entirely. */
export function isSemanticSearchDisabled(): boolean {
  const flag = env(
    'CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH',
    'CLAUDE_CODE_SEMANTIC_SEARCH',
  )
  return flag === '0' || flag === 'false' || flag === 'off'
}

export function l2Normalize(vec: EmbeddingVector): EmbeddingVector {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!
  if (sum <= 0) return vec
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
  return vec
}

export function toEmbeddingVector(input: number[]): EmbeddingVector {
  const vec = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const value = input[i]!
    if (!Number.isFinite(value)) {
      throw new EmbeddingError('Embedding endpoint returned non-finite values')
    }
    vec[i] = value
  }
  return l2Normalize(vec)
}

// ---------------------------------------------------------------------------
// Persistent cache (memory + append-only JSONL per model)
//
// Key = sha256(model + '\0' + text). Vectors stored as base64 Float32 blobs so
// the file stays compact and parse-free. FIFO eviction beyond MAX_DISK_ENTRIES.
// ---------------------------------------------------------------------------

const MAX_DISK_ENTRIES = 50_000

/**
 * Cache directory, overridable via CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR
 * (resolved lazily so tests can redirect it before first use).
 */
function getCacheDir(): string {
  return process.env.CLAUDE_CODE_ADVISOR_EMBEDDING_CACHE_DIR?.trim() ||
    join(envPaths('claude-cli', { suffix: '' }).cache, 'advisor-embeddings')
}

const memoryCache = new Map<string, EmbeddingVector>()
const diskCacheLoadedModels = new Set<string>()
const inFlightLoads = new Map<string, Promise<void>>()

export function embeddingCacheKey(model: string, text: string): string {
  return createHash('sha256').update(`${model}\u0000${text}`).digest('hex')
}

function cacheFileForModel(model: string): string {
  const sanitized = model.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
  return join(getCacheDir(), `embeddings-${sanitized}.jsonl`)
}

function decodeBase64Vector(value: string): EmbeddingVector | null {
  try {
    const buf = Buffer.from(value, 'base64')
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null
    return new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    )
  } catch {
    return null
  }
}

async function loadDiskCache(model: string): Promise<void> {
  if (diskCacheLoadedModels.has(model)) return
  const existing = inFlightLoads.get(model)
  if (existing) return existing
  const load = (async () => {
    const file = cacheFileForModel(model)
    try {
      if (!existsSync(file)) return
      const lines = readFileSync(file, 'utf8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const record = JSON.parse(trimmed) as { k?: string; v?: string }
          if (typeof record.k !== 'string' || typeof record.v !== 'string') continue
          // Do not clobber newer in-memory vectors with stale disk entries.
          if (memoryCache.has(record.k)) continue
          const vector = decodeBase64Vector(record.v)
          if (vector) memoryCache.set(record.k, vector)
        } catch {
          // Corrupt line - skip.
        }
      }
    } catch {
      // Unreadable cache - treat as empty.
    } finally {
      diskCacheLoadedModels.add(model)
    }
  })()
  inFlightLoads.set(model, load)
  try {
    await load
  } finally {
    inFlightLoads.delete(model)
  }
}

function appendDiskCache(model: string, entries: Array<[string, EmbeddingVector]>): void {
  if (entries.length === 0) return
  try {
    mkdirSync(getCacheDir(), { recursive: true })
    const file = cacheFileForModel(model)
    let totalLines = 0
    try {
      if (existsSync(file)) {
        totalLines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length
      }
    } catch {
      totalLines = 0
    }
    // FIFO trim: if the file would exceed the cap, rewrite with the newest
    // entries only (existing lines first, then the new batch).
    const keep = Math.max(0, MAX_DISK_ENTRIES - entries.length)
    if (totalLines > keep) {
      const lines: string[] = []
      try {
        if (existsSync(file)) {
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (line.trim()) lines.push(line.trim())
          }
        }
      } catch {
        // ignore rewrite-source read failure
      }
      const trimmed = lines.slice(Math.max(0, lines.length - keep))
      const serialized = entries.map(([key, vector]) =>
        JSON.stringify({ k: key, v: Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength).toString('base64') }),
      )
      writeFileSync(file, [...trimmed, ...serialized].join('\n') + '\n')
      return
    }
    const serialized = entries.map(([key, vector]) =>
      JSON.stringify({ k: key, v: Buffer.from(vector.buffer as ArrayBuffer, vector.byteOffset, vector.byteLength).toString('base64') }),
    )
    appendFileSync(file, serialized.join('\n') + '\n')
  } catch {
    // Cache write failure is non-fatal - search still works.
  }
}

/** Test-only: wipe in-memory cache state. */
export function resetEmbeddingMemoryCacheForTests(): void {
  memoryCache.clear()
  diskCacheLoadedModels.clear()
}

const EMBED_BATCH_ITEMS = 32
const EMBED_BATCH_CHARS = 96_000

function chunkBatches(texts: readonly string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentChars = 0
  for (const text of texts) {
    const isBatchFull =
      current.length >= EMBED_BATCH_ITEMS ||
      (current.length > 0 && currentChars + text.length > EMBED_BATCH_CHARS)
    if (isBatchFull) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(text)
    currentChars += text.length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** Batch size cap for the embed input text (chars). Exported for tests. */
export const EMBED_TEXT_CAP_CHARS = 3_000

// ---------------------------------------------------------------------------
// Local approximate backend (no network, no config, deterministic)
// ---------------------------------------------------------------------------

const LOCAL_DIM = 384
const LOCAL_TRIGRAM_WEIGHT = 0.5

function djb2(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

/**
 * Deterministic hashed bag-of-features embedding: token unigrams plus char
 * trigrams of longer ASCII tokens (gives fuzzy sub-word matching), hashed into
 * LOCAL_DIM signed buckets and L2-normalized. Not true semantics - a cheap
 * approximate fallback clearly labeled in search output.
 */
export function computeLocalEmbedding(text: string): EmbeddingVector {
  const vector = new Float32Array(LOCAL_DIM)
  if (!text.trim()) return vector
  const tokens = tokenize(text)
  const addFeature = (feature: string, weight: number) => {
    const hash = djb2(feature)
    const index = Math.abs(hash) % LOCAL_DIM
    const sign = (hash >>> 16) & 1 ? -1 : 1
    vector[index] = vector[index]! + sign * weight
  }
  for (const token of tokens) {
    addFeature(token, 1)
    if (token.length >= 4 && /^[a-z0-9]+$/.test(token)) {
      for (let i = 0; i + 3 <= token.length; i++) {
        addFeature(token.slice(i, i + 3), LOCAL_TRIGRAM_WEIGHT)
      }
    }
  }
  return l2Normalize(vector)
}

export function createLocalEmbeddingBackend(): EmbeddingBackend {
  return {
    kind: 'local',
    label: 'local-approximate',
    semantic: false,
    async embed(texts) {
      return texts.map(text => {
        if (!text.trim()) return new Float32Array(0)
        const key = embeddingCacheKey('local', text)
        const cached = memoryCache.get(key)
        if (cached) return cached
        const vector = computeLocalEmbedding(text)
        memoryCache.set(key, vector)
        return vector
      })
    },
  }
}


// ---------------------------------------------------------------------------
// Local SEMANTIC backend (Transformers.js in-process ONNX embedding model)
// ---------------------------------------------------------------------------
//
// Runs a real ONNX embedding model in-process via @huggingface/transformers
// (Transformers.js v3, onnxruntime WASM). No server, no API key, no per-token
// cost: true local semantics with a one-time model download cached on disk.
//
// Graceful degradation: import and pipeline load both throw EmbeddingError on
// failure, which the search layer already handles (hybrid degrades to
// keyword-only, pure-semantic reports a clean error). Also covers the
// compiled-binary case, where the package is typically NOT embedded into the
// exe so the dynamic import fails cleanly; set
// CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0 there to use the approximate fallback.

/** Default local ONNX embedding model (small, fast, cross-lingual-ish). */
export const LOCAL_TRANSFORMERS_DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'

function transformersCacheModel(model: string): string {
  // Include the inference dtype so vectors computed with a different
  // quantization are never mixed within one cache namespace.
  return 'local-semantic:q8:' + model
}

export interface TransformersBackendOptions {
  pipelineFactory?: () => Promise<TransformersPipeline>
}

export interface TransformersPipeline {
  run(texts: string[], opts: { pooling?: 'mean'; normalize?: boolean }): Promise<Float32Array>
}

let _transformersPipeline: Promise<TransformersPipeline> | null = null
let _transformersModelName: string | null = null

export function resetTransformersPipelineForTests(): void {
  _transformersPipeline = null
  _transformersModelName = null
}

async function defaultPipelineFactory(model: string): Promise<TransformersPipeline> {
  // Variable indirection so `bun build --compile` leaves this as a runtime
  // dynamic import instead of trying to bundle a missing optional package.
  const pkg = ['@huggingface', 'transformers'].join('/')
  const mod: any = await import(pkg)
  const modEnv = mod.env
  try {
    modEnv.cacheDir = join(getCacheDir(), 'transformers-models')
    mkdirSync(modEnv.cacheDir, { recursive: true })
  } catch { /* fall back to transformers default cache */ }
  try {
    modEnv.backends ??= {}
    modEnv.backends.onnx ??= {}
    modEnv.backends.onnx.wasm ??= {}
  } catch { /* env shape may vary by version; non-fatal */ }
  const extractor = await mod.pipeline('feature-extraction', model, {
    // q8 quantization: ~4x smaller download (~23MB vs ~90MB for MiniLM) and
    // faster CPU inference, with negligible recall loss for search ranking.
    dtype: 'q8',
    progress_callback: () => {},
  })
  return {
    async run(texts, opts) {
      const out = await extractor(texts, {
        pooling: opts.pooling ?? 'mean',
        normalize: opts.normalize ?? true,
      })
      const data = (out as any)?.data
      if (data instanceof Float32Array) return data
      if (Array.isArray(data) || ArrayBuffer.isView(data)) {
        return new Float32Array(data as any)
      }
      throw new EmbeddingError('Transformers.js pipeline returned an unexpected tensor shape')
    },
  }
}

export function createTransformersLocalBackend(
  model: string = LOCAL_TRANSFORMERS_DEFAULT_MODEL,
  opts?: TransformersBackendOptions,
): EmbeddingBackend {
  const cacheModel = transformersCacheModel(model)
  return {
    kind: 'local',
    label: 'local-semantic:' + model,
    semantic: true,
    async embed(texts, callOpts) {
      if (texts.length === 0) return []
      await loadDiskCache(cacheModel)
      const results: EmbeddingVector[] = new Array(texts.length)
      const misses: Array<{ index: number; text: string; key: string }> = []
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!
        if (!text.trim()) { results[i] = new Float32Array(0); continue }
        const key = embeddingCacheKey(cacheModel, text)
        const cached = memoryCache.get(key)
        if (cached) results[i] = cached
        else misses.push({ index: i, text, key })
      }
      if (misses.length === 0) return results

      if (!_transformersPipeline || _transformersModelName !== model) {
        _transformersModelName = model
        _transformersPipeline = (async () =>
          opts?.pipelineFactory ? opts.pipelineFactory() : defaultPipelineFactory(model))()
      }
      let pipeline: TransformersPipeline
      try {
        pipeline = await _transformersPipeline
      } catch (err) {
        _transformersPipeline = null
        _transformersModelName = null
        throw new EmbeddingError(
          'Could not load the local embedding model "' + model + '". ' +
          'Reinstall with the official installer (it provisions the embedding ' +
          'runtime and prefetches the model), or run `bun install` when running ' +
          'from source. Verify anytime with `cclite-verify-embeddings`. Set ' +
          'CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0 to use the approximate local ' +
          'fallback instead. Detail: ' +
          (err instanceof Error ? err.message : String(err)).slice(0, 200),
        )
      }

      const newEntries: Array<[string, EmbeddingVector]> = []
      for (const batch of chunkBatches(misses.map(m => m.text))) {
        let flat: Float32Array
        try {
          flat = await pipeline.run(batch, { pooling: 'mean', normalize: true })
        } catch (err) {
          _transformersPipeline = null
          _transformersModelName = null
          throw new EmbeddingError(
            'Local model "' + model + '" inference failed: ' +
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
          )
        }
        const dim = Math.floor(flat.length / batch.length)
        if (dim <= 0 || flat.length % batch.length !== 0) {
          throw new EmbeddingError('Local model "' + model + '" returned an unexpected embedding length')
        }
        for (let i = 0; i < batch.length; i++) {
          const vec = l2Normalize(toEmbeddingVector(Array.from(flat.slice(i * dim, (i + 1) * dim))))
          const miss = misses[newEntries.length]!
          results[miss.index] = vec
          newEntries.push([miss.key, vec])
        }
      }
      for (const [key, vector] of newEntries) memoryCache.set(key, vector)
      appendDiskCache(cacheModel, newEntries)
      return results
    },
  }
}

/** Resolve the local Transformers.js model name when opted in, else null. */
export function resolveLocalTransformersModel(): string | null {
  const flag = env('CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING')
  if (flag === '0' || flag === 'false' || flag === 'off') return null
  const explicit = env('CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL')
  if (explicit) return explicit
  // Default-on: the local-semantic tier is the standard semantic backend.
  return LOCAL_TRANSFORMERS_DEFAULT_MODEL
}

/**
 * Resolve the active embedding backend from the environment, in priority
 * order: explicit disable -> in-process Transformers.js local-semantic model
 * (default-on; CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL picks the model) ->
 * local approximate fallback (when opted out via
 * CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0). Returns null only when semantic
 * search is explicitly disabled.
 */
export function resolveEmbeddingBackend(): EmbeddingBackend | null {
  if (isSemanticSearchDisabled()) return null
  const localModel = resolveLocalTransformersModel()
  if (localModel) return createTransformersLocalBackend(localModel)
  return createLocalEmbeddingBackend()
}

