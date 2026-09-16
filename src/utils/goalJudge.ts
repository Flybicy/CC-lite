import { sideQuery } from './sideQuery.js'
import { getRuntimeMainLoopModel } from './model/model.js'

export type GoalVerdict = {
  complete: boolean
  reason?: string
}

/**
 * Backstop judge for goal mode. The marker ([GOAL_COMPLETE]) is the fast
 * path; this fires on a slower cadence for models that achieve the goal but
 * forget to emit the marker. One small call per judge interval.
 */
export async function judgeGoalCompletion(
  objective: string,
  lastAssistantText: string,
): Promise<GoalVerdict> {
  const response = await sideQuery({
    model: getRuntimeMainLoopModel(),
    max_tokens: 256,
    maxRetries: 1,
    querySource: 'goal_judge',
    system:
      'You are a completion judge for an autonomous goal loop. Reply with ONLY a JSON object, no prose, no markdown.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Goal:\n<goal>\n${objective}\n</goal>\n\nThe agent's latest reply:\n<latest-reply>\n${lastAssistantText.slice(-4000)}\n</latest-reply>\n\nDecide whether the goal is fully achieved and verified (not just claimed, not mid-work). Reply with exactly one JSON object:\n{"complete": true} or {"complete": false, "reason": "what is still missing"}`,
          },
        ],
      },
    ],
  })

  const text = (response.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('\n')
  return parseGoalVerdict(text)
}

/** Extract the JSON verdict from the judge's reply. Anything unparseable
 * counts as "not complete" so the loop stays on the safe side. */
export function parseGoalVerdict(text: string): GoalVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { complete: false }
  try {
    const parsed = JSON.parse(match[0]) as { complete?: boolean; reason?: string }
    return { complete: parsed.complete === true, reason: parsed.reason }
  } catch {
    return { complete: false }
  }
}
