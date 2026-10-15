/**
 * The four ACP tools, in cclite's Tool format.
 *
 * The wire schemas come verbatim from `acp-kernel` (so cclite and the paper's
 * reference hosts stay in lockstep). cclite prefers `inputJSONSchema` over the
 * Zod schema when serialising tools (see src/utils/api.ts), so the kernel's
 * JSON Schema is what the model actually receives; the permissive Zod object
 * only has to survive the host's own input plumbing.
 */
import {
  ACP_STATUS_TOOL,
  COMPRESS_TOOL,
  COMPRESS_TOOL_NAME,
  DECOMPRESS_TOOL,
  DECOMPRESS_TOOL_NAME,
  SEARCH_CONTEXT_TOOL,
  SEARCH_CONTEXT_TOOL_NAME,
  collectBlockContent,
  parseCompressInput,
  type CoreMessage,
} from 'acp-kernel'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolInputJSONSchema } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isAcpEnabled } from './config.js'
import { getAcpSession } from './session.js'

/**
 * The kernel accepts several input shapes (flat range object, array of
 * ranges, JSON-encoded string). Validation lives in `parseCompressInput`, so
 * the host schema stays permissive and passes everything through.
 */
const passthroughSchema = lazySchema(() => z.looseObject({}))
type PassthroughSchema = ReturnType<typeof passthroughSchema>

type AcpToolOutput = { ok: boolean; message: string }

function textResult(output: AcpToolOutput, toolUseID: string) {
  return {
    type: 'tool_result' as const,
    tool_use_id: toolUseID,
    content: output.message,
  }
}

function jsonSchemaOf(tool: { input_schema: unknown }): ToolInputJSONSchema {
  return tool.input_schema as ToolInputJSONSchema
}

// ---------------------------------------------------------------------------
// compress — the mutating call the whole mechanism hangs on
// ---------------------------------------------------------------------------

