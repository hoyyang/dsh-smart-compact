import { describe, expect, it, vi } from 'vitest'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { RolloverCompactionEngine, buildHandoffCheckpoint, deriveHandoffContext, deriveNotesFreshness, deriveRecentActivity, handoffCheckpointWorstCaseText, HANDOFF_LINE_MAX, ACTIVITY_ENTRY_MAX, windowGeneration } from '../src/rollover.ts'
import { consumeRollover, requestRollover } from '../src/new-context.ts'
import type { CtxLike } from '../src/budget.ts'

interface FakeCtx extends CtxLike {
  on(event: string, listener: (...args: unknown[]) => unknown): void
  listeners: Map<string, Array<(...args: unknown[]) => unknown>>
  streamCalls: number
}

function makeFakeCtx(totalTokens: number): FakeCtx {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const fake: FakeCtx = {
    listeners,
    streamCalls: 0,
    tokenMeter: {
      measure: () => ({ totalTokens, surfaceTokens: 0, baseline: { kind: 'estimated' } }),
    },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
      stream: async function* () {
        fake.streamCalls += 1
        yield { type: 'text', text: 'SHOULD NEVER BE CALLED' }
      },
    } as unknown as CtxLike['llm'],
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    reflect: { provide: () => {} },
    on(event: string, listener: (...args: unknown[]) => unknown) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {}
    },
  }
  return fake
}

function makeAgent(events: Array<{ seq: number; type: string }> = []) {
  return {
    // Host Session shape (dsh >= 0.1.5-rc): a durable-log snapshot, no `events`.
    session: { id: 'sess-1', seq: events.length, snapshotEvents: () => events },
    options: { provider: 'test-provider', model: 'test-model' },
  }
}

function makeEngine(ctx: FakeCtx, overrides?: { thresholdRatio?: number; fallbackBufferTokens?: number; auto?: boolean; hasNotes?: (sessionId: string) => Promise<boolean>; lastNoteWrittenAt?: (sessionId: string) => Promise<number | null> }) {
  const pending = new WeakSet<object>()
  const cfg = {
    thresholdRatio: overrides?.thresholdRatio ?? 0.85,
    fallbackBufferTokens: overrides?.fallbackBufferTokens ?? 1000,
    auto: overrides?.auto ?? true,
    logger: ctx.logger,
    onRolloverRefused: vi.fn(),
    onBudgetDegraded: vi.fn(),
    ...(overrides?.hasNotes ? { hasNotes: overrides.hasNotes } : {}),
    ...(overrides?.lastNoteWrittenAt ? { lastNoteWrittenAt: overrides.lastNoteWrittenAt } : {}),
  }
  const engine = new RolloverCompactionEngine(ctx as never, { thresholdRatio: cfg.thresholdRatio, auto: cfg.auto }, cfg, pending)
  return { engine, pending, cfg }
}

describe('windowGeneration', () => {
  it('counts completed rollovers as the window generation', () => {
    expect(windowGeneration(undefined)).toBe(0)
    expect(windowGeneration([{ seq: 0, type: 'user/message' }])).toBe(0)
    expect(windowGeneration([{ seq: 1, type: 'compaction/summary' }])).toBe(1)
  })
})

