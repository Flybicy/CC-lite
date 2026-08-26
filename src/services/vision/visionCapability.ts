// ---------------------------------------------------------------------------
// Vision capability probe — CC-lite
//
// Third-party gateways expose no capability metadata (that probe is
// first-party Anthropic only), so we can't *ask* a model whether it sees
// images. We approximate with a name heuristic over the CURRENT tier
// binding, refreshed per call so /model switches apply immediately:
//   - anthropic-type providers accept image blocks (Claude API surface)
//   - openai-type: known multimodal families pass (gpt-4o, gemini, qwen-vl,
//     doubao-vision, glm-4v, claude-*, gpt-4.1/5, o*, 豆包等); everything
//     else is treated as text-only and gets ViewImage as its "eyes".
// Conservative default: unknown names count as TEXT-ONLY, because a spurious
// ViewImage offer to a vision-capable model is harmless, while the reverse
// strands the user without any way to see images.
// ---------------------------------------------------------------------------

import { resolveTierConnectionByTier } from '../../utils/providers/tierResolver.js'

const MULTIMODAL =
  /(gpt-4o|gpt-4\.1|gpt-5|o[0-9]+|gemini|claude-|qwen-vl|qvq|glm-4v|doubao|llava|vision|internvl|pixtral|kimi.*vl|sense.*vl)/i

/** Does the model id look like a vision-capable OpenAI-compatible model? */
export function modelNameSuggestsVision(model: string): boolean {
  return MULTIMODAL.test(model)
}

/**
 * Should ViewImage be advertised for the given tier? True only when a vision
 * fallback is configured AND the current tier connection looks text-only.
 * (resolveVisionProvider is checked by the tool itself; here we answer the
 * "does the main model already see" half.)
 */
export function mainModelAlreadySees(tier: 'pro' | 'plus' | 'se' = 'pro'): boolean {
  const conn = resolveTierConnectionByTier(tier)
  if (conn.source !== 'routing') {
    // env fallback (e.g. direct ANTHROPIC_API_KEY): Anthropic models see.
    return true
  }
  if (conn.type === 'anthropic') return true
  return modelNameSuggestsVision(conn.model)
}
