/**
 * Sidebar command — minimal metadata only.
 * Implementation is lazy-loaded from sidebar.ts to reduce startup time.
 */
import type { Command } from '../../commands.js'

const sidebar = {
  type: 'local-jsx',
  name: 'sidebar',
  aliases: ['rail'],
  description: 'Toggle the fullscreen right rail (project + tasks)',
  immediate: true,
  load: () => import('./sidebar.js'),
} satisfies Command

export default sidebar
