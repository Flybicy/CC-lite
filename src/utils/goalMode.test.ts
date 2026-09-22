import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetForTesting,
  clearGoal,
  getGoalSnapshot,
  incrementGoalRound,
  setGoal,
  subscribeGoal,
} from './goalMode.js'

afterEach(() => {
  _resetForTesting()
})

describe('goal mode external store (drives the persistent banner)', () => {
  test('snapshot reflects set/clear and stays a stable reference between changes', () => {
    expect(getGoalSnapshot()).toEqual({ active: false, text: null, round: 0 })

    setGoal('ship it')
    const s = getGoalSnapshot()
    expect(s).toEqual({ active: true, text: 'ship it', round: 0 })
    // useSyncExternalStore requires the same reference when nothing changed.
    expect(getGoalSnapshot()).toBe(s)

    clearGoal()
    expect(getGoalSnapshot()).toEqual({ active: false, text: null, round: 0 })
  })

  test('notifies subscribers on set, round increment, and clear', () => {
    let count = 0
    const unsub = subscribeGoal(() => {
      count++
    })

    setGoal('do the work')
    incrementGoalRound()
    clearGoal()

    expect(count).toBe(3)
    expect(getGoalSnapshot().round).toBe(0)
    unsub()
  })

  test('round increments are visible in the snapshot', () => {
    setGoal('keep going')
    incrementGoalRound()
    incrementGoalRound()
    expect(getGoalSnapshot()).toEqual({
      active: true,
      text: 'keep going',
      round: 2,
    })
  })
})
