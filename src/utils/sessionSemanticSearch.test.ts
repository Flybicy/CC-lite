import { describe, expect, it } from 'bun:test'
import {
  mergeKeywordAndSemantic,
  rankSessionsBySimilarity,
  SEMANTIC_SESSION_MAX_RESULTS,
  SEMANTIC_SESSION_MIN_SCORE,
  type RankSessionsOptions,
} from './sessionSemanticSearch.js'
import type { EmbeddingBackend, EmbeddingVector } from '../tools/AdvisorTool/conversationLog/embeddings.js'

// Deterministic fake model: dim-2 vectors where the first char code decides
// the direction. 'a'-texts cluster together and away from 'z'-texts.
const DIM = 2

function fakeVector(text: string): EmbeddingVector {
  const v = new Float32Array(DIM)
  if (!text.trim()) return v
  const hot = text.includes('database') || text.includes('数据库') ? 1 : -1
  v[0] = hot
  v[1] = 1
  return v
}

function fakeBackend(): EmbeddingBackend {
  return {
    kind: 'local',
    label: 'fake',
    semantic: true,
    async embed(texts) {
      return texts.map(fakeVector)
    },
  }
}

function failingBackend(): EmbeddingBackend {
  return {
    kind: 'local',
    label: 'fake-fail',
    semantic: true,
    async embed() {
      throw new Error('model missing')
    },
  }
}

const opts: RankSessionsOptions = { backend: fakeBackend() }

describe('rankSessionsBySimilarity', () => {
  it('returns only sessions at or above the threshold', async () => {
    const logs = ['db session about database tuning', 'cooking recipes', 'database migrations again']
    const scores = await rankSessionsBySimilarity('database cleanup', logs, l => l, opts)
    expect(scores).not.toBeNull()
    // The cooking session's vector points the other way -> below threshold.
    expect(scores!.has(logs[1])).toBe(false)
    expect(scores!.has(logs[0])).toBe(true)
    expect(scores!.has(logs[2])).toBe(true)
    for (const score of scores!.values()) {
      expect(score).toBeGreaterThanOrEqual(SEMANTIC_SESSION_MIN_SCORE)
    }
  })

  it('returns null on empty/whitespace query without calling the backend', async () => {
    let calls = 0
    const countingBackend: EmbeddingBackend = {
      ...fakeBackend(),
      async embed(texts) { calls += texts.length; return texts.map(fakeVector) },
    }
    expect(await rankSessionsBySimilarity('', ['a'], l => l, { backend: countingBackend })).toBeNull()
    expect(await rankSessionsBySimilarity('   ', ['a'], l => l, { backend: countingBackend })).toBeNull()
    expect(calls).toBe(0)
  })

  it('returns null when there are no sessions', async () => {
    expect(await rankSessionsBySimilarity('query', [], () => '', opts)).toBeNull()
  })

  it('returns null (not throw) when embedding fails', async () => {
    const result = await rankSessionsBySimilarity('q', ['a'], l => l, { backend: failingBackend() })
    expect(result).toBeNull()
  })

  it('caps embedded text length per session', async () => {
    const seenLengths: number[] = []
    const spyBackend: EmbeddingBackend = {
      ...fakeBackend(),
      async embed(texts, embedOpts) {
        if (embedOpts?.forQuery) return [fakeVector(texts[0]!)]
        for (const t of texts) seenLengths.push(t.length)
        return texts.map(fakeVector)
      },
    }
    const longText = 'database '.repeat(1000) // ~9000 chars
    await rankSessionsBySimilarity('database', [longText], l => l, { backend: spyBackend })
    expect(seenLengths[0]).toBeLessThanOrEqual(2000)
  })
})

describe('mergeKeywordAndSemantic', () => {
  it('keeps keyword-hit order untouched and appends capped semantic-only hits', () => {
    const kw = ['k1', 'k2']
    const matches = new Map<string, number>([
      ['s-best', 0.9],
      ['s-worst', 0.31],
      ['s-mid', 0.5],
      ['k1', 0.99], // keyword hit also scored semantically - not duplicated
    ])
    const merged = mergeKeywordAndSemantic(kw, matches)
    expect(merged).toEqual(['k1', 'k2', 's-best', 's-mid', 's-worst'])
  })

  it('respects the max-results cap for semantic-only extras', () => {
    const matches = new Map<string, number>()
    for (let i = 0; i < SEMANTIC_SESSION_MAX_RESULTS + 5; i++) {
      matches.set(`extra-${i}`, 0.5 + i / 100)
    }
    const merged = mergeKeywordAndSemantic([], matches)
    expect(merged).toHaveLength(SEMANTIC_SESSION_MAX_RESULTS)
    // Best score first.
    expect(merged[0]).toBe(`extra-${SEMANTIC_SESSION_MAX_RESULTS + 4}`)
  })

  it('passes the keyword list through when there is no semantic info', () => {
    const kw = ['a', 'b']
    expect(mergeKeywordAndSemantic(kw, null)).toEqual(kw)
    expect(mergeKeywordAndSemantic(kw, new Map())).toEqual(kw)
    // Returned list is a copy - callers may sort freely.
    const result = mergeKeywordAndSemantic(kw, null)
    expect(result).not.toBe(kw)
  })
})
