// ---------------------------------------------------------------------------
// Multi-provider registry — CC-lite
//
// A local, file-backed registry that lets the user configure several model
// providers (OpenAI-compatible or Anthropic-compatible) and route each model
// SCOPE to a specific provider + model:
//
//   - main:     the planning / big model that drives the main loop
//   - subagent: the worker / small model that does the grunt work (tools,
//               exploration, subagents)
//   - advisor:  the reviewer model used by the Advisor tool
//
// Stored at ~/.claude/providers.json (or $CLAUDE_CONFIG_DIR/providers.json).
// The API keys live in plaintext in that file — it is a local, single-user
// file (chmod 600 on POSIX). This is intentional per the product decision:
// everything stays on the user's machine and there is no separate secret
// store to manage. Configure it through the local WebUI (`cclite config`),
// which binds only to 127.0.0.1.
//
// Backwards compatible: when no routing entry exists for a scope, the caller
// falls back to the pre-existing environment-variable behaviour, so plain
// ANTHROPIC_API_KEY / OPENAI_* setups keep working unchanged.
// ---------------------------------------------------------------------------

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  renameSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { z } from 'zod/v4'

export type ProviderType = 'openai' | 'anthropic'
export type ModelScope = 'main' | 'subagent' | 'advisor'

export const ProviderEntrySchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  type: z.enum(['openai', 'anthropic']),
  baseURL: z.string().trim().min(1),
  apiKey: z.string().default(''),
  models: z.array(z.string().trim().min(1)).default([]),
})

export const RoutingEntrySchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
})

export const ProviderConfigSchema = z.object({
  version: z.literal(1).default(1),
  providers: z.array(ProviderEntrySchema).default([]),
  routing: z
    .object({
      main: RoutingEntrySchema.optional(),
      subagent: RoutingEntrySchema.optional(),
      advisor: RoutingEntrySchema.optional(),
    })
    .default({}),
})

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>
export type RoutingEntry = z.infer<typeof RoutingEntrySchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export interface ResolvedScopeProvider {
  scope: ModelScope
  provider: ProviderEntry
  model: string
}

/** Fresh empty config. Callers may mutate the result (WebUI handlers edit in
 * place before saving), so never share a single instance. */
function emptyConfig(): ProviderConfig {
  return { version: 1, providers: [], routing: {} }
}

/** Absolute path to providers.json (honors CLAUDE_CONFIG_DIR). */
export function getProviderConfigPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'providers.json')
}

// The config is cheap to read but touched on hot paths (every API request
// resolves a scope). Cache it keyed on file mtime so external edits (e.g. the
// WebUI writing a new file) are picked up without a restart.
let cache: { mtimeMs: number; config: ProviderConfig } | null = null

function statMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** Read + validate providers.json. Returns an empty config on any error. */
export function loadProviderConfig(): ProviderConfig {
  const path = getProviderConfigPath()
  const mtimeMs = statMtime(path)
  if (mtimeMs === null) {
    cache = null
    return emptyConfig()
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.config
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = ProviderConfigSchema.parse(JSON.parse(raw))
    cache = { mtimeMs, config: parsed }
    return parsed
  } catch {
    // Malformed file: don't crash the CLI, fall back to env behaviour.
    return emptyConfig()
  }
}

/** Persist providers.json atomically with 600 permissions. */
export function saveProviderConfig(config: ProviderConfig): void {
  const path = getProviderConfigPath()
  const validated = ProviderConfigSchema.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8')
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows / filesystems without POSIX perms: best-effort.
  }
  renameSync(tmp, path)
  cache = null
}

/** True when at least one scope has a routing binding to a real provider. */
export function isProviderRoutingActive(): boolean {
  const cfg = loadProviderConfig()
  const scopes: ModelScope[] = ['main', 'subagent', 'advisor']
  return scopes.some(s => resolveScopeProvider(s, cfg) !== null)
}

/**
 * Resolve the provider + model bound to a scope, or null when there is no
 * routing (caller falls back to env). Returns null if the routing points at a
 * provider id that no longer exists.
 */
export function resolveScopeProvider(
  scope: ModelScope,
  cfg: ProviderConfig = loadProviderConfig(),
): ResolvedScopeProvider | null {
  const route = cfg.routing?.[scope]
  if (!route) return null
  const provider = cfg.providers.find(p => p.id === route.providerId)
  if (!provider) return null
  return { scope, provider, model: route.model }
}

/** Map a querySource string to the model scope it belongs to. */
export function scopeForQuerySource(source: string | undefined): ModelScope {
  if (!source) return 'main'
  if (source === 'advisor') return 'advisor'
  if (source.startsWith('agent:')) return 'subagent'
  return 'main'
}

/** Clear the in-memory cache (tests / after external writes). */
export function resetProviderConfigCacheForTests(): void {
  cache = null
}

