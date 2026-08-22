// ---------------------------------------------------------------------------
// Multi-provider registry — CC-lite
//
// A local, file-backed registry that lets the user configure several model
// providers (OpenAI-compatible or Anthropic-compatible) and bind each of the
// three call TIERS to a specific provider + model:
//
//   - pro:  strongest model — drives the main loop / planning
//   - plus: mid tier — Advisor reviews and second opinions
//   - se:   economy tier — subagents, exploration, tool grunt work
//
// The rest of the codebase only ever asks for `pro` / `plus` / `se`. The
// concrete provider + model string is resolved from this file on every
// request, so editing it in the WebUI takes effect on the next request with
// no CLI restart (hot reload via the mtime-keyed cache below).
//
// Stored at ~/.claude/providers.json (or $CLAUDE_CONFIG_DIR/providers.json).
// The API keys live in plaintext in that file — it is a local, single-user
// file (chmod 600 on POSIX). This is intentional per the product decision:
// everything stays on the user's machine and there is no separate secret
// store to manage. Configure it through the local WebUI (`cclite config`),
// which binds only to 127.0.0.1.
//
// Backwards compatible on two axes:
//   1. v1 files that used `routing: { main, subagent, advisor }` are migrated
//      in memory to `tiers: { pro, plus, se }` (main→pro, advisor→plus,
//      subagent→se). The file is only rewritten on the next save.
//   2. When a tier has no binding, callers fall back to the pre-existing
//      environment-variable behaviour, so plain ANTHROPIC_API_KEY / OPENAI_*
//      setups keep working unchanged.
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

/** Public call codenames. This is what the rest of the codebase references. */
export type ModelTier = 'pro' | 'plus' | 'se'

/** Legacy internal name for the same three slots. Kept for call-site compat. */
export type ModelScope = 'main' | 'subagent' | 'advisor'

export const MODEL_TIERS: readonly ModelTier[] = ['pro', 'plus', 'se'] as const

export const SCOPE_TO_TIER: Record<ModelScope, ModelTier> = {
  main: 'pro',
  advisor: 'plus',
  subagent: 'se',
}

export const TIER_TO_SCOPE: Record<ModelTier, ModelScope> = {
  pro: 'main',
  plus: 'advisor',
  se: 'subagent',
}

/** Human-facing blurbs, shared by the WebUI and the TUI. */
export const TIER_LABELS: Record<ModelTier, { title: string; hint: string }> = {
  pro: { title: 'pro', hint: '主档位 · 默认主循环，失败自动降级到 plus' },
  plus: { title: 'plus', hint: '第二档 · pro 失败时的顺位目标' },
  se: { title: 'se', hint: '兜底档 · plus 失败时的顺位目标' },
}

export function isModelTier(value: unknown): value is ModelTier {
  return (
    typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
  )
}

export const ProviderEntrySchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  type: z.enum(['openai', 'anthropic']),
  baseURL: z.string().trim().min(1),
  apiKey: z.string().default(''),
  models: z.array(z.string().trim().min(1)).default([]),
})

export const TierBindingSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
})

/** Legacy alias — v1 called these "routing entries". */
export const RoutingEntrySchema = TierBindingSchema

export const TierMapSchema = z
  .object({
    pro: TierBindingSchema.optional(),
    plus: TierBindingSchema.optional(),
    se: TierBindingSchema.optional(),
  })
  .default({})

const LegacyRoutingMapSchema = z
  .object({
    main: TierBindingSchema.optional(),
    subagent: TierBindingSchema.optional(),
    advisor: TierBindingSchema.optional(),
  })
  .default({})

export const ProviderConfigSchema = z.object({
  version: z.literal(2).default(2),
  providers: z.array(ProviderEntrySchema).default([]),
  tiers: TierMapSchema,
})

export type ProviderEntry = z.infer<typeof ProviderEntrySchema>
export type TierBinding = z.infer<typeof TierBindingSchema>
export type RoutingEntry = TierBinding
export type TierMap = z.infer<typeof TierMapSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export interface ResolvedTierProvider {
  tier: ModelTier
  /** Legacy scope name for the same slot. */
  scope: ModelScope
  provider: ProviderEntry
  model: string
}

/** Legacy alias — same shape, `scope` was the primary key in v1. */
export type ResolvedScopeProvider = ResolvedTierProvider

