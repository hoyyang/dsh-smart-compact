/**
 * ctx_history: recall original session content archived by rollover.
 * Reads the durable session event stream directly — zero new storage; the
 * compaction/summary event's shadowedSeqs point back at the original events.
 * @module dsh-smart-compact/history
 */
import { truncateToTokens } from './config.js'

/** Minimal structural view of one durable session event (avoids a hard peer on dsh-session types). */
export interface SessionEventLike {
  seq: number
  type: string
  /** Untyped payload: the host's event-data unions have no index signature. */
  data?: unknown
}

/**
 * Structural view of the host Session's durable-log API (dsh >= 0.1.5-rc).
 * The host removed `Session.events`; reading it now yields nothing, which
 * silently disabled recall. This adapter therefore fails loud by name instead
 * of degrading to an empty log.
 */
export interface SessionLogLike {
  /** Log length as the host reports it (`Session.seq`). */
  readonly seq?: number
  /** Full durable log in log order (`Session.snapshotEvents()`). */
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly SessionEventLike[]
}

/** Snapshot a session's durable event log, or fail loud naming the missing capability. */
export function sessionEvents(session: SessionLogLike): readonly SessionEventLike[] {
  if (typeof session?.snapshotEvents !== 'function') {
    throw new Error(
      'dsh-smart-compact: this host session does not expose snapshotEvents() — dsh >= 0.1.5-rc is required (Session.events was removed); update dsh or reinstall the plugin',
    )
  }
  return session.snapshotEvents()
}

export interface ArchivedWindow {
  index: number
  startSeq: number
  endSeq: number
  shadowedSeqs: number[]
  shadowedTokenCount: number
}

export interface EventHit {
  seq: number
  type: string
  preview: string
}

/** Extract a flat text projection from any known session event shape. */
export function eventText(event: SessionEventLike): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  const message = data.message as { content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }> } | undefined
  if (message && Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block.text === 'string') return block.text
        if (block.arguments !== undefined) return `${String(block.name ?? 'tool')}(${safeJson(block.arguments)})`
        return safeJson(block)
      })
      .join('\n')
  }
  if (typeof data.content === 'string') return data.content
  if (data.summary !== undefined) return safeJson(data.summary)
  return safeJson(data)
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function firstLine(text: string, width = 120): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  return line.length > width ? `${line.slice(0, width)}…` : line
}

/** Read-only recall facade over one session's durable event stream. */
export class SessionArchiveReader {
  constructor(
    private readonly events: readonly SessionEventLike[],
    private readonly maxOutputTokens: number,
  ) {}

  private compactionEvents(): SessionEventLike[] {
    return this.events.filter((e) => e.type === 'compaction/summary')
  }

  /** One entry per completed rollover: the shadowed span it archived. */
  listWindows(): ArchivedWindow[] {
    return this.compactionEvents().map((event, index) => {
      const data = (event.data ?? {}) as { shadowedSeqs?: number[]; shadowedRange?: { start: number; end: number }; shadowedTokenCount?: number }
      const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
      return {
        index: index + 1,
        startSeq: seqs.length > 0 ? seqs[0] : data.shadowedRange?.start ?? 0,
        endSeq: seqs.length > 0 ? seqs[seqs.length - 1] : data.shadowedRange?.end ?? 0,
        shadowedSeqs: seqs,
        shadowedTokenCount: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
      }
    })
  }

  /** Project original events by seq (most useful: those inside shadowed spans). */
  readSeqs(seqs: number[]): string {
    if (seqs.length === 0) throw new Error('dsh-smart-compact: ctx_history read requires at least one seq')
    const bySeq = new Map(this.events.map((e) => [e.seq, e]))
    const parts: string[] = []
    let budget = this.maxOutputTokens
    for (const seq of seqs) {
      const event = bySeq.get(seq)
      if (!event) throw new Error(`dsh-smart-compact: no archived event with seq ${seq} in this session (events run 0..${Math.max(0, this.events.length - 1)})`)
      const text = truncateToTokens(eventText(event), Math.min(budget, this.maxOutputTokens), `ctx_history read seq ${seq}`)
      parts.push(`── seq ${seq} · ${event.type} ──\n${text}`)
      budget -= Math.ceil(text.length / 4)
      if (budget <= 0) break
    }
    return parts.join('\n\n')
  }

  /** Case-folded substring search over the whole stream; returns a compact hit list, never full bodies. */
  search(keyword: string, archivedOnly = true): string {
    const needle = keyword.trim().toLowerCase()
    if (needle === '') throw new Error('dsh-smart-compact: ctx_history search requires a non-empty keyword')
    const archived = new Set(this.listWindows().flatMap((w) => w.shadowedSeqs))
    const hits: EventHit[] = []
    for (const event of this.events) {
      if (event.type.startsWith('compaction/')) continue
      if (archivedOnly && archived.size > 0 && !archived.has(event.seq)) continue
      const text = eventText(event)
      if (text.toLowerCase().includes(needle)) {
        hits.push({ seq: event.seq, type: event.type, preview: firstLine(text) })
        if (hits.length >= 50) break
      }
    }
    if (hits.length === 0) {
      if (archivedOnly && archived.size > 0) return `(no archived event matches ${JSON.stringify(keyword)} — retry with archivedOnly=false to search the live window too)`
      return `(no event matches ${JSON.stringify(keyword)})`
    }
    const body = hits.map((h) => `seq ${h.seq} · ${h.type} · ${h.preview}`).join('\n')
    return truncateToTokens(`${hits.length} hit(s):\n${body}`, this.maxOutputTokens, 'ctx_history search')
  }

  /** Total archived token mass across every rollover (budget telemetry). */
  archivedTokenCount(): number {
    return this.listWindows().reduce((sum, w) => sum + w.shadowedTokenCount, 0)
  }
}

/** Shape of the ctx_history tool arguments. */
export interface HistoryArgs {
  action: 'list' | 'read' | 'search'
  seqs?: number[]
  keyword?: string
  archivedOnly?: boolean
}
