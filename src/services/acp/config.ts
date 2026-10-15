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

export function getAcpContextLimit(): number {
  const raw = process.env.CCLITE_ACP_CONTEXT_LIMIT
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  const cfg = readConfigSafely()
  if (typeof cfg.acpContextLimit === 'number' && cfg.acpContextLimit > 0) {
    return cfg.acpContextLimit
  }
  return ACP_DEFAULT_CONTEXT_LIMIT
}

/**
 * Kernel config. Defaults are the paper's production values (see
 * DESIGN.md): nudge gate 50K growth, floor 0.45 x gate, promotion after
 * 3 survivors, recoverable tiers 1-3.
 */
export function buildAcpConfig(): Config {
  return defaultConfig(getAcpContextLimit())
}
