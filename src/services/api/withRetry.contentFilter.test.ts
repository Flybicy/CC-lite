import { describe, expect, it } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { isContentFilterError } from './withRetry.js'

function makeApiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, new Headers())
}

describe('isContentFilterError', () => {
  it('flags the new-api sensitive_words shape on 500', () => {
    expect(
      isContentFilterError(
        makeApiError(
          500,
          '{"error":{"message":"sensitive words detected","type":"new_api_error","code":"sensitive_words_detected"}}',
        ),
      ),
    ).toBe(true)
  })

  it('flags OpenAI-style content_filter', () => {
    expect(isContentFilterError(makeApiError(400, 'content_filter: output blocked'))).toBe(true)
  })

  it('flags Chinese 敏感词 / 违规 wording', () => {
    expect(isContentFilterError(makeApiError(500, '内容安全风险：命中敏感词'))).toBe(true)
    expect(isContentFilterError(makeApiError(403, '请求违规'))).toBe(true)
  })

  it('does not flag genuine 5xx', () => {
    expect(isContentFilterError(makeApiError(500, 'Internal Server Error'))).toBe(false)
    expect(isContentFilterError(makeApiError(502, 'Bad Gateway'))).toBe(false)
  })

  it('does not flag non-APIError values', () => {
    expect(isContentFilterError(new Error('sensitive words'))).toBe(false)
  })
})
