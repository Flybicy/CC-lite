/**
 * CC-lite tier codenames. These are the public call names the whole codebase
 * uses instead of hardcoding vendor model IDs:
 *
 *   opus   — strongest model, main loop / planning
 *   sonnet — mid tier, Advisor reviews
 *   haiku  — economy tier, subagents and tool work
 *
 * Each one resolves through providers.json (configured in `cclite config`) at
 * call time, so changing the bound model in the WebUI takes effect on the next
 * request without restarting the CLI.
 */
export const TIER_ALIASES = ['opus', 'sonnet', 'haiku'] as const
export type TierAlias = (typeof TIER_ALIASES)[number]

export function isTierAlias(model: string): model is TierAlias {
  return (TIER_ALIASES as readonly string[]).includes(model.trim().toLowerCase())
}

export const MODEL_ALIASES = [
  'opus',
  'sonnet',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * Bare model family aliases that act as wildcards in the availableModels allowlist.
 * When "opus" is in the allowlist, ANY opus model is allowed (opus 4.5, 4.6, etc.).
 * When a specific model ID is in the allowlist, only that exact version is allowed.
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export function isModelFamilyAlias(model: string): boolean {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