describe('RolloverCompactionEngine.summarize — the zero-model-call handoff', () => {
  it('numbers the opened window by session-window index (first window is #1)', async () => {
    const ctx = makeFakeCtx(0)
    const { engine } = makeEngine(ctx)
    const first = makeAgent([])
    expect((await engine.summarize({}, first as never, undefined)).summary[0].text).toContain('Context window #2 opened')
    const second = makeAgent([{ seq: 1, type: 'compaction/summary' }])
    expect((await engine.summarize({}, second as never, undefined)).summary[0].text).toContain('Context window #3 opened')
  })

  it('returns a fixed template, never an LLM call shape', async () => {
    const ctx = makeFakeCtx(0)
    const { engine } = makeEngine(ctx)
    const agent = makeAgent([{ seq: 1, type: 'compaction/summary' }])
    const result = await engine.summarize({}, agent as never, undefined)
    expect(result.summary).toHaveLength(1)
    expect(result.summary[0].type).toBe('text')
    expect(result.summary[0].text).toContain('[smart-compact rollover]')
    expect(result.summary[0].text).toContain('ctx_notes')
    expect(result.summary[0].text).toContain('ctx_history')
    expect(result).toMatchObject({ provider: 'rollover-template', model: 'none' })
    expect((result as Record<string, unknown>).llmStreamCall).toBeUndefined()
    expect(ctx.streamCalls).toBe(0)
  })

  it('switches the anchor to ctx_history recall when the session has no notes (honest handoff)', async () => {
    const { engine } = makeEngine(makeFakeCtx(0), { hasNotes: async () => false })
    const agent = makeAgent([])
    const text = (await engine.summarize({}, agent as never, undefined)).summary[0].text
    expect(text).toContain('no ctx_notes yet')
    expect(text).toContain('ctx_history')
    expect(text).not.toContain('live in ctx_notes')
  })

  it('carries mechanical Task/Last-action orientation lines derived from the log (v0.4.6)', async () => {
    const ctx = makeFakeCtx(0)
    const { engine } = makeEngine(ctx)
    const agent = makeAgent([
      { seq: 1, type: 'session/title', data: { title: '移动-ISS-202609-00049110A' } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '分析这个反馈单\n第二行不应出现' }] } },
    ] as never)
    const text = (await engine.summarize({}, agent as never, undefined)).summary[0].text as string
    expect(text).toContain('Task: 移动-ISS-202609-00049110A')
    expect(text).toContain('Last action: 分析这个反馈单')
    expect(text).toContain('newest exchange remains visible in this window')
  })

  it('omits the orientation lines when the log carries nothing derivable', async () => {
    const ctx = makeFakeCtx(0)
    const { engine } = makeEngine(ctx)
    const text = (await engine.summarize({}, makeAgent([]) as never, undefined)).summary[0].text as string
    expect(text).not.toContain('Task:')
    expect(text).not.toContain('Last action:')
  })

  it('caps derived orientation lines at HANDOFF_LINE_MAX', () => {
    const long = '很长的任务描述'.repeat(40)
    const derived = deriveHandoffContext([
      { seq: 1, type: 'session/title', data: { title: long } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: long }] } },
    ])
    expect(derived.task.length).toBeLessThanOrEqual(HANDOFF_LINE_MAX + 1)
    expect(derived.last.length).toBeLessThanOrEqual(HANDOFF_LINE_MAX + 1)
    expect(derived.task.endsWith('…')).toBe(true)
  })

  it('prices the worst-case template at or above every real anchor (probe stays biased inert)', () => {
    const filler = 'x'.repeat(HANDOFF_LINE_MAX)
    const worst = handoffCheckpointWorstCaseText()
    for (const notesAssured of [true, false]) {
      for (const context of [undefined, { task: '', last: '' }, { task: '任务', last: '最后动作' }, { task: filler, last: filler }]) {
        expect(worst.length).toBeGreaterThanOrEqual(buildHandoffCheckpoint(98, notesAssured, context).length)
      }
    }
  })

  it('keeps the notes-first anchor when notes exist, the probe throws, or it is absent', async () => {
    const agent = makeAgent([])
    const truthy = makeEngine(makeFakeCtx(0), { hasNotes: async () => true })
    expect((await truthy.engine.summarize({}, agent as never, undefined)).summary[0].text).toContain('live in ctx_notes')
    const throwing = makeEngine(makeFakeCtx(0), { hasNotes: async () => { throw new Error('boom') } })
    expect((await throwing.engine.summarize({}, agent as never, undefined)).summary[0].text).toContain('live in ctx_notes')
    const plain = makeEngine(makeFakeCtx(0))
    expect((await plain.engine.summarize({}, agent as never, undefined)).summary[0].text).toContain('live in ctx_notes')
  })
})

