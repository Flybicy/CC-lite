import type { Command } from '../../commands.js'

const goal = {
  type: 'prompt',
  name: 'goal',
  description:
    'Set a goal and keep working until it is done (/goal <task> to start, /goal off to stop)',
  progressMessage: 'setting goal',
  contentLength: 0, // Dynamic content
  source: 'builtin',
  argumentHint: '<goal> | off',
  load: () => import('./goal.js'),
} satisfies Command

export default goal
