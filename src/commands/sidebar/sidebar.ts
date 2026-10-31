import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

/**
 * Toggle the right rail. Lives here because ctrl+shift+s never reaches the app
 * on a stock Windows terminal (the terminal swallows the chord), which made the
 * rail effectively unreachable there.
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  const arg = args.trim().toLowerCase()
  const prev = context.getAppState().showRightSidebar
  const next = arg === 'on' || arg === 'show' ? true : arg === 'off' || arg === 'hide' ? false : !prev

  if (next !== prev) {
    context.setAppState(state => ({ ...state, showRightSidebar: next }))
  }

  const hint = next
    ? 'Right rail on (needs a terminal at least 100 columns wide)'
    : 'Right rail off'
  onDone(hint, { display: 'system' })
  return null
}
