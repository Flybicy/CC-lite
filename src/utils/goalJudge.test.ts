import { describe, expect, test } from 'bun:test'
import { parseGoalVerdict } from './goalJudge.js'

describe('parseGoalVerdict', () => {
  test('parses a complete verdict', () => {
    expect(parseGoalVerdict('{"complete": true}')).toEqual({ complete: true, reason: undefined })
  })

  test('parses incomplete with reason', () => {
    expect(parseGoalVerdict('{"complete": false, "reason": "tests not run"}'))
      .toEqual({ complete: false, reason: 'tests not run' })
  })

  test('tolerates surrounding prose', () => {
    expect(parseGoalVerdict('Here is my verdict: {"complete": true} done.')).toEqual({
      complete: true,
      reason: undefined,
    })
  })

  test('unparseable text is treated as not complete', () => {
    expect(parseGoalVerdict('no json here')).toEqual({ complete: false })
    expect(parseGoalVerdict('{"complete":')).toEqual({ complete: false })
    expect(parseGoalVerdict('')).toEqual({ complete: false })
  })

  test('complete must be literally true', () => {
    expect(parseGoalVerdict('{"complete": "yes"}').complete).toBe(false)
  })
})
