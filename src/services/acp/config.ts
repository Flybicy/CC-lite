/**
 * ACP (incremental hierarchical compression) — configuration.
 *
 * cclite adaptation of the `acp-kernel` context-compression engine
 * (github.com/ranxianglei/acp-kernel, MIT). The kernel is a pure,
 * host-agnostic library: it never calls a model and never touches disk.
 * cclite owns the session state, renders the nudge, and exposes the
 * `compress` family of tools; the model writes the summaries.
 *
 * Precedence (highest first):
 *   CCLITE_DISABLE_ACP=1  -> off
 *   CCLITE_ACP=1          -> on
 *   settings.acpEnabled   -> on unless explicitly false
 */
import { defaultConfig, type Config } from 'acp-kernel'
import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getContextWindowForModel } from '../../utils/context.js'

/** Fallback window when nothing better is known. */
export const ACP_DEFAULT_CONTEXT_LIMIT = 200_000

export function isAcpEnabled(): boolean {
  if (isEnvTruthy(process.env.CCLITE_DISABLE_ACP)) {
    return false
  }
  if (isEnvTruthy(process.env.CCLITE_ACP)) {
    return true
  }
  const cfg = readConfigSafely()
  return cfg.acpEnabled !== false
}

/**
 * `getGlobalConfig()` throws before startup allows config reads. ACP must
 * still answer during early bootstrap, so fall back to the defaults.
 */
function readConfigSafely(): { acpEnabled?: boolean; acpContextLimit?: number } {
  try {
    return getGlobalConfig() as { acpEnabled?: boolean; acpContextLimit?: number }
  } catch {
    return {}
  }
}

/** Resolves the window cclite is using for a model; injectable for tests. */
export type WindowResolver = (model: string) => number

function resolveModelWindow(model: string): number {
  return getContextWindowForModel(model, undefined, 'main')
}

let modelHint: string | undefined

/**
 * Pure precedence rule, so it can be tested without env/settings fixtures:
 * explicit env > explicit setting > the window cclite resolved for the model >
 * the 200K fallback.
 */
export function pickAcpContextLimit(
  envValue: number | undefined,
  settingValue: number | undefined,
  modelWindow: number | undefined,
): number {
  if (envValue !== undefined && Number.isFinite(envValue) && envValue > 0) {
    return envValue
  }
  if (
    settingValue !== undefined &&
    Number.isFinite(settingValue) &&
    settingValue > 0
  ) {
    return settingValue
  }
  if (
    modelWindow !== undefined &&
    Number.isFinite(modelWindow) &&
    modelWindow > 0
  ) {
    return modelWindow
  }
  return ACP_DEFAULT_CONTEXT_LIMIT
}

export function getAcpContextLimit(
  model?: string,
  resolveWindow: WindowResolver = resolveModelWindow,
): number {
  const raw = process.env.CCLITE_ACP_CONTEXT_LIMIT
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  const cfg = readConfigSafely()
  // Follow whatever window cclite itself resolved for the model in play
  // (tier window, models.dev capability, [1m], CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  // /config → Context tokens). Hardcoding 200K made ACP nudge at 90K even on
  // a 1M endpoint, which is far too eager.
  const effectiveModel = model ?? modelHint
  let window: number | undefined
  if (effectiveModel) {
    try {
      window = resolveWindow(effectiveModel)
    } catch {
      // Window lookup can touch settings/model tables that are not ready yet.
      window = undefined
    }
  }
  return pickAcpContextLimit(parsed, cfg.acpContextLimit, window)
}

/**
 * Model the current turn will use. The query loop sets this each turn so the
 * tool handlers (which have no model in hand) still resolve the same window.
 */
export function setAcpModelHint(model?: string): void {
  modelHint = model
}

/**
 * Kernel config. Defaults are the paper's production values (see
 * DESIGN.md): nudge gate 50K growth, floor 0.45 x gate, promotion after
 * 3 survivors, recoverable tiers 1-3.
 */
export function buildAcpConfig(limit: number = getAcpContextLimit()): Config {
  return defaultConfig(limit)
}
