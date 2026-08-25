import type { LocalCommandCall } from '../../types/command.js'
import {
  describeFastHedge,
  resolveFastHedgeConfig,
} from '../../services/api/hedgedRequest.js'
import { getTurboGovernorSnapshot } from '../../services/api/turboGovernor.js'

function describeGovernor(): string {
  const snap = getTurboGovernorSnapshot()
  return (
    `concurrency ${snap.allowance}/${snap.ceiling}, ` +
    `event-loop lag ${snap.eventLoopLagMs < 0 ? 'n/a' : `${snap.eventLoopLagMs}ms`}`
  )
}

export const call: LocalCommandCall = async args => {
  const arg = args.trim().toLowerCase()

  if (arg === 'status' || arg === '') {
    const config = resolveFastHedgeConfig()
    return {
      type: 'text',
      value: config
        ? `turbo mode is ON (${describeFastHedge(config)}) — ${describeGovernor()}. Applies to OpenAI-compatible providers; hedged duplicates bill extra input tokens`
        : 'turbo mode is OFF — enable with /turbo on, --turbo, or CCLITE_TURBO=1',
    }
  }

  if (arg === 'off' || arg === '0' || arg === 'false') {
    delete process.env.CCLITE_TURBO
    return { type: 'text', value: 'turbo mode OFF — requests are no longer hedged' }
  }

  if (arg === 'on' || arg === '1' || arg === 'true') {
    process.env.CCLITE_TURBO = '1'
  } else if (arg !== '') {
    return {
      type: 'text',
      value: `Unknown argument "${args.trim()}". Usage: /turbo [on|off|status]`,
    }
  } else {
    // No argument: toggle on (status is the read-only spelling).
    process.env.CCLITE_TURBO = '1'
  }

  const config = resolveFastHedgeConfig()
  return {
    type: 'text',
    value: config
      ? `turbo mode ON (${describeFastHedge(config)}) — ${describeGovernor()}. Takes effect from the next request. Tunables: CCLITE_TURBO_HEDGES, CCLITE_TURBO_HEDGE_DELAY_MS, CCLITE_TURBO_ATTEMPT_TIMEOUT_MS`
      : 'turbo mode enabled but hedging is inactive (CCLITE_TURBO_HEDGES<=1)',
  }
}
