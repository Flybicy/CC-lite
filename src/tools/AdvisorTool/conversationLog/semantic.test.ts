import { beforeAll, afterAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  computeLocalEmbedding,
  createLocalEmbeddingBackend,
  embeddingCacheKey,
  isSemanticSearchDisabled,
  l2Normalize,
  resetEmbeddingMemoryCacheForTests,
  toEmbeddingVector,
  EmbeddingError,
  type EmbeddingBackend,
} from './embeddings.js'
import {
  buildEntryEmbeddingText,
  cosineSimilarity,
  hasEmbeddingText,
  hybridSearch,
  rrfFuse,
  semanticSearch,
} from './semantic.js'
import { buildSearchIndex, bm25Search } from './search.js'
import { createConversationLogTool } from './ConversationLogTool.js'
import { conversationLogInputSchema } from '../schemas.js'
import type { ConversationEntry } from '../types.js'

// ---------------------------------------------------------------------------
// Local embedding backend
// ---------------------------------------------------------------------------

describe('computeLocalEmbedding', () => {
  it('is deterministic', () => {
    const a = computeLocalEmbedding('fix the parser bug in tokenizer')
    const b = computeLocalEmbedding('fix the parser bug in tokenizer')
    expect([...a]).toEqual([...b])
  })

  it('produces unit-length vectors for non-empty text', () => {
    const v = computeLocalEmbedding('some meaningful text')
    let norm = 0
    for (const x of v) norm += x * x
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
  })

  it('returns a zero vector for empty text', () => {
    const v = computeLocalEmbedding('   ')
    expect(v.length).toBeGreaterThan(0)
    expect([...v].every(x => x === 0)).toBe(true)
  })

  it('rates related text above unrelated text', () => {
    const query = computeLocalEmbedding('authentication token expired error')
    const related = computeLocalEmbedding('the auth token expired and refresh failed')
    const unrelated = computeLocalEmbedding('grocery list: apples bananas oranges')
    expect(cosineSimilarity(query, related)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    )
  })

  it('shares sub-word features across variants (fuzzy matching)', () => {
    const query = computeLocalEmbedding('tokeniz')
    const variant = computeLocalEmbedding('tokenizer')
    const unrelated = computeLocalEmbedding('zebra')
    expect(cosineSimilarity(query, variant)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    )
  })
})

describe('l2Normalize / toEmbeddingVector', () => {
  it('normalizes to unit length', () => {
    const v = toEmbeddingVector([3, 4])
    expect(v[0]!).toBeCloseTo(0.6, 5)
    expect(v[1]!).toBeCloseTo(0.8, 5)
  })

  it('handles zero vectors', () => {
    const v = l2Normalize(new Float32Array([0, 0, 0]))
    expect([...v]).toEqual([0, 0, 0])
  })

  it('rejects non-finite values', () => {
    expect(() => toEmbeddingVector([1, Number.NaN])).toThrow(EmbeddingError)
  })
})

// ---------------------------------------------------------------------------
// Embedding configuration
// ---------------------------------------------------------------------------

describe('embedding configuration', () => {
  const ENV_KEYS = [
    'CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL',
    'CLAUDE_CODE_EMBEDDING_MODEL',
    'CLAUDE_CODE_EMBEDDING_MODEL_ID',
    'CLAUDE_CODE_ADVISOR_EMBEDDING_BASE_URL',
    'CLAUDE_CODE_EMBEDDING_BASE_URL',
    'CLAUDE_CODE_ADVISOR_EMBEDDING_API_KEY',
    'CLAUDE_CODE_EMBEDDING_API_KEY',
    'CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH',
    'CLAUDE_CODE_SEMANTIC_SEARCH',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
  ]

  function withEnv(env: Record<string, string>, fn: () => void) {
    const saved: Record<string, string | undefined> = {}
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    Object.assign(process.env, env)
    try {
      fn()
    } finally {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  it('disables semantic search via flag', () => {
    withEnv(
      { CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL: 'x', CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH: '0' },
      () => {
        expect(isSemanticSearchDisabled()).toBe(true)
      },
    )
    withEnv(
      { CLAUDE_CODE_ADVISOR_EMBEDDING_MODEL: 'x', CLAUDE_CODE_SEMANTIC_SEARCH: 'false' },
      () => {
        expect(isSemanticSearchDisabled()).toBe(true)
      },
    )
  })

  it('cache keys differ per model and text', () => {
    expect(embeddingCacheKey('a', 'x')).not.toBe(embeddingCacheKey('b', 'x'))
    expect(embeddingCacheKey('a', 'x')).not.toBe(embeddingCacheKey('a', 'y'))
    expect(embeddingCacheKey('a', 'x')).toHaveLength(64) // sha256 hex
  })
})

// ---------------------------------------------------------------------------
// Semantic ranking + fusion (pure functions)
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: 1,
    role: 'user',
    text: 'hello',
    searchBody: 'hello',
    charLength: 5,
    truncated: false,
    ...overrides,
  }
}

