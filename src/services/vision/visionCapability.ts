// ---------------------------------------------------------------------------
// Vision routing probe — CC-lite
//
// Earlier versions guessed from the model NAME (gpt-4o etc.). Wrong both
// ways (sensenova-u1.5-lite looks "vision" but cannot see; a relay-renamed
// model can see but wasn't listed). The WebUI now carries an explicit
// per-tier 图片处理 choice: native = the bound model takes images itself;
// assist = route them through the vision provider. This module just reads
// that setting.
// ---------------------------------------------------------------------------

import { MODEL_TIERS, loadProviderConfig, type ModelTier } from '../../utils/providers/providerRegistry.js'

/** All tier codenames that route image-bearing turns through the vision slot. */
export function tiersUsingVisionAssist(): string[] {
  const cfg = loadProviderConfig()
  const out: string[] = []
  for (const tier of MODEL_TIERS) {
    const b = cfg.tiers?.[tier]
    if (b && b.images === 'assist') out.push(tier)
  }
  return out
}

/**
 * Should ViewImage be advertised at all? Bound vision slot AND at least one
 * tier is set to 使用视觉辅助. Read per call — WebUI saves apply mid-session.
 */
export function visionAssistIsActive(): boolean {
  const cfg = loadProviderConfig()
  if (!cfg.tiers?.vision) return false
  return MODEL_TIERS.some(t => cfg.tiers?.[t]?.images === 'assist')
}

/** Does the given tier route images through the vision provider? */
export function tierUsesVisionAssist(
  tier: ModelTier,
): boolean {
  return loadProviderConfig().tiers?.[tier]?.images === 'assist'
}
