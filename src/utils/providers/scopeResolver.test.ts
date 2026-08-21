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
  resolveScopeConnection,
  resolveScopeConnectionByScope,
} from './scopeResolver.js'

let dir: string
let prevEnv: string | undefined

beforeEach(() => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'cclite-scope-'))
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
  version: 1,
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
  routing: {
    main: { providerId: 'deepseek', model: 'deepseek-chat' },
  },
}

describe('resolveScopeConnection', () => {
  it('resolves a routed scope to full connection details', () => {
    saveProviderConfig(CFG)
    const conn = resolveScopeConnection('repl_main_thread')
    expect(conn.source).toBe('routing')
    if (conn.source === 'routing') {
      expect(conn.type).toBe('openai')
      expect(conn.baseURL).toBe('https://api.deepseek.com/v1')
      expect(conn.apiKey).toBe('sk-ds')
      expect(conn.model).toBe('deepseek-chat')
      expect(conn.scope).toBe('main')
    }
  })

  it('maps agent sources to the subagent scope', () => {
    saveProviderConfig(CFG)
    // subagent not routed in CFG → env fallback, but scope label is subagent
    const conn = resolveScopeConnection('agent:builtin:Task')
    expect(conn.source).toBe('env')
    expect(conn.scope).toBe('subagent')
  })

  it('maps advisor source to advisor scope', () => {
    saveProviderConfig(CFG)
    const conn = resolveScopeConnection('advisor')
    expect(conn.scope).toBe('advisor')
  })

  it('falls back to env when no routing exists', () => {
    const conn = resolveScopeConnectionByScope('main')
    expect(conn.source).toBe('env')
  })
})
