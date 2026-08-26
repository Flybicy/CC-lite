// ---------------------------------------------------------------------------
// CC-lite local config WebUI server
//
// Serves a single-page UI bound to 127.0.0.1 only (default port 1511). There
// is no login form on purpose: the listener is loopback-exclusive and the
// process dies with the `cclite config` command. It does enforce a Host /
// Origin allowlist, because without it any website the user visits could use
// DNS rebinding to read /api/config — which contains plaintext API keys.
//
// The page manages ~/.claude/providers.json — the provider registry plus the
// pro / plus / se tier bindings.
//
// Plain node:http so it works identically under Bun and Node runtimes.
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  getProviderConfigPath,
  loadProviderConfig,
  resetProviderConfigCacheForTests,
  saveProviderConfig,
  MODEL_TIERS,
  type ModelTier,
  type ProviderConfig,
  type ProviderEntry,
} from '../utils/providers/providerRegistry.js'

// Aux slots（作图 / 视觉辅助）与三档同等持久化；删除提供商时也一起清绑。
const TIER_KEYS = [...MODEL_TIERS, 'image', 'vision'] as const
import { CONFIG_UI_PAGE } from './page.js'

const HOST = '127.0.0.1'

/** Default port, and the window scanned when it is already taken. */
export const DEFAULT_CONFIG_PORT = 1511
const PORT_SCAN_ATTEMPTS = 20

const PROVIDERS_PREFIX = '/api/providers/'
const FETCH_MODELS_SUFFIX = '/fetch-models'

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

/**
 * Reject requests whose Host header is not a loopback literal, and any
 * cross-origin request. Both are DNS-rebinding defenses: an attacker page can
 * point a hostname it controls at 127.0.0.1, but it cannot forge these headers.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  // Strip the port; IPv6 literals arrive as "[::1]:1511".
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0]
  return host === '127.0.0.1' || host === '[::1]' || host === 'localhost'
}

function isAllowedOrigin(origin: string | undefined): boolean {
  // Same-origin fetches from our own page omit Origin in some runtimes; only
  // reject when one is present and does not point back at loopback.
  if (!origin) return true
  try {
    return isAllowedHost(new URL(origin).host)
  } catch {
    return false
  }
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
 * GET {baseURL}/models; Anthropic-compatible endpoints expose GET
 * {baseURL}/v1/models (x-api-key + anthropic-version) — but only when the
 * configured baseURL does not already end in /v1. Returns an empty list when
 * the provider does not support listing.
 */
