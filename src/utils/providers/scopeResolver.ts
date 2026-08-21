// ---------------------------------------------------------------------------
// Scope-aware provider connection resolver — CC-lite
//
// Turns a query's scope (main / subagent / advisor) into the concrete
// connection details the API layer needs: which backend transport (anthropic
// SDK vs OpenAI shim), the base URL, the API key, and the model string.
//
// When providers.json has a routing entry for the scope, that wins. Otherwise
// this returns { source: 'env' } and the caller keeps its legacy env-driven
// behaviour untouched — so existing ANTHROPIC_API_KEY / OPENAI_* setups are
// unaffected.
// ---------------------------------------------------------------------------

import {
  resolveScopeProvider,
  scopeForQuerySource,
  type ModelScope,
  type ProviderType,
} from './providerRegistry.js'

export interface ScopeConnection {
  source: 'routing'
  scope: ModelScope
  type: ProviderType
  baseURL: string
  apiKey: string
  model: string
}

export interface ScopeEnvFallback {
  source: 'env'
  scope: ModelScope
}

export type ScopeResolution = ScopeConnection | ScopeEnvFallback

/** Resolve connection details for a query source string. */
export function resolveScopeConnection(
  querySource: string | undefined,
): ScopeResolution {
  const scope = scopeForQuerySource(querySource)
  return resolveScopeConnectionByScope(scope)
}

/** Resolve connection details for an explicit scope. */
export function resolveScopeConnectionByScope(
  scope: ModelScope,
): ScopeResolution {
  const resolved = resolveScopeProvider(scope)
  if (!resolved) return { source: 'env', scope }
  const { provider, model } = resolved
  return {
    source: 'routing',
    scope,
    type: provider.type,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    model,
  }
}
