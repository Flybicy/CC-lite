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
  /**
   * Embed texts; result order matches input order.
   * `forQuery: true` marks retrieval-query texts so models with an asymmetrical
   * retrieval recipe (e.g. BGE's instruction prefix) can apply their query-side
   * transformation. Document/passage texts must NOT set it.
   */
  embed(
    texts: string[],
    opts?: { signal?: AbortSignal; forQuery?: boolean },
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
// Insertion-order eviction cap: content-hashed vectors are bounded by unique
// texts in practice, but a hard ceiling keeps worst-case memory finite.
const MAX_MEMORY_ENTRIES = 20_000
const diskCacheLoadedModels = new Set<string>()
const inFlightLoads = new Map<string, Promise<void>>()
// Memoized non-empty line counts per cache file — avoids an O(file) sync
// re-read on every append batch.
const diskCacheLineCounts = new Map<string, number>()

function rememberVector(key: string, vector: EmbeddingVector): void {
  if (!memoryCache.has(key) && memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value
    if (oldest !== undefined) memoryCache.delete(oldest)
  }
  memoryCache.set(key, vector)
}

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
      let lineCount = 0
      const lines = readFileSync(file, 'utf8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        lineCount++
        try {
          const record = JSON.parse(trimmed) as { k?: string; v?: string }
          if (typeof record.k !== 'string' || typeof record.v !== 'string') continue
          // Do not clobber newer in-memory vectors with stale disk entries.
          if (memoryCache.has(record.k)) continue
          const vector = decodeBase64Vector(record.v)
          if (vector) rememberVector(record.k, vector)
        } catch {
          // Corrupt line - skip.
        }
      }
      diskCacheLineCounts.set(model, lineCount)
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
    const memoizedCount = diskCacheLineCounts.get(model)
    // FIFO trim: if the file would exceed the cap, rewrite with the newest
    // entries only (existing lines first, then the new batch).
    const keep = Math.max(0, MAX_DISK_ENTRIES - entries.length)
    if (memoizedCount !== undefined && memoizedCount <= keep) {
      // Fast path: no rewrite needed. Append and bump the memoized count.
      const serialized = entries.map(([key, vector]) =>
        JSON.stringify({ k: key, v: encodeBase64Vector(vector) }),
      )
      appendFileSync(file, serialized.join('\n') + '\n')
      diskCacheLineCounts.set(model, memoizedCount + entries.length)
      return
    }
    let totalLines = 0
    if (memoizedCount === undefined) {
      try {
        if (existsSync(file)) {
          totalLines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length
        }
      } catch {
        totalLines = 0
      }
    } else {
      totalLines = memoizedCount
    }
    if (totalLines <= keep) {
      const serialized = entries.map(([key, vector]) =>
        JSON.stringify({ k: key, v: encodeBase64Vector(vector) }),
      )
      appendFileSync(file, serialized.join('\n') + '\n')
      diskCacheLineCounts.set(model, totalLines + entries.length)
      return
    }
    // Rewrite with the newest `keep` old lines plus this batch.
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
      JSON.stringify({ k: key, v: encodeBase64Vector(vector) }),
    )
    writeFileSync(file, [...trimmed, ...serialized].join('\n') + '\n')
    diskCacheLineCounts.set(model, trimmed.length + serialized.length)
  } catch {
    // Cache write failure is non-fatal - search still works.
    diskCacheLineCounts.delete(model)
  }
}

function encodeBase64Vector(vector: EmbeddingVector): string {
  return Buffer.from(
    vector.buffer as ArrayBuffer,
    vector.byteOffset,
    vector.byteLength,
  ).toString('base64')
}

/** Test-only: wipe in-memory cache state. */
export function resetEmbeddingMemoryCacheForTests(): void {
  memoryCache.clear()
  diskCacheLoadedModels.clear()
  diskCacheLineCounts.clear()
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
        rememberVector(key, vector)
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

/**
 * Default model for Chinese locales: BAAI bge-small-zh-v1.5 distilled to ONNX.
 * Similar size/speed class as MiniLM (~24MB q8) but dramatically better Chinese
 * retrieval quality. Selected automatically from the environment locale unless
 * CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL overrides it.
 */
export const LOCAL_TRANSFORMERS_CHINESE_MODEL = 'Xenova/bge-small-zh-v1.5'

// ---------------------------------------------------------------------------
// Per-model inference recipe registry
//
// Embedding models are not interchangeable at inference time: pooling strategy
// differs (BERT-style bge models use CLS, sentence-transformers use mean) and
// retrieval-tuned models like BGE expect an instruction prefix on QUERY texts
// only (documents stay unprefixed). Anything not listed gets the safe default:
// mean pooling, no prefix — same behavior as before the registry existed.
// ---------------------------------------------------------------------------

interface LocalModelSpec {
  /** Token pooling strategy applied before L2 normalization. */
  pooling: 'mean' | 'cls'
  /**
   * Prefix prepended to query-side texts (embed(..., { forQuery: true })).
   * Per BGE's retrieval recipe; improves recall, never applied to documents.
   */
  queryPrefix?: string
}

const LOCAL_MODEL_SPECS: Record<string, LocalModelSpec> = {
  [LOCAL_TRANSFORMERS_DEFAULT_MODEL]: { pooling: 'mean' },
  [LOCAL_TRANSFORMERS_CHINESE_MODEL]: {
    pooling: 'cls',
    // Official BAAI zh retrieval instruction (bge-small-zh-v1.5 model card).
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
  },
}

/** Inference recipe for a model id; unknown models fall back to mean/no-prefix. */
export function localModelSpecFor(model: string): LocalModelSpec {
  return LOCAL_MODEL_SPECS[model] ?? { pooling: 'mean' }
}

/** Best-effort BCP-47 tag from Intl, or null when unavailable. */
function intlLocaleTag(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale ?? null
  } catch {
    return null
  }
}

