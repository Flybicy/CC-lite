import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { describeImage } from '../../services/vision/describeImage.js'
import { resolveVisionProvider } from '../../utils/providers/providerRegistry.js'
import { visionAssistIsActive } from '../../services/vision/visionCapability.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, VIEW_IMAGE_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    path: z
      .string()
      .describe(
        'Absolute or cwd-relative path to the image file (png/jpg/jpeg/gif/webp).',
      ),
    question: z
      .string()
      .optional()
      .describe(
        'What to ask about the image. Omit for a thorough general description.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    description: z.string().describe("The vision model's textual description of the image"),
    model: z.string().describe('Vision model that produced the description'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Input = z.input<InputSchema>
export type Output = z.infer<OutputSchema>

export const ViewImageTool = buildTool({
  name: VIEW_IMAGE_TOOL_NAME,
  searchHint: 'describe image content via vision model',
  maxResultSizeChars: 20_000,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'View image'
  },
  getActivityDescription(input) {
    return input?.path ? `Viewing ${input.path}` : 'Viewing image'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  isEnabled() {
    // WebUI 档位选了“使用视觉辅助”且 vision 槽绑妥了才出现。
    return resolveVisionProvider() !== null && visionAssistIsActive()
  },
  toAutoClassifierInput(input) {
    return input.path
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input) {
    if (!input?.path) return null
    return `path: "${input.path}"${input.question ? `, question: "${input.question}"` : ''}`
  },
  async call(input, { abortController }) {
    const description = await describeImage(input.path, input.question, {
      signal: abortController.signal,
    })
    const binding = resolveVisionProvider()
    const output: Output = { description, model: binding?.model ?? 'vision' }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `[image described by ${content.model}]\n${content.description}`,
    }
  },
});
