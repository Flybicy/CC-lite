import { beforeEach, describe, expect, test } from 'bun:test'
import { getAcpSession, resetAcpSession } from './session.js'
import { applyAcpStage } from './stage.js'
import { CompressTool } from './tools.js'
import { baseIds, toCoreMessages, type CcMessage } from './translate.js'

/** Minimal stand-in for a cclite conversation message. */
function user(text: string, uuid: string): CcMessage {
  return { type: 'user', uuid, message: { role: 'user', content: text } }
}

function assistantText(text: string, uuid: string): CcMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

function assistantToolUse(uuid: string, toolId: string, name: string): CcMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name, input: { file: 'a.ts' } }],
    },
  }
}

function toolResult(uuid: string, toolId: string, text: string): CcMessage {
  return {
    type: 'user',
    uuid,
    isMeta: true,
    toolUseResult: text,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content: text }],
    },
  }
}

function conversation(turns: number): CcMessage[] {
  const out: CcMessage[] = [user('Build me a thing.', 'u-start')]
  for (let i = 0; i < turns; i++) {
    const toolId = `tool-${i}`
    out.push(user(`step ${i}: do the thing`, `u-${i}`))
    out.push(assistantToolUse(`a-${i}`, toolId, 'Read'))
    out.push(toolResult(`tr-${i}`, toolId, `contents of file ${i}\n`.repeat(400)))
    out.push(assistantText(`step ${i} done.`, `at-${i}`))
  }
  return out
}

beforeEach(() => {
  resetAcpSession()
})

describe('translate', () => {
  test('assigns stable base ids and keeps tool results as tool cores', () => {
    const messages = conversation(2)
    const bases = baseIds(messages)
    expect(bases).toEqual(messages.map(m => m.uuid as string))

    const cores = toCoreMessages(messages)
    expect(cores.some(c => c.role === 'tool')).toBe(true)
    expect(cores.some(c => c.contentType === 'tool-call')).toBe(true)
    expect(cores.every(c => c.id.includes('#'))).toBe(true)

    // Round-trip stability: same input -> same core ids.
    expect(toCoreMessages(messages).map(c => c.id)).toEqual(cores.map(c => c.id))
  })

  test('synthesises ids for messages without a uuid', () => {
    const messages: CcMessage[] = [
      { type: 'user', message: { role: 'user', content: 'no uuid here' } },
    ]
    expect(baseIds(messages)).toEqual(['cc-0'])
    expect(toCoreMessages(messages)[0]!.id).toBe('cc-0#0')
  })

  test('drops system bookkeeping and virtual messages', () => {
    const cores = toCoreMessages([
      { type: 'system', subtype: 'compact_boundary', content: 'x' },
      { type: 'user', uuid: 'v', isVirtual: true, message: { role: 'user', content: 'v' } },
      user('real', 'r'),
    ])
    expect(cores).toHaveLength(1)
    expect(cores[0]!.id).toBe('r#0')
  })
})

describe('stage', () => {
  test('keeps the conversation intact and tags messages with refs', () => {
    const messages = conversation(3)
    const result = applyAcpStage(messages)

    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(messages.length)
    expect(result!.messages[0]!.type).toBe('user')

    const firstContent = result!.messages[0]!.message!.content as string
    expect(firstContent).toContain('<acp')
    expect(firstContent).toContain('m00001')
    // Original text survives the tag prefix.
    expect(firstContent).toContain('Build me a thing.')
  })

  test('preserves tool_result block structure while adding tags', () => {
    const result = applyAcpStage(conversation(2))!
    const toolMsg = result.messages.find(m => {
      const c = m.message?.content
      return (
        Array.isArray(c) &&
        c.some((b: { type?: string }) => b.type === 'tool_result')
      )
    })
    expect(toolMsg).toBeDefined()
    const blocks = toolMsg!.message!.content as { type: string }[]
    expect(blocks.some(b => b.type === 'tool_result')).toBe(true)
    expect(blocks.some(b => b.type === 'text')).toBe(true)
  })

  test('is stable across repeated turns with no compression', () => {
    const messages = conversation(2)
    const first = applyAcpStage(messages)!
    const second = applyAcpStage(messages)!
    expect(second.messages).toHaveLength(first.messages.length)
    expect(second.nudgeInjected).toBe(false)
  })
})

describe('compress tool', () => {
  test('folds a range and the next turn renders a summary in its place', async () => {
    // Six turns: the kernel will not fold a range that splits a tool
    // call/result pair or reaches into the protected recent zone, so the
    // range has to cover whole aged-out turns.
    const messages = conversation(6)
    applyAcpStage(messages)

    const session = getAcpSession()
    const byRaw = session.state.messageRefs.byRaw as Record<string, string>
    const startRef = byRaw['u-start#0']!
    const endRef = byRaw['at-1#0']!
    expect(startRef).toBe('m00001')

    const output = (
      await CompressTool.call(
        {
          content: [
            {
              startId: startRef,
              endId: endRef,
              summary:
                'The user asked for a thing to be built. Step 0 read a source file and returned its full contents; the assistant confirmed the step was done.',
              topic: 'setup',
            },
          ],
        } as never,
        {} as never,
        (() => {}) as never,
        {} as never,
      )
    ).data

    expect(output).toMatchObject({ ok: true })
    expect(output.message).toContain('tokens compressed')

    const next = applyAcpStage(messages)!
    expect(next.messages.length).toBeLessThan(messages.length)
    expect(session.state.blocks.filter(b => b.active)).toHaveLength(1)

    const summaryMsg = next.messages.find(m =>
      String(m.message?.content ?? '').includes('[Compressed conversation section]'),
    )
    expect(summaryMsg).toBeDefined()
  })

  test('reports a helpful failure for unparseable input', async () => {
    applyAcpStage(conversation(1))
    const output = (
      await CompressTool.call(
        { content: [] } as never,
        {} as never,
        (() => {}) as never,
        {} as never,
      )
    ).data
    expect(output.ok).toBe(false)
    expect(output.message).toContain('No valid ranges')
  })
})
