// Goal mode state — persists for the session. When active, the query loop
// keeps nudging the model forward until it ends a reply with [GOAL_COMPLETE]
// or the round cap is hit.

let goalText: string | null = null
let goalRound = 0

// Safety cap so a confused model cannot loop forever burning tokens.
export const GOAL_MAX_ROUNDS = 50

// Every N rounds without a completion marker, a side-call judge reviews the
// transcript to decide whether the goal is actually done (backstop for
// models that forget to emit the marker).
export const GOAL_JUDGE_EVERY = 5

export const GOAL_COMPLETE_MARKER = '[GOAL_COMPLETE]'

export function setGoal(text: string): void {
  goalText = text
  goalRound = 0
}

export function clearGoal(): void {
  goalText = null
  goalRound = 0
}

export function getGoal(): string | null {
  return goalText
}

export function isGoalModeActive(): boolean {
  return goalText !== null
}

export function getGoalRound(): number {
  return goalRound
}

export function incrementGoalRound(): number {
  goalRound += 1
  return goalRound
}

export function _resetForTesting(): void {
  goalText = null
  goalRound = 0
}
