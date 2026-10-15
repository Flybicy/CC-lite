/**
 * ACP translation layer: cclite conversation messages <-> acp-kernel
 * `CoreMessage`s.
 *
 * NOTE ON TYPES: this fork does not type-check — `src/types/message.ts` is
 * absent from the repo even though 177 files import from it. We therefore
 * treat cclite messages structurally (see `CcMessage`) instead of importing
 * the phantom message types.
 *
 * Raw ids: the kernel derives its stable `mNNNNN` refs from the raw ids we
 * give it, so a message's raw id MUST be stable across turns. cclite uuids
 * are already stable and unique, so we use them verbatim and only invent ids
 * for messages that genuinely lack one.
 */
import type { CoreMessage } from 'acp-kernel'

/** Structural view of a cclite conversation message. */
export type CcMessage = {
  type?: string
  uuid?: string
  message?: { role?: string; content?: unknown }
  isMeta?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  subtype?: string
  content?: unknown
  [key: string]: unknown
}

/** Rendered summary messages minted by the kernel in the pruned view. */
export const ACP_SUMMARY_ID_PREFIX = 'acp_summary_'

export function isAcpSummaryId(id: string): boolean {
  return id.startsWith(ACP_SUMMARY_ID_PREFIX)
}

function firstLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Flatten a tool_result `content` (string | blocks) into plain text. */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text)
        } else if (b.type === 'image') {
          parts.push('[image]')
        }
      }
    }
    return parts.join('\n')
  }
  if (content == null) {
    return ''
  }
  return String(content)
}

/** Stable base id for every cclite message in a list (index fallback). */
export function baseIdFor(m: CcMessage, index: number): string {
  return typeof m?.uuid === 'string' && m.uuid.length > 0 ? m.uuid : `cc-${index}`
}

export function baseIds(messages: readonly CcMessage[]): string[] {
  return messages.map((m, i) => baseIdFor(m, i))
}

function coreId(baseId: string, blockIndex: number): string {
  return `${baseId}#${blockIndex}`
}

/**
 * cclite messages -> kernel cores.
 *
 * Deliberately drops: system/informational messages (the system prompt is a
 * separate channel in cclite), compact boundaries, virtual bookkeeping
 * messages, and transcript-only noise. KEEPS: meta user messages that carry
 * real text (ACP nudge anchors, context injections) because the model sees
 * them on the wire.
 */
export function toCoreMessages(messages: readonly CcMessage[]): CoreMessage[] {
  const cores: CoreMessage[] = []

  for (const [index, m] of messages.entries()) {
    if (!m || typeof m !== 'object') {
      continue
    }
    if (m.isVirtual === true) {
      continue
    }
    if (m.type === 'progress' || m.type === 'attachment') {
      continue
    }
    if (m.type === 'system') {
      // Compact boundaries and internal bookkeeping are not model-visible
      // conversation; a compact summary however IS on the wire, so keep it.
      if (m.isCompactSummary !== true) {
        continue
      }
    }
    if (m.type !== 'user' && m.type !== 'assistant') {
      continue
    }

    const baseId = baseIdFor(m, index)
    const content = m.message?.content
    const role: CoreMessage['role'] = m.type === 'user' ? 'user' : 'assistant'

    if (typeof content === 'string') {
      if (content.length === 0) {
        continue
      }
      cores.push({
        id: coreId(baseId, 0),
        role,
        contentType: 'text',
        text: content,
      })
      continue
    }

    if (!Array.isArray(content)) {
      continue
    }

    let emittedForMessage = 0
    for (const block of content) {
      if (typeof block === 'string') {
        cores.push({
          id: coreId(baseId, emittedForMessage),
          role,
          contentType: 'text',
          text: block,
        })
        emittedForMessage += 1
        continue
      }
      if (!block || typeof block !== 'object') {
        continue
      }
      const b = block as {
        type?: string
        text?: string
        thinking?: string
        id?: string
        name?: string
        input?: unknown
        tool_use_id?: string
        content?: unknown
        is_error?: boolean
      }
      const id = coreId(baseId, emittedForMessage)

      switch (b.type) {
        case 'text':
          if (typeof b.text === 'string' && b.text.length > 0) {
            cores.push({ id, role, contentType: 'text', text: b.text })
            emittedForMessage += 1
          }
          break
        case 'thinking':
          if (typeof b.thinking === 'string') {
            cores.push({
              id,
              role,
              contentType: 'reasoning',
              text: b.thinking,
            })
            emittedForMessage += 1
          }
          break
        case 'tool_use':
          cores.push({
            id,
            role,
            contentType: 'tool-call',
            toolName: typeof b.name === 'string' ? b.name : 'unknown',
            toolCallId: typeof b.id === 'string' ? b.id : id,
            text: b.input === undefined ? '' : JSON.stringify(b.input),
          })
          emittedForMessage += 1
          break
        case 'tool_result': {
          const text = flattenToolResult(b.content)
          cores.push({
            id,
            role: 'tool',
            contentType: 'tool-result',
            toolName: undefined,
            toolCallId:
              typeof b.tool_use_id === 'string' ? b.tool_use_id : id,
            text: b.is_error === true ? `[error] ${text}` : text,
          })
          emittedForMessage += 1
          break
        }
        default:
          // images / unknown block kinds are not compressible prose
          break
      }
    }
  }

  return cores
}

/** Build a cclite-shaped summary message for a rendered kernel summary. */
export function makeSummaryMessage(id: string, text: string): CcMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: id,
    isMeta: true,
    isVisibleInTranscriptOnly: true,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Build the cclite-shaped message carrying the growth-gated nudge.
 *
 * Deliberately a *user* message: Anthropic-shaped wires reject `system`
 * entries inside the messages array, and cclite's own pipeline already
 * understands meta user messages (isMeta) as context-injection carriers.
 */
export function makeNudgeMessage(text: string, id: string): CcMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: id,
    isMeta: true,
    isVisibleInTranscriptOnly: true,
    timestamp: new Date().toISOString(),
  }
}

export { firstLine }
