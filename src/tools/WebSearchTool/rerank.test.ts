import { describe, expect, it } from 'bun:test'
import {
  isSemanticRerankEnabled,
  rerankBySimilarity,
} from './rerank.js'
import type { EmbeddingBackend, EmbeddingVector } from '../AdvisorTool/conversationLog/embeddings.js'

function fakeBackend(vectors: Float32Array[]): EmbeddingBackend {
  let call = 0
  return {
    kind: 'local',
    label: 'test',
    semantic: true,
    async embed(texts: string[]) {
      void texts
      // Rerank embeds the query alone first (so models with query-side
      // retrieval instructions treat it correctly), then the snippets.
      if (call++ === 0) return [vectors[0]!]
      return vectors.slice(1)
    },
  }
}

const items = [
  { id: 'a', snippet: 'chocolate chip cookie recipe' },
  { id: 'b', snippet: 'fixing node.js memory leaks with heap snapshots' },
  { id: 'c', snippet: 'cookie clicker strategy guide' },
]

describe('semantic rerank (SearXNG)', () => {
  it('is opt-in and off by default', () => {
    delete process.env.CCLITE_SEMANTIC_RERANK
    expect(isSemanticRerankEnabled()).toBe(false)
    process.env.CCLITE_SEMANTIC_RERANK = '1'
    expect(isSemanticRerankEnabled()).toBe(true)
    delete process.env.CCLITE_SEMANTIC_RERANK
  })

  it('orders results by cosine similarity to the query', async () => {
    // Query vector; b is closest, then c, then a.
    const q = new Float32Array([1, 0, 0])
    const backend = fakeBackend([
      q,
      new Float32Array([0.9, 0.1, 0]), // a — low similarity
      new Float32Array([0.99, 0.05, 0]), // b — highest
      new Float32Array([0.95, 0.08, 0]), // c — middle
    ])
    const ranked = await rerankBySimilarity(
      'node memory leak',
      items,
      i => i.snippet,
      { backend },
    )
    expect(ranked.map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps original order on score ties (stable sort)', async () => {
    const same = new Float32Array([1, 0, 0])
    const backend = fakeBackend([
      same,
      new Float32Array([1, 0, 0]),
      new Float32Array([1, 0, 0]),
      new Float32Array([1, 0, 0]),
    ])
    const ranked = await rerankBySimilarity('q', items, i => i.snippet, { backend })
    expect(ranked.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns the input untouched for 0/1 items or a failing backend', async () => {
    const failing: EmbeddingBackend = {
      kind: 'local',
      label: 'bad',
      semantic: true,
      async embed() {
        throw new Error('boom')
      },
    }
    await expect(rerankBySimilarity('q', [], i => i.snippet, { backend: failing })).resolves.toEqual([])
    const one = [items[0]!]
    await expect(rerankBySimilarity('q', one, i => i.snippet, { backend: failing })).resolves.toBe(one)
    const failed = await rerankBySimilarity('q', items, i => i.snippet, { backend: failing })
    expect(failed.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('empty snippets sink but ties among them stay stable', async () => {
    const q = new Float32Array([1, 0, 0])
    // Embed by content: non-empty texts get the query direction, empty get
    // zero vectors (mirrors real backends).
    const backend: EmbeddingBackend = {
      kind: 'local',
      label: 'test',
      semantic: true,
      async embed(texts: string[]) {
        return texts.map(t => (t.trim().length > 0 ? new Float32Array(q) : new Float32Array(0)))
      },
    }
    const ranked = await rerankBySimilarity('q', items, i => (i.id === 'a' ? '' : i.snippet), {
      backend,
    })
    // b/c scored 1.0 and keep relative order; zero-vector a sinks.
    expect(ranked.map(r => r.id)).toEqual(['b', 'c', 'a'])
  })
})