describe('cosineSimilarity', () => {
  it('computes similarity for aligned vectors', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([1, 1])
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('returns 0 for zero vectors or length mismatch', () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(3))).toBe(0)
    expect(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toBe(0)
  })
})

describe('buildEntryEmbeddingText / hasEmbeddingText', () => {
  it('prefixes role and includes searchText', () => {
    const entry = makeEntry({
      searchBody: 'body text',
      searchText: '{"command":"ls"}',
    })
    const text = buildEntryEmbeddingText(entry)
    expect(text.startsWith('user')).toBe(true)
    expect(text).toContain('body text')
    expect(text).toContain('command')
  })

  it('caps long entries', () => {
    const entry = makeEntry({ searchBody: 'x'.repeat(5_000) })
    expect(buildEntryEmbeddingText(entry, 100).length).toBe(100)
  })

  it('marks thinking-only entries as unembeddable', () => {
    expect(hasEmbeddingText(makeEntry({ searchBody: '' }))).toBe(false)
    expect(hasEmbeddingText(makeEntry())).toBe(true)
  })
})

describe('semanticSearch', () => {
  it('ranks the closest vector first', () => {
    const entries = [
      makeEntry({ id: 1, searchBody: 'cats' }),
      makeEntry({ id: 2, searchBody: 'dogs' }),
      makeEntry({ id: 3, searchBody: 'kittens' }),
    ]
    // Hand-crafted vectors: query closer to "cats"/"kittens" than "dogs".
    const query = new Float32Array([1, 0])
    // cos(q, e1) ~ 0.99995, cos(q, e3) ~ 0.949, cos(q, e2) ~ 0.200
    const vectors = [
      new Float32Array([1, 0.01]),
      new Float32Array([0.2, 0.98]),
      new Float32Array([0.9, 0.3]),
    ]
    const rank = semanticSearch(query, vectors, entries)
    expect(rank.results).toHaveLength(3)
    expect(rank.results[0]!.entry.id).toBe(1)
    expect(rank.results[1]!.entry.id).toBe(3)
    expect(rank.results[2]!.entry.id).toBe(2)
    expect(rank.results[0]!.score).toBeGreaterThan(rank.results[2]!.score)
  })

  it('applies filters before ranking', () => {
    const entries = [
      makeEntry({ id: 1, role: 'user', searchBody: 'a' }),
      makeEntry({ id: 2, role: 'assistant', searchBody: 'b' }),
    ]
    const rank = semanticSearch(
      new Float32Array([1]),
      [new Float32Array([1]), new Float32Array([1])],
      entries,
      e => e.role === 'assistant',
    )
    expect(rank.results).toHaveLength(1)
    expect(rank.results[0]!.entry.id).toBe(2)
  })

  it('skips zero vectors (no embedding text)', () => {
    const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 })]
    const rank = semanticSearch(
      new Float32Array([1]),
      [new Float32Array(0), new Float32Array([1])],
      entries,
    )
    expect(rank.results.map(r => r.entry.id)).toEqual([2])
  })
})

describe('rrfFuse', () => {
  it('fuses two rankings with shared items ranked higher', () => {
    const fused = rrfFuse<string>([
      { items: ['a', 'b', 'c'], weight: 0.5 },
      { items: ['c', 'a', 'd'], weight: 0.5 },
    ])
    const order = fused.map(f => f.item)
    // 'a' and 'c' appear in both lists -> top of the fusion
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'))
    expect(fused[0]!.score).toBeGreaterThan(0)
  })

  it('records per-list ranks', () => {
    const fused = rrfFuse<string>([
      { items: ['x', 'y'], weight: 0.5 },
      { items: ['y'], weight: 0.5 },
    ])
    const y = fused.find(f => f.item === 'y')!
    expect(y.ranks).toEqual([2, 1])
    const x = fused.find(f => f.item === 'x')!
    expect(x.ranks).toEqual([1, undefined])
  })
})

