// ---------------------------------------------------------------------------
// Embedding backends for ReadConversationLog semantic search.
//
// Two backends:
//   - remote: any OpenAI-compatible /embeddings endpoint (OpenAI, SiliconFlow,
//     Jina, Ollama /v1, LM Studio, vLLM, ...). Configured via env vars, with
//     persistent on-disk caching so unchanged messages are never re-embedded.
//   - local: a deterministic hashed bag-of-features vectorizer. No network,
//     no cost, offline-safe. It is NOT true semantics - it provides fuzzy
//     sub-word matching on top of what BM25 already does. Always labeled
//     "local-approximate" in tool output so the advisor knows which one ran.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import envPaths from 'env-paths'
import { tokenize } from './tokenizer.js'

/** L2-normalized embedding vector. Zero-length input yields a zero vector. */
export type EmbeddingVector = Float32Array

export interface EmbeddingBackend {
  /** 'remote' (true semantic model) or 'local' (approximate fallback). */
  kind: 'remote' | 'local'
  /** Human-readable label included in search output, e.g. "remote:bge-m3". */
  label: string
  /** True semantic understanding (remote embedding model). */
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
// Configuration
// ---------------------------------------------------------------------------

/**
 * Wire protocol spoken by the remote embedding endpoint.
 *  - 'openai': OpenAI-compatible `POST {baseUrl}/embeddings` with
 *    `{model, input}` -> `{data: [{embedding, index}]}` (OpenAI, Azure-style
 *    gateways, SiliconFlow, OpenRouter, vLLM, Ollama's /v1, ...).
 *  - 'ollama': Ollama native `POST {baseUrl}/embed` with
 *    `{model, input}` -> `{embeddings: [[...]]}`.
 *  - 'auto' (default): pick 'ollama' when the base URL looks like an Ollama
 *    server (path ends in /api or port 11434), otherwise 'openai'.
 */
export type EmbeddingProtocol = 'openai' | 'ollama' | 'auto'

export interface EmbeddingConfig {
  model: string
  baseUrl: string
  apiKey: string
  protocol?: EmbeddingProtocol
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

/** Resolve the remote embedding endpoint configuration, or null if unset. */
export function resolveEmbeddingConfig(): EmbeddingConfig | null {
  const model = env(
    'CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL',
    'CLAUDE_CODE_EMBEDDING_MODEL',
    'CLAUDE_CODE_EMBEDDING_MODEL_ID',
  )
  if (!model) return null
  const baseUrl = env(
    'CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL',
    'CLAUDE_CODE_EMBEDDING_BASE_URL',
    'OPENAI_BASE_URL',
  ) ?? 'https://api.openai.com/v1'
  const apiKey = env(
    'CLAUDE_CODE_ADVISOR_EMBEDDING_API_KEY',
    'CLAUDE_CODE_EMBEDDING_API_KEY',
    'OPENAI_API_KEY',
    'CLAUDE_CODE_EMBEDDING_API_TOKEN',
  ) ?? ''
  const rawProtocol = env(
    'CLAUDE_CODE_ADVISOR_EMBEDDING_PROTOCOL',
    'CLAUDE_CODE_EMBEDDING_PROTOCOL',
  )?.toLowerCase()
  const protocol: EmbeddingProtocol =
    rawProtocol === 'openai' || rawProtocol === 'ollama' ? rawProtocol : 'auto'
  return { model, baseUrl: normalizeBaseUrl(baseUrl), apiKey, protocol }
}

/**
 * Resolve the effective wire protocol for a config. 'auto' detects Ollama by
 * URL shape (a base path ending in /api, or the default Ollama port 11434);
 * everything else uses the OpenAI-compatible protocol.
 */
export function resolveEffectiveProtocol(cfg: EmbeddingConfig): 'openai' | 'ollama' {
  if (cfg.protocol === 'openai' || cfg.protocol === 'ollama') return cfg.protocol
  try {
    const url = new URL(cfg.baseUrl)
    if (url.pathname.replace(/\/+$/, '').endsWith('/api')) return 'ollama'
    if (url.port === '11434') return 'ollama'
  } catch {
    // fall through to openai
  }
  return 'openai'
}

/** Explicit opt-out of semantic search modes entirely. */
export function isSemanticSearchDisabled(): boolean {
  const flag = env(
    'CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH',
    'CLAUDE_CODE_SEMANTIC_SEARCH',
  )
  return flag === '0' || flag === 'false' || flag === 'off'
}

/**
 * Normalize a base URL for the /embeddings path.
 * "https://api.openai.com" and "https://api.openai.com/v1" both become
 * ".../v1/embeddings"; custom paths are preserved as-is.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new EmbeddingError(`Invalid embedding base URL: ${baseUrl}`)
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    parsed.pathname = '/v1'
  }
  return parsed.toString().replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Remote backend (OpenAI-compatible /embeddings)
// ---------------------------------------------------------------------------

const EMBED_BATCH_ITEMS = 32
const EMBED_BATCH_CHARS = 96_000
const EMBED_REQUEST_TIMEOUT_MS = 30_000
const EMBED_MAX_ATTEMPTS = 3

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new EmbeddingError('Embedding request aborted'))
    }, { once: true })
  })
}

function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function ollamaEmbedUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  // Base URL already points at the Ollama API root ("http://host:11434/api")
  // -> append /embed; otherwise append the full /api/embed path.
  return trimmed.endsWith('/api') ? `${trimmed}/embed` : `${trimmed}/api/embed`
}

async function fetchEmbeddingsOnce(
  cfg: EmbeddingConfig,
  batch: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`
  const protocol = resolveEffectiveProtocol(cfg)
  const url = protocol === 'ollama' ? ollamaEmbedUrl(cfg.baseUrl) : `${cfg.baseUrl}/embeddings`
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, input: batch }),
    },
    EMBED_REQUEST_TIMEOUT_MS,
    signal,
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new EmbeddingError(
      `Embedding endpoint returned ${response.status}: ${body.slice(0, 300)}`,
      response.status,
    )
  }
  if (protocol === 'ollama') {
    // Ollama native: { embeddings: number[][], model?, ... }
    const json = (await response.json()) as { embeddings?: unknown; error?: unknown }
    if (json.error) {
      throw new EmbeddingError(`Embedding endpoint error: ${String(json.error).slice(0, 300)}`)
    }
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== batch.length) {
      throw new EmbeddingError(
        `Embedding endpoint returned ${Array.isArray(json.embeddings) ? json.embeddings.length : 0} vectors for ${batch.length} inputs`,
      )
    }
    return json.embeddings.map(item => {
      if (!Array.isArray(item)) {
        throw new EmbeddingError('Embedding endpoint returned a non-array vector')
      }
      return item as number[]
    })
  }
  const json = (await response.json()) as {
    data?: Array<{ embedding?: unknown; index?: unknown }>
    error?: { message?: unknown }
  }
  if (json.error) {
    throw new EmbeddingError(
      `Embedding endpoint error: ${String(json.error.message ?? 'unknown').slice(0, 300)}`,
    )
  }
  if (!Array.isArray(json.data) || json.data.length !== batch.length) {
    throw new EmbeddingError(
      `Embedding endpoint returned ${json.data?.length ?? 0} vectors for ${batch.length} inputs`,
    )
  }
  const sorted = [...json.data].sort((a, b) => (Number(a.index ?? 0)) - (Number(b.index ?? 0)))
  return sorted.map(item => {
    if (!Array.isArray(item.embedding)) {
      throw new EmbeddingError('Embedding endpoint returned a non-array vector')
    }
    return item.embedding as number[]
  })
}

async function fetchEmbeddingsWithRetry(
  cfg: EmbeddingConfig,
  batch: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchEmbeddingsOnce(cfg, batch, signal)
    } catch (err) {
      lastError = err
      if (err instanceof EmbeddingError && err.status !== undefined && !isRetryableStatus(err.status)) {
        throw err
      }
      if (signal?.aborted) throw err
      if (attempt < EMBED_MAX_ATTEMPTS) {
        await sleep(400 * attempt + Math.random() * 200, signal)
      }
    }
  }
  throw lastError
}

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

/**
 * Create a caching remote embedding backend. Cached vectors are looked up by
 * sha256(model + text), so repeated advisor runs never re-embed unchanged
 * messages and only genuinely new messages cost an API call.
 */
export function createRemoteEmbeddingBackend(
  cfg: EmbeddingConfig = resolveEmbeddingConfig()!,
): EmbeddingBackend {
  if (!cfg) throw new EmbeddingError('No embedding configuration provided')
  return {
    kind: 'remote',
    label: `remote:${cfg.model}`,
    semantic: true,
    async embed(texts, opts) {
      if (texts.length === 0) return []
      await loadDiskCache(cfg.model)
      const results: EmbeddingVector[] = new Array(texts.length)
      const misses: Array<{ index: number; text: string; key: string }> = []
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i]!
        if (!text.trim()) {
          results[i] = new Float32Array(0)
          continue
        }
        const key = embeddingCacheKey(cfg.model, text)
        const cached = memoryCache.get(key)
        if (cached) {
          results[i] = cached
        } else {
          misses.push({ index: i, text, key })
        }
      }
      if (misses.length > 0) {
        const newEntries: Array<[string, EmbeddingVector]> = []
        let cursor = 0
        for (const batch of chunkBatches(misses.map(m => m.text))) {
          const vectors = await fetchEmbeddingsWithRetry(cfg, batch, opts?.signal)
          for (let i = 0; i < batch.length; i++) {
            const miss = misses[cursor]!
            const vector = toEmbeddingVector(vectors[i]!)
            results[miss.index] = vector
            newEntries.push([miss.key, vector])
            cursor++
          }
        }
        for (const [key, vector] of newEntries) memoryCache.set(key, vector)
        appendDiskCache(cfg.model, newEntries)
      }
      return results
    },
  }
}

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
// exe so the dynamic import fails cleanly. For true local semantics inside a
// compiled binary, point a local Ollama / LM Studio at the *remote* backend
// via CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL=http://localhost:11434/v1.

