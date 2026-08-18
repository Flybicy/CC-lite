import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationEntry } from '../types.js'
import {
  ARCHIVE_ID_BASE,
  MAX_ARCHIVE_ENTRIES,
  getProjectMemoryFile,
  loadProjectMemory,
  persistProjectMemory,
} from './archive.js'

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

let dir: string
let prevDir: string | undefined
let prevFlag: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archive-test-'))
  prevDir = process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR
  prevFlag = process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY
  process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR = dir
  delete process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY
})

afterEach(() => {
  if (prevDir === undefined) delete process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR
  else process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY_DIR = prevDir
  if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY
  else process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY = prevFlag
  rmSync(dir, { recursive: true, force: true })
})

describe('persistProjectMemory / loadProjectMemory', () => {
  test('round-trips entries with renumbered high ids', async () => {
    await persistProjectMemory([makeEntry(0, 'hello world'), makeEntry(1, 'second message', 'assistant')])
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(2)
    expect(loaded[0]!.id).toBe(ARCHIVE_ID_BASE)
    expect(loaded[1]!.id).toBe(ARCHIVE_ID_BASE + 1)
    expect(loaded[0]!.text).toBe('hello world')
    expect(loaded[1]!.role).toBe('assistant')
  })

  test('dedupes identical content across repeated persists', async () => {
    const entries = [makeEntry(0, 'same content'), makeEntry(1, 'unique')]
    await persistProjectMemory(entries)
    await persistProjectMemory(entries) // identical batch again
    await persistProjectMemory([makeEntry(0, 'same content')]) // subset again
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(2)
    expect(loaded.map(e => e.text)).toEqual(['same content', 'unique'])
  })

  test('appends only new entries on later runs', async () => {
    await persistProjectMemory([makeEntry(0, 'first')])
    await persistProjectMemory([makeEntry(0, 'first'), makeEntry(1, 'second')])
    const loaded = await loadProjectMemory()
    expect(loaded.map(e => e.text)).toEqual(['first', 'second'])
  })

  test('skips empty-content entries', async () => {
    await persistProjectMemory([makeEntry(0, ''), makeEntry(1, '   '), makeEntry(2, 'real')])
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.text).toBe('real')
  })

  test('is a no-op when disabled via env flag', async () => {
    process.env.CLAUDE_CODE_ADVISOR_PROJECT_MEMORY = '0'
    await persistProjectMemory([makeEntry(0, 'hello')])
    const loaded = await loadProjectMemory()
    expect(loaded).toEqual([])
  })

  test('load returns [] when no archive exists', async () => {
    expect(await loadProjectMemory()).toEqual([])
  })

  test('drops records with invalid roles on load', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const file = getProjectMemoryFile()
    mkdirSync(dir, { recursive: true })
    const good = { v: 1, fp: 'a', ts: 1, entry: makeEntry(0, 'good') }
    const bad = { v: 1, fp: 'b', ts: 2, entry: { ...makeEntry(1, 'bad'), role: 'system' } }
    writeFileSync(file, JSON.stringify(good) + '\n' + JSON.stringify(bad) + '\nnot-json\n')
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.text).toBe('good')
  })

  test('fingerprint ignores the volatile id field', async () => {
    await persistProjectMemory([makeEntry(0, 'id independent')])
    // Same text but a different live id must be recognised as a duplicate.
    await persistProjectMemory([makeEntry(42, 'id independent')])
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(1)
  })

  test('archive survives a simulated restart (fresh load from disk)', async () => {
    await persistProjectMemory([makeEntry(0, 'persisted across restart')])
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(1)
    const again = await loadProjectMemory()
    expect(again[0]!.text).toBe('persisted across restart')
    expect(again[0]!.id).toBe(ARCHIVE_ID_BASE)
  })
})

describe('archive bounds', () => {
  test('load caps to the newest MAX_ARCHIVE_ENTRIES', async () => {
    // Write many distinct records directly (faster than persist loop).
    const { writeFileSync } = await import('node:fs')
    const file = getProjectMemoryFile()
    const total = MAX_ARCHIVE_ENTRIES + 50
    const lines: string[] = []
    for (let i = 0; i < total; i++) {
      const entry = makeEntry(i, `record-${i}`)
      lines.push(JSON.stringify({ v: 1, fp: `fp-${i}`, ts: i, entry }))
    }
    writeFileSync(file, lines.join('\n') + '\n')
    const loaded = await loadProjectMemory()
    expect(loaded.length).toBe(MAX_ARCHIVE_ENTRIES)
    // FIFO: the oldest records were dropped; the newest is last.
    expect(loaded[loaded.length - 1]!.text).toBe(`record-${total - 1}`)
    expect(loaded[0]!.text).toBe(`record-${total - MAX_ARCHIVE_ENTRIES}`)
  })
})
