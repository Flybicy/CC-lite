import { describe, expect, it, beforeEach } from 'bun:test'
import {
  getAppClipboard,
  getAppClipboardHistory,
  resetAppClipboardForTests,
  setAppClipboard,
} from './appClipboard.js'

beforeEach(() => {
  resetAppClipboardForTests()
})

describe('appClipboard', () => {
  it('stores and retrieves the most recent text', () => {
    expect(getAppClipboard()).toBeUndefined()
    setAppClipboard('first copy')
    setAppClipboard('second copy')
    expect(getAppClipboard()).toBe('second copy')
  })

  it('ignores empty and whitespace-only text', () => {
    setAppClipboard('')
    setAppClipboard('   ')
    expect(getAppClipboard()).toBeUndefined()
  })

  it('dedups consecutive identical copies instead of stacking entries', () => {
    setAppClipboard('same')
    setAppClipboard('same')
    setAppClipboard('other')
    setAppClipboard('same')
    // 'same' appears once (refreshed), plus 'other'.
    expect(getAppClipboardHistory().length).toBe(2)
    expect(getAppClipboard()).toBe('same')
  })

  it('keeps a small newest-first history ring', () => {
    for (let i = 0; i < 20; i++) setAppClipboard(`text-${i}`)
    const history = getAppClipboardHistory()
    expect(history.length).toBeLessThan(20)
    expect(history[0]!.text).toBe('text-19')
  })
})
