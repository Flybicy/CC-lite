// ---------------------------------------------------------------------------
// Tier-aware provider connection resolver — CC-lite
//
// Turns a query's tier (pro / plus / se) into the concrete connection details
// the API layer needs: which backend transport (anthropic SDK vs OpenAI shim),
// the base URL, the API key, and the model string.
//
// When providers.json binds the tier, that wins. Otherwise this returns
// { source: 'env' } and the caller keeps its legacy env-driven behaviour
// untouched — so existing ANTHROPIC_API_KEY / OPENAI_* setups are unaffected.
//
// Every call re-reads the registry (mtime-cached), so edits made in the WebUI
// apply to the next request without restarting the CLI.
// ---------------------------------------------------------------------------

import {
  resolveTierProvider,
  tierForQuerySource,
  TIER_TO_SCOPE,
  type ModelScope,
  type ModelTier,
  type ProviderType,
} from './providerRegistry.js'

export interface TierConnection {
  source: 'routing'
  tier: ModelTier
  /** Legacy slot name for the same tier. */
  scope: ModelScope
  type: ProviderType
  baseURL: string
  apiKey: string
  model: string
  /** Provider-specific extra request headers (optional). */
  headers?: Record<string, string>
}

export interface TierEnvFallback {
  source: 'env'
  tier: ModelTier
  scope: ModelScope
}

export type TierResolution = TierConnection | TierEnvFallback

/** Resolve connection details for a query source string. */
export function resolveTierConnection(
  querySource: string | undefined,
): TierResolution {
  return resolveTierConnectionByTier(tierForQuerySource(querySource))
}

/** Explicit context window (tokens) configured on the tier binding, if any. */
export function resolveTierContextWindow(tier: ModelTier): number | undefined {
  return resolveTierProvider(tier)?.contextWindow
}

/**
 * Whether this tier needs Anthropic's 1M-context beta header. Empty when the
 * tier falls back to env or the provider speaks OpenAI (the beta is
 * Anthropic-only and ignored — sometimes rejected — elsewhere).
 */
export function tierNeeds1mBetaHeader(tier: ModelTier): boolean {
  const conn = resolveTierConnectionByTier(tier)
  if (conn.source !== 'routing' || conn.type !== 'anthropic') return false
  // 200K is the pre-beta Anthropic default; anything above needs the header.
  return (resolveTierContextWindow(tier) ?? 0) > 200_000
}

/** Resolve connection details for an explicit tier. */
export function resolveTierConnectionByTier(tier: ModelTier): TierResolution {
  const resolved = resolveTierProvider(tier)
  const scope = TIER_TO_SCOPE[tier]
  if (!resolved) return { source: 'env', tier, scope }
  const { provider, model } = resolved
  return {
    source: 'routing',
    tier,
    scope,
    type: provider.type,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    model,
    headers: provider.headers,
  }
}