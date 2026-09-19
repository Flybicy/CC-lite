import { describe, expect, mock, test } from 'bun:test'

// Regression guard: the judge must use the model active for the current turn.
let capturedModel: string | undefined

mock.module('./sideQuery.js', () => ({
  sideQuery: async (opts: { model: string }) => {
    capturedModel = opts.model
    return { content: [{ type: 'text', text: '{"complete": true}' }] }
  },
}))

const { judgeGoalCompletion } = await import('./goalJudge.js')

describe('judgeGoalCompletion model forwarding', () => {
  test('passes the provided model through to sideQuery', async () => {
    capturedModel = undefined
    const verdict = await judgeGoalCompletion('do the thing', 'done', 'my-model-id')
    expect(capturedModel).toBe('my-model-id')
    expect(verdict).toEqual({ complete: true, reason: undefined })
  })
})
