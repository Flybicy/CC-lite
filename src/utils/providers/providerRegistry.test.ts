import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProviderConfigPath,
  isProviderRoutingActive,
  loadProviderConfig,
  resetProviderConfigCacheForTests,
  resolveScopeProvider,
  saveProviderConfig,
  scopeForQuerySource,
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
  version: 1,
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
  routing: {
    main: { providerId: 'openai-main', model: 'gpt-4o' },
    subagent: { providerId: 'local-lm', model: 'qwen2.5-7b' },
  },
}

describe('providerRegistry', () => {
  it('returns an empty config when the file is absent', () => {
    const cfg = loadProviderConfig()
    expect(cfg.providers).toEqual([])
    expect(cfg.routing).toEqual({})
    expect(isProviderRoutingActive()).toBe(false)
  })

  it('round-trips save/load and honors CLAUDE_CONFIG_DIR', () => {
    saveProviderConfig(SAMPLE)
    expect(getProviderConfigPath()).toBe(join(dir, 'providers.json'))
    const cfg = loadProviderConfig()
    expect(cfg.providers).toHaveLength(2)
    expect(cfg.routing.main?.model).toBe('gpt-4o')
    expect(isProviderRoutingActive()).toBe(true)
  })

  it('resolves the provider bound to a scope', () => {
    saveProviderConfig(SAMPLE)
    const main = resolveScopeProvider('main')
    expect(main?.provider.id).toBe('openai-main')
    expect(main?.provider.apiKey).toBe('sk-main')
    expect(main?.model).toBe('gpt-4o')

    const sub = resolveScopeProvider('subagent')
    expect(sub?.provider.baseURL).toBe('http://127.0.0.1:1234/v1')
    expect(sub?.model).toBe('qwen2.5-7b')

    // advisor has no routing entry
    expect(resolveScopeProvider('advisor')).toBeNull()
  })

  it('returns null when routing points at a missing provider', () => {
    saveProviderConfig({
      version: 1,
      providers: [],
      routing: { main: { providerId: 'ghost', model: 'x' } },
    })
    expect(resolveScopeProvider('main')).toBeNull()
    expect(isProviderRoutingActive()).toBe(false)
  })

  it('falls back to an empty config on malformed JSON', () => {
    writeFileSync(join(dir, 'providers.json'), '{ not json', 'utf8')
    const cfg = loadProviderConfig()
    expect(cfg.providers).toEqual([])
  })

  it('maps query sources to scopes', () => {
    expect(scopeForQuerySource('advisor')).toBe('advisor')
    expect(scopeForQuerySource('agent:custom')).toBe('subagent')
    expect(scopeForQuerySource('repl_main_thread')).toBe('main')
    expect(scopeForQuerySource(undefined)).toBe('main')
  })

  it('picks up external edits via mtime cache invalidation', () => {
    saveProviderConfig(SAMPLE)
    expect(loadProviderConfig().providers).toHaveLength(2)
    // simulate an external writer (WebUI) replacing the file
    const next: ProviderConfig = {
      ...SAMPLE,
      providers: [SAMPLE.providers[0]],
      routing: { main: { providerId: 'openai-main', model: 'gpt-4o-mini' } },
    }
    // ensure mtime advances even on coarse clocks
    const later = Date.now() + 2000
    writeFileSync(join(dir, 'providers.json'), JSON.stringify(next), 'utf8')
    const { utimesSync } = require('node:fs')
    utimesSync(join(dir, 'providers.json'), later / 1000, later / 1000)
    const cfg = loadProviderConfig()
    expect(cfg.providers).toHaveLength(1)
    expect(cfg.routing.main?.model).toBe('gpt-4o-mini')
  })
})
