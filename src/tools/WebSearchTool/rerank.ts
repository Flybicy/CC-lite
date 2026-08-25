// ---------------------------------------------------------------------------
// Local semantic reranking for SearXNG web-search results.
//
// Reuses the advisor's local embedding model (no API cost, fully offline)
// to reorder search hits so the most semantically relevant snippets come
// first. Purely best-effort: any failure returns the input order unchanged,
// and the whole feature is opt-in via CCLITE_SEMANTIC_RERANK=1.
// ---------------------------------------------------------------------------

import { resolveEmbeddingBackend, type EmbeddingBackend } from '../AdvisorTool/conversationLog/embeddings.js'
import { cosineSimilarity } from '../AdvisorTool/conversationLog/semantic.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export const SEMANTIC_RERANK_ENV_VAR = 'CCLITE_SEMANTIC_RERANK'

/** Default snippet cap per embedded text — snippets are short; be frugal. */
const DEFAULT_SNIPPET_CAP_CHARS = 800

export function isSemanticRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEnvTruthy(env[SEMANTIC_RERANK_ENV_VAR])
}

/**
 * Reorder `items` so that those whose snippet text is most similar to
 * `query` come first. Stable: equal scores keep their original relative
 * order. Never throws — on any embedding failure the input order is
 * returned as-is, so callers can treat this as pure optimization.
 */
export async function rerankBySimilarity<T>(
  query: string,
  items: readonly T[],
  getSnippet: (item: T) => string,
  opts?: { backend?: EmbeddingBackend; capChars?: number },
): Promise<readonly T[]> {
  if (items.length <= 1) return items

  let backend = opts?.backend
  if (!backend) {
    try {
      backend = resolveEmbeddingBackend() ?? undefined
    } catch {
      return items
    }
    if (!backend) return items
  }

  const cap = opts?.capChars ?? DEFAULT_SNIPPET_CAP_CHARS
  try {
    // Query and documents are embedded in separate calls so models with an
    // asymmetric retrieval recipe (BGE instruction prefix) treat each side
    // correctly. Both still share the backend's caches.
    const [queryVectors, docVectors] = await Promise.all([
      backend.embed([query.slice(0, cap)], { forQuery: true }),
      backend.embed(items.map(item => getSnippet(item).slice(0, cap))),
    ])
    const queryVector = queryVectors[0]
    if (!queryVector || queryVector.length === 0) return items

    return items
      .map((item, index) => ({
        item,
        index,
        // Empty snippets yield zero vectors -> cosine 0 -> sink via stability.
        score: cosineSimilarity(queryVector, docVectors[index] ?? new Float32Array(0)),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(entry => entry.item)
  } catch {
    // Reranking must never break the search path.
    return items
  }
}
