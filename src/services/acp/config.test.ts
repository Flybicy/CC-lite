import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  ACP_DEFAULT_CONTEXT_LIMIT,
  getAcpContextLimit,
  pickAcpContextLimit,
  setAcpModelHint,
} from './config.js'
import { getAcpSession, resetAcpSession } from './session.js'

const ENV = 'CCLITE_ACP_CONTEXT_LIMIT'

describe('pickAcpContextLimit', () => {
  test('env override wins over everything', () => {
    expect(pickAcpContextLimit(500_000, 300_000, 1_000_000)).toBe(500_000)
  })

  test('explicit setting wins over the resolved model window', () => {
    expect(pickAcpContextLimit(undefined, 300_000, 1_000_000)).toBe(300_000)
  })

  test('follows the model window when nothing overrides it', () => {
    expect(pickAcpContextLimit(undefined, undefined, 1_000_000)).toBe(1_000_000)
    expect(pickAcpContextLimit(undefined, undefined, 128_000)).toBe(128_000)
  })

  test('falls back to 200K when nothing is known', () => {
    expect(pickAcpContextLimit(undefined, undefined, undefined)).toBe(
      ACP_DEFAULT_CONTEXT_LIMIT,
    )
  })

  test('ignores non-positive and non-finite values', () => {
    expect(pickAcpContextLimit(0, -1, 400_000)).toBe(400_000)
    expect(pickAcpContextLimit(Number.NaN, Number.POSITIVE_INFINITY, 400_000)).toBe(
      400_000,
    )
  })
})

describe('getAcpContextLimit', () => {
  afterEach(() => {
    delete process.env[ENV]
    setAcpModelHint(undefined)
  })

  test('resolves the window through the injected resolver', () => {
    const seen: string[] = []
    const limit = getAcpContextLimit('arkplan/some-1m-model', model => {
      seen.push(model)
      return 1_000_000
    })
    expect(seen).toEqual(['arkplan/some-1m-model'])
    expect(limit).toBe(1_000_000)
  })

  test('uses the model hint set by the query loop', () => {
    setAcpModelHint('opus')
    const limit = getAcpContextLimit(undefined, () => 1_000_000)
    expect(limit).toBe(1_000_000)
  })

  test('env still beats the model window', () => {
    process.env[ENV] = '64000'
    expect(getAcpContextLimit('opus', () => 1_000_000)).toBe(64_000)
  })

  test('falls back when the resolver throws or returns garbage', () => {
    const throwing = () => {
      throw new Error('boom')
    }
    expect(getAcpContextLimit('opus', throwing)).toBe(ACP_DEFAULT_CONTEXT_LIMIT)
    expect(getAcpContextLimit('opus', () => 0)).toBe(ACP_DEFAULT_CONTEXT_LIMIT)
  })
})

describe('getAcpSession window changes', () => {
  beforeEach(() => {
    resetAcpSession()
    delete process.env[ENV]
  })

  afterEach(() => {
    delete process.env[ENV]
    resetAcpSession()
  })

  test('keeps folded state when the window changes', () => {
    process.env[ENV] = '500000'
    const first = getAcpSession()
    expect(first.limit).toBe(500_000)
    first.state.stats.tokensCompressed = 1234

    process.env[ENV] = '1000000'
    const second = getAcpSession()
    expect(second.limit).toBe(1_000_000)
    // Same kernel objects: the work survives a model switch.
    expect(second.state).toBe(first.state)
    expect(second.core).toBe(first.core)
    expect(second.contentStore).toBe(first.contentStore)
    expect(second.config.modelContextLimit).toBe(1_000_000)
    expect(second.state.stats.tokensCompressed).toBe(1234)
  })
})
