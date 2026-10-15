/**
 * ACP compression philosophy — injected into the system prompt.
 *
 * The doctrine is authored upstream in `acp-kernel` (COMPRESS_PHILOSOPHY +
 * HOW_TO_COMPRESS_RULES) and is deliberately terse: two failure modes, one
 * criterion for compressing, the protected zones, summary craft, and the
 * interaction mechanics (including that the model may refuse).
 *
 * Built once and cached: a byte-stable system prompt is what keeps the
 * provider prefix cache warm across turns.
 */
import { buildCompressSystemPrompt } from 'acp-kernel'

let cached: string | null = null

export function getAcpSystemPrompt(): string {
  if (cached === null) {
    cached = buildCompressSystemPrompt()
  }
  return cached
}

/** Test seam — the prompt is process-stable by design. */
export function _resetAcpSystemPromptCache(): void {
  cached = null
}
