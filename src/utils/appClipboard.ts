// ---------------------------------------------------------------------------
// In-app selection clipboard.
//
// Terminal clipboard support is a minefield: OSC 52 is disabled by default in
// iTerm2 and gated in VS Code, and Linux boxes often lack wl-copy/xclip/xsel.
// Shelling out or installing helper packages is not always allowed either.
//
// This module gives CC-lite an ALWAYS-working clipboard: every copy path
// (copy-on-select, ctrl+shift+c, /copy) mirrors its text here, and ctrl+y
// yanks it straight into the prompt input — no system clipboard involved,
// works identically over SSH, in tmux, and on bare terminals. System
// clipboard integration still runs in parallel; this is the reliable floor,
// not a replacement.
// ---------------------------------------------------------------------------

export interface AppClipboardEntry {
  text: string
  /** Epoch ms when the text was copied. */
  copiedAt: number
}

/** Small ring so a stray copy doesn't lose the previous content forever. */
const MAX_ENTRIES = 8

let entries: AppClipboardEntry[] = []

/**
 * Store text as the most-recent app clipboard entry. No-ops on empty/
 * whitespace-only text (mirrors useCopyOnSelect's "not worth copying" rule).
 */
export function setAppClipboard(text: string): void {
  if (!text || !text.trim()) return
  // Dedup consecutive copies of identical text - refresh timestamp instead.
  const existing = entries.findIndex(e => e.text === text)
  if (existing !== -1) entries.splice(existing, 1)
  entries.unshift({ text, copiedAt: Date.now() })
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
}

/** Most recent copied text, or undefined when nothing has been copied yet. */
export function getAppClipboard(): string | undefined {
  return entries[0]?.text
}

/** Peek the whole ring, newest first. Exposed for future UI (yank menu). */
export function getAppClipboardHistory(): readonly AppClipboardEntry[] {
  return entries
}

/** Test-only: wipe all state. */
export function resetAppClipboardForTests(): void {
  entries = []
}
