// ---------------------------------------------------------------------------
// CC-lite local config WebUI server
//
// Serves a single-page UI bound to 127.0.0.1 only (default port 1511). There
// is no auth layer on purpose: the listener is loopback-exclusive and the
// process dies with the `cclite config` command. The page manages
// ~/.claude/providers.json — provider registry + per-scope model routing.
//
// Plain node:http so it works identically under Bun and Node runtimes.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  getProviderConfigPath,
  loadProviderConfig,
  resetProviderConfigCacheForTests,
  saveProviderConfig,
  type ModelScope,
  type ProviderConfig,
  type ProviderEntry,
} from '../utils/providers/providerRegistry.js'
import { CONFIG_UI_PAGE } from './page.js'

const HOST = '127.0.0.1'

const SCOPES: ModelScope[] = ['main', 'subagent', 'advisor']

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 1_000_000) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function isScope(v: unknown): v is ModelScope {
  return typeof v === 'string' && (SCOPES as string[]).includes(v)
}

function slugifyId(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'provider'
}

function uniqueId(cfg: ProviderConfig, wanted: string): string {
  let id = wanted
  let n = 2
  while (cfg.providers.some(p => p.id === id)) {
    id = `${wanted}-${n++}`
  }
  return id
}

/**
 * Fetch the model list from a provider. OpenAI-compatible providers expose
 * GET {baseURL}/models (Bearer auth); Anthropic-compatible endpoints expose
 * GET {baseURL}/v1/models (x-api-key + anthropic-version). Returns an empty
 * list when the provider does not support listing.
 */
async function fetchProviderModels(provider: ProviderEntry): Promise<string[]> {
  const base = provider.baseURL.replace(/\/+$/, '')
  const isOpenAI = provider.type === 'openai'
  const url = isOpenAI
    ? `${base}/models`
    : `${base}/v1/models`
  const headers: Record<string, string> = {}
  if (isOpenAI) {
    if (provider.apiKey) headers['authorization'] = `Bearer ${provider.apiKey}`
  } else {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) throw new Error(`provider returned HTTP ${resp.status}`)
  const data = (await resp.json()) as unknown
  const list = Array.isArray((data as { data?: unknown }).data)
    ? (data as { data: Array<{ id?: unknown }> }).data
    : []
  return list
    .map(m => (typeof m?.id === 'string' ? m.id : ''))
    .filter(s => s.length > 0)
    .sort()
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  const path = url.pathname
  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(CONFIG_UI_PAGE)
      return
    }
    if (req.method === 'GET' && path === '/api/config') {
      const cfg = loadProviderConfig()
      json(res, 200, { config: cfg, path: getProviderConfigPath() })
      return
    }
    if (req.method === 'POST' && path === '/api/providers') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const type = body.type === 'anthropic' ? 'anthropic' : 'openai'
      if (!label) throw new Error('label is required')
      if (!baseURL) throw new Error('baseURL is required')
      try {
        new URL(baseURL)
      } catch {
        throw new Error('baseURL must be a valid URL')
      }
      const cfg = loadProviderConfig()
      const existingId = typeof body.id === 'string' ? body.id.trim() : ''
      let provider: ProviderEntry
      if (existingId) {
        const idx = cfg.providers.findIndex(p => p.id === existingId)
        if (idx === -1) throw new Error(`provider "${existingId}" not found`)
        provider = {
          ...cfg.providers[idx],
          label,
          baseURL,
          type,
          // Empty apiKey on update keeps the stored key.
          apiKey: apiKey || cfg.providers[idx].apiKey,
        }
        cfg.providers[idx] = provider
      } else {
        provider = {
          id: uniqueId(cfg, slugifyId(label)),
          label,
          type,
          baseURL,
          apiKey,
          models: [],
        }
        cfg.providers.push(provider)
      }
      saveProviderConfig(cfg)
      json(res, 200, { provider })
      return
    }

    if (req.method === 'DELETE' && path.startsWith('/api/providers/')) {
      const id = decodeURIComponent(path.slice('/api/providers/'.length))
      const cfg = loadProviderConfig()
      const before = cfg.providers.length
      cfg.providers = cfg.providers.filter(p => p.id !== id)
      if (cfg.providers.length === before) throw new Error(`provider "${id}" not found`)
      // Drop routing entries pointing at the deleted provider.
      for (const scope of SCOPES) {
        if (cfg.routing[scope]?.providerId === id) delete cfg.routing[scope]
      }
      saveProviderConfig(cfg)
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path.endsWith('/fetch-models')) {
      const id = decodeURIComponent(
        path.slice('/api/providers/'.length, -'/fetch-models'.length),
      )
      const cfg = loadProviderConfig()
      const provider = cfg.providers.find(p => p.id === id)
      if (!provider) throw new Error(`provider "${id}" not found`)
      const models = await fetchProviderModels(provider)
      provider.models = models
      saveProviderConfig(cfg)
      json(res, 200, { models })
      return
    }

    if (req.method === 'PUT' && path === '/api/routing') {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const cfg = loadProviderConfig()
      for (const scope of SCOPES) {
        const value = body[scope]
        if (value === null || value === undefined) {
          delete cfg.routing[scope]
          continue
        }
        if (typeof value !== 'object') throw new Error(`routing.${scope} must be an object or null`)
        const providerId = (value as Record<string, unknown>).providerId
        const model = (value as Record<string, unknown>).model
        if (typeof providerId !== 'string' || !providerId.trim()) continue
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error(`routing.${scope}.model is required`)
        }
        if (!cfg.providers.some(p => p.id === providerId)) {
          throw new Error(`routing.${scope}: unknown provider "${providerId}"`)
        }
        cfg.routing[scope] = { providerId: providerId.trim(), model: model.trim() }
      }
      saveProviderConfig(cfg)
      json(res, 200, { routing: cfg.routing })
      return
    }

    if (req.method === 'POST' && path === '/api/fetch-models-direct') {
      // Fetch models without saving the provider first (used in the add form).
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const provider: ProviderEntry = {
        id: '__preview__',
        label: 'preview',
        type: body.type === 'anthropic' ? 'anthropic' : 'openai',
        baseURL: typeof body.baseURL === 'string' ? body.baseURL.trim() : '',
        apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
        models: [],
      }
      if (!provider.baseURL) throw new Error('baseURL is required')
      const models = await fetchProviderModels(provider)
      json(res, 200, { models })
      return
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    const status = message === 'unknown error' ? 500 : 400
    json(res, status, { error: message })
  }
}

export interface ConfigServer {
  port: number
  url: string
  close: () => Promise<void>
}

export async function startConfigServer(preferredPort = 1511): Promise<ConfigServer> {
  const envPort = Number(process.env.CCLITE_CONFIG_PORT)
  const chosen = Number.isInteger(envPort) && envPort > 0 ? envPort : preferredPort
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      try {
        json(res, 500, { error: String(err) })
      } catch {
        /* socket already closed */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(chosen, HOST, () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : chosen
  // Bust the mtime cache so this process serves file changes from other
  // writers (multiple `cclite config` runs in a row).
  resetProviderConfigCacheForTests()
  return {
    port: actualPort,
    url: `http://${HOST}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      ),
  }
}
