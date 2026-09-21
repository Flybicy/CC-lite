import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  PROJECT_MEMORY_FILENAMES,
  isMemoryFilePath,
  processMemoryFile,
} from './claudemd.js'

describe('AGENTS.md memory support', () => {
  test('AGENTS.md is the top-priority project memory filename', () => {
    // Order matters: discovery reads the first existing name and stops, so
    // AGENTS.md must come before the legacy CLAUDE.md.
    expect([...PROJECT_MEMORY_FILENAMES]).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })

  test('isMemoryFilePath recognizes AGENTS.md alongside CLAUDE.md', () => {
    expect(isMemoryFilePath('/repo/AGENTS.md')).toBe(true)
    expect(isMemoryFilePath('/repo/.claude/AGENTS.md')).toBe(true)
    expect(isMemoryFilePath('/repo/CLAUDE.md')).toBe(true)
    expect(isMemoryFilePath('/repo/CLAUDE.local.md')).toBe(true)
    expect(isMemoryFilePath(`/repo${sep}.claude${sep}rules${sep}x.md`)).toBe(
      true,
    )
    expect(isMemoryFilePath('/repo/README.md')).toBe(false)
  })

  test('processMemoryFile loads an AGENTS.md as project memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cclite-agents-'))
    try {
      const p = join(dir, 'AGENTS.md')
      writeFileSync(p, '# Project rules\nUse bun, not npm.\n', 'utf8')
      const files = await processMemoryFile(p, 'Project', new Set(), false)
      expect(files.length).toBeGreaterThan(0)
      expect(files[0]!.type).toBe('Project')
      expect(files[0]!.content).toContain('Use bun, not npm.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
