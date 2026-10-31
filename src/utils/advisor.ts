// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { isTierBound, resolveAdvisorProvider } from './providers/providerRegistry.js'
import { isTierAlias } from './model/aliases.js'
import { resolveModelProfileModel } from './model/modelProfiles.js'

/**
 * The Advisor model, in priority order:
 * 1. `CLAUDE_CODE_ADVISOR_MODEL` — explicit env override (headless/scripts).
 * 2. The dedicated Advisor slot in providers.json (WebUI「辅助能力 → 顾问模型」).
 *    The slot carries its own provider, so the advisor runs on a different
 *    backend than the main loop when configured that way.
 * 3. Opus tier, so an opus→sonnet→haiku downgrade carries the advisor with it.
 * 4. A bound-but-orphaned sonnet tier (advisor-only setups).
 * 5. modelProfiles.advisor.model.
 */
export function getAdvisorModel(): string | undefined {
  return (
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
    resolveAdvisorProvider()?.model ||
    (isTierBound('opus') ? 'opus' : undefined) ||
    (isTierBound('sonnet') ? 'sonnet' : undefined) ||
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
  // A dedicated Advisor slot is explicit configuration pinned to its own
  // provider — failover on the main loop must not drag the advisor off it.
  if (!process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() && resolveAdvisorProvider()) {
    return getAdvisorModel()
  }
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
    resolveAdvisorProvider()?.model ||
    (isTierBound('opus') ? 'opus' : undefined) ||
    (isTierBound('sonnet') ? 'sonnet' : undefined) ||
    modelProfiles?.advisor?.model ||
    undefined
  )
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