describe('RolloverCompactionEngine.compactIfNeeded — three-band policy', () => {
  it('quiet band (below threshold): no compaction, no super delegation', async () => {
    const ctx = makeFakeCtx(10_000) // 10% of a 100k window, threshold at 85%
    const { engine } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded').mockResolvedValue(null)
    const agent = makeAgent()
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(superSpy).not.toHaveBeenCalled()
    superSpy.mockRestore()
  })

  it('grace band: remind exactly once per generation, still no compaction', async () => {
    const ctx = makeFakeCtx(85_500) // above 85k threshold, below 86k force line
    const { engine } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded').mockResolvedValue(null)
    const agent = makeAgent()
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(superSpy).not.toHaveBeenCalled()
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('grace band entered'))
    // second step in the same window generation: no repeat reminder
    ctx.logger.info = vi.fn()
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(ctx.logger.info).not.toHaveBeenCalled()
    superSpy.mockRestore()
  })

  it('forced band (threshold + buffer): delegates to basic with the template summarizer', async () => {
    const ctx = makeFakeCtx(90_000) // well past 86k force line
    const { engine } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded').mockResolvedValue({ shadowedSeqs: [0, 1] })
    const agent = makeAgent()
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(superSpy).toHaveBeenCalledTimes(1)
    superSpy.mockRestore()
  })

  it('new_context request is consumed exactly once and never silently swallowed', async () => {
    const ctx = makeFakeCtx(10_000) // quiet band — only a pending request can force
    const { engine, pending } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockResolvedValueOnce(null)          // pressure path refuses (pruner pulled usage below threshold)
      .mockResolvedValueOnce({ shadowedSeqs: [0, 1] })  // overflow fallback MUST run
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(superSpy).toHaveBeenCalledTimes(2)
    expect((superSpy.mock.calls[1] as unknown[])[1]).toBe('context-overflow') // fallback trigger
    expect(consumeRollover(pending, agent.session)).toBe(false) // consumed once
    // second step: no pending request, quiet band, no delegation
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(superSpy).toHaveBeenCalledTimes(2)
    superSpy.mockRestore()
  })

  it('keeps a forced request pending when the engine refuses, and reports it (never silently swallowed)', async () => {
    const ctx = makeFakeCtx(10_000)
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockResolvedValue(null) // both the pressure band and the overflow fallback find nothing compactable
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(superSpy).toHaveBeenCalledTimes(2)
    expect(pending.has(agent.session)).toBe(true) // request survived the refusal (non-destructive probe)
    expect(cfg.onRolloverRefused).toHaveBeenCalledWith({ reason: expect.stringContaining('nothing compactable') })
    // next step, SAME still-armed request: it forces again instead of being lost
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(superSpy).toHaveBeenCalledTimes(4)
    expect(cfg.onRolloverRefused).toHaveBeenCalledTimes(2) // every retry is reported, none is swallowed
    expect(pending.has(agent.session)).toBe(true)
    superSpy.mockRestore()
  })

  it('survives an engine error without breaking the step and reports it', async () => {
    const ctx = makeFakeCtx(10_000)
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockRejectedValue(new Error('token-meter surface does not match the current session surface'))
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(consumeRollover(pending, agent.session)).toBe(true) // still pending for a later step
    expect(cfg.onRolloverRefused).toHaveBeenCalledWith({ reason: expect.stringContaining('error: ') })
    superSpy.mockRestore()
  })

it('treats a non-Error rejection as an incident instead of crashing the step', async () => {
    const ctx = makeFakeCtx(10_000)
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockRejectedValue('plain string rejection') // third-party adapters reject with non-Errors
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(cfg.onRolloverRefused).toHaveBeenCalledWith({ reason: expect.stringContaining('plain string rejection') })
    expect(pending.has(agent.session)).toBe(true)
    superSpy.mockRestore()
  })

  it('keeps the request armed and records no incident when the step was aborted', async () => {
    const ctx = makeFakeCtx(10_000)
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockRejectedValue(new Error('aborted'))
    const agent = makeAgent()
    const controller = new AbortController()
    requestRollover(pending, agent as never)
    controller.abort()
    await expect(engine.compactIfNeeded(agent as never, 'pressure', controller.signal)).resolves.toBeNull()
    expect(cfg.onRolloverRefused).not.toHaveBeenCalled() // an abort is not a refusal
    expect(pending.has(agent.session)).toBe(true)         // and the explicit request is not dropped
    superSpy.mockRestore()
  })

  it('commits on the first band without running the overflow fallback', async () => {
    const ctx = makeFakeCtx(10_000)
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockResolvedValue({ shadowedSeqs: [0, 1] })
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.not.toBeNull()
    expect(superSpy).toHaveBeenCalledTimes(1) // no unnecessary second pass
    expect(pending.has(agent.session)).toBe(false) // committed ⇒ consumed
    superSpy.mockRestore()
  })

  it('counts a budget-measurement failure even on the forced path (degraded signal stays reachable)', async () => {
    const ctx = makeFakeCtx(10_000)
    ctx.llm.resolveModelInfo = async () => ({ context: {} }) // no contextWindow
    const { engine, pending, cfg } = makeEngine(ctx)
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded')
      .mockResolvedValue({ shadowedSeqs: [0, 1] })
    const agent = makeAgent()
    requestRollover(pending, agent as never)
    for (let i = 0; i < 5; i += 1) await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(cfg.onBudgetDegraded).toHaveBeenCalledWith(5)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('BUDGET OBSERVABILITY DEGRADED'))
    superSpy.mockRestore()
  })

  it('budget measurement failure degrades loudly to a logged warning, no crash', async () => {
    const ctx = makeFakeCtx(10_000)
    ctx.llm.resolveModelInfo = async () => ({ context: {} }) // no contextWindow
    const { engine } = makeEngine(ctx)
    const agent = makeAgent()
    await expect(engine.compactIfNeeded(agent as never, 'pressure', undefined)).resolves.toBeNull()
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget measurement failed'))
  })

  it('auto=false keeps manual/overflow paths (no new_context tool exists to arm pending)', async () => {
    const ctx = makeFakeCtx(95_000)
    const { engine } = makeEngine(ctx, { auto: false })
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactIfNeeded: (...a: unknown[]) => unknown }, 'compactIfNeeded').mockResolvedValue(null)
    const agent = makeAgent()
    // pressure trigger goes straight to super (no bands, no consumption)
    await engine.compactIfNeeded(agent as never, 'pressure', undefined)
    expect(superSpy).toHaveBeenCalledTimes(1)
    superSpy.mockRestore()
  })
})

