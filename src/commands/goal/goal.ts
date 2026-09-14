import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../commands.js'
import {
  clearGoal,
  getGoal,
  GOAL_COMPLETE_MARKER,
  GOAL_MAX_ROUNDS,
  isGoalModeActive,
  setGoal,
} from '../../utils/goalMode.js'

async function getPromptForCommand(
  args: string,
  _context: ToolUseContext,
): Promise<{ type: 'text'; text: string }[]> {
  const text = args.trim()

  if (text === 'off' || text === 'stop' || text === 'clear') {
    clearGoal()
    return [
      {
        type: 'text',
        text: '[Goal mode has been turned off. Briefly confirm to the user that goal mode is stopped and you will no longer auto-continue.]',
      },
    ]
  }

  if (text === '') {
    if (isGoalModeActive()) {
      return [
        {
          type: 'text',
          text: `[Goal mode is currently active with goal: "${getGoal()}". Briefly tell the user the current goal and that they can run /goal off to stop.]`,
        },
      ]
    }
    return [
      {
        type: 'text',
        text: '[No goal is set. Briefly tell the user: run /goal <task> to have you keep working until the task is done.]',
      },
    ]
  }

  setGoal(text)
  return [
    {
      type: 'text',
      text: `Goal mode is now active. Your goal: ${text}

Rules while goal mode is active:
- Work autonomously and persistently. Break the goal into steps and execute them one by one — do not stop to ask for direction unless you are truly blocked on information only the user can provide.
- If something fails (command error, test failure, API hiccup), diagnose and retry with a different approach instead of giving up.
- After each work session, take stock of what remains and keep going.
- The loop continues automatically: if you finish a reply without completing the goal, you will be asked to continue (up to ${GOAL_MAX_ROUNDS} continuation rounds).
- When the goal is FULLY achieved — verified, not just attempted — end your final reply with the exact marker ${GOAL_COMPLETE_MARKER} on its own line. Do not emit the marker early; only when everything is actually done.

Begin now: analyze the current state and start working.`,
    },
  ]
}

export default {
  getPromptForCommand,
} satisfies Partial<Command>
