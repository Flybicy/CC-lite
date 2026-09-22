// Goal mode state — persists for the session. When active, the query loop
// keeps nudging the model forward until it ends a reply with [GOAL_COMPLETE]
// or the round cap is hit.

let goalText: string | null = null
let goalRound = 0

// UI subscription so a persistent banner can reflect goal state live. goalMode
// is a plain module (imported by the query loop and the /goal command), so we
// expose a tiny external store instead of routing through React context.
const listeners = new Set<() => void>()
// Cached snapshot object — useSyncExternalStore requires a stable reference
// between notifications, otherwise it loops re-rendering.
let snapshot: { active: boolean; text: string | null; round: number } = {
  active: false,
  text: null,
  round: 0,
}

function recomputeSnapshot(): void {
  snapshot = { active: goalText !== null, text: goalText, round: goalRound }
}

function notify(): void {
  recomputeSnapshot()
  for (const listener of listeners) listener()
}

/** Subscribe to goal-state changes (for the persistent UI banner). */
export function subscribeGoal(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Stable snapshot of goal state for useSyncExternalStore. */
export function getGoalSnapshot(): {
  active: boolean
  text: string | null
  round: number
} {
  return snapshot
}

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
  notify()
}

export function clearGoal(): void {
  goalText = null
  goalRound = 0
  notify()
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
  notify()
  return goalRound
}

export function _resetForTesting(): void {
  goalText = null
  goalRound = 0
  notify()
}
