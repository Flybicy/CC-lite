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
