// ---------------------------------------------------------------------------
// Pre-download the local semantic embedding model so the first real search
// doesn't pay the download cost. Run by the installers after `bun install`.
//
// Prints a clear OK/FAIL line and exits non-zero on failure so the installer
// can warn without aborting the whole install.
// ---------------------------------------------------------------------------

import {
  LOCAL_TRANSFORMERS_DEFAULT_MODEL,
  resolveEmbeddingBackend,
  resolveLocalTransformersModel,
} from '../src/tools/AdvisorTool/conversationLog/embeddings.js'

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot // vectors are L2-normalized, so the dot product is the cosine
}

const model = resolveLocalTransformersModel()
if (!model) {
  console.log(
    '[skip] local semantic embeddings are disabled ' +
      '(CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING is off) - nothing to prefetch',
  )
  process.exit(0)
}

console.log(`[*] Prefetching embedding model: ${model}`)
console.log(`    (default: ${LOCAL_TRANSFORMERS_DEFAULT_MODEL}, ~23MB q8 quantized, one time)`)

const backend = resolveEmbeddingBackend()
if (!backend?.semantic) {
  console.error('[x] Semantic backend unavailable - got: ' + (backend?.label ?? 'none'))
  process.exit(1)
}

const started = Date.now()
try {
  // Three probes double as a smoke test: a query, a related sentence, and an
  // unrelated one. A real embedding model scores related >> unrelated.
  const [query, related, unrelated] = await backend.embed([
    'How do I fix a memory leak in my Node.js server?',
    'Debugging a memory leak in a Node process using heap snapshots.',
    'My favorite recipe for chocolate chip cookies.',
  ])
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  if (!query || !related || !unrelated || query.length === 0) {
    console.error('[x] Model returned an empty embedding vector')
    process.exit(1)
  }
  const simRelated = cosine(query, related)
  const simUnrelated = cosine(query, unrelated)
  console.log(`[+] Model ready in ${elapsed}s - backend: ${backend.label}`)
  console.log(`    dimensions: ${query.length}`)
  console.log(`    similarity  related: ${simRelated.toFixed(3)}  unrelated: ${simUnrelated.toFixed(3)}`)
  if (simRelated <= simUnrelated + 0.2) {
    console.error('[x] Similarity check failed - related text did not clearly outrank unrelated')
    process.exit(1)
  }
  console.log('[+] Semantic search verified: real embeddings are working')
} catch (err) {
  console.error(
    '[x] Model prefetch failed: ' +
      (err instanceof Error ? err.message : String(err)).slice(0, 300),
  )
  process.exit(1)
}