describe('basic engine registration (inherited)', () => {
  it('constructor with auto=true registers agent/pre-step and overflow listeners', () => {
    const ctx = makeFakeCtx(0)
    makeEngine(ctx)
    expect(ctx.listeners.get('agent/pre-step')?.length).toBe(1)
    expect(ctx.listeners.get('agent/request-error')?.length).toBe(1)
  })
})

describe('RolloverCompactionEngine.compactNow — manual path bookkeeping', () => {
  it('books the ops probe on success (the manual path used to bypass every onRollover hook)', async () => {
    const ctx = makeFakeCtx(0)
    const onRollover = vi.fn()
    const engine = new RolloverCompactionEngine(
      ctx as never,
      { auto: false },
      { thresholdRatio: 0.85, fallbackBufferTokens: 1000, auto: false, logger: ctx.logger, onRollover },
      new WeakSet(),
    )
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactNow: (...a: unknown[]) => unknown }, 'compactNow').mockResolvedValue({
      compactionId: 'c1', startSeq: 1, summarySeq: 9, endSeq: 10, summary: [],
      shadowedSeqs: [1, 2, 3], shadowedTokenCount: 100, shadowedRange: { start: 1, end: 3 },
    })
    try {
      const agent = makeAgent()
      const result = await engine.compactNow(agent as never, new AbortController().signal, 'cmd-1')
      expect(result).not.toBeNull()
      expect(superSpy).toHaveBeenCalledTimes(1)
      expect(onRollover).toHaveBeenCalledTimes(1)
      expect(onRollover).toHaveBeenCalledWith({ generation: 0, trigger: 'manual' })
    } finally {
      superSpy.mockRestore()
    }
  })

  it('does not book the probe when nothing was compactable (null is not a rollover)', async () => {
    const ctx = makeFakeCtx(0)
    const onRollover = vi.fn()
    const engine = new RolloverCompactionEngine(
      ctx as never,
      { auto: false },
      { thresholdRatio: 0.85, fallbackBufferTokens: 1000, auto: false, logger: ctx.logger, onRollover },
      new WeakSet(),
    )
    const superSpy = vi.spyOn(BasicCompactionEngine.prototype as never as { compactNow: (...a: unknown[]) => unknown }, 'compactNow').mockResolvedValue(null)
    try {
      const agent = makeAgent()
      await expect(engine.compactNow(agent as never, new AbortController().signal, 'cmd-1')).resolves.toBeNull()
      expect(onRollover).not.toHaveBeenCalled()
    } finally {
      superSpy.mockRestore()
    }
  })
})