/** Fresh empty config. Callers may mutate the result (WebUI handlers edit in
 * place before saving), so never share a single instance. */
function emptyConfig(): ProviderConfig {
  return { version: 2, providers: [], tiers: {} }
}

/** Absolute path to providers.json (honors CLAUDE_CONFIG_DIR). */
export function getProviderConfigPath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'providers.json')
}

/**
 * Accept both the v2 shape (`tiers`) and the v1 shape (`routing`), always
 * returning v2. `version` is ignored on read: the shape is what matters, and
 * being lenient here means a hand-edited file never bricks the CLI.
 */
function parseConfig(raw: unknown): ProviderConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const { version: _ignoredVersion, routing, ...rest } = obj
  if (rest.tiers === undefined && routing !== undefined) {
    const legacy = LegacyRoutingMapSchema.parse(routing)
    const tiers: TierMap = {}
    for (const tier of MODEL_TIERS) {
      const entry = legacy[TIER_TO_SCOPE[tier]]
      if (entry) tiers[tier] = entry
    }
    return ProviderConfigSchema.parse({ ...rest, tiers })
  }
  return ProviderConfigSchema.parse(rest)
}

// The config is cheap to read but touched on hot paths (every API request
// resolves a tier). Cache it keyed on file identity (mtime + size) so
// external edits — the WebUI writing a new file — are picked up on the next
// request without a restart.
let cache: { key: string; config: ProviderConfig } | null = null

function statKey(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/** Read + validate providers.json. Returns an empty config on any error. */
export function loadProviderConfig(): ProviderConfig {
  const path = getProviderConfigPath()
  const key = statKey(path)
  if (key === null) {
    cache = null
    return emptyConfig()
  }
  if (cache && cache.key === key) return cache.config
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = parseConfig(JSON.parse(raw))
    cache = { key, config: parsed }
    return parsed
  } catch {
    // Malformed file: don't crash the CLI, fall back to env behaviour.
    return emptyConfig()
  }
}

/** Persist providers.json atomically with 600 permissions. */
export function saveProviderConfig(config: ProviderConfig): void {
  const path = getProviderConfigPath()
  const validated = ProviderConfigSchema.parse({
    providers: config.providers,
    tiers: config.tiers,
  })
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

/** True when at least one tier has a binding to a real provider. */
export function isProviderRoutingActive(): boolean {
  const cfg = loadProviderConfig()
  return MODEL_TIERS.some(tier => resolveTierProvider(tier, cfg) !== null)
}

/**
 * Resolve the provider + model bound to a tier, or null when there is no
 * binding (caller falls back to env). Returns null if the binding points at a
 * provider id that no longer exists.
 */
export function resolveTierProvider(
  tier: ModelTier,
  cfg: ProviderConfig = loadProviderConfig(),
): ResolvedTierProvider | null {
  const binding = cfg.tiers?.[tier]
  if (!binding) return null
  const provider = cfg.providers.find(p => p.id === binding.providerId)
  if (!provider) return null
  return { tier, scope: TIER_TO_SCOPE[tier], provider, model: binding.model }
}

/** Legacy entry point: resolve by scope name instead of tier codename. */
export function resolveScopeProvider(
  scope: ModelScope,
  cfg: ProviderConfig = loadProviderConfig(),
): ResolvedScopeProvider | null {
  return resolveTierProvider(SCOPE_TO_TIER[scope], cfg)
}

/** True when the tier is bound to an existing provider. */
export function isTierBound(tier: ModelTier): boolean {
  return resolveTierProvider(tier) !== null
}

/** Map a querySource string to the tier that should serve it. */
export function tierForQuerySource(source: string | undefined): ModelTier {
  if (!source) return 'pro'
  // The Advisor follows the main loop: same provider, same model, same
  // failover chain. Reviewing advice is only as good as the model giving it,
  // and advisor calls are rare enough that sharing pro costs little.
  if (source === 'advisor') return 'pro'
  if (source.startsWith('agent:')) return 'se'
  return 'pro'
}

/** Map a querySource string to the legacy scope name it belongs to. */
export function scopeForQuerySource(source: string | undefined): ModelScope {
  return TIER_TO_SCOPE[tierForQuerySource(source)]
}

/** Clear the in-memory cache (tests / after external writes). */
export function resetProviderConfigCacheForTests(): void {
  cache = null
}
