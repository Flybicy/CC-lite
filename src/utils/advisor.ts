// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { isTierBound } from './providers/providerRegistry.js'
import { isTierAlias } from './model/aliases.js'
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

// Mirror of the session extras in query.ts (kept structural to avoid pulling
// the whole query module into this leaf util).
type TierSessionExtras = {
  ccLiteTierHome?: string
  ccLiteTierSticky?: boolean
  ccLiteTierCurrent?: string
}

/**
 * Session-aware advisor model. Rules:
 * - Manual /model switch (chain rebased: home === current, not sticky): the
 *   user moved on purpose while pro still works — keep the advisor on the
 *   strongest default (pro).
 * - Failover (current !== home, or sticky balance downgrade): the main loop
 *   is degraded — ride the same tier so the advisor doesn't keep hammering
 *   the broken/out-of-credit provider.
 */
export function getSessionAdvisorModel(
  sessionExtras: TierSessionExtras | undefined,
): string | undefined {
  const current = sessionExtras?.ccLiteTierCurrent
  const home = sessionExtras?.ccLiteTierHome
  if (current && isTierAlias(current)) {
    const degraded =
      (home !== undefined && current !== home) ||
      sessionExtras?.ccLiteTierSticky === true
    if (degraded) return current
  }
  return getAdvisorModel()
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
