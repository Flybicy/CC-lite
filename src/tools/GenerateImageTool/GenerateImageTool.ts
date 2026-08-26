import { z } from 'zod/v4'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTool } from '../../Tool.js'
import { generateImage } from '../../services/images/imageGen.js'
import { resolveImageProvider } from '../../utils/providers/providerRegistry.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { DESCRIPTION, GENERATE_IMAGE_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .describe(
        'The image-generation prompt. Write it carefully per the tool description: subject, composition, style, lighting, detail anchors.',
      ),
    size: z
      .string()
      .optional()
      .describe("Provider-dependent size, e.g. '1024x1024'. Omit for the provider default."),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    file: z.string().describe('Saved image file path'),
    message: z.string().describe('Human-facing summary'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const GenerateImageTool = buildTool({
  name: GENERATE_IMAGE_TOOL_NAME,
  searchHint: 'generate save image from prompt',
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Generate image'
  },
  getActivityDescription(input) {
    return 'Generating image'
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
  isEnabled() {
    return resolveImageProvider() !== null
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input) {
    if (!input?.prompt) return null
    return 'prompt: "' + (input.prompt.length > 80 ? input.prompt.slice(0, 77) + '…' : input.prompt) + '"'
  },
  async call(input, { abortController }) {
    const img = await generateImage(input.prompt, {
      size: input.size,
      signal: abortController.signal,
    })
    const dir = resolve('images')
    mkdirSync(dir, { recursive: true })
    const ext = img.mime.includes('png') ? 'png' : img.mime.includes('webp') ? 'webp' : 'jpg'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, 'image-' + stamp + '.' + ext)
    writeFileSync(file, img.bytes)
    const output: Output = {
      file,
      message: '已保存 ' + file + '（' + (img.bytes.length / 1024).toFixed(0) + ' KB）。给用户引用这个相对路径即可。',
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: content.message,
    }
  },
});
