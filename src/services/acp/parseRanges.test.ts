import { describe, expect, test } from 'bun:test'
import { normalizeCompressRanges } from './parseRanges.js'

describe('normalizeCompressRanges — the shapes the compress schema advertises', () => {
  test('single header block', () => {
    const out = normalizeCompressRanges('m00150–m00220 retry loop\n- retried the same call 3x')
    expect(out).toEqual([
      {
        startRef: 'm00150',
        endRef: 'm00220',
        summary: '- retried the same call 3x',
        topic: 'retry loop',
      },
    ])
  })

  test('multi-block text (the documented PREFERRED form)', () => {
    const text = [
      'm00100–m00140 first\n- did A',
      '',
      'm00200–m00260 second\n- did B',
    ].join('\n')
    const out = normalizeCompressRanges(text)
    expect(out.map(r => `${r.startRef}:${r.endRef}`)).toEqual(['m00100:m00140', 'm00200:m00260'])
    expect(out[1]!.summary).toBe('- did B')
    expect(out[1]!.topic).toBe('second')
  })

  test('array of strings and {content: string}', () => {
    const one = 'm00050–m00090 a\n- x'
    expect(normalizeCompressRanges([one])).toHaveLength(1)
    expect(normalizeCompressRanges({ content: one })).toHaveLength(1)
  })

  test('{content: [{startId, endId, summary}]} — the shape the kernel already parses', () => {
    const out = normalizeCompressRanges({
      content: [{ startId: 'm00100', endId: 'm00200', summary: 'x' }],
    })
    expect(out).toEqual([{ startRef: 'm00100', endRef: 'm00200', summary: 'x' }])
  })

  test('{ranges: [...]}, flat {startRef,endRef,summary}, {range, summary}', () => {
    expect(
      normalizeCompressRanges({ ranges: [{ startRef: 'm0010', endRef: 'm0020', summary: 'y' }] }),
    ).toEqual([{ startRef: 'm00010', endRef: 'm00020', summary: 'y' }])
    expect(normalizeCompressRanges({ startRef: 'm00300', endRef: 'm00350', summary: 'z' })).toEqual([
      { startRef: 'm00300', endRef: 'm00350', summary: 'z' },
    ])
    expect(normalizeCompressRanges({ range: 'm00400–m00450', summary: 'w' })).toEqual([
      { startRef: 'm00400', endRef: 'm00450', summary: 'w' },
    ])
  })

  test('dash variants and Chinese 到', () => {
    const out = normalizeCompressRanges(
      ['m00010 - m00020 a\n- s', 'm00030 — m00040 b\n- s', 'm00050 到 m00060 c\n- s'].join('\n'),
    )
    expect(out.map(r => `${r.startRef}:${r.endRef}`)).toEqual([
      'm00010:m00020',
      'm00030:m00040',
      'm00050:m00060',
    ])
  })

  test('drops empty summaries and duplicate ranges', () => {
    const text = ['m00100–m00200 empty', 'm00100–m00200 dup\n- kept'].join('\n')
    const out = normalizeCompressRanges(text)
    expect(out).toHaveLength(1)
    expect(out[0]!.summary).toBe('- kept')
  })

  test('returns [] for junk', () => {
    expect(normalizeCompressRanges(undefined)).toEqual([])
    expect(normalizeCompressRanges({})).toEqual([])
    expect(normalizeCompressRanges('no headers here')).toEqual([])
    expect(normalizeCompressRanges([1, null, true])).toEqual([])
  })
})
