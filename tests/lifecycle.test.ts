import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureBudget, resolveModelTarget, wrapUpAdvice, type CtxLike } from '../src/budget.ts'
import { apply } from '../src/index.ts'

function makeAgent(events: Array<{ seq: number; type: string }> = [], totalTokens = 0) {
  return {
    session: { id: 'sess-9', events },
    options: { provider: 'p', model: 'm' },
  }
}

function makeCtx(totalTokens = 0) {
  const registered: Array<{ name: string; disposeLabel?: string }> = []
  const effects: Array<() => void> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    tools: {
      register: vi.fn((t: { name: string }) => {
        registered.push(t)
        return () => {
          const index = registered.indexOf(t)
          if (index >= 0) registered.splice(index, 1)
        }
      }),
    },
    effect: vi.fn((factory: () => unknown, label: string) => {
      // Mirror cordis semantics: run the factory NOW, keep its disposer.
      const disposer = factory()
      effects.push(() => {
        if (typeof disposer === 'function') (disposer as () => void)()
      })
      void label
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
    }),
    reflect: { provide: () => {} },
    get: vi.fn(() => undefined),
    tokenMeter: { measure: () => ({ totalTokens, surfaceTokens: 0, baseline: { kind: 'estimated' } }) },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
      stream: vi.fn(),
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof apply>[0] & CtxLike, registered, effects, listeners }
}

describe('measureBudget / resolveModelTarget', () => {
  it('returns total/window/remaining from meter + model info', async () => {
    const ctx = makeCtx(12_345).ctx
    const budget = await measureBudget(ctx, makeAgent() as never)
    expect(budget).toEqual({ totalTokens: 12_345, contextWindow: 100_000, remaining: 87_655, baselineKind: 'estimated' })
  })

  it('fails loud when the model has no context window', async () => {
    const ctx = makeCtx(0).ctx
    ;(ctx.llm as unknown as { resolveModelInfo: () => Promise<{ context: Record<string, never> }> }).resolveModelInfo = async () => ({ context: {} })
    await expect(measureBudget(ctx, makeAgent() as never)).rejects.toThrow(/no context window configured for model p\/m/)
  })

  it('fails loud when neither agent options nor request header carry the model', () => {
    const agent = { session: { id: 'x', events: [] } }
    expect(() => resolveModelTarget(agent as never)).toThrow(/cannot resolve the routed model for session x/)
  })
})

describe('wrapUpAdvice', () => {
  it('advises only inside the grace band', () => {
    expect(wrapUpAdvice(9000, 8192)).toBeNull()
    expect(wrapUpAdvice(1000, 8192)).toContain('ctx_notes')
  })
})

describe('apply() lifecycle', () => {
  async function notesDir() {
    return mkdtemp(join(tmpdir(), 'dsh-smart-compact-apply-'))
  }

  it('registers exactly four tools with auto=true and arms the engine', async () => {
    const { ctx, registered, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: true })
    const names = registered.map((t) => t.name).sort()
    expect(names).toEqual(['ctx_history', 'ctx_notes', 'get_context_remaining', 'new_context'])
    expect(listeners.get('agent/pre-step')?.length).toBe(1) // inherited from basic
    expect(listeners.get('system-prompt/assemble')?.length).toBe(1) // reminder
  })

  it('auto=false omits new_context and the reminder waterfall', async () => {
    const { ctx, registered, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: false })
    expect(registered.map((t) => t.name).sort()).toEqual(['ctx_history', 'ctx_notes', 'get_context_remaining'])
    expect(listeners.get('system-prompt/assemble')).toBeUndefined()
  })

  it('enabled=false leaves the host untouched (zero tools, zero listeners)', async () => {
    const { ctx, registered, listeners } = makeCtx()
    apply(ctx, { enabled: false })
    expect(registered).toHaveLength(0)
    expect(listeners.size).toBe(0)
  })

  it('re-apply after dispose is idempotent (unload/reinstall parity)', async () => {
    const { ctx, registered, effects } = makeCtx()
    const dir = await notesDir()
    apply(ctx, { notesDir: dir })
    expect(registered).toHaveLength(4)
    for (const dispose of effects) dispose()
    expect(registered).toHaveLength(0)
    apply(ctx, { notesDir: dir })
    expect(registered).toHaveLength(4)
  })

  it('yields the compaction slot politely when construction collides with an existing owner', async () => {
    const { ctx, registered, listeners } = makeCtx()
    // Simulate cordis: the Service constructor's provide() collides on the
    // occupied slot — the collision error names the holder.
    ;(ctx as unknown as { reflect: { provide: (name: string) => void } }).reflect = {
      provide: (name: string) => {
        if (name === 'compaction') throw new Error('service "compaction" has been registered at <GlmCompactionEngine>')
      },
    }
    apply(ctx, { notesDir: await notesDir() })
    // tools minus new_context still mount; no engine listeners; loud notice logged
    expect(registered.map((t) => t.name).sort()).toEqual(['ctx_history', 'ctx_notes', 'get_context_remaining'])
    expect(listeners.get('agent/pre-step')).toBeUndefined()
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('compaction slot occupied by GlmCompactionEngine'))
  })
})
