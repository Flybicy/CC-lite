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
  // Lazy-load the implementation inside getPromptForCommand (like /insights).
  // PromptCommand has no `load` field — the slash-command processor calls
  // getPromptForCommand directly, so it must exist on the command object.
  async getPromptForCommand(args, context) {
    const real = (await import('./goal.js')).default
    return real.getPromptForCommand(args, context)
  },
} satisfies Command

export default goal
