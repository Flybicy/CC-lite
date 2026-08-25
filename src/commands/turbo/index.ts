/**
 * Turbo command - minimal metadata only.
 * Implementation is lazy-loaded from turbo.ts to reduce startup time.
 *
 * Named "turbo" (not "fast") to avoid colliding with the Anthropic
 * priority-processing fast mode that already ships in this codebase
 * (/fast picker, settings.fastMode, chat:fastMode keybinding).
 */
import type { Command } from '../../commands.js'

const turbo = {
  type: 'local',
  name: 'turbo',
  aliases: ['hedge'],
  description:
    'Toggle high-concurrency mode: hedged duplicate API requests race; fastest stream wins',
  argumentHint: '[on|off|status]',
  supportsNonInteractive: false,
  load: () => import('./turbo.js'),
} satisfies Command

export default turbo