/**
 * Pure locale decision used by isChineseLocale: do these signals indicate a
 * Chinese-speaking user? Env vars win over the Intl default locale. Exported
 * for deterministic tests.
 */
export function localePicksChinese(
  envValues: ReadonlyArray<string | undefined>,
  intlLocale?: string | null,
): boolean {
  // A set-but-non-Chinese env var still wins over Intl: LC_ALL=en on a
  // zh Windows install means the shell locale is explicitly English, and
  // Intl only papers over the OS default. Only fall through to Intl when
  // every env var is unset.
  const set = envValues.filter(v => v && v.trim())
  if (set.length > 0) {
    return set.some(v => /^zh/i.test(v!.trim()))
  }
  return !!intlLocale && /^zh/i.test(intlLocale)
}

/** True when any LANG-family env var or Intl locale looks like Chinese. */
export function isChineseLocale(): boolean {
  return localePicksChinese([
    process.env['LC_ALL'],
    process.env['LANG'],
    process.env['LANGUAGE'],
    process.env['LC_CTYPE'],
  ], intlLocaleTag())
}

/**
 * Pick the default local model for the current environment: the Chinese
 * bge distillation on Chinese locales, MiniLM everywhere else. Explicit
 * CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL always wins over this choice
 * (see resolveLocalTransformersModel).
 */
export function resolveDefaultLocalModel(): string {
  return isChineseLocale() ? LOCAL_TRANSFORMERS_CHINESE_MODEL : LOCAL_TRANSFORMERS_DEFAULT_MODEL
}

function transformersCacheModel(model: string): string {
  // Include the inference dtype so vectors computed with a different
  // quantization are never mixed within one cache namespace.
  return 'local-semantic:q8:' + model
}

export interface TransformersBackendOptions {
  pipelineFactory?: () => Promise<TransformersPipeline>
}

export interface TransformersPipeline {
  run(texts: string[], opts: { pooling?: 'mean' | 'cls'; normalize?: boolean }): Promise<Float32Array>
}

let _transformersPipeline: {
  model: string
  promise: Promise<TransformersPipeline>
} | null = null

export function resetTransformersPipelineForTests(): void {
  _transformersPipeline = null
}

// ---------------------------------------------------------------------------
// First-download progress reporting
//
// The model auto-downloads (~23MB) on first use. Without feedback the user
// stares at a silent prompt for seconds-to-minutes and assumes the app hung.
// Transformers.js fires progress_callback per file with {status, progress,
// loaded, total}; we render one throttled stderr line. Best-effort: any
// error inside the reporter is swallowed.
// ---------------------------------------------------------------------------

const PROGRESS_MIN_INTERVAL_MS = 300
const PROGRESS_MIN_STEP = 2

/** Throttled single-line download reporter on stderr. Never throws. */
function createDownloadProgressReporter(model: string): (data: unknown) => void {
  let lastRenderedPct = -100
  let lastRenderAt = 0
  let finishedFiles = 0
  let startedFiles = 0
  const report = (data: unknown): void => {
    try {
      if (!data || typeof data !== 'object') return
      const event = data as { status?: string; progress?: number; loaded?: number; total?: number; file?: string }
      const now = Date.now()
      if (event.status === 'initiate') {
        startedFiles++
      } else if (event.status === 'done' || event.status === 'ready') {
        finishedFiles++
        // Always announce completed files immediately - they are rare.
        writeProgressLine(
          `[cclite] fetching embedding model ${model} … ${finishedFiles}/${Math.max(startedFiles, finishedFiles)} files done`,
          true,
        )
        lastRenderAt = now
      } else if (event.status === 'progress' && typeof event.progress === 'number' && isFinite(event.progress)) {
        const pct = Math.max(0, Math.min(100, Math.floor(event.progress)))
        const due =
          pct - lastRenderedPct >= PROGRESS_MIN_STEP ||
          now - lastRenderAt >= PROGRESS_MIN_INTERVAL_MS ||
          pct >= 100
        if (!due) return
        lastRenderedPct = pct
        lastRenderAt = now
        const mbLoaded = typeof event.loaded === 'number' ? (event.loaded / (1024 * 1024)).toFixed(1) : null
        const mbTotal = typeof event.total === 'number' ? (event.total / (1024 * 1024)).toFixed(1) : null
        const bytes = mbLoaded && mbTotal ? ` (${mbLoaded}/${mbTotal}MB)` : ''
        writeProgressLine(`[cclite] fetching embedding model ${model} … ${pct}%${bytes}`, false)
      }
    } catch {
      // Progress display must never break model loading.
    }
  }
  return report
}

