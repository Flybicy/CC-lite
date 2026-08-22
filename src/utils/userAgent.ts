/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

export function getClaudeCodeUserAgent(): string {
  // Strict Anthropic-compatible gateways 401 unless the UA matches the
  // official CLI shape (e.g. "claude-cli/2.0.30 (external, cli)").
  return `claude-cli/${MACRO.VERSION} (external, cli)`
}