async function fetchProviderModels(provider: ProviderEntry): Promise<string[]> {
  const base = provider.baseURL.replace(/\/+$/, '')
  const isOpenAI = provider.type === 'openai'
  const url =
    isOpenAI || /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`
  const headers: Record<string, string> = { ...(provider.headers ?? {}) }
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
  const hostHeader = req.headers.host
  if (!isAllowedHost(hostHeader) || !isAllowedOrigin(req.headers.origin)) {
    json(res, 403, {
      error: 'forbidden: this page is only reachable at http://127.0.0.1',
    })
    return
  }
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
      const headers =
        body.headers &&
        typeof body.headers === 'object' &&
        !Array.isArray(body.headers)
          ? Object.fromEntries(
              Object.entries(body.headers as Record<string, unknown>)
                .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
                .map(([k, v]) => [k.trim(), v as string])
                .filter(([k]) => k.length > 0),
            )
          : undefined
      if (!label) throw new Error('label is required')
      if (!baseURL) throw new Error('baseURL is required')
      let parsedBase: URL
      try {
        parsedBase = new URL(baseURL)
      } catch {
        throw new Error('baseURL must be a valid URL')
      }
      if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
        throw new Error('baseURL must use http:// or https://')
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
          headers,
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
          headers,
        }
        cfg.providers.push(provider)
      }
      saveProviderConfig(cfg)
      json(res, 200, { provider })
      return
    }

    if (
      req.method === 'POST' &&
      path.startsWith(PROVIDERS_PREFIX) &&
      path.endsWith(FETCH_MODELS_SUFFIX)
    ) {
      const id = decodeURIComponent(
        path.slice(PROVIDERS_PREFIX.length, -FETCH_MODELS_SUFFIX.length),
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

    if (req.method === 'DELETE' && path.startsWith(PROVIDERS_PREFIX)) {
      const id = decodeURIComponent(path.slice(PROVIDERS_PREFIX.length))
      const cfg = loadProviderConfig()
      const before = cfg.providers.length
      cfg.providers = cfg.providers.filter(p => p.id !== id)
      if (cfg.providers.length === before) throw new Error(`provider "${id}" not found`)
      // Drop tier bindings pointing at the deleted provider.
      for (const tier of TIER_KEYS) {
        if (cfg.tiers[tier]?.providerId === id) delete cfg.tiers[tier]
      }
      saveProviderConfig(cfg)
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'PUT' && (path === '/api/tiers' || path === '/api/routing')) {
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const cfg = loadProviderConfig()
      for (const key of Object.keys(body)) {
        if (!(TIER_KEYS as readonly string[]).includes(key)) throw new Error(`unknown tier "${key}"`)
      }
      for (const tier of TIER_KEYS) {
        const value = body[tier]
        if (value === null || value === undefined) {
          delete cfg.tiers[tier]
          continue
        }
        if (typeof value !== 'object') {
          throw new Error(`tiers.${tier} must be an object or null`)
        }
        const providerId = (value as Record<string, unknown>).providerId
        const model = (value as Record<string, unknown>).model
        // An empty providerId means "leave this tier unbound".
        if (typeof providerId !== 'string' || !providerId.trim()) {
          delete cfg.tiers[tier]
          continue
        }
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error(`tiers.${tier}.model is required`)
        }
        if (!cfg.providers.some(p => p.id === providerId)) {
          throw new Error(`tiers.${tier}: unknown provider "${providerId}"`)
        }
        const rawWindow = (value as Record<string, unknown>).contextWindow
        let contextWindow: number | undefined
        if (rawWindow !== undefined && rawWindow !== null && rawWindow !== '') {
          const n = typeof rawWindow === 'number' ? rawWindow : Number(rawWindow)
          if (!Number.isInteger(n) || n <= 0) {
            throw new Error(`tiers.${tier}.contextWindow must be a positive integer (tokens)`)
          }
          contextWindow = n
        }
        cfg.tiers[tier] = {
          providerId: providerId.trim(),
          model: model.trim(),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
        }
      }
      saveProviderConfig(cfg)
      json(res, 200, { tiers: cfg.tiers })
      return
    }

    if (req.method === 'POST' && path === '/api/fetch-models-direct') {
      // Fetch models without saving the provider first (used in the add form).
      const body = (await readJsonBody(req)) as Record<string, unknown>
      const existingId = typeof body.id === 'string' ? body.id.trim() : ''
      const typedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      // Editing an existing provider with the key field left blank: reuse the
      // stored key instead of probing unauthenticated and reporting HTTP 401.
      const storedKey = existingId
        ? (loadProviderConfig().providers.find(p => p.id === existingId)?.apiKey ?? '')
        : ''
      const provider: ProviderEntry = {
        id: '__preview__',
        label: 'preview',
        type: body.type === 'anthropic' ? 'anthropic' : 'openai',
        baseURL: typeof body.baseURL === 'string' ? body.baseURL.trim() : '',
        apiKey: typedKey || storedKey,
        models: [],
        headers:
          body.headers &&
          typeof body.headers === 'object' &&
          !Array.isArray(body.headers)
            ? (Object.fromEntries(
                Object.entries(body.headers as Record<string, unknown>).filter(
                  ([k, v]) => typeof k === 'string' && typeof v === 'string',
                ),
              ) as Record<string, string>)
            : undefined,
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
  /** True when `port` differs from the port that was asked for. */
  fellBackFromPort?: number
  close: () => Promise<void>
}

/** Resolve the port to try first: explicit argument > env > built-in default. */
export function resolvePreferredPort(explicit?: number): number {
  if (Number.isInteger(explicit) && (explicit as number) > 0) {
    return explicit as number
  }
  const envPort = Number(process.env.CCLITE_CONFIG_PORT)
  if (Number.isInteger(envPort) && envPort > 0) return envPort
  return DEFAULT_CONFIG_PORT
}

function listenOnce(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

/**
 * Start the WebUI. Port selection: explicit `preferredPort` (from --port) wins
 * over $CCLITE_CONFIG_PORT, which wins over 1511. When the chosen port is busy
 * we scan upward instead of failing, so a second `cclite config` (or any
 * unrelated process on 1511) no longer blocks the UI. Port 0 is honored
 * verbatim for tests (the OS picks an ephemeral port).
 */
export async function startConfigServer(
  preferredPort?: number,
): Promise<ConfigServer> {
  const first = preferredPort === 0 ? 0 : resolvePreferredPort(preferredPort)
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      try {
        json(res, 500, { error: String(err) })
      } catch {
        /* socket already closed */
      }
    })
  })

  const attempts = first === 0 ? 1 : PORT_SCAN_ATTEMPTS
  let lastError: unknown
  let bound = false
  for (let i = 0; i < attempts; i++) {
    try {
      await listenOnce(server, first === 0 ? 0 : first + i)
      bound = true
      break
    } catch (err) {
      lastError = err
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break
    }
  }
  if (!bound) {
    server.close()
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError))
  }

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : first
  // Bust the mtime cache so this process serves file changes from other
  // writers (multiple `cclite config` runs in a row).
  resetProviderConfigCacheForTests()
  return {
    port: actualPort,
    url: `http://${HOST}:${actualPort}`,
    ...(first !== 0 && actualPort !== first ? { fellBackFromPort: first } : {}),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      ),
  }
}

export type { ModelTier }