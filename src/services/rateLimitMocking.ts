/**
 * Privacy stub - mock rate-limit simulation (upstream /mock-limits feature for
 * Anthropic employees) is removed. Functions exist only to satisfy imports in
 * api/withRetry.ts and api/errors.ts; build defines USER_TYPE='external' so
 * these code paths are unreachable at runtime.
 */
export function shouldProcessRateLimits() { return false }
export function isMockRateLimitError() { return false }
export function getMockRateLimitHeaders(): Record<string, never> { return {} }
export function checkMockRateLimitError(): null { return null }

