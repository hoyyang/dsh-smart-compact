// Button availability semantics: windowAvailability mirrors the ENGINE's own
// manual-path decision — the priced surface range (retain=0, same token meter)
// must mass more than the framed handoff checkpoint, or the compaction
// transaction would refuse with "summary is not smaller than the shadowed
// content" (observed live: three red no-op receipts on a freshly rolled
// window). Fixture event shapes match history.test.ts (both project through
// the host's extractSessionEventText).
import { describe, expect, it } from 'vitest'
import { framedCheckpointTokenEstimate, mergeSessionLedger, windowAvailability } from '../src/state.js'
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
    // The range excludes the newest node (retain-last rule): [user] = 400 > FRAMED.
    const nodes = [node(0, 400), node(1, 400)]
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 1, archivable: true })
    // A single priced node → empty range (nothing shadowable) → inert.
    expect(windowAvailability(events, [node(0, 400)], FRAMED).archivable).toBe(false)
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

  it('one new exchange re-arms, but a single new message does not (retain-last rule)', () => {
    // Manual range = first non-system node .. length-2: the newest surface
    // node is always retained. After the rollover the surface is [checkpoint,
    // msg]: range = [checkpoint] ≈ template size → the engine refuses → inert.
    // A second exchange extends the range past the checkpoint → re-armed.
    const events = [
      userEvent(0, '旧窗口的问题'),
      rolloverSummary(1, [0]),
      userEvent(2, '[smart-compact rollover] Context window #2 opened. ...'),
      userEvent(3, '新窗口的第一条消息'),
      modelEvent(4, '新窗口的回答'),
    ]
    const nodes = [node(2, 230), node(3, 600), node(4, 700)]
    // range = [checkpoint, first message] = 830 > FRAMED → archivable.
    expect(windowAvailability(events, nodes, FRAMED)).toEqual({ windowNo: 2, archivable: true })
    // One message only: range = [checkpoint] = 230 ≤ FRAMED → inert.
    expect(windowAvailability(events, nodes.slice(0, 2), FRAMED).archivable).toBe(false)
  })

  it('a leading system message is never part of the range (node 0 head)', () => {
    const events = [
      { seq: 0, type: 'system/message', data: { content: [{ type: 'text', text: 'sys' }] } },
      userEvent(1, '真实内容一'),
      modelEvent(2, '真实内容二'),
    ]
    // keepFromIdx=1 ≤ firstIdx=1 → empty range → inert…
    expect(windowAvailability(events, [node(0, 900), node(1, 260)], FRAMED).archivable).toBe(false)
    // …with one more node the range = [user] only; 260 > FRAMED(250) → archivable.
    expect(windowAvailability(events, [node(0, 900), node(1, 260), node(2, 300)], FRAMED).archivable).toBe(true)
    // …and just below the bar → inert.
    expect(windowAvailability(events, [node(0, 900), node(1, 240), node(2, 300)], FRAMED).archivable).toBe(false)
  })

  it('several rollovers: live window number counts every compaction/summary', () => {
    const events = [
      userEvent(0, 'w1'),
      rolloverSummary(1, [0]),
      userEvent(2, 'w2-a'),
      rolloverSummary(3, [2]),
      userEvent(4, 'w3-a'),
    ]
    // surface only; range excludes the newest node: [w2-a] = 230… use enough mass
    const nodes = [node(2, 300), node(4, 900)]
    // two completed rollovers → live window is #3 (same numbering ctx_history prints); range = [w2-a] = 300 > FRAMED
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
    // The worst-case template (orientation lines at their caps) plus framing
    // lands well above 100 tokens and below 500 — wide bounds that survive
    // host pricing drift.
    expect(estimate).toBeGreaterThan(100)
    expect(estimate).toBeLessThan(500)
  })

  it('falls back to a chars/4 heuristic without a meter (and never throws)', () => {
    const estimate = framedCheckpointTokenEstimate()
    expect(estimate).toBeGreaterThan(100)
  })
})

describe('mergeSessionLedger — per-session engine evidence', () => {
  it('keeps sessions apart and leaves the newest entry last', () => {
    let ledger = mergeSessionLedger(undefined, 'session-a', { at: 't1', totalTokens: 136_173, contextWindow: 272_000, thresholdTokens: 135_808, usableWindow: 144_000 })
    ledger = mergeSessionLedger(ledger, 'session-b', { at: 't2', totalTokens: 71_392, contextWindow: 1_000_000, thresholdTokens: 607_808, usableWindow: 616_000 })
    expect(Object.keys(ledger)).toEqual(['session-a', 'session-b'])
    expect(ledger['session-a']!.totalTokens).toBe(136_173) // a second session no longer erases the first
    expect(ledger['session-b']!.contextWindow).toBe(1_000_000)
  })

  it('merges a skip reason into an existing measurement without losing the numbers', () => {
    const first = mergeSessionLedger(undefined, 's', { at: 't1', totalTokens: 317_469, contextWindow: 272_000, thresholdTokens: 135_808, usableWindow: 144_000 })
    const second = mergeSessionLedger(first, 's', { at: 't2', skipReason: 'only 58,165 tokens added since the last switch (< 100000)' })
    expect(second['s']).toMatchObject({ at: 't2', totalTokens: 317_469, skipReason: 'only 58,165 tokens added since the last switch (< 100000)' })
  })

  it('records a refusal without inventing a measurement', () => {
    const ledger = mergeSessionLedger(undefined, 's', { at: 't1', refusal: 'forced band: nothing compactable at 317469 tokens' })
    expect(ledger['s']).toEqual({ at: 't1', refusal: 'forced band: nothing compactable at 317469 tokens' })
    expect(ledger['s']!.totalTokens).toBeUndefined()
  })

  it('drops the oldest entry past the limit', () => {
    let ledger: Record<string, { at: string }> | undefined
    for (let index = 0; index < 10; index += 1) ledger = mergeSessionLedger(ledger, `s${index}`, { at: `t${index}` })
    expect(Object.keys(ledger!)).toHaveLength(8)
    expect(Object.keys(ledger!)[0]).toBe('s2')
    expect(Object.keys(ledger!)[7]).toBe('s9')
  })
})