describe('RolloverCompactionEngine.summarize — mandatory anchor sanitization (v0.5.0)', () => {
  it('redacts personal and company information out of the Task/Last-action anchors', async () => {
    const ctx = makeFakeCtx(0)
    const { engine } = makeEngine(ctx)
    // 合成数据：张三 / 13800138000 / example.com / 示例科技有限公司
    const agent = makeAgent([
      { seq: 1, type: 'session/title', data: { title: '与示例科技有限公司的合作推进' } },
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '联系 张三 13800138000 或 zhangsan@example.com 索要合同' }] } },
    ]) as never
    const text = (await engine.summarize({}, agent, undefined)).summary[0].text as string
    expect(text).toContain('Task:')
    expect(text).toContain('Last action:')
    expect(text).not.toContain('13800138000')
    expect(text).not.toContain('zhangsan@example.com')
    expect(text).not.toContain('示例科技有限公司')
    expect(text).toContain('【已脱敏:手机号】')
    expect(text).toContain('【已脱敏:邮箱】')
    expect(text).toContain('【已脱敏:企业名】')
  })
})

describe('stale-notes gate (ISS-202609-00089191A: the anchor vouched for day-old notes)', () => {
  const T0 = Date.parse('2026-09-28T03:01:00.000Z')
  const content = (text: string) => ({ content: [{ type: 'text', text }] })

  it('deriveNotesFreshness: activity after the note is stale; before it is fresh; missing stamp is unknown', () => {
    const events = [
      { seq: 1, type: 'user/message', time: T0 - 1000, data: content('early') },
      { seq: 2, type: 'user/message', time: T0 + 60_000, data: content('commit landed') },
      { seq: 3, type: 'user/message', time: T0 + 120_000, data: content('persist done') },
    ]
    expect(deriveNotesFreshness(events, T0)).toMatchObject({ stale: true, eventsAfter: 2 })
    expect(deriveNotesFreshness(events, T0 + 200_000)).toMatchObject({ stale: false, eventsAfter: 0 })
    expect(deriveNotesFreshness(events, null)).toMatchObject({ stale: false, eventsAfter: 0 })
    const timeless = [{ seq: 1, type: 'user/message', data: content('no time') }]
    expect(deriveNotesFreshness(timeless, T0)).toMatchObject({ stale: false, eventsAfter: 0 })
  })

  it('anchor downgrades to STALE wording with the mechanical activity tail; fresh keeps the classic wording', async () => {
    const events = [
      { seq: 1, type: 'user/message', time: T0 - 1000, data: content('early') },
      { seq: 2, type: 'tool/call', time: T0 + 60_000, data: { name: 'bash', arguments: '{}' } },
      { seq: 3, type: 'user/message', time: T0 + 120_000, data: content('persist done') },
    ]
    const stale = makeEngine(makeFakeCtx(0), { hasNotes: async () => true, lastNoteWrittenAt: async () => T0 })
    const text = (await stale.engine.summarize({}, makeAgent(events) as never, undefined)).summary[0].text as string
    expect(text).toContain('Handoff notes are STALE')
    expect(text).toContain('2026-09-28 03:01 UTC')
    expect(text).toContain('2 activity event(s)')
    expect(text).toContain('Mechanical activity after the last note: bash@03:02')
    expect(text).not.toContain('read it first')
    expect(text).not.toContain('do not assume anything not written there')

    const fresh = makeEngine(makeFakeCtx(0), { hasNotes: async () => true, lastNoteWrittenAt: async () => T0 + 300_000 })
    const freshText = (await fresh.engine.summarize({}, makeAgent(events) as never, undefined)).summary[0].text as string
    expect(freshText).toContain('live in ctx_notes')
    expect(freshText).not.toContain('STALE')

    const unknown = makeEngine(makeFakeCtx(0), { hasNotes: async () => true, lastNoteWrittenAt: async () => null })
    const unknownText = (await unknown.engine.summarize({}, makeAgent(events) as never, undefined)).summary[0].text as string
    expect(unknownText).toContain('live in ctx_notes')
    expect(unknownText).not.toContain('STALE')
  })

  it('summarize keeps the classic anchor when the freshness probe throws', async () => {
    const events = [{ seq: 1, type: 'user/message', time: T0 + 1000, data: content('x') }]
    const throwing = makeEngine(makeFakeCtx(0), { hasNotes: async () => true, lastNoteWrittenAt: async () => { throw new Error('boom') } })
    expect((await throwing.engine.summarize({}, makeAgent(events) as never, undefined)).summary[0].text).toContain('live in ctx_notes')
  })

  it('deriveRecentActivity: tool names and clocks only, newest last, capped', () => {
    const events = [
      { seq: 1, type: 'tool/call', time: T0 + 1000, data: { name: 'run_code', arguments: '{"code":"SECRET"}' } },
      { seq: 2, type: 'tool/call', time: T0 + 2000, data: { name: 'edit', arguments: '{}' } },
      { seq: 3, type: 'tool/call', time: T0 + 3000, data: { name: 'bash', arguments: '{}' } },
      { seq: 4, type: 'tool/call', time: T0 + 4000, data: { name: 'read', arguments: '{}' } },
    ]
    const tail = deriveRecentActivity(events as never, T0)
    expect(tail).toBe('edit@03:01, bash@03:01, read@03:01')
    expect(tail).not.toContain('SECRET')
  })

  it('worst-case template still prices the STALE variant with a maxed activity tail', () => {
    const filler = 'x'.repeat(HANDOFF_LINE_MAX)
    const worst = handoffCheckpointWorstCaseText()
    expect(worst).toContain('STALE')
    expect(worst).toContain('Mechanical activity after the last note')
    for (const recent of [undefined, 'bash@03:02', 'o'.repeat(ACTIVITY_ENTRY_MAX)]) {
      for (const eventsAfter of [1, 99999]) {
        const real = buildHandoffCheckpoint(98, true, { task: filler, last: filler, ...(recent ? { recent } : {}) }, { stale: true, eventsAfter, lastWriteAtMs: T0 })
        expect(worst.length).toBeGreaterThanOrEqual(real.length)
      }
    }
  })
})
