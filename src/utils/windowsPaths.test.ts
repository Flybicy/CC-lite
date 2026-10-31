import { describe, expect, test } from 'bun:test'
import {
  discoverNiubashBashPath,
  getNiubashBashCandidates,
  getNiubashInstallRoots,
  looksLikeNiubashPath,
  shouldPreferNiubash,
} from './windowsPaths.js'

describe('Niubash Bash path resolution', () => {
  test('derives winuxcmd bash from the Niubash shell environment', () => {
    expect(
      getNiubashBashCandidates({
        NIU_SHELL: 'C:\\Tools\\Niubash\\niu.exe',
      }),
    ).toContain('C:\\Tools\\Niubash\\winuxcmd\\bin\\bash.exe')
  })

  test('honors an explicit CCLITE_NIUBASH_PATH before derived paths', () => {
    expect(
      getNiubashBashCandidates({
        CCLITE_NIUBASH_PATH: 'D:\\portable\\niu-bash.exe',
        WINUXCMD_HOME: 'D:\\portable\\winuxcmd',
      }),
    ).toEqual([
      'D:\\portable\\niu-bash.exe',
      'D:\\portable\\winuxcmd\\bin\\bash.exe',
    ])
  })

  test('derives conventional install roots from the user environment', () => {
    const roots = getNiubashInstallRoots({
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      USERPROFILE: 'C:\\Users\\u',
    })

    expect(roots).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Niubash')
    expect(roots).toContain('C:\\Program Files\\Niubash')
    expect(roots).toContain('C:\\Program Files (x86)\\Niubash')
    expect(roots).toContain('C:\\Users\\u\\Niubash')
  })

  test('recognises Niubash installs and rejects Git Bash', () => {
    expect(
      looksLikeNiubashPath('C:\\aaa\\Niubash\\winuxcmd\\bin\\bash.exe'),
    ).toBe(true)
    expect(looksLikeNiubashPath('C:/aaa/Niubash/winuxcmd/bin/bash.exe')).toBe(
      true,
    )
    expect(looksLikeNiubashPath('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(
      false,
    )
  })

  test('prefers Niubash by default and only opts out explicitly', () => {
    expect(shouldPreferNiubash({})).toBe(true)
    expect(shouldPreferNiubash({ NIU_SHELL: 'C:\\x\\niu.exe' })).toBe(true)
    expect(shouldPreferNiubash({ CCLITE_USE_NIUBASH: '1' })).toBe(true)
    expect(shouldPreferNiubash({ CCLITE_USE_NIUBASH: '0' })).toBe(false)
    expect(shouldPreferNiubash({ CCLITE_USE_NIUBASH: 'false' })).toBe(false)
  })

  test('discovery is a no-op on non-Windows platforms', () => {
    if (process.platform === 'win32') return
    expect(discoverNiubashBashPath({})).toBeNull()
  })
})