describe('hybridSearch', () => {
  it('fuses keyword and semantic results with both scores attached', () => {
    const entries = [
      makeEntry({ id: 1, searchBody: 'authentication flow' }),
      makeEntry({ id: 2, searchBody: 'login bug' }),
    ]
    const keyword = bm25Search('authentication', buildSearchIndex(entries), 10)
    const semantic = [
      { entry: entries[1]!, score: 0.9 },
      { entry: entries[0]!, score: 0.3 },
    ]
    const fused = hybridSearch(keyword.results, semantic)
    const ids = fused.results.map(r => r.entry.id)
    expect(ids).toContain(1)
    expect(ids).toContain(2)
    const r2 = fused.results.find(r => r.entry.id === 2)!
    expect(r2.semanticScore).toBeCloseTo(0.9, 5)
    expect(r2.keywordScore).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tool integration with injected mock backends
// ---------------------------------------------------------------------------

/**
 * Deterministic mock backend: maps texts to 2D vectors by keyword groups,
 * emulating a real semantic model (related wording -> close vectors).
 */
function mockSemanticBackend(
  groups: Array<{ match: RegExp; vector: number[] }>,
  fallback: number[] = [0.1, 0.9],
): EmbeddingBackend & { getCallCount(): number } {
  let calls = 0
  return {
    kind: 'remote',
    label: 'mock:test-model',
    semantic: true,
    getCallCount: () => calls,
    async embed(texts: string[]) {
      calls += texts.length
      return texts.map(text => {
        for (const group of groups) {
          if (group.match.test(text)) return new Float32Array(group.vector)
        }
        return new Float32Array(fallback)
      })
    },
  }
}

describe('ConversationLogTool semantic search', () => {
  const entries: ConversationEntry[] = [
    makeEntry({ id: 1, role: 'user', searchBody: 'the deployment keeps failing on kubernetes' }),
    makeEntry({ id: 2, role: 'assistant', searchBody: 'I will investigate the rollout issue' }),
    makeEntry({ id: 3, role: 'user', searchBody: 'meanwhile the database migration also broke' }),
  ]

  it('semantic mode ranks conceptually related entries', async () => {
    const backend = mockSemanticBackend([
      { match: /deployment|rollout|kubernetes|cluster|shipping/i, vector: [1, 0.1] },
      { match: /database|migration/i, vector: [0.1, 1] },
    ])
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: backend,
    })
    const result = await tool.call({
      action: 'search',
      query: 'problems with shipping to the cluster',
      mode: 'semantic',
      top_k: 3,
      match_mode: 'or',
    })
    expect(result.data).toContain('mode: semantic')
    expect(result.data).toContain('mock:test-model')
    // First result should be id 1 (deployment) or 2 (rollout), not 3
    const firstId = Number(result.data.match(/\[(\d+)\]/)![1])
    expect([1, 2]).toContain(firstId)
    expect(result.data).toContain('sem=')
  })

  it('hybrid mode includes keyword matches that semantic missed', async () => {
    // Semantic backend maps everything to one vector (useless); keyword must
    // still surface the exact-term match via fusion.
    const backend = mockSemanticBackend([])
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: backend,
    })
    const result = await tool.call({
      action: 'search',
      query: 'kubernetes',
      mode: 'hybrid',
      top_k: 3,
      match_mode: 'or',
    })
    expect(result.data).toContain('mode: hybrid')
    expect(result.data).toContain('[1]')
    expect(result.data).toContain('kw=')
  })

  it('reuses entry vectors across searches within a tool instance', async () => {
    const backend = mockSemanticBackend([
      { match: /deployment/i, vector: [1, 0] },
    ])
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: backend,
    })
    await tool.call({ action: 'search', query: 'deploy', mode: 'semantic', top_k: 2, match_mode: 'or' })
    await tool.call({ action: 'search', query: 'deploy again', mode: 'semantic', top_k: 2, match_mode: 'or' })
    // 3 entry texts once + 2 queries = 5 embed calls total (not 3+3+2)
    expect(backend.getCallCount()).toBe(5)
  })

  it('hybrid degrades to keyword-only with a note when the backend fails', async () => {
    const failing: EmbeddingBackend = {
      kind: 'remote',
      label: 'remote:broken',
      semantic: true,
      async embed() {
        throw new EmbeddingError('endpoint down', 503)
      },
    }
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: failing,
    })
    const result = await tool.call({
      action: 'search',
      query: 'kubernetes',
      mode: 'hybrid',
      top_k: 5,
      match_mode: 'or',
    })
    expect(result.data).toContain('keyword-only')
    expect(result.data).toContain('endpoint down')
    expect(result.data).toContain('[1]')
  })

  it('pure semantic mode reports a clean error when the backend fails', async () => {
    const failing: EmbeddingBackend = {
      kind: 'remote',
      label: 'remote:broken',
      semantic: true,
      async embed() {
        throw new EmbeddingError('endpoint down', 503)
      },
    }
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: failing,
    })
    const result = await tool.call({
      action: 'search',
      query: 'anything',
      mode: 'semantic',
      top_k: 5,
      match_mode: 'or',
    })
    expect(result.data).toContain('Semantic search failed')
    expect(result.data).toContain('endpoint down')
  })

  it('keyword mode remains the default and unchanged', async () => {
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries))
    const parsed = conversationLogInputSchema.parse({
      action: 'search',
      query: 'kubernetes',
    })
    expect(parsed.mode).toBe('keyword')
    const result = await tool.call(parsed)
    expect(result.data).toContain('[1]')
    expect(result.data).not.toContain('mode: semantic')
    expect(result.data).not.toContain('mode: hybrid')
  })

  it('applies role filters in semantic mode', async () => {
    const backend = mockSemanticBackend([
      { match: /deployment|rollout|kubernetes|database|migration|broke/i, vector: [1, 0] },
    ])
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: backend,
    })
    const result = await tool.call({
      action: 'search',
      query: 'problems',
      mode: 'semantic',
      top_k: 10,
      match_mode: 'or',
      roles: ['assistant'],
    })
    expect(result.data).toContain('[2]')
    expect(result.data).not.toContain('[1]')
    expect(result.data).not.toContain('[3]')
  })

  it('reports disabled semantic search when opted out', async () => {
    const prev = process.env.CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH
    process.env.CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH = '0'
    try {
      // No explicit backend injected - env resolution path
      const { tool } = createConversationLogTool(entries, buildSearchIndex(entries))
      const result = await tool.call({
        action: 'search',
        query: 'x',
        mode: 'semantic',
        top_k: 5,
        match_mode: 'or',
      })
      expect(result.data).toContain('disabled')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH
      else process.env.CLAUDE_CODE_ADVISOR_SEMANTIC_SEARCH = prev
    }
  })

  it('local approximate backend works offline and is labeled', async () => {
    const { tool } = createConversationLogTool(entries, buildSearchIndex(entries), {
      embedBackend: createLocalEmbeddingBackend(),
    })
    const result = await tool.call({
      action: 'search',
      query: 'deploy failures',
      mode: 'semantic',
      top_k: 3,
      match_mode: 'or',
    })
    expect(result.data).toContain('local-approximate')
    expect(result.data).toContain('CLAUDE_CODE_ADVISOR_LOCAL_EMBEDDING=0')
  })
})

// ---------------------------------------------------------------------------
// Schema contract
// ---------------------------------------------------------------------------

describe('search schema mode field', () => {
  it('defaults to keyword', () => {
    const parsed = conversationLogInputSchema.parse({ action: 'search', query: 'x' })
    expect(parsed.mode).toBe('keyword')
  })

  it('accepts semantic and hybrid', () => {
    for (const mode of ['semantic', 'hybrid'] as const) {
      const parsed = conversationLogInputSchema.parse({ action: 'search', query: 'x', mode })
      expect(parsed.mode).toBe(mode)
    }
  })

  it('rejects unknown modes', () => {
    expect(() =>
      conversationLogInputSchema.parse({ action: 'search', query: 'x', mode: 'vector' }),
    ).toThrow()
  })
})

