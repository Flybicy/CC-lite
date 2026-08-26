/**
 * /image command — generate an image from a prompt via the configured
 * image provider (providers.json tiers.image, set in the WebUI).
 * Minimal metadata only; implementation lazy-loads from image.ts.
 */
import type { Command } from '../../commands.js'

const image = {
  type: 'local',
  name: 'image',
  aliases: ['img', 'draw'],
  description: 'Generate an image: /image <prompt> — saved into ./images/. Or just describe what you want in chat and the model can call GenerateImage itself.',
  argumentHint: '<prompt>',
  supportsNonInteractive: false,
  load: () => import('./image.js'),
} satisfies Command

export default image
