// ---------------------------------------------------------------------------
// Per-tier session model overrides — CC-lite
//
// `/model glm-5.3` (a concrete model id) does NOT switch providers; it pins
// that model on the CURRENT tier for this session — the provider, apiKey and
// headers stay whatever the tier binding says. `/model opus|sonnet|haiku` still
// switches the tier whole. Overrides live in memory only: restarting cclite
// clears them, which keeps providers.json pristine.
// ---------------------------------------------------------------------------

import { normalizeTierName, type ModelTier } from './providerRegistry.js'

const overrides = new Map<ModelTier, string>()

/** Pin a concrete model for a tier this session. */
export function setTierModelOverride(tier: ModelTier, model: string): void {
  overrides.set(tier, model.trim())
}

/** The session override for a tier, if any. */
export function getTierModelOverride(tier: ModelTier): string | undefined {
  return overrides.get(tier)
}

/** Clear one tier's override (or all). */
export function clearTierModelOverride(tier?: string): void {
  if (tier) overrides.delete(tier.trim().toLowerCase() as ModelTier)
  else overrides.clear()
}

/** Test-only reset. */
export function resetTierOverridesForTests(): void {
  overrides.clear()
}
