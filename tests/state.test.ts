// Button availability semantics: windowAvailability is the authority the
// state route serves and the client button goes inert on. Each case mirrors a
// real log shape the engine produces (same fixture shapes as history.test.ts —
// both project through the host's own extractSessionEventText).
import { describe, expect, it } from 'vitest'
import { windowAvailability } from '../src/state.js'
import type { SessionEventLike } from '../src/history.js'

function userEvent(seq: number, text: string): SessionEventLike {
  return { seq, type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

function modelEvent(seq: number, text: string): SessionEventLike {
  return { seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function rolloverSummary(seq: number, shadowedSeqs: number[]): SessionEventLike {
  return { seq, type: 'compaction/summary', data: { shadowedSeqs, shadowedTokenCount: 1234 } }
}

describe('windowAvailability', () => {
  it('empty log: nothing to archive (window #1)', () => {
    expect(windowAvailability([])).toEqual({ windowNo: 1, archivable: false })
  })

  it('fresh session with one real exchange: archivable', () => {
    const events = [userEvent(0, '你好'), modelEvent(1, '你好！有什么可以帮你？')]
    expect(windowAvailability(events)).toEqual({ windowNo: 1, archivable: true })
  })

  it('right after a rollover: only the handoff checkpoint is live — NOT archivable', () => {
    const events = [
      userEvent(0, '旧窗口的问题'),
      modelEvent(1, '旧窗口的回答'),
      rolloverSummary(2, [0, 1]),
    ]
    expect(windowAvailability(events)).toEqual({ windowNo: 2, archivable: false })
  })

  it('the next real exchange after a rollover re-arms the button', () => {
    const events = [
      userEvent(0, '旧窗口的问题'),
      modelEvent(1, '旧窗口的回答'),
      rolloverSummary(2, [0, 1]),
      userEvent(3, '新窗口的第一条消息'),
    ]
    expect(windowAvailability(events)).toEqual({ windowNo: 2, archivable: true })
  })

  it('several rollovers: live window is everything after the last shadowed span', () => {
    const events = [
      userEvent(0, 'w1'),
      rolloverSummary(1, [0]),
      userEvent(2, 'w2-a'),
      modelEvent(3, 'w2-b'),
      rolloverSummary(4, [2, 3]),
      userEvent(5, 'w3-a'),
    ]
    // two completed rollovers → live window is #3 (same numbering ctx_history prints)
    expect(windowAvailability(events)).toEqual({ windowNo: 3, archivable: true })
  })

  it('compaction bookkeeping events alone never count as archivable content', () => {
    const events = [
      { seq: 0, type: 'compaction/start', data: {} },
      { seq: 1, type: 'compaction/end', data: {} },
    ]
    expect(windowAvailability(events)).toEqual({ windowNo: 1, archivable: false })
  })

  it('textless noise events (steps, headers) do not arm the button', () => {
    const events = [
      { seq: 0, type: 'request/header', data: { header: { big: 'x' } } },
      { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    ]
    expect(windowAvailability(events).archivable).toBe(false)
  })
})
