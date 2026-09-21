import { describe, expect, test } from 'bun:test'
import goal from './index.js'

// Regression guard for the /goal TypeError:
//   "e.getPromptForCommand is not a function"
// The command declares type:'prompt', so the slash-command processor calls
// command.getPromptForCommand(args, context) directly. A prior version put a
// `load: () => import('./goal.js')` on the object instead of the method, which
// the bundle build (no strict tsc) shipped as a runtime crash on every /goal.
describe('goal command contract', () => {
  test('is a prompt command that exposes getPromptForCommand', () => {
    expect(goal.type).toBe('prompt')
    expect(typeof goal.getPromptForCommand).toBe('function')
    // Must NOT rely on a `load` field — PromptCommand has no such hook.
    expect('load' in goal).toBe(false)
  })

  test('setting a goal returns activation text', async () => {
    const blocks = await goal.getPromptForCommand(
      'ship the feature',
      {} as never,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('Goal mode is now active')
    expect(blocks[0]!.text).toContain('ship the feature')
  })

  test('/goal off returns the stop confirmation', async () => {
    const blocks = await goal.getPromptForCommand('off', {} as never)
    expect(blocks[0]!.text).toContain('Goal mode has been turned off')
  })
})
