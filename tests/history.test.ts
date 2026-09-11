import { describe, expect, it } from 'vitest'
import { SessionArchiveReader, eventText, sessionEvents, type SessionEventLike } from '../src/history.ts'

function eventsWithOneRollover(): SessionEventLike[] {
  return [
    { seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'fix the login bug, postgres migration is forbidden' }] } } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'working on it' }] } } },
    { seq: 2, type: 'tool/call', data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: { command: 'psql -c 1' } }] } } },
    { seq: 3, type: 'tool/result', data: { content: 'psql: connected' } },
    { seq: 4, type: 'compaction/summary', data: { shadowedSeqs: [0, 1, 2, 3], shadowedRange: { start: 0, end: 3 }, shadowedTokenCount: 5400 } },
    { seq: 5, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'continue' }] } } },
  ]
}

describe('sessionEvents — host Session API adapter', () => {
  it('reads the durable log through snapshotEvents()', () => {
    const events = eventsWithOneRollover()
    expect(sessionEvents({ seq: events.length, snapshotEvents: () => events })).toHaveLength(6)
  })

  it('fails loud (naming the missing capability) instead of returning an empty log', () => {
    expect(() => sessionEvents({ id: 'legacy' } as never)).toThrow(/does not expose snapshotEvents\(\)/)
  })
})

describe('SessionArchiveReader.listWindows', () => {
  it('derives one archived window per compaction/summary event', () => {
    const reader = new SessionArchiveReader(eventsWithOneRollover(), 8192)
    const windows = reader.listWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ index: 1, startSeq: 0, endSeq: 3, shadowedTokenCount: 5400 })
    expect(windows[0].shadowedSeqs).toEqual([0, 1, 2, 3])
    expect(reader.archivedTokenCount()).toBe(5400)
  })
})

describe('SessionArchiveReader.search', () => {
  it('returns compact hit lists (never full bodies) and respects archivedOnly', () => {
    const reader = new SessionArchiveReader(eventsWithOneRollover(), 8192)
    const hits = reader.search('postgres')
    expect(hits).toContain('seq 0')
    expect(hits).not.toContain('psql: connected')
    const wider = reader.search('connected', false)
    expect(wider).toContain('seq 3')
    const none = reader.search('zzz-not-there')
    expect(none).toContain('no archived event matches')
  })

  it('rejects empty keywords (fail loud)', () => {
    const reader = new SessionArchiveReader(eventsWithOneRollover(), 8192)
    expect(() => reader.search('  ')).toThrow(/non-empty keyword/)
  })
})

describe('SessionArchiveReader.readSeqs', () => {
  it('projects original bodies for archived seqs and truncates over budget', () => {
    const reader = new SessionArchiveReader(eventsWithOneRollover(), 8192)
    const out = reader.readSeqs([2])
    expect(out).toContain('seq 2')
    expect(out).toContain('bash(')
    expect(() => reader.readSeqs([999])).toThrow(/no archived event with seq 999/)
    expect(() => reader.readSeqs([])).toThrow(/at least one seq/)
  })

  it('truncates output when a single body exceeds the token budget', () => {
    const big: SessionEventLike[] = [
      { seq: 0, type: 'tool/result', data: { content: 'x'.repeat(40_000) } },
      { seq: 1, type: 'compaction/summary', data: { shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 }, shadowedTokenCount: 10_000 } },
    ]
    const reader = new SessionArchiveReader(big, 1024)
    const out = reader.readSeqs([0])
    expect(out).toContain('[truncated:')
    expect(out.length).toBeLessThan(40_000)
  })
})

describe('eventText', () => {
  it('projects message content, tool arguments, raw content, and unknown data', () => {
    expect(eventText({ seq: 0, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } })).toContain('hello')
    expect(eventText({ seq: 1, type: 'tool/call', data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: { a: 1 } }] } } })).toContain('bash(')
    expect(eventText({ seq: 2, type: 'tool/result', data: { content: 'plain' } })).toBe('plain')
    expect(eventText({ seq: 3, type: 'compaction/summary', data: { shadowedSeqs: [1] } })).toContain('shadowedSeqs')
    expect(eventText({ seq: 4, type: 'mystery/event', data: { k: 1 } })).toContain('"k"')
  })
})
