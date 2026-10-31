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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getAcpSnapshotDir } from './persist.js'

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

// ---------------------------------------------------------------------------
// Fixed per-request overhead: system prompt + tool schemas
// ---------------------------------------------------------------------------
/**
 * The kernel only measures the conversation it renders. Every request also
 * carries the system prompt and the tool schemas, which on a real cclite
 * session is 30-40K tokens. Percentages computed against the raw window were
 * therefore optimistic: a 200K window nudged at "75%" (150K of conversation
 * text) while the request was already ~190K. Measuring the gap from the
 * API-reported usage lets us hand the kernel a *conversation budget* instead
 * of the raw window, so 45%/75% mean what they say.
 */
export const ACP_DEFAULT_OVERHEAD_TOKENS = 35_000
/** Never hand the kernel a budget this small — compression at 60K is useless. */
export const ACP_MIN_CONVERSATION_BUDGET = 60_000
/** Ignore samples where the delta would swallow most of the window. */
const ACP_MAX_OVERHEAD_RATIO = 0.6
/**
 * Overhead samples: a conversation this small is nearly all fixed cost, so the
 * billed/estimated gap is dominated by the system prompt and tool schemas.
 */
const ACP_OVERHEAD_SAMPLE_MIN = 2_000
const ACP_OVERHEAD_SAMPLE_MAX = 20_000
/**
 * Ratio samples: only trust a conversation large enough that the fixed
 * overhead is a minor share of the bill, otherwise `billed / conversation`
 * is really measuring the overhead again.
 */
const ACP_MIN_RATIO_SAMPLE = 50_000
/** Chinese/CJK text tokenizes far denser than the kernel's chars/4 guess. */
const ACP_MAX_TOKEN_RATIO = 4

let overheadEstimate: number | undefined
let tokenRatio: number | undefined
let estimatesLoaded = false

/**
 * The estimates survive restarts: losing them would make the first request of
 * a resumed CJK session optimistic again (exactly the 514K overflow this was
 * written to prevent). Best-effort — a missing file just means defaults.
 */
function ensureEstimatesLoaded(): void {
  if (estimatesLoaded) return
  estimatesLoaded = true
  try {
    const raw = readFileSync(join(getAcpSnapshotDir(), 'estimate.json'), 'utf8')
    const parsed = JSON.parse(raw) as { overhead?: number; ratio?: number }
    if (typeof parsed.overhead === 'number' && parsed.overhead > 0) {
      overheadEstimate = parsed.overhead
    }
    if (
      typeof parsed.ratio === 'number' &&
      parsed.ratio >= 1 &&
      parsed.ratio <= ACP_MAX_TOKEN_RATIO
    ) {
      tokenRatio = parsed.ratio
    }
  } catch {
    // first run for this project
  }
}

function saveEstimates(): void {
  try {
    const dir = getAcpSnapshotDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'estimate.json'),
      JSON.stringify({ overhead: overheadEstimate, ratio: tokenRatio }),
      'utf8',
    )
  } catch {
    // best effort
  }
}

/**
 * Feed one completed request back into the overhead estimator.
 * `inputTokens` is the billed prompt (input + cache read + cache creation),
 * `conversationTokens` is what the ACP stage measured for the same request.
 */
export function noteAcpRequestUsage(
  inputTokens: number,
  conversationTokens: number,
): void {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(conversationTokens)) {
    return
  }
  if (inputTokens <= 0 || conversationTokens <= 0) {
    return
  }
  const delta = inputTokens - conversationTokens
  if (delta <= 0) {
    return
  }

  // Two independent samples, because one equation cannot pin down both the
  // fixed overhead and the tokenizer ratio:
  //   billed = ratio * conversationEstimate + overhead
  // A short session is nearly all overhead (ratio ~ 1 for ASCII too), so it
  // only feeds the overhead estimate; a long session is where the ratio is
  // measurable once the overhead is known.
  if (
    conversationTokens >= ACP_OVERHEAD_SAMPLE_MIN &&
    conversationTokens <= ACP_OVERHEAD_SAMPLE_MAX
  ) {
    const capped = Math.min(
      delta,
      Math.round(inputTokens * ACP_MAX_OVERHEAD_RATIO),
    )
    // Exponential smoothing: schemas grow with MCP servers, so follow slowly.
    overheadEstimate =
      overheadEstimate === undefined
        ? capped
        : Math.round(overheadEstimate * 0.5 + capped * 0.5)
  }

  if (conversationTokens >= ACP_MIN_RATIO_SAMPLE) {
    const variable = inputTokens - (overheadEstimate ?? ACP_DEFAULT_OVERHEAD_TOKENS)
    if (variable > 0) {
      const ratio = Math.min(
        ACP_MAX_TOKEN_RATIO,
        Math.max(1, variable / conversationTokens),
      )
      tokenRatio = tokenRatio === undefined ? ratio : tokenRatio * 0.7 + ratio * 0.3
    }
  }
  saveEstimates()
}

export function getAcpOverheadEstimate(): number {
  ensureEstimatesLoaded()
  return overheadEstimate ?? ACP_DEFAULT_OVERHEAD_TOKENS
}

export function resetAcpOverheadEstimate(): void {
  overheadEstimate = undefined
  tokenRatio = undefined
}

/** Billed prompt tokens per rendered conversation token (1 = estimator exact). */
export function getAcpTokenRatio(): number {
  ensureEstimatesLoaded()
  return tokenRatio ?? 1
}

/**
 * Window available to the conversation, expressed in the units the kernel
 * measures. The billed-prompt ratio already contains the fixed overhead
 * (system prompt + schemas), so subtracting it again would double-count and
 * make compression fire far too early.
 */
export function getAcpConversationBudget(
  model?: string,
  resolveWindow: WindowResolver = resolveModelWindow,
): number {
  const window = getAcpContextLimit(model, resolveWindow)
  const ratio = getAcpTokenRatio()
  const budget = window / ratio
  return Math.max(ACP_MIN_CONVERSATION_BUDGET, Math.min(window, Math.round(budget)))
}

/**
 * Kernel config. Defaults are the paper's production values (see
 * DESIGN.md): nudge gate 50K growth, floor 0.45 x gate, promotion after
 * 3 survivors, recoverable tiers 1-3.
 */
export function buildAcpConfig(
  limit: number = getAcpConversationBudget(),
): Config {
  const base = defaultConfig(limit)
  // CC-lite: nudge earlier than the kernel defaults. The estimator ratio is
  // only as good as the last observation and one long turn can add tens of
  // thousands of tokens, so keep ~15% headroom below the window.
  return {
    ...base,
    nudge: {
      ...base.nudge,
      minContextLimitPct: 0.4,
      maxContextLimitPct: 0.7,
      emergencyThresholdPct: 0.85,
    },
  }
}
