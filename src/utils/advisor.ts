// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { isTierBound } from './providers/providerRegistry.js'
import { resolveModelProfileModel } from './model/modelProfiles.js'

/**
 * The Advisor model. The advisor rides the same tier as the main loop: when
 * `pro` is bound it gets 'pro', so a pro→plus→se downgrade carries the
 * advisor down with it. A bound-but-orphaned `plus` (no pro) still works for
 * setups that configure the advisor alone.
 */
export function getAdvisorModel(): string | undefined {
  return (
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
    (isTierBound('pro') ? 'pro' : undefined) ||
    (isTierBound('plus') ? 'plus' : undefined) ||
    resolveModelProfileModel('advisor') ||
    undefined
  )
}

/** Read advisor model from an explicit modelProfiles object (reactive, no cache). */
export function getAdvisorModelFromProfiles(
  modelProfiles: { advisor?: { model?: string } } | undefined,
): string | undefined {
  return (
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
    (isTierBound('pro') ? 'pro' : undefined) ||
    (isTierBound('plus') ? 'plus' : undefined) ||
    modelProfiles?.advisor?.model ||
    undefined
  )
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
