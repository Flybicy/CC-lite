// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

import { isTierBound } from './providers/providerRegistry.js'
import { resolveModelProfileModel } from './model/modelProfiles.js'

/**
 * The Advisor model. When the `plus` tier is bound in providers.json we return
 * the codename, so the concrete model is resolved per call and re-binding it in
 * the WebUI applies without a restart.
 */
export function getAdvisorModel(): string | undefined {
  return (
    process.env.CLAUDE_CODE_ADVISOR_MODEL?.trim() ||
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
    (isTierBound('plus') ? 'plus' : undefined) ||
    modelProfiles?.advisor?.model ||
    undefined
  )
}

export function isAdvisorEnabled(): boolean {
  return !!getAdvisorModel()
}

// Advisor API calls go through query() directly (AdvisorTool.tsx:runAdvisorQuery).
