import figures from 'figures'
import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { Box, Text } from '../../ink.js'
import {
  GOAL_MAX_ROUNDS,
  getGoalSnapshot,
  subscribeGoal,
} from '../../utils/goalMode.js'

/**
 * Persistent goal banner. While goal mode is active, this stays pinned in the
 * always-visible prompt region so the user's goal never scrolls out of view —
 * the transcript above scrolls into terminal history, but this line is part of
 * the live (bottom) region Ink re-renders in place every frame.
 *
 * A true fixed top bar isn't possible in a scrollback terminal (the top is
 * ordinary scrollback that moves as output grows); the live region is the only
 * always-on-screen anchor, so the banner lives there.
 */
export function GoalBanner(): React.ReactNode {
  const { active, text, round } = useSyncExternalStore(
    subscribeGoal,
    getGoalSnapshot,
    getGoalSnapshot,
  )

  if (!active || !text) {
    return null
  }

  const roundLabel = round > 0 ? ` · round ${round}/${GOAL_MAX_ROUNDS}` : ''

  return (
    <Box paddingLeft={2} width="100%">
      <Text color="remember" wrap="truncate-end">
        {figures.pointer} Goal: {text}
        <Text dimColor>
          {roundLabel} · /goal off to stop
        </Text>
      </Text>
    </Box>
  )
}
