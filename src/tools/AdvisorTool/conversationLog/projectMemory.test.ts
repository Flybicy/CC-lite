import { describe, expect, it } from 'bun:test'
import type { ConversationEntry } from '../types.js'
import { ARCHIVE_ID_BASE } from './archive.js'
import { buildSearchIndex } from './search.js'
import { createConversationLogTool } from './ConversationLogTool.js'

function makeEntry(id: number, text: string, role: ConversationEntry['role'] = 'user'): ConversationEntry {
  return {
    id,
    role,
    text,
    searchBody: text,
    charLength: text.length,
    truncated: false,
  }
}

const archived: ConversationEntry[] = [
  makeEntry(ARCHIVE_ID_BASE, 'last week we chose postgres for the database layer'),
  makeEntry(ARCHIVE_ID_BASE + 1, 'agreed to deploy the parser service on kubernetes', 'assistant'),
]

const live: ConversationEntry[] = [
  makeEntry(0, 'now add retry logic to the worker'),
  makeEntry(1, 'the retry policy uses exponential backoff', 'assistant'),
]

describe('ConversationLogTool with prior-project memory', () => {
  it('index shows a prior-context divider and tags archived entries', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live), { archivedEntries: archived })
    const result = await tool.call({ action: 'index', limit: 10 } as any)
    expect(result.data).toContain('prior project context')
    expect(result.data).toContain(`[${ARCHIVE_ID_BASE}]`)
    expect(result.data).toContain('(prior session)')
    expect(result.data).toContain('[0]')
  })

  it('live-only index output is unchanged when no archive is supplied', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live))
    const result = await tool.call({ action: 'index', limit: 10 } as any)
    expect(result.data).not.toContain('prior session')
    expect(result.data).not.toContain('prior project context')
  })

  it('keyword search finds text from prior sessions', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live), { archivedEntries: archived })
    const result = await tool.call({ action: 'search', query: 'postgres database', mode: 'keyword', match_mode: 'or' } as any)
    expect(result.data).toContain(`[${ARCHIVE_ID_BASE}]`)
  })

  it('read resolves a prior-session entry by its high id', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live), { archivedEntries: archived })
    const result = await tool.call({ action: 'read', message_ids: [ARCHIVE_ID_BASE] } as any)
    expect(result.data).toContain('postgres')
  })

  it('around works across the archive/live boundary', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live), { archivedEntries: archived })
    const result = await tool.call({ action: 'around', message_id: ARCHIVE_ID_BASE + 1, before: 3, after: 3 } as any)
    // window covers archived id 1000000..1000001 and live id 0..1
    expect(result.data).toContain(`[${ARCHIVE_ID_BASE}]`)
    expect(result.data).toContain('[0]')
    expect(result.data).toContain('[1]')
  })

  it('read of a live id still works alongside the archive', async () => {
    const { tool } = createConversationLogTool(live, buildSearchIndex(live), { archivedEntries: archived })
    const result = await tool.call({ action: 'read', message_ids: [1] } as any)
    expect(result.data).toContain('exponential backoff')
  })
})
