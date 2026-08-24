import { describe, expect, test } from 'bun:test'
import { rewriteDeletionToTrash } from './trashGuard.js'

const cwd = process.cwd()

describe('rewriteDeletionToTrash', () => {
  test('rewrites a plain rm into a trash move with manifest entry', () => {
    const out = rewriteDeletionToTrash('rm -rf ./dist', cwd)
    expect(out).not.toBeNull()
    expect(out).toContain('.claude/trash')
    expect(out).toContain('mv -- ./dist')
    expect(out).toContain('manifest.jsonl')
    expect(out).toContain('cclite trash')
  })

  test('rewrites rm with multiple targets and globs', () => {
    const out = rewriteDeletionToTrash('rm foo.txt bar/*.log', cwd)
    expect(out).toContain('mv -- foo.txt bar/*.log')
  })

  test('leaves compound or non-deletion commands untouched', () => {
    expect(rewriteDeletionToTrash('rm -rf a && cat b', cwd)).toBeNull()
    expect(rewriteDeletionToTrash('ls -la', cwd)).toBeNull()
    expect(rewriteDeletionToTrash('rm a | wc', cwd)).toBeNull()
  })

  test('respects the opt-out switch', () => {
    process.env.CCLITE_NO_TRASH_GUARD = '1'
    try {
      expect(rewriteDeletionToTrash('rm -rf ./dist', cwd)).toBeNull()
    } finally {
      delete process.env.CCLITE_NO_TRASH_GUARD
    }
  })
})
