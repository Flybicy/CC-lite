// ---------------------------------------------------------------------------
// Local semantic ranking for the /resume session picker.
//
// Reuses the advisor's local embedding model (no API cost, fully offline) to
// supplement the picker's keyword filter. The keyword filter only matches
// literal substrings of title/branch/tag — searching "数据库迁移" finds
// nothing even when a session is all about schema migration. Semantic scores
// close that gap: related sessions surface when keywords dead-end, and are
// appended (clearly capped) as extra candidates otherwise.
//
// Purely best-effort: every function here returns null/input unchanged on any
// embedding failure, so the picker never regresses because of this module.
// ---------------------------------------------------------------------------

import { resolveEmbeddingBackend, type EmbeddingBackend } from '../tools/AdvisorTool/conversationLog/embeddings.js'
import { cosineSimilarity } from '../tools/AdvisorTool/conversationLog/semantic.js'

/**
 * Minimum cosine similarity for a session to count as semantically related.
 * MiniLM/bge-class models score loosely-related text around 0.3; below that
 * the match list turns into noise. Tuned conservatively on purpose.
 */
export const SEMANTIC_SESSION_MIN_SCORE = 0.3

/** Cap on semantic-only sessions appended after keyword hits. */
export const SEMANTIC_SESSION_MAX_RESULTS = 12

/**
 * Per-session cap on embedded text. Session transcripts can be huge; head of
 * buildSearchableText already carries title/tag/summary/first prompt, which
 * is what matters for topical similarity.
 */
const EMBED_TEXT_CAP_CHARS = 2_000

export interface RankSessionsOptions {
  backend?: EmbeddingBackend
}

/**
 * Score sessions against `query` by cosine similarity between local-model
 * embeddings. Returns null when there is nothing to do (empty query, no
 * sessions, no backend) or when embedding fails — callers treat null as "no
 * semantic information available" and keep pure keyword behavior.
 *
 * Returned map contains only sessions scoring >= SEMANTIC_SESSION_MIN_SCORE,
 * so consumers can iterate entries directly.
 */
export async function rankSessionsBySimilarity<T>(
  query: string,
  logs: readonly T[],
  getText: (log: T) => string,
  opts?: RankSessionsOptions,
): Promise<Map<T, number> | null> {
  const trimmed = query.trim()
  if (!trimmed || logs.length === 0) return null

  let backend = opts?.backend
  if (!backend) {
    try {
      backend = resolveEmbeddingBackend() ?? undefined
    } catch {
      return null
    }
    if (!backend) return null
  }

  try {
    // Query first so models with an asymmetric retrieval recipe apply their
    // instruction prefix to the query side only.
    const [queryVector] = await backend.embed([trimmed.slice(0, EMBED_TEXT_CAP_CHARS)], {
      forQuery: true,
    })
    if (!queryVector || queryVector.length === 0) return null

    const docVectors = await backend.embed(
      logs.map(log => getText(log).slice(0, EMBED_TEXT_CAP_CHARS)),
    )

    const matches = new Map<T, number>()
    for (let i = 0; i < logs.length; i++) {
      const vector = docVectors[i]
      // Empty searchable text yields a zero-length vector - skip, not score-0.
      if (!vector || vector.length === 0) continue
      const score = cosineSimilarity(queryVector, vector)
      if (score >= SEMANTIC_SESSION_MIN_SCORE) {
        matches.set(logs[i]!, score)
      }
    }
    return matches
  } catch {
    return null
  }
}

/**
 * Combine keyword-filter results with semantic scores for display.
 *
 * - Keyword hits stay in their original order (recency, as before) — exact
 *   matches jumping around would feel wrong.
 * - Semantic-only sessions (not caught by the keyword filter) are appended,
 *   best score first, capped at SEMANTIC_SESSION_MAX_RESULTS.
 * - No semantic info (null/empty map) → keyword list returned unchanged.
 */
export function mergeKeywordAndSemantic<T>(
  keywordHits: readonly T[],
  matches: Map<T, number> | null,
): T[] {
  if (!matches || matches.size === 0) return [...keywordHits]
  const merged = [...keywordHits]
  const seen = new Set(keywordHits)
  const extras = [...matches.entries()]
    .filter(([log]) => !seen.has(log))
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEMANTIC_SESSION_MAX_RESULTS)
    .map(([log]) => log)
  return [...merged, ...extras]
}
