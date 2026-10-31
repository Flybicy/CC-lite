/**
 * Tolerant `compress` input normalisation.
 *
 * Why this exists: `acp-kernel` 0.0.101 advertises the line form
 *
 *     m00150–m00220 optional topic
 *     - summary bullet
 *     - ...
 *
 * in `COMPRESS_TOOL.input_schema` (and calls it PREFERRED for multi-range
 * batches), but its `parseCompressInput()` only accepts the flat object form
 * (`{startRef, endRef, summary}`) and the `{content: [object, ...]}` array.
 * Every documented string form parses to zero ranges, so a model that follows
 * the schema gets `No valid ranges were parsed` — observed twice in a row on
 * a real session (a 50% failure rate for the tool).
 *
 * This module normalises every advertised shape into the flat range objects
 * the kernel does accept, so the schema and the parser agree again.
 */

export type NormalizedRange = {
  startRef: string
  endRef: string
  summary: string
  topic?: string
}

/** `m00150–m00220`, `m150-m220`, `m00150 — m00220`, `m00150~m00220` … */
const HEADER_RE = /^\s*m(\d{3,7})\s*(?:[–—\-~～]|\.\.|到)\s*m(\d{3,7})\s*(.*)$/i

function normalizeRef(digits: string): string {
  return `m${digits.padStart(5, '0')}`
}

/** Split a plain-text batch into header-delimited blocks. */
function parseHeaderBlocks(text: string): NormalizedRange[] {
  const lines = text.split(/\r?\n/)
  const out: NormalizedRange[] = []
  let current: { startRef: string; endRef: string; topic?: string; body: string[] } | null = null

  const flush = () => {
    if (!current) {
      return
    }
    const summary = current.body.join('\n').trim()
    if (summary.length > 0) {
      out.push({
        startRef: current.startRef,
        endRef: current.endRef,
        summary,
        ...(current.topic ? { topic: current.topic } : {}),
      })
    }
    current = null
  }

  for (const line of lines) {
    const match = HEADER_RE.exec(line)
    if (match) {
      flush()
      const topic = (match[3] ?? '').trim()
      current = {
        startRef: normalizeRef(match[1]!),
        endRef: normalizeRef(match[2]!),
        ...(topic ? { topic } : {}),
        body: [],
      }
      continue
    }
    if (current) {
      current.body.push(line)
    }
  }
  flush()
  return out
}

/** `{startId, endId, summary}` / `{startRef, endRef, summary}` / `{range, summary}` */
function parseObjectRange(value: Record<string, unknown>): NormalizedRange[] {
  const summaryRaw =
    value.summary ?? value.content ?? value.text ?? value.body ?? undefined
  const summary =
    typeof summaryRaw === 'string' ? summaryRaw.trim() : ''
  if (summary.length === 0) {
    return []
  }

  const topicRaw = value.topic ?? value.title
  const topic = typeof topicRaw === 'string' && topicRaw.trim().length > 0
    ? topicRaw.trim()
    : undefined

  const start =
    value.startRef ?? value.startId ?? value.start ?? value.from ?? undefined
  const end = value.endRef ?? value.endId ?? value.end ?? value.to ?? undefined
  if (typeof start === 'string' && typeof end === 'string') {
    const s = /^m?(\d{3,7})$/i.exec(start.trim())
    const e = /^m?(\d{3,7})$/i.exec(end.trim())
    if (s && e) {
      return [
        {
          startRef: normalizeRef(s[1]!),
          endRef: normalizeRef(e[1]!),
          summary,
          ...(topic ? { topic } : {}),
        },
      ]
    }
  }

  const rangeRaw = value.range ?? value.refs ?? undefined
  if (typeof rangeRaw === 'string') {
    const m = HEADER_RE.exec(rangeRaw)
    if (m) {
      const blockTopic = topic ?? ((m[3] ?? '').trim() || undefined)
      return [
        {
          startRef: normalizeRef(m[1]!),
          endRef: normalizeRef(m[2]!),
          summary,
          ...(blockTopic ? { topic: blockTopic } : {}),
        },
      ]
    }
  }
  return []
}

function normalizeOne(value: unknown): NormalizedRange[] {
  if (typeof value === 'string') {
    return parseHeaderBlocks(value)
  }
  if (Array.isArray(value)) {
    return value.flatMap(normalizeOne)
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    // The kernel's own container shapes: `{content: ...}` and `{ranges: ...}`.
    const nested = obj.content ?? obj.ranges ?? obj.blocks
    const hasOwnBounds =
      obj.startRef !== undefined ||
      obj.startId !== undefined ||
      obj.range !== undefined
    if (nested !== undefined && !hasOwnBounds) {
      const inner = normalizeOne(nested)
      if (inner.length > 0) {
        return inner
      }
    }
    return parseObjectRange(obj)
  }
  return []
}

/**
 * Turn any shape the model may send into the flat range objects
 * `acp-kernel.applyCompression()` accepts. Returns `[]` when nothing usable
 * is present.
 */
export function normalizeCompressRanges(input: unknown): NormalizedRange[] {
  const ranges = normalizeOne(input)
  // Drop duplicates and empty summaries; keep the first occurrence.
  const seen = new Set<string>()
  const out: NormalizedRange[] = []
  for (const range of ranges) {
    if (range.summary.length === 0) {
      continue
    }
    const key = `${range.startRef}:${range.endRef}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(range)
  }
  return out
}
