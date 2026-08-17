// ---------------------------------------------------------------------------
// Semantic (vector) search and hybrid fusion for ReadConversationLog.
//
// semanticSearch ranks entries by cosine similarity between the embedded
// query and precomputed entry vectors. rrfFuse merges that ranking with the
// BM25 keyword ranking via Reciprocal Rank Fusion - the standard robust way
// to combine two retrieval signals without calibrating raw score scales.
// ---------------------------------------------------------------------------

import type { EmbeddingVector } from './embeddings.js'
import type { ConversationEntry, SearchResult } from '../types.js'

/** Cosine similarity; zero vectors score 0 (never NaN). */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Build the text that gets embedded for an entry: role prefix for light
 * context, then the semantic body, then hidden tool-input text - capped at
 * `cap` chars to bound embedding cost per message.
 */
export function buildEntryEmbeddingText(entry: ConversationEntry, cap = 3_000): string {
  const parts: string[] = [entry.role]
  if (entry.searchBody) parts.push(entry.searchBody)
  if (entry.searchText) parts.push(entry.searchText)
  const text = parts.join('\n')
  return text.length > cap ? text.slice(0, cap) : text
}

/** Entries whose embedding text is non-empty after the role prefix. */
export function hasEmbeddingText(entry: ConversationEntry): boolean {
  return buildEntryEmbeddingText(entry).trim().length > entry.role.length
}

export interface SemanticSearchResult {
  entry: ConversationEntry
  score: number // raw cosine similarity, [-1, 1]
}

export interface SemanticRank {
  results: SemanticSearchResult[] // sorted by score desc, then id desc
  totalMatches: number // entries above the match threshold
}

const SEMANTIC_MATCH_THRESHOLD = 0.05

/**
 * Rank all entries by cosine similarity to the query vector.
 * `filter` (role/ID range) is applied before ranking, mirroring keyword search.
 */
export function semanticSearch(
  queryVector: EmbeddingVector,
  vectors: readonly EmbeddingVector[], // aligned with entries
  entries: readonly ConversationEntry[],
  filter?: (entry: ConversationEntry) => boolean,
): SemanticRank {
  if (queryVector.length === 0 || entries.length === 0) {
    return { results: [], totalMatches: 0 }
  }
  const scored: SemanticSearchResult[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (filter && !filter(entry)) continue
    const vector = vectors[i]!
    if (vector.length === 0) continue
    const score = cosineSimilarity(queryVector, vector)
    scored.push({ entry, score })
  }
  const results = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.id - a.entry.id)
  const totalMatches = results.filter(s => s.score >= SEMANTIC_MATCH_THRESHOLD).length
  return { results, totalMatches }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

export interface FusedRank<T> {
  item: T
  score: number // fused score, sum of weight / (RRF_K + rank)
  /** Per-list ranks (1-based); absent when the item was not ranked by that list. */
  ranks: Array<number | undefined>
}

const RRF_K = 60

/**
 * Fuse multiple ranked lists into one. Each list contributes
 * weight / (RRF_K + rank). Items missing from a list simply get no
 * contribution from it - standard RRF behavior.
 */
export function rrfFuse<T>(
  lists: Array<{ items: readonly T[]; weight: number }>,
  k: number = RRF_K,
): FusedRank<T>[] {
  const fused = new Map<T, { score: number; ranks: Array<number | undefined> }>()
  lists.forEach((list, listIndex) => {
    for (let rank = 1; rank <= list.items.length; rank++) {
      const item = list.items[rank - 1]!
      let entry = fused.get(item)
      if (!entry) {
        entry = { score: 0, ranks: new Array(lists.length).fill(undefined) }
        fused.set(item, entry)
      }
      entry.score += list.weight / (k + rank)
      entry.ranks[listIndex] = rank
    }
  })
  return [...fused.entries()]
    .map(([item, value]) => ({ item, score: value.score, ranks: value.ranks }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Hybrid search: RRF-fuse keyword (BM25) and semantic rankings.
 * Returns fused results with both raw scores attached for transparency.
 */
export function hybridSearch(
  keywordResults: readonly SearchResult[], // already ranked
  semanticResults: readonly SemanticSearchResult[], // already ranked
  filter?: (entry: ConversationEntry) => boolean,
): { results: Array<SearchResult & { semanticScore?: number; keywordScore?: number }>; totalMatches: number } {
  // Apply the filter to semantic results too (keyword results are pre-filtered).
  const semantic = filter ? semanticResults.filter(r => filter(r.entry)) : semanticResults
  const keywordEntries = keywordResults.map(r => r.entry)
  const semanticEntries = semantic.map(r => r.entry)
  const fused = rrfFuse<ConversationEntry>([
    { items: keywordEntries, weight: 0.5 },
    { items: semanticEntries, weight: 0.5 },
  ])
  const keywordByEntry = new Map(keywordResults.map(r => [r.entry, r]))
  const semanticByEntry = new Map(semantic.map(r => [r.entry, r.score]))

  const results = fused.map(f => {
    const keyword = keywordByEntry.get(f.item)
    const semanticScore = semanticByEntry.get(f.item)
    return {
      entry: f.item,
      score: f.score,
      matchedTokens: keyword?.matchedTokens ?? [],
      excerpt: keyword?.excerpt,
      keywordScore: keyword?.score,
      semanticScore,
    }
  })
  const totalMatches = new Set([
    ...keywordEntries,
    ...semantic.filter(r => r.score >= SEMANTIC_MATCH_THRESHOLD).map(r => r.entry),
  ]).size
  return { results, totalMatches }
}
