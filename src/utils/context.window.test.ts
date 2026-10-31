import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getContextWindowForModel } from './context.js'
import {
  resetProviderConfigCacheForTests,
  saveProviderConfig,
} from './providers/providerRegistry.js'

let dir: string
let prevEnv: string | undefined
let prevMaxTokens: string | undefined

beforeEach(() => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR
  prevMaxTokens = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  dir = mkdtempSync(join(tmpdir(), 'cclite-window-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  if (prevMaxTokens === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = prevMaxTokens
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

const PROVIDERS = [
  {
    id: 'relay',
    label: 'Relay',
    type: 'openai' as const,
    baseURL: 'https://relay.example.test/v1',
    apiKey: 'k',
    models: ['deepseek-v4.1-flash'],
  },
]

describe('getContextWindowForModel — tier codenames resolve to the model', () => {
  it('clamps a codename to the smallest window its model is bound to', () => {
    saveProviderConfig({
      version: 2,
      providers: PROVIDERS,
      tiers: {
        opus: {
          providerId: 'relay',
          model: 'deepseek-v4.1-flash',
          contextWindow: 200_000,
        },
        sonnet: {
          providerId: 'relay',
          model: 'deepseek-v4.1-flash',
          contextWindow: 500_000,
        },
      },
    })
    // Same model, different tier rows: the conservative window must win, or
    // auto-compact / the ACP kernel never fire before the upstream 413s.
    expect(getContextWindowForModel('opus')).toBe(200_000)
    expect(getContextWindowForModel('sonnet')).toBe(200_000)
  })

  it('keeps a lone binding window untouched', () => {
    saveProviderConfig({
      version: 2,
      providers: PROVIDERS,
      tiers: {
        sonnet: {
          providerId: 'relay',
          model: 'deepseek-v4.1-flash',
          contextWindow: 500_000,
        },
      },
    })
    expect(getContextWindowForModel('sonnet')).toBe(500_000)
  })

  it('still honors the explicit env override', () => {
    saveProviderConfig({
      version: 2,
      providers: PROVIDERS,
      tiers: {
        sonnet: {
          providerId: 'relay',
          model: 'deepseek-v4.1-flash',
          contextWindow: 500_000,
        },
      },
    })
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '320000'
    expect(getContextWindowForModel('sonnet')).toBe(320_000)
  })
})
