import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  ContinuationWatch,
  CONTINUATION_SOURCE_KIND,
  buildContinuationMessage,
  isDegenerateTurnEnd,
  recoveryPrompt,
  summarizeAssistantContent,
  type ContinuationAgentLike,
  type GoalsLike,
} from '../src/continue.ts'

interface FixtureEvent { seq: number; type: string; data?: unknown }
interface Fixture {
  source: string
  events: FixtureEvent[]
  counterexamples: Array<{ name: string; event: { type: string; data?: unknown }; lastAssistant: { hasText: boolean; hasToolCall: boolean } | null }>
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/degenerate-turns.json', import.meta.url), 'utf8')) as Fixture

const logger = () => ({ info: vi.fn(), warn: vi.fn() })

function assistantEvent(content: Array<{ type: string; text?: string }>): { type: string; data: unknown } {
  return { type: 'assistant/message', data: { turn: 1, step: 1, message: { content } } }
}

function turnEnd(kind: string, turn = 1): { type: string; data: unknown } {
  return { type: 'turn/end', data: { turn, reason: { kind } } }
}

function userEvent(kind: string): { type: string; data: unknown } {
  return { type: 'user/message', data: { message: { source: { kind }, content: [] } } }
}

interface HarnessOptions {
  goal?: { phase: string; activation: string; id?: string; revision?: number } | null
  goalsThrows?: boolean
  measure?: { totalTokens: number; usableWindow: number } | null
  status?: string
  queued?: number
  maxConsecutiveRecoveries?: number
  followup?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const resume = vi.fn()
  const followup = vi.fn()
  const rollover = vi.fn(async () => 7)
  const flush = vi.fn(async () => true)
  const recovered: Array<{ action: string; rollover: number | null }> = []
  const gaveUp: Array<{ reason: string }> = []
  const log = logger()
  const agent: ContinuationAgentLike = {
    session: { id: 'session-1' },
    status: opts.status ?? 'idle',
    whenIdle: async () => undefined,
    inbox: { nextTurn: new Array(opts.queued ?? 0).fill({}) },
    ...(opts.followup === false ? {} : { followup }),
  }
  const goals: GoalsLike = {
    get: () => {
      if (opts.goalsThrows) throw new Error('goals unavailable')
      const goal = opts.goal
      if (goal === null || goal === undefined) return undefined
      return { id: goal.id ?? 'goal-1', revision: goal.revision ?? 3, phase: goal.phase, activation: goal.activation }
    },
    resume,
  }
  const watch = new ContinuationWatch({
    logger: log,
    maxConsecutiveRecoveries: opts.maxConsecutiveRecoveries ?? 2,
    agents: { get: (id: string) => (id === 'session-1' ? agent : undefined) },
    goals: () => goals,
    measure: async () => opts.measure ?? null,
    rollover,
    flush,
    onRecovered: (info) => recovered.push({ action: info.action, rollover: info.rollover }),
    onGaveUp: (info) => gaveUp.push({ reason: info.reason }),
  })
  return { watch, agent, resume, followup, rollover, flush, recovered, gaveUp, logger: log }
}

describe('classifier — real events from session-761460d5', () => {
  it('reads a reasoning-only answer as visible output: none', () => {
    const degenerate = fixture.events.find((event) => event.seq === 2957)!
    const content = (degenerate.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
    expect(summarizeAssistantContent(content)).toEqual({ hasText: false, hasToolCall: false })
  })

  it('keeps a healthy step (text + tool call) out of the trigger', () => {
    const healthy = fixture.events.find((event) => event.seq === 2938)!
    const content = (healthy.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content
    expect(summarizeAssistantContent(content)).toEqual({ hasText: true, hasToolCall: true })
  })

  it('flags all four real max-tokens turns (three in turn 11-13, one in turn 19)', () => {
    const ends = fixture.events.filter((event) => event.type === 'turn/end')
    expect(ends).toHaveLength(4)
    for (const end of ends) {
      expect((end.data as { reason: { kind: string } }).reason.kind).toBe('max-tokens')
      expect(isDegenerateTurnEnd(end, { hasText: false, hasToolCall: false })).toBe(true)
    }
  })

  it('never flags the six counterexamples', () => {
    for (const counterexample of fixture.counterexamples) {
      expect(isDegenerateTurnEnd(counterexample.event, counterexample.lastAssistant)).toBe(false)
    }
  })

  it('treats whitespace-only text as invisible output', () => {
    expect(summarizeAssistantContent([{ type: 'text', text: '  \n ' }])).toEqual({ hasText: false, hasToolCall: false })
  })
})

describe('recovery prompt', () => {
  it('names the window switch only when one happened', () => {
    expect(recoveryPrompt()).not.toContain('机械换窗')
    expect(recoveryPrompt({ rollover: 4 })).toContain('已机械换窗 #4')
    expect(recoveryPrompt({ rollover: null })).not.toContain('机械换窗')
  })

  it('builds a producer-owned user message (never the literal "plugin")', () => {
    const message = buildContinuationMessage(recoveryPrompt()) as { role: string; source: { kind: string; form: string }; content: Array<{ type: string; text: string }> }
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe(CONTINUATION_SOURCE_KIND)
    expect(message.source.kind).not.toBe('plugin')
    expect(message.source.form).toBe('continuation')
    expect(message.content[0]!.text).toContain('[smart-compact 续跑]')
  })
})

describe('ContinuationWatch — goal path', () => {
  it('resumes a disarmed active goal and injects nothing', async () => {
    // v0.6.3: a degenerate turn switches the window before continuing, so the
    // measurement is supplied and the switch is part of the expectation.
    const h = harness({ goal: { phase: 'active', activation: 'disarmed' }, measure: { totalTokens: 150_000, usableWindow: 144_000 } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', 4))
    await h.watch.drain()
    expect(h.resume).toHaveBeenCalledWith(h.agent, { id: 'goal-1', revision: 3 })
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.recovered).toEqual([{ action: 'goal-resume', rollover: 7 }])
  })

  it('does nothing when the host already re-armed the goal', async () => {
    const h = harness({ goal: { phase: 'active', activation: 'armed' } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.recovered[0]!.action).toBe('goal-already-armed')
  })

  it('never restarts a goal a human paused or completed', async () => {
    const h = harness({ goal: { phase: 'paused', activation: 'disarmed' } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.recovered[0]!.action).toBe('skipped')
  })
})

describe('ContinuationWatch — message path', () => {
  it('injects one continuation message, flushes it, and switches the window first when past the wall', async () => {
    const h = harness({ measure: { totalTokens: 317_469, usableWindow: 144_000 } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.rollover).toHaveBeenCalledTimes(1)
    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(h.flush).toHaveBeenCalledTimes(1)
    expect(h.recovered).toEqual([{ action: 'message', rollover: 7 }])
  })

  it('skips the switch when the window still has room', async () => {
    const h = harness({ measure: { totalTokens: 40_000, usableWindow: 144_000 } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.rollover).not.toHaveBeenCalled()
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way when messages are already queued', async () => {
    const h = harness({ queued: 1 })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.recovered[0]!.action).toBe('skipped')
  })
})

describe('ContinuationWatch — guards', () => {
  it('ignores subagent/automation sessions (no human message)', async () => {
    const h = harness()
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.recovered).toHaveLength(0)
  })

  it('recovers a turn once even when the event is replayed', async () => {
    const h = harness()
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', 9))
    await h.watch.drain()
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', 9))
    await h.watch.drain()
    expect(h.followup).toHaveBeenCalledTimes(1)
  })

  it('gives up after maxConsecutiveRecoveries and stays quiet', async () => {
    const h = harness({ maxConsecutiveRecoveries: 2 })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    for (const turn of [1, 2, 3, 4]) {
      h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
      h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', turn))
      await h.watch.drain()
    }
    expect(h.followup).toHaveBeenCalledTimes(2)
    expect(h.gaveUp).toHaveLength(1)
    expect(h.gaveUp[0]!.reason).toContain('did not produce visible output')
  })

  it('a completed turn resets the streak and the give-up latch', async () => {
    const h = harness({ maxConsecutiveRecoveries: 1 })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', 1))
    await h.watch.drain()
    h.watch.observe({ id: 'session-1' }, turnEnd('completed', 2))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens', 3))
    await h.watch.drain()
    expect(h.followup).toHaveBeenCalledTimes(2)
  })

  it('leaves a max-tokens turn alone when it produced text or a tool call', async () => {
    for (const content of [[{ type: 'text', text: 'done for now' }], [{ type: 'tool-call' }]]) {
      const h = harness()
      h.watch.observe({ id: 'session-1' }, userEvent('user'))
      h.watch.observe({ id: 'session-1' }, assistantEvent(content))
      h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
      await h.watch.drain()
      expect(h.followup).not.toHaveBeenCalled()
    }
  })

  it('records a give-up when the goal refuses to resume', async () => {
    const h = harness({ goal: { phase: 'active', activation: 'disarmed' } })
    h.resume.mockImplementation(() => { throw new Error('GOAL_INVALID_TRANSITION') })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.followup).not.toHaveBeenCalled()
    expect(h.gaveUp[0]!.reason).toContain('goal resume rejected')
  })

  it('falls back to the message path when the goal service is unreachable', async () => {
    const h = harness({ goalsThrows: true })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
})

describe('ContinuationWatch — a stale routed target must not veto the switch (v0.6.3)', () => {
  it('switches even when the measurement still reports room (stale 1M target, real 272k route)', async () => {
    // 2026-11-05 azure incident: the stale options measured 407k of 616k usable
    // while the real route had already clamped the completion to 16 tokens.
    const h = harness({ measure: { totalTokens: 407_143, usableWindow: 616_000 } })
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.rollover).toHaveBeenCalledTimes(1)
    expect(h.followup).toHaveBeenCalledTimes(1)
    expect(h.recovered).toEqual([{ action: 'message', rollover: 7 }])
  })

  it('switches when the measurement is unavailable', async () => {
    const h = harness() // measure resolves null
    h.watch.observe({ id: 'session-1' }, userEvent('user'))
    h.watch.observe({ id: 'session-1' }, assistantEvent([{ type: 'reasoning' }]))
    h.watch.observe({ id: 'session-1' }, turnEnd('max-tokens'))
    await h.watch.drain()
    expect(h.rollover).toHaveBeenCalledTimes(1)
    expect(h.followup).toHaveBeenCalledTimes(1)
  })
})