/** Default local ONNX embedding model (small, fast, cross-lingual-ish). */
export const LOCAL_TRANSFORMERS_DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'

function transformersCacheModel(model: string): string {
  return 'local-semantic:' + model
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
          'Install it with `bun add @huggingface/transformers` (run-from-source) ' +
          'or use a local Ollama/LM Studio via CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL ' +
          'for the compiled binary. Detail: ' +
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
  const explicit = env('CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL')
  if (explicit) return explicit
  const flag = env('CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING')
  if (flag === '1' || flag === 'true' || flag === 'on') {
    return LOCAL_TRANSFORMERS_DEFAULT_MODEL
  }
  return null
}

/**
 * Resolve the active embedding backend from the environment, in priority
 * order: explicit disable -> remote endpoint -> in-process Transformers.js
 * local-semantic model -> local approximate fallback. Returns null only when
 * semantic search is explicitly disabled.
 */
export function resolveEmbeddingBackend(): EmbeddingBackend | null {
  if (isSemanticSearchDisabled()) return null
  const cfg = resolveEmbeddingConfig()
  if (cfg) return createRemoteEmbeddingBackend(cfg)
  const localModel = resolveLocalTransformersModel()
  if (localModel) return createTransformersLocalBackend(localModel)
  return createLocalEmbeddingBackend()
}

