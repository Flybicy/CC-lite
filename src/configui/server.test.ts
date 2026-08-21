import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProviderConfig,
  resetProviderConfigCacheForTests,
} from '../utils/providers/providerRegistry.js'
import {
  isAllowedHost,
  resolvePreferredPort,
  startConfigServer,
  type ConfigServer,
} from './server.js'

let dir: string
let prevEnv: string | undefined
let server: ConfigServer
let base: string

beforeAll(async () => {
  prevEnv = process.env.CLAUDE_CONFIG_DIR
  dir = mkdtempSync(join(tmpdir(), 'cclite-cfgui-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  resetProviderConfigCacheForTests()
  server = await startConfigServer(0) // ephemeral port for tests
  base = server.url
})

afterAll(async () => {
  await server.close()
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevEnv
  resetProviderConfigCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

async function call(path: string, method = 'GET', body?: unknown) {
  const resp = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: resp.status, data: await resp.json().catch(() => null) }
}

describe('config WebUI server', () => {
  it('serves the HTML page', async () => {
    const resp = await fetch(base + '/')
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('CC-lite')
    expect(html).toContain('提供商')
    // the three tier codenames must be present in the page
    expect(html).toContain('pro')
    expect(html).toContain('plus')
    expect(html).toContain('se')
  })

  it('adds a provider, reflects it in /api/config and on disk', async () => {
    const { status, data } = await call('/api/providers', 'POST', {
      label: 'Local LM Studio',
      type: 'openai',
      baseURL: 'http://127.0.0.1:1234/v1',
      apiKey: '',
    })
    expect(status).toBe(200)
    expect(data.provider.id).toBe('local-lm-studio')

    const cfg = await call('/api/config')
    expect(cfg.data.config.providers).toHaveLength(1)

    resetProviderConfigCacheForTests()
    expect(loadProviderConfig().providers[0].baseURL).toBe('http://127.0.0.1:1234/v1')
  })

  it('generates unique ids for duplicate labels', async () => {
    const { data } = await call('/api/providers', 'POST', {
      label: 'Local LM Studio',
      type: 'openai',
      baseURL: 'http://127.0.0.1:9999/v1',
      apiKey: 'x',
    })
    expect(data.provider.id).toBe('local-lm-studio-2')
  })

  it('edits a provider without clobbering the stored key on empty input', async () => {
    const { data } = await call('/api/providers', 'POST', {
      id: 'local-lm-studio-2',
      label: 'LM Studio B',
      type: 'openai',
      baseURL: 'http://127.0.0.1:9999/v1',
      apiKey: '',
    })
    expect(data.provider.label).toBe('LM Studio B')
    expect(data.provider.apiKey).toBe('x')
  })

  it('rejects invalid baseURL', async () => {
    const { status, data } = await call('/api/providers', 'POST', {
      label: 'bad',
      baseURL: 'notaurl',
    })
    expect(status).toBe(400)
    expect(data.error).toContain('baseURL')
  })

  it('rejects a non-http baseURL scheme', async () => {
    const { status, data } = await call('/api/providers', 'POST', {
      label: 'bad scheme',
      baseURL: 'file:///etc/passwd',
    })
    expect(status).toBe(400)
    expect(data.error).toContain('http')
  })

  it('saves pro/plus/se bindings and clears on null', async () => {
    const put = await call('/api/tiers', 'PUT', {
      pro: { providerId: 'local-lm-studio', model: 'qwen2.5-7b' },
      se: { providerId: 'local-lm-studio-2', model: 'qwen2.5-3b' },
      plus: null,
    })
    expect(put.status).toBe(200)
    resetProviderConfigCacheForTests()
    const cfg = loadProviderConfig()
    expect(cfg.tiers.pro?.model).toBe('qwen2.5-7b')
    expect(cfg.tiers.se?.providerId).toBe('local-lm-studio-2')
    expect(cfg.tiers.plus).toBeUndefined()
  })

  it('rejects binding a tier to an unknown provider', async () => {
    const { status, data } = await call('/api/tiers', 'PUT', {
      pro: { providerId: 'ghost', model: 'x' },
    })
    expect(status).toBe(400)
    expect(data.error).toContain('unknown provider')
  })

  it('rejects an unknown tier name', async () => {
    const { status, data } = await call('/api/tiers', 'PUT', {
      ultra: { providerId: 'local-lm-studio', model: 'x' },
    })
    expect(status).toBe(400)
    expect(data.error).toContain('unknown tier')
  })

  it('deleting a provider drops its tier bindings', async () => {
    const del = await call('/api/providers/local-lm-studio', 'DELETE')
    expect(del.status).toBe(200)
    resetProviderConfigCacheForTests()
    const cfg = loadProviderConfig()
    expect(cfg.tiers.pro).toBeUndefined()
    expect(cfg.tiers.se?.providerId).toBe('local-lm-studio-2')
  })

  it('returns 404 for unknown routes', async () => {
    const { status } = await call('/api/nope')
    expect(status).toBe(404)
  })

  it('rejects a non-loopback Host header (DNS rebinding guard)', async () => {
    const resp = await fetch(base + '/api/config', {
      headers: { host: 'evil.example.com' },
    })
    expect(resp.status).toBe(403)
  })

  it('rejects a cross-origin request', async () => {
    const resp = await fetch(base + '/api/config', {
      headers: { origin: 'https://evil.example.com' },
    })
    expect(resp.status).toBe(403)
  })

  it('accepts loopback hosts only', () => {
    expect(isAllowedHost('127.0.0.1:1511')).toBe(true)
    expect(isAllowedHost('localhost:1511')).toBe(true)
    expect(isAllowedHost('[::1]:1511')).toBe(true)
    expect(isAllowedHost('example.com')).toBe(false)
    expect(isAllowedHost(undefined)).toBe(false)
  })

  it('prefers an explicit port over CCLITE_CONFIG_PORT', () => {
    const prev = process.env.CCLITE_CONFIG_PORT
    process.env.CCLITE_CONFIG_PORT = '18151'
    expect(resolvePreferredPort(1600)).toBe(1600)
    expect(resolvePreferredPort(undefined)).toBe(18151)
    if (prev === undefined) delete process.env.CCLITE_CONFIG_PORT
    else process.env.CCLITE_CONFIG_PORT = prev
    expect(resolvePreferredPort(undefined)).toBe(1511)
  })

  it('scans upward when the preferred port is taken', async () => {
    const first = await startConfigServer(18190)
    expect(first.port).toBe(18190)
    const second = await startConfigServer(18190)
    expect(second.port).toBe(18191)
    expect(second.fellBackFromPort).toBe(18190)
    await first.close()
    await second.close()
  })
})