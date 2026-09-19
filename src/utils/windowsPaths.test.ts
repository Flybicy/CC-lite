import { describe, expect, test } from 'bun:test'
import { getNiubashBashCandidates } from './windowsPaths.js'

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
})
