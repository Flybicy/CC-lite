import { describe, expect, it } from 'bun:test'
import {
  normalizeSchemaForOpenAI,
  openaiStreamToAnthropic,
} from './openaiShim.js'

describe('normalizeSchemaForOpenAI', () => {
  it('keeps optional parameters optional', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' }, timeout: { type: 'number' } },
      required: ['command'],
    }
    const normalized = normalizeSchemaForOpenAI(schema)
    expect(normalized.required).toEqual(['command'])
  })

  it('drops required keys that are absent from properties (Gemini/strict relays)', () => {
    const schema = {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path', 'phantom_key'],
    }
    expect(normalizeSchemaForOpenAI(schema).required).toEqual(['file_path'])
  })

  it('returns non-object schemas unchanged', () => {
    const schema = { type: 'string' }
    expect(normalizeSchemaForOpenAI(schema)).toBe(schema)
  })
})

function sseResponse(chunks: unknown[]): Response {
  const body = chunks
    .map(c => `data: ${JSON.stringify(c)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
  return new Response(body)
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe('openaiStreamToAnthropic tool-call routing', () => {
  it('routes argument continuations without an index to the most recent tool call', async () => {
    const response = sseResponse([
      { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"command":' } }] },
          finish_reason: null,
        }],
      },
      // Continuation with NO index — must land on call_1's block.
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ function: { arguments: '"ls"}' } }] },
          finish_reason: null,
        }],
      },
      // Second tool call also without index — new block.
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ id: 'call_2', function: { name: 'Read', arguments: '{}' } }] },
          finish_reason: null,
        }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ])

    const events = await collect(openaiStreamToAnthropic(response, 'test-model'))
    const starts = events.filter(
      e => (e as { type: string }).type === 'content_block_start',
    ) as Array<{ index: number; content_block: { type: string; id?: string } }>
    expect(starts).toHaveLength(2)
    expect(starts[0]!.content_block.id).toBe('call_1')
    expect(starts[0]!.index).toBe(0)
    expect(starts[1]!.content_block.id).toBe('call_2')
    expect(starts[1]!.index).toBe(1)

    // call_1's streamed args + continuation land on block 0; call_2's initial
    // args land on its own block.
    const jsonDeltas = events.filter(
      e =>
        (e as { type: string }).type === 'content_block_delta' &&
        (e as { delta: { type: string } }).delta.type === 'input_json_delta',
    ) as Array<{ index: number; delta: { partial_json: string } }>
    expect(jsonDeltas).toHaveLength(3)
    expect(jsonDeltas[2]!.index).toBe(1)
    expect(jsonDeltas[0]!.index).toBe(0)
    expect(jsonDeltas[1]!.index).toBe(0)
    expect(jsonDeltas[0]!.delta.partial_json + jsonDeltas[1]!.delta.partial_json).toBe(
      '{"command":"ls"}',
    )

    const stop = events.find(
      e => (e as { type: string }).type === 'message_delta',
    ) as { delta: { stop_reason: string } } | undefined
    expect(stop?.delta.stop_reason).toBe('tool_use')
  })

  it('still routes parallel tool calls correctly when indexes are provided', async () => {
    const response = sseResponse([
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'A', arguments: '{"x":' } }] },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'B', arguments: '{"y":' } }] },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const events = await collect(openaiStreamToAnthropic(response, 'test-model'))
    const jsonDeltas = events.filter(
      e =>
        (e as { type: string }).type === 'content_block_delta' &&
        (e as { delta: { type: string } }).delta.type === 'input_json_delta',
    ) as Array<{ index: number; delta: { partial_json: string } }>
    expect(jsonDeltas.map(d => `${d.index}:${d.delta.partial_json}`)).toEqual([
      '0:{"x":',
      '1:{"y":',
      '0:1}',
      '1:2}',
    ])
  })
})
