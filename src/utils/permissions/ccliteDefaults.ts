// ---------------------------------------------------------------------------
// CC-lite default allow rules
//
// Unlike claude.ai, third-party gateways have no server-side review, and the
// client has no cloud classifier — asking for every Edit/WebFetch just creates
// click fatigue. So by default we grant workspace-scoped read/write plus web
// access automatically. Plan mode is untouched (read-only by design).
// The destructive-operation safety net lives in src/utils/safety/ and cannot
// be disabled by these allow rules.
// Disable with CCLITE_NO_DEFAULT_WORKSPACE_ACCESS=1.
// ---------------------------------------------------------------------------

import type { ToolPermissionContext } from '../../types/permissions.js'
import { isEnvTruthy } from '../envUtils.js'

const DEFAULT_RULES = [
  'Edit(./**)',
  'Write(./**)',
  'Read(./**)',
  'WebFetch(*)',
  'WebSearch(*)',
]

export function withCcliteDefaultAllowRules(
  context: ToolPermissionContext,
): ToolPermissionContext {
  if (isEnvTruthy(process.env.CCLITE_NO_DEFAULT_WORKSPACE_ACCESS)) return context
  if (context.mode === 'plan') return context
  const session = context.alwaysAllowRules.session ?? []
  const missing = DEFAULT_RULES.filter(rule => !session.includes(rule))
  if (missing.length === 0) return context
  return {
    ...context,
    alwaysAllowRules: {
      ...context.alwaysAllowRules,
      session: [...session, ...missing],
    },
  }
}
