import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProviderConfigPath,
  isProviderRoutingActive,
  isTierBound,
  loadProviderConfig,
  resetProviderConfigCacheForTests,
  resolveScopeProvider,
  resolveTierProvider,
  saveProviderConfig,
  scopeForQuerySource,
  tierForQuerySource,
  type ProviderConfig,
} from './providerRegistry.js'

let dir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'cclite-providers-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

const SAMPLE: ProviderConfig = {
  version: 2,
  providers: [
    {
      id: 'openai-main',
      label: 'OpenAI',
      type: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-main',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
      id: 'local-lm',
      label: 'LM Studio',
      type: 'openai',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      models: ['qwen2.5-7b'],
    },
  ],
  tiers: {
    pro: { providerId: 'openai-main', model: 'gpt-4o' },
    se: { providerId: 'local-lm', model: 'qwen2.5-7b' },
  },
}

describe('providerRegistry', () => {
  it('returns an empty config when the file is absent', () => {
    const cfg = loadProviderConfig()
    expect(cfg.providers).toEqual([])
    expect(cfg.tiers).toEqual({})
    expect(isProviderRoutingActive()).toBe(false)
  })

  it('round-trips save/load and honors CLAUDE_CONFIG_DIR', () => {
    saveProviderConfig(SAMPLE)
    expect(getProviderConfigPath()).toBe(join(dir, 'providers.json'))
    const cfg = loadProviderConfig()
    expect(cfg.providers).toHaveLength(2)
    expect(cfg.tiers.pro?.model).toBe('gpt-4o')
    expect(isProviderRoutingActive()).toBe(true)
  })

  it('resolves the provider bound to a tier', () => {
    saveProviderConfig(SAMPLE)
    const pro = resolveTierProvider('pro')
    expect(pro?.provider.id).toBe('openai-main')
    expect(pro?.provider.apiKey).toBe('sk-main')
    expect(pro?.model).toBe('gpt-4o')
    expect(pro?.scope).toBe('main')

    const se = resolveTierProvider('se')
    expect(se?.provider.baseURL).toBe('http://127.0.0.1:1234/v1')
    expect(se?.model).toBe('qwen2.5-7b')

    // plus has no binding
    expect(resolveTierProvider('plus')).toBeNull()
    expect(isTierBound('plus')).toBe(false)
    expect(isTierBound('pro')).toBe(true)
  })

  it('resolves through the legacy scope names too', () => {
    saveProviderConfig(SAMPLE)
    expect(resolveScopeProvider('main')?.model).toBe('gpt-4o')
    expect(resolveScopeProvider('subagent')?.model).toBe('qwen2.5-7b')
    expect(resolveScopeProvider('advisor')).toBeNull()
  })

  it('migrates a v1 file with routing/main/subagent/advisor to tiers', () => {
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        version: 1,
        providers: SAMPLE.providers,
        routing: {
          main: { providerId: 'openai-main', model: 'gpt-4o' },
          subagent: { providerId: 'local-lm', model: 'qwen2.5-7b' },
          advisor: { providerId: 'openai-main', model: 'gpt-4o-mini' },
        },
      }),
      'utf8',
    )
    const cfg = loadProviderConfig()
    expect(cfg.version).toBe(2)
    expect(cfg.tiers.pro?.model).toBe('gpt-4o')
    expect(cfg.tiers.se?.model).toBe('qwen2.5-7b')
    expect(cfg.tiers.plus?.model).toBe('gpt-4o-mini')
  })

  it('returns null when a tier points at a missing provider', () => {
    saveProviderConfig({
      version: 2,
      providers: [],
      tiers: { pro: { providerId: 'ghost', model: 'x' } },
    })
    expect(resolveTierProvider('pro')).toBeNull()
    expect(isProviderRoutingActive()).toBe(false)
  })

  it('falls back to an empty config on malformed JSON', () => {
    writeFileSync(join(dir, 'providers.json'), '{ not json', 'utf8')
    const cfg = loadProviderConfig()
    expect(cfg.providers).toEqual([])
  })

  it('maps query sources to tiers and legacy scopes', () => {
    expect(tierForQuerySource('advisor')).toBe('pro')
    expect(tierForQuerySource('agent:custom')).toBe('se')
    expect(tierForQuerySource('repl_main_thread')).toBe('pro')
    expect(tierForQuerySource(undefined)).toBe('pro')

    expect(scopeForQuerySource('advisor')).toBe('main')
    expect(scopeForQuerySource('agent:custom')).toBe('subagent')
    expect(scopeForQuerySource('repl_main_thread')).toBe('main')
    expect(scopeForQuerySource(undefined)).toBe('main')
  })

  it('picks up external edits via cache invalidation (hot reload)', () => {
    saveProviderConfig(SAMPLE)
    expect(loadProviderConfig().tiers.pro?.model).toBe('gpt-4o')
    // simulate an external writer (the WebUI) replacing the file
    const next: ProviderConfig = {
      ...SAMPLE,
      providers: [SAMPLE.providers[0]],
      tiers: { pro: { providerId: 'openai-main', model: 'gpt-4o-mini' } },
    }
    writeFileSync(join(dir, 'providers.json'), JSON.stringify(next), 'utf8')
    // ensure the identity key changes even on coarse mtime clocks
    const later = (Date.now() + 2000) / 1000
    utimesSync(join(dir, 'providers.json'), later, later)
    const cfg = loadProviderConfig()
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.tiers.pro?.model).toBe('gpt-4o-mini')
    expect(resolveTierProvider('pro')?.model).toBe('gpt-4o-mini')
  })
})