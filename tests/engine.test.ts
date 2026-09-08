import { describe, expect, it, vi } from 'vitest'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { RolloverCompactionEngine, windowGeneration } from '../src/rollover.ts'
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
    session: { id: 'sess-1', events },
    options: { provider: 'test-provider', model: 'test-model' },
  }
}

function makeEngine(ctx: FakeCtx, overrides?: { thresholdRatio?: number; fallbackBufferTokens?: number; auto?: boolean }) {
  const pending = new WeakSet<object>()
  const cfg = {
    thresholdRatio: overrides?.thresholdRatio ?? 0.85,
    fallbackBufferTokens: overrides?.fallbackBufferTokens ?? 1000,
    auto: overrides?.auto ?? true,
    logger: ctx.logger,
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
