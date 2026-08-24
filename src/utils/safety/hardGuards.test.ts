import { describe, expect, test } from 'bun:test'
import { checkHardBlockedCommand } from './hardGuards.js'

const cwd = process.cwd()

describe('checkHardBlockedCommand', () => {
  test('blocks mkfs and raw disk overwrite', () => {
    expect(checkHardBlockedCommand('mkfs.ext4 /dev/sda', cwd)).toBeTruthy()
    expect(checkHardBlockedCommand('dd if=/dev/zero of=/dev/sda', cwd)).toBeTruthy()
  })

  test('blocks fork bomb', () => {
    expect(checkHardBlockedCommand(':(){ :|:& };:', cwd)).toBeTruthy()
  })

  test('blocks recursive delete of root or home, even with sudo', () => {
    expect(checkHardBlockedCommand('rm -rf /', cwd)).toBeTruthy()
    expect(checkHardBlockedCommand('sudo rm -rf /', cwd)).toBeTruthy()
    expect(checkHardBlockedCommand('rm -rf ~', cwd)).toBeTruthy()
  })

  test('allows ordinary deletions and reads', () => {
    expect(checkHardBlockedCommand('rm -rf ./node_modules', cwd)).toBeNull()
    expect(checkHardBlockedCommand('rm -rf ./build/dist', cwd)).toBeNull()
    expect(checkHardBlockedCommand('rm file.txt', cwd)).toBeNull()
    expect(checkHardBlockedCommand('ls -la /', cwd)).toBeNull()
    expect(checkHardBlockedCommand('echo hello', cwd)).toBeNull()
  })
})
