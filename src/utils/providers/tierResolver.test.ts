import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resetProviderConfigCacheForTests,
  saveProviderConfig,
  type ProviderConfig,
} from './providerRegistry.js'
import {
  resolveTierConnection,
  resolveTierConnectionByTier,
} from './tierResolver.js'

let dir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'cclite-tier-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

const CFG: ProviderConfig = {
  version: 2,
  providers: [
    {
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
      models: ['deepseek-chat'],
    },
  ],
  tiers: {
    pro: { providerId: 'deepseek', model: 'deepseek-chat' },
  },
}

describe('resolveTierConnection', () => {
  it('resolves a bound tier to full connection details', () => {
    saveProviderConfig(CFG)
    const conn = resolveTierConnection('repl_main_thread')
    expect(conn.source).toBe('routing')
    if (conn.source === 'routing') {
      expect(conn.tier).toBe('pro')
      expect(conn.scope).toBe('main')
      expect(conn.type).toBe('openai')
      expect(conn.baseURL).toBe('https://api.deepseek.com/v1')
      expect(conn.apiKey).toBe('sk-ds')
      expect(conn.model).toBe('deepseek-chat')
    }
  })

  it('maps agent sources to the se tier', () => {
    saveProviderConfig(CFG)
    // se is unbound in CFG → env fallback, but the tier label is still se
    const conn = resolveTierConnection('agent:builtin:Task')
    expect(conn.source).toBe('env')
    expect(conn.tier).toBe('se')
    expect(conn.scope).toBe('subagent')
  })

  it('maps the advisor source to the pro tier (advisor follows the main loop)', () => {
    saveProviderConfig(CFG)
    const conn = resolveTierConnection('advisor')
    expect(conn.tier).toBe('pro')
    expect(conn.scope).toBe('main')
  })

  it('falls back to env when the tier is unbound', () => {
    const conn = resolveTierConnectionByTier('pro')
    expect(conn.source).toBe('env')
  })
})
describe('provider custom headers', () => {
  it('passes provider.headers through the resolved connection', () => {
    saveProviderConfig({
      version: 2,
      providers: [
        {
          id: 'strict',
          label: 'Strict GW',
          type: 'anthropic',
          baseURL: 'https://gw.example.com',
          apiKey: 'sk-x',
          models: [],
          headers: {
            'User-Agent': 'claude-cli/2.0.30 (external, cli)',
            'x-app': 'cli',
          },
        },
      ],
      tiers: { plus: { providerId: 'strict', model: 'some-model' } },
    })
    const conn = resolveTierConnectionByTier('plus')
    expect(conn.source).toBe('routing')
    if (conn.source === 'routing') {
      expect(conn.headers).toEqual({
        'User-Agent': 'claude-cli/2.0.30 (external, cli)',
        'x-app': 'cli',
      })
    }
  })

  it('omits headers when the provider has none', () => {
    saveProviderConfig(CFG)
    const conn = resolveTierConnectionByTier('pro')
    if (conn.source === 'routing') {
      expect(conn.headers).toBeUndefined()
    }
  })
})

describe('tier contextWindow', () => {
  const CTX_CFG: ProviderConfig = {
    version: 2,
    providers: [
      { id: 'a', label: 'A', type: 'anthropic', baseURL: 'https://a.example.com', apiKey: '', models: [] },
      { id: 'o', label: 'O', type: 'openai', baseURL: 'https://o.example.com/v1', apiKey: '', models: [] },
    ],
    tiers: {
      pro: { providerId: 'a', model: 'm1', contextWindow: 1_000_000 },
      plus: { providerId: 'o', model: 'm2', contextWindow: 128_000 },
      se: { providerId: 'a', model: 'm3' },
    },
  }

  it('resolves the configured window per tier', async () => {
    const { resolveTierContextWindow } = await import('./tierResolver.js')
    saveProviderConfig(CTX_CFG)
    expect(resolveTierContextWindow('pro')).toBe(1_000_000)
    expect(resolveTierContextWindow('plus')).toBe(128_000)
    expect(resolveTierContextWindow('se')).toBeUndefined()
  })

  it('only asks for the 1M beta header on anthropic providers above 200K', async () => {
    const { tierNeeds1mBetaHeader } = await import('./tierResolver.js')
    saveProviderConfig(CTX_CFG)
    expect(tierNeeds1mBetaHeader('pro')).toBe(true)
    expect(tierNeeds1mBetaHeader('plus')).toBe(false) // openai provider
    expect(tierNeeds1mBetaHeader('se')).toBe(false) // no window configured
  })

  it('feeds getContextWindowForModel through the tier codename and scope', async () => {
    const { getContextWindowForModel } = await import('../context.js')
    saveProviderConfig(CTX_CFG)
    expect(getContextWindowForModel('pro')).toBe(1_000_000)
    // Resolved model id: scope fallback maps main -> pro
    expect(getContextWindowForModel('m1', [], 'main')).toBe(1_000_000)
  })
})
