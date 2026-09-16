// Button availability semantics: windowAvailability mirrors the ENGINE's own
// manual-path decision — the priced surface range (retain=0, same token meter)
// must mass more than the framed handoff checkpoint, or the compaction
// transaction would refuse with "summary is not smaller than the shadowed
// content" (observed live: three red no-op receipts on a freshly rolled
// window). Fixture event shapes match history.test.ts (both project through
// the host's extractSessionEventText).
import { describe, expect, it } from 'vitest'
import { framedCheckpointTokenEstimate, windowAvailability } from '../src/state.js'
import type { PricedNodeLike } from '../src/state.js'
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

function node(seq: number, tokens: number): PricedNodeLike {
  return { seq, tokens }
}

const FRAMED = 250 // framed template estimate used across the metered cases

describe('windowAvailability (metered — the engine\'s own comparison)', () => {
  it('no priced surface: nothing to archive (window #1)', () => {
    expect(windowAvailability([], [], FRAMED)).toEqual({ windowNo: 1, archivable: false })
  })

  it('fresh session with real mass above the framed checkpoint: archivable', () => {
    const events = [userEvent(0, '你好'), modelEvent(1, '你好！有什么可以帮你？')]
    const nodes = [node(0, 400), node(1, 400)]
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 1, archivable: true })
  })

  it('right after a rollover the live surface is the old checkpoint itself — NOT archivable', () => {
    // The handoff checkpoint IS a priced surface user message; re-rolling
    // would shadow it with an equally sized template → the engine refuses.
    const events = [
      userEvent(0, '旧窗口的问题'),
      modelEvent(1, '旧窗口的回答'),
      rolloverSummary(2, [0, 1]),
      userEvent(3, '[smart-compact rollover] Context window #2 opened. ...'), // the checkpoint message
    ]
    // The meter prices the SURFACE only: shadowed seqs 0/1 are replaced by the
    // checkpoint message (seq 3) — the durable log keeps them, the surface
    // does not, and the engine's manual range covers exactly the surface.
    const nodes = [node(3, 230)]
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 2, archivable: false })
  })

  it('the next real exchange after a rollover re-arms the button', () => {
    const events = [
      userEvent(0, '旧窗口的问题'),
      rolloverSummary(1, [0]),
      userEvent(2, '[smart-compact rollover] Context window #2 opened. ...'),
      userEvent(3, '新窗口的第一条消息'),
    ]
    const nodes = [node(0, 8000), node(2, 230), node(3, 600)]
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 2, archivable: true })
  })

  it('a leading system message is never part of the range (node 0 head)', () => {
    const events = [
      { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
      userEvent(1, '真实内容'),
    ]
    const nodes = [node(0, 900), node(1, 260)]
    // Only the user message is shadowable; 260 > FRAMED(250) → archivable.
    expect(windowAvailability(events, nodes, FRAMED).archivable).toBe(true)
    // …and just below the bar → inert.
    expect(windowAvailability(events, [node(0, 900), node(1, 240)], FRAMED).archivable).toBe(false)
  })

  it('several rollovers: live window number counts every compaction/summary', () => {
    const events = [
      userEvent(0, 'w1'),
      rolloverSummary(1, [0]),
      userEvent(2, 'w2-a'),
      rolloverSummary(3, [2]),
      userEvent(4, 'w3-a'),
    ]
    const nodes = [node(2, 230), node(4, 900)]
    // two completed rollovers → live window is #3 (same numbering ctx_history prints)
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 3, archivable: true })
  })

  it('null measurement (meter unavailable) degrades to the text-presence heuristic, fail-open', () => {
    const events = [userEvent(0, '你好')]
    expect(windowAvailability(events, null, FRAMED)).toEqual({ windowNo: 1, archivable: true })
    // The same shapes the heuristic must NOT arm on:
    const handoffOnly = [rolloverSummary(0, [1, 2])]
    expect(windowAvailability(handoffOnly, null, FRAMED).archivable).toBe(false)
    const noise = [
      { seq: 0, type: 'request/header', data: { header: { big: 'x' } } },
      { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    ]
    expect(windowAvailability(noise, null, FRAMED).archivable).toBe(false)
  })
})

describe('framedCheckpointTokenEstimate', () => {
  it('prices the framed template with the host meter when available', () => {
    const estimate = framedCheckpointTokenEstimate((message: unknown) => {
      const content = (message as { content: Array<{ text: string }> }).content
      return content.reduce((sum, b) => sum + Math.ceil(b.text.length / 4) + 4, 4)
    })
    // The five-line template plus framing lands well above 100 tokens and
    // below 500 — wide bounds that survive host pricing drift.
    expect(estimate).toBeGreaterThan(100)
    expect(estimate).toBeLessThan(500)
  })

  it('falls back to a chars/4 heuristic without a meter (and never throws)', () => {
    const estimate = framedCheckpointTokenEstimate()
    expect(estimate).toBeGreaterThan(100)
  })
})