export const CompressTool = buildTool({
  name: COMPRESS_TOOL_NAME,
  searchHint: 'compress consumed conversation ranges into durable summaries',
  maxResultSizeChars: 20_000,
  isEnabled() {
    return isAcpEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  get inputSchema(): PassthroughSchema {
    return passthroughSchema()
  },
  get inputJSONSchema(): ToolInputJSONSchema {
    return jsonSchemaOf(COMPRESS_TOOL)
  },
  async description() {
    return COMPRESS_TOOL.description
  },
  async prompt() {
    return COMPRESS_TOOL.description
  },
  async call(args) {
    const session = getAcpSession()
    const ranges = parseCompressInput(args)
    if (ranges.length === 0) {
      return {
        data: {
          ok: false,
          message:
            'No valid ranges were parsed. Provide a startRef/endRef pair plus a summary (see the tool description).',
        },
      }
    }

    const applied = session.core.applyCompression({
      ranges,
      messages: session.lastCores,
      state: session.state,
      config: session.config,
    })
    session.state = applied.state

    const { blocksCreated, tokensCompressed, errors, warnings, notes } =
      applied.result

    const lines = [
      `Folded ${ranges.length} range(s) into ${blocksCreated} block(s); ${tokensCompressed} tokens compressed.`,
    ]
    if (warnings.length > 0) {
      lines.push(`Warnings: ${warnings.join('; ')}`)
    }
    if (notes && notes.length > 0) {
      lines.push(`Notes: ${notes.join('; ')}`)
    }
    if (errors.length > 0) {
      lines.push(`Errors: ${errors.join('; ')}`)
    }

    return { data: { ok: errors.length === 0, message: lines.join('\n') } }
  },
  mapToolResultToToolResultBlockParam(output: AcpToolOutput, toolUseID: string) {
    return textResult(output, toolUseID)
  },
} satisfies ToolDef<PassthroughSchema, AcpToolOutput>)

// ---------------------------------------------------------------------------
// decompress — recover a folded block in full
// ---------------------------------------------------------------------------

export const DecompressTool = buildTool({
  name: DECOMPRESS_TOOL_NAME,
  searchHint: 'recover the full text of a previously compressed block',
  maxResultSizeChars: 200_000,
  isEnabled() {
    return isAcpEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  get inputSchema(): PassthroughSchema {
    return passthroughSchema()
  },
  get inputJSONSchema(): ToolInputJSONSchema {
    return jsonSchemaOf(DECOMPRESS_TOOL)
  },
  async description() {
    return DECOMPRESS_TOOL.description
  },
  async prompt() {
    return DECOMPRESS_TOOL.description
  },
  async call(args) {
    const session = getAcpSession()
    const blockId = String(
      (args as { blockId?: unknown }).blockId ?? '',
    ).trim()
    if (blockId.length === 0) {
      return { data: { ok: false, message: 'blockId is required.' } }
    }

    const block = session.core.decompress(blockId, session.state)
    if (!block) {
      return {
        data: {
          ok: false,
          message: `No active block "${blockId}". Use acp_status to list active blocks.`,
        },
      }
    }

    const collected = collectBlockContent(session.state, block, session.lastCores) as {
      text?: string
      content?: string
      messages?: CoreMessage[]
    }
    const text =
      collected.text ??
      collected.content ??
      (collected.messages ?? [])
        .map(m => m.text ?? '')
        .filter(t => t.length > 0)
        .join('\n\n')

    if (text.length === 0) {
      return {
        data: {
          ok: false,
          message: `Block "${blockId}" has no recoverable content in this session.`,
        },
      }
    }

    return {
      data: {
        ok: true,
        message: `Block ${blockId}${block.topic ? ` (${block.topic})` : ''}:\n\n${text}`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: AcpToolOutput, toolUseID: string) {
    return textResult(output, toolUseID)
  },
} satisfies ToolDef<PassthroughSchema, AcpToolOutput>)

// ---------------------------------------------------------------------------
// search_context — find folded blocks by keyword
// ---------------------------------------------------------------------------

export const SearchContextTool = buildTool({
  name: SEARCH_CONTEXT_TOOL_NAME,
  searchHint: 'search compressed blocks by keyword',
  maxResultSizeChars: 20_000,
  isEnabled() {
    return isAcpEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  get inputSchema(): PassthroughSchema {
    return passthroughSchema()
  },
  get inputJSONSchema(): ToolInputJSONSchema {
    return jsonSchemaOf(SEARCH_CONTEXT_TOOL)
  },
  async description() {
    return SEARCH_CONTEXT_TOOL.description
  },
  async prompt() {
    return SEARCH_CONTEXT_TOOL.description
  },
  async call(args) {
    const session = getAcpSession()
    const query = String((args as { query?: unknown }).query ?? '').trim()
    if (query.length === 0) {
      return { data: { ok: false, message: 'query is required.' } }
    }

    const blocks = session.core.search(query, session.state)
    if (blocks.length === 0) {
      return {
        data: {
          ok: true,
          message: `No compressed blocks match "${query}".`,
        },
      }
    }

    const lines = blocks.map(
      b =>
        `${b.blockId}${b.topic ? ` [${b.topic}]` : ''} (tier ${b.tier}) — ${b.summary}`,
    )
    return {
      data: {
        ok: true,
        message: `${blocks.length} matching block(s):\n\n${lines.join('\n\n')}`,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: AcpToolOutput, toolUseID: string) {
    return textResult(output, toolUseID)
  },
} satisfies ToolDef<PassthroughSchema, AcpToolOutput>)

// ---------------------------------------------------------------------------
// acp_status — what is resident, what is folded, what is reclaimable
// ---------------------------------------------------------------------------

export const AcpStatusTool = buildTool({
  name: ACP_STATUS_TOOL.name,
  searchHint: 'show context usage and which blocks are compressed',
  maxResultSizeChars: 20_000,
  isEnabled() {
    return isAcpEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  get inputSchema(): PassthroughSchema {
    return passthroughSchema()
  },
  get inputJSONSchema(): ToolInputJSONSchema {
    return jsonSchemaOf(ACP_STATUS_TOOL)
  },
  async description() {
    return ACP_STATUS_TOOL.description
  },
  async prompt() {
    return ACP_STATUS_TOOL.description
  },
  async call() {
    const session = getAcpSession()
    const report = session.core.status(
      session.state,
      session.lastTokenCount,
      session.config,
    )

    const lines = [
      `Context: ${report.tokenCount} / ${report.modelContextLimit} tokens (${Math.round(report.contextUsage * 100)}% used)`,
      `Blocks: ${report.activeBlocks} active / ${report.totalBlocks} total`,
      `Tokens compressed so far: ${report.tokensCompressed}`,
    ]
    const breakdown = Object.entries(report.breakdown)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([k, v]) => `${k}=${v}`)
    if (breakdown.length > 0) {
      lines.push(`Breakdown: ${breakdown.join(' ')}`)
    }

    return { data: { ok: true, message: lines.join('\n') } }
  },
  mapToolResultToToolResultBlockParam(output: AcpToolOutput, toolUseID: string) {
    return textResult(output, toolUseID)
  },
} satisfies ToolDef<PassthroughSchema, AcpToolOutput>)

export const ACP_TOOLS = [
  CompressTool,
  DecompressTool,
  SearchContextTool,
  AcpStatusTool,
]
