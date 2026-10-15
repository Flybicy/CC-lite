/**
 * ACP stage — the seam that replaces auto-compact in the query loop.
 *
 * Responsibilities:
 *  1. translate the conversation into kernel cores,
 *  2. run one kernel turn (assign refs, prune compressed ranges, decide the
 *     growth-gated nudge, render ref tags),
 *  3. translate the rendered view back into cclite messages,
 *  4. append the nudge when the kernel asks for one.
 *
 * The kernel never calls a model. When it decides the context should be
 * compressed it only *asks* — the model then calls the `compress` tool.
 */
import {
  defaultCountTokens,
  renderNudgeText,
  type CoreMessage,
  type ProcessTurnResult,
} from 'acp-kernel'
import { isAcpEnabled } from './config.js'
import { getAcpSession } from './session.js'
import {
  baseIds,
  isAcpSummaryId,
  makeNudgeMessage,
  makeSummaryMessage,
  toCoreMessages,
  type CcMessage,
} from './translate.js'

export type AcpStageResult = {
  messages: CcMessage[]
  /** Tokens the kernel measured for the rendered view. */
  tokenCount: number
  /** Pre-render tokens, for reporting savings. */
  rawTokenCount: number
  nudgeInjected: boolean
}

/** `<acp tokens="8" type="text">m00001</acp>` prefix emitted by render-refs. */
const TAG_RE = /^<acp\b[^>]*>[^<]*<\/acp>\n?/

function splitTag(text: string): { tag: string; rest: string } {
  const match = TAG_RE.exec(text)
  if (!match) {
    return { tag: '', rest: text }
  }
  return { tag: match[0].replace(/\n$/, ''), rest: text.slice(match[0].length) }
}

function countTokens(cores: readonly CoreMessage[]): number {
  let total = 0
  for (const core of cores) {
    total += defaultCountTokens(core.text ?? '')
  }
  return total
}

/**
 * Prepend the kernel's ref tags to a message so the model can cite ranges
 * like `m00180–m00205`. Tags ride in a leading text block; the original
 * blocks are preserved verbatim (tool_use / tool_result shape untouched).
 */
function withTags(message: CcMessage, tags: readonly string[]): CcMessage {
  const joined = tags.filter(t => t.length > 0).join('\n')
  if (joined.length === 0) {
    return message
  }
  const content = message.message?.content
  if (typeof content === 'string') {
    return {
      ...message,
      message: { ...message.message, content: `${joined}\n${content}` },
    }
  }
  if (Array.isArray(content)) {
    return {
      ...message,
      message: {
        ...message.message,
        content: [{ type: 'text', text: joined }, ...content],
      },
    }
  }
  return message
}

/**
 * Run one ACP turn over the outgoing conversation.
 *
 * Returns `null` when ACP is disabled or there is nothing to compress —
 * callers then fall back to their previous behaviour.
 */
export function applyAcpStage(
  messages: readonly CcMessage[],
): AcpStageResult | null {
  if (!isAcpEnabled()) {
    return null
  }

  const cores = toCoreMessages(messages)
  if (cores.length === 0) {
    return null
  }

  const session = getAcpSession()
  const bases = baseIds(messages)
  const byBase = new Map<string, CcMessage>()
  bases.forEach((base, index) => {
    const message = messages[index]
    if (message) {
      byBase.set(base, message)
    }
  })

  const rawTokenCount = countTokens(cores)

  let result: ProcessTurnResult
  try {
    result = session.core.processTurn({
      messages: cores,
      state: session.state,
      config: session.config,
      tokenCount: rawTokenCount,
      contentStore: session.contentStore,
    })
  } catch {
    // A kernel fault must never break the conversation: fall back to the
    // untransformed history for this turn.
    return null
  }

  session.state = result.state
  session.contentStore = result.contentStore
  session.lastCores = result.messages

  // Pass 1: collect ref tags per source message, in kernel order.
  const tagsByBase = new Map<string, string[]>()
  for (const core of result.messages) {
    if (isAcpSummaryId(core.id)) {
      continue
    }
    const base = core.id.split('#')[0]!
    const { tag } = splitTag(core.text ?? '')
    const existing = tagsByBase.get(base)
    if (existing) {
      if (tag) {
        existing.push(tag)
      }
    } else {
      tagsByBase.set(base, tag ? [tag] : [])
    }
  }

  // Pass 2: replay the kernel's rendered order, mapping cores back onto the
  // original cclite messages (so tool_use / tool_result shapes survive) and
  // splicing rendered summaries in at their true position.
  const rendered: CcMessage[] = []
  const emittedBases = new Set<string>()
  for (const core of result.messages) {
    if (isAcpSummaryId(core.id)) {
      rendered.push(makeSummaryMessage(core.id, core.text ?? ''))
      continue
    }
    const base = core.id.split('#')[0]!
    if (emittedBases.has(base)) {
      continue
    }
    const original = byBase.get(base)
    if (!original) {
      continue
    }
    emittedBases.add(base)
    rendered.push(withTags(original, tagsByBase.get(base) ?? []))
  }

  let nudgeInjected = false
  const nudge = result.nudge
  if (nudge?.shouldInject) {
    const { text } = renderNudgeText(nudge)
    if (text.length > 0) {
      rendered.push(makeNudgeMessage(text, `acp-nudge-${Date.now()}`))
      nudgeInjected = true
    }
  }

  session.lastTokenCount = rawTokenCount

  return {
    messages: rendered,
    tokenCount: rawTokenCount,
    rawTokenCount,
    nudgeInjected,
  }
}
