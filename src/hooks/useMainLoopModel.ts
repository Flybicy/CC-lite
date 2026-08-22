import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics-stub.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { resolveModelProfileModel } from '../utils/model/modelProfiles.js'
import { isTierAlias } from '../utils/model/aliases.js'
import { isModelAllowed } from '../utils/model/modelAllowlist.js'

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  // Subscribe to AppState.settings so /config changes trigger re-render.
  // OffscreenFreeze is reset via settingsVersion, so this subscription
  // ensures the Logo computes fresh values on the post-invalidation render.
  const settingsModelProfiles = useAppState(s => s.settings.modelProfiles)

  // parseUserSpecifiedModel reads tengu_ant_model_override via
  // _CACHED_MAY_BE_STALE (in resolveAntModel). Until GB init completes,
  // that's the stale disk cache; after, it's the in-memory remoteEval map.
  // AppState doesn't change when GB init finishes, so we subscribe to the
  // refresh signal and force a re-render to re-resolve with fresh values.
  // Without this, the alias resolution is frozen until something else
  // happens to re-render the component — the API would sample one model
  // while /model (which also re-resolves) displays another.
  const [, forceRerender] = useReducer(x => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  const specified =
    mainLoopModelForSession ??
    mainLoopModel ??
    (process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      resolveModelProfileModel('main') ||
      settingsModelProfiles?.main?.model) ??
    null

  // Match the allowlist gate in getUserSpecifiedModelSetting()
  const allowed =
    specified && isModelAllowed(specified)
      ? specified
      : getDefaultMainLoopModelSetting()
  // Keep a tier codename (pro/plus/se) unresolved: query.ts keys the
  // pro→plus→se failover chain off the codename, and each request resolves it
  // against the live providers.json so WebUI re-binds take effect hot.
  const model = isTierAlias(allowed) ? allowed : parseUserSpecifiedModel(allowed)
  return model
}