/**
 * Render one progress line in place when stderr is a TTY (\r rewrite);
 * otherwise print sparse newline-separated updates so piped logs stay sane.
 */
function writeProgressLine(line: string, finalNewline: boolean): void {
  const tty = process.stderr.isTTY
  if (tty) {
    process.stderr.write('\r\x1b[K' + line)
    if (finalNewline) process.stderr.write('\n')
  } else if (finalNewline) {
    process.stderr.write(line + '\n')
  } else {
    // Non-TTY: only milestone lines are written by callers via finalNewline.
  }
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
  const spec = localModelSpecFor(model)
  const extractor = await mod.pipeline('feature-extraction', model, {
    // q8 quantization: ~4x smaller download (~23MB vs ~90MB for MiniLM) and
    // faster CPU inference, with negligible recall loss for search ranking.
    dtype: 'q8',
    progress_callback: createDownloadProgressReporter(model),
  })
  return {
    async run(texts, opts) {
      const out = await extractor(texts, {
        pooling: opts?.pooling ?? spec.pooling,
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
  const spec = localModelSpecFor(model)
  return {
    kind: 'local',
    label: 'local-semantic:' + model,
    semantic: true,
    async embed(texts, callOpts) {
      if (texts.length === 0) return []
      // Query-side retrieval instruction (BGE recipe): applied before hashing,
      // so prefixed queries cache under their own keys and documents are
      // never polluted with the prefix.
      const effectiveTexts =
        callOpts?.forQuery && spec.queryPrefix
          ? texts.map(text => (text.trim() ? spec.queryPrefix! + text : text))
          : texts
      await loadDiskCache(cacheModel)
      const results: EmbeddingVector[] = new Array(texts.length)
      const misses: Array<{ index: number; text: string; key: string }> = []
      for (let i = 0; i < texts.length; i++) {
        const text = effectiveTexts[i]!
        if (!text.trim()) { results[i] = new Float32Array(0); continue }
        const key = embeddingCacheKey(cacheModel, text)
        const cached = memoryCache.get(key)
        if (cached) results[i] = cached
        else misses.push({ index: i, text, key })
      }
      if (misses.length === 0) return results

      // Load (or reuse) the pipeline for THIS model. The singleton is a
      // {model, promise} tuple so concurrent calls for different models can
      // never cross wires: each caller awaits the pipeline it triggered.
      let entry = _transformersPipeline
      if (!entry || entry.model !== model) {
        entry = {
          model,
          promise: opts?.pipelineFactory
            ? opts.pipelineFactory()
            : defaultPipelineFactory(model),
        }
        _transformersPipeline = entry
      }
      let pipeline: TransformersPipeline
      try {
        pipeline = await entry.promise
      } catch (err) {
        // Only clear if a newer load has not already replaced us.
        if (_transformersPipeline === entry) _transformersPipeline = null
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
          flat = await pipeline.run(batch, { pooling: spec.pooling, normalize: true })
        } catch (err) {
          if (_transformersPipeline?.promise === entry.promise) _transformersPipeline = null
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
      for (const [key, vector] of newEntries) rememberVector(key, vector)
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
  // Default-on, locale-aware: Chinese environments get bge-small-zh-v1.5,
  // everything else MiniLM. CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING_MODEL wins.
  return resolveDefaultLocalModel()
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

// ---------------------------------------------------------------------------
// Background warm-up
//
// The embedding pipeline costs ~0.5-2s to load (and a one-time ~23MB download
// on very first use). Warming it up shortly after startup means the first
// semantic search is instant instead of paying that cost mid-conversation.
// Fire-and-forget: every failure is swallowed, nothing is awaited, and the
// timer is unref'd so it never keeps the process alive.
// ---------------------------------------------------------------------------

let warmupScheduled = false

/**
 * Schedule an idle-time pipeline warm-up. Safe to call multiple times (only
 * the first call schedules). No-op when semantic search is disabled.
 */
export function scheduleEmbeddingWarmup(delayMs = 2_000): void {
  if (warmupScheduled) return
  if (isSemanticSearchDisabled()) return
  warmupScheduled = true
  const timer = setTimeout(() => {
    try {
      const backend = resolveEmbeddingBackend()
      // Only the real model benefits from warming; the approximate fallback
      // has no load cost at all.
      if (!backend?.semantic) return
      void backend.embed(['warmup']).catch(() => {
        // Warm-up is best-effort; the search path reports real errors.
      })
    } catch {
      // Never let warm-up scheduling break startup.
    }
  }, delayMs)
  // Don't hold the event loop open for a warm-up the process may never need.
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

