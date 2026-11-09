import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureBudget, resolveModelTarget, wrapUpAdvice, type CtxLike } from '../src/budget.ts'
import { apply } from '../src/index.ts'

function makeAgent(events: Array<{ seq: number; type: string }> = [], totalTokens = 0) {
  void totalTokens
  return {
    // Host Session shape (dsh >= 0.1.5-rc): a durable-log snapshot, no `events`.
    session: { id: 'sess-9', seq: events.length, snapshotEvents: () => events },
    options: { provider: 'p', model: 'm' },
  }
}

function makeCtx(totalTokens = 0) {
  const registered: Array<{ name: string; disposeLabel?: string }> = []
  const effects: Array<() => void> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
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
    // Model cordis: isolate(name) returns a scoped child context; the isolated
    // service honestly reads as absent through it (reflection is keyed by the
    // isolate shadow), while every other service still resolves.
    isolate: vi.fn(() => isolated),
    get: vi.fn(() => undefined),
    tokenMeter: { measure: () => ({ totalTokens, surfaceTokens: 0, baseline: { kind: 'estimated' } }) },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
      stream: vi.fn(),
    },
  }
  // cordis's isolate() is a LIVE prototype-linked child, not a snapshot:
  // properties keep resolving through the parent (so a reflect replaced after
  // makeCtx() is still seen, exactly like the real thing), except the isolated
  // service name, which honestly reads as undefined.
  const isolatedGet = vi.fn(() => undefined)
  const isolated = new Proxy(ctx as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (prop === 'get') return isolatedGet
      return Reflect.get(target, prop, receiver)
    },
  })
  return {
    ctx: ctx as unknown as Parameters<typeof apply>[0] & CtxLike,
    registered,
    effects,
    listeners,
    isolate: ctx.isolate as unknown as ReturnType<typeof vi.fn>,
    isolatedGet,
  }
}

describe('measureBudget / resolveModelTarget', () => {
  it('returns total/window/remaining from meter + model info', async () => {
    const ctx = makeCtx(12_345).ctx
    const budget = await measureBudget(ctx, makeAgent() as never)
    expect(budget).toMatchObject({ totalTokens: 12_345, contextWindow: 100_000, remaining: 87_655, baselineKind: 'estimated', provider: 'p' })
    // v0.6.1: the completion reservation (max_tokens) narrows the usable input ceiling.
    expect(budget.completionReserve).toBe(0)
    expect(budget.usableWindow).toBe(100_000)
  })

  it('fails loud when the model has no context window', async () => {
    const ctx = makeCtx(0).ctx
    ;(ctx.llm as unknown as { resolveModelInfo: () => Promise<{ context: Record<string, never> }> }).resolveModelInfo = async () => ({ context: {} })
    await expect(measureBudget(ctx, makeAgent() as never)).rejects.toThrow(/no context window configured for model p\/m/)
  })

  it('fails loud when neither agent options nor request header carry the model', () => {
    const agent = { session: { id: 'x', snapshotEvents: () => [] } }
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

  // The ops probe is written to <DSH_HOME>/dsh-smart-compact/engine-state.json.
  // Tests must never touch the developer's real home (running the suite used to
  // overwrite the live probe with synthetic mount data).
  let home = ''
  let previousHome: string | undefined
  beforeEach(async () => {
    previousHome = process.env.DSH_HOME
    home = await mkdtemp(join(tmpdir(), 'dsh-smart-compact-home-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  it('writes its ops probe under DSH_HOME, not the real user home', async () => {
    const { ctx } = makeCtx()
    apply(ctx, { notesDir: await notesDir() })
    const probe = JSON.parse(await readFile(join(home, 'dsh-smart-compact', 'engine-state.json'), 'utf8'))
    expect(probe).toMatchObject({ plugin: 'dsh-smart-compact', engineMounted: true })
  })

  it('isolates the lagging toolResultPruner service from the engine context', async () => {
    const { ctx, isolate, isolatedGet } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: true })
    expect(isolate).toHaveBeenCalledWith('toolResultPruner')
    // the engine's view of the service is absent (that is what defuses the
    // stale third-party pruner) and the apply-time self-check stays silent
    expect(isolatedGet).toHaveBeenCalledWith('toolResultPruner')
    expect(isolatedGet('toolResultPruner')).toBeUndefined()
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('did not take effect'))
  })

  it('warns when isolation does not take effect (a pruner would abort rollovers)', async () => {
    const { ctx } = makeCtx()
    // simulate a no-op isolate(): the engine would get the parent context back
    ;(ctx as unknown as { isolate: () => unknown }).isolate = () => ({ ...(ctx as unknown as object), get: () => ({ prune: () => {} }) })
    apply(ctx, { notesDir: await notesDir(), auto: true })
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("ctx.isolate('toolResultPruner') did not take effect"))
  })

  it('the loaded kernel frames checkpoints with a v4 producer kind (not the retired "plugin" wrapper)', async () => {
    const { compactCheckpointSource } = await import('@deepseek-ai/dsh-compaction')
    expect((compactCheckpointSource as unknown as (id: string) => { kind: string })('x').kind).not.toBe('plugin')
  })

  it('refuses to mount the engine on a stale kernel whose checkpoints use kind "plugin"', async () => {
    vi.resetModules()
    vi.doMock('@deepseek-ai/dsh-compaction', async (orig) => ({
      ...(await orig<object>()),
      compactCheckpointSource: () => ({ kind: 'plugin', plugin: 'compact' }),
    }))
    try {
      const fresh = (await import('../src/index.ts')).apply
      const { ctx, registered, listeners } = makeCtx()
      fresh(ctx, { notesDir: await notesDir(), auto: true })
      expect(ctx.logger.error).toHaveBeenCalledWith(expect.stringContaining('rollover engine NOT mounted'))
      expect(listeners.get('agent/pre-step')).toBeUndefined()
      expect(registered.map((t) => t.name)).toContain('ctx_notes')
      const probe = JSON.parse(await readFile(join(home, 'dsh-smart-compact', 'engine-state.json'), 'utf8'))
      expect(probe).toMatchObject({ engineMounted: false, slotHolder: 'stale kernel' })
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-compaction')
      vi.resetModules()
    }
  })

  it('registers exactly four tools with auto=true and arms the engine', async () => {
    const { ctx, registered, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: true })
    const names = registered.map((t) => t.name).sort()
    expect(names).toEqual(['ctx_history', 'ctx_notes', 'get_context_remaining', 'new_context'])
    expect(listeners.get('agent/pre-step')?.length).toBe(1) // inherited from basic
    expect(listeners.get('system-prompt/assemble')?.length).toBe(1) // reminder
  })

  it('arms zero-output recovery with auto=true (one session/event listener)', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: true })
    expect(listeners.get('session/event')?.length).toBe(1)
    expect(ctx.logger.info).toHaveBeenCalledWith(expect.stringContaining('zero-output recovery armed'))
  })

  it('autoContinue=false registers no recovery listener (opt-out stays byte-identical)', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: true, autoContinue: false })
    expect(listeners.get('session/event')).toBeUndefined()
  })

  it('auto=false registers no recovery listener either', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx, { notesDir: await notesDir(), auto: false })
    expect(listeners.get('session/event')).toBeUndefined()
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

describe('routed model truth — the request header wins over agent options (v0.6.3)', () => {
  function agentWith(
    header: { provider: string; model: string; maxTokens?: number } | undefined,
    options: { provider?: string; model?: string; maxTokens?: number },
  ) {
    return {
      session: {
        id: 'sess-routed',
        snapshotEvents: () => [],
        ...(header === undefined ? {} : { requestHeader: () => ({ config: header }) }),
      },
      options,
    }
  }

  it('follows the model the session is actually routed to, not the creation-time seed', () => {
    // 2026-11-05: the agent was created on deepseek-flash (1M/384k) and the user
    // switched to 微软 Azure gpt-6.1-sol (272k/128k); options stayed stale.
    const agent = agentWith(
      { provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol', maxTokens: 128_000 },
      { provider: 'deepseek-official', model: 'deepseek/deepseek-flash', maxTokens: 384_000 },
    )
    expect(resolveModelTarget(agent as never)).toEqual({ provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol' })
  })

  it('falls back to agent options before the first request header exists', () => {
    const agent = agentWith(undefined, { provider: 'deepseek-official', model: 'deepseek/deepseek-flash' })
    expect(resolveModelTarget(agent as never)).toEqual({ provider: 'deepseek-official', model: 'deepseek/deepseek-flash' })
  })

  it("reserves the adapter's default maxTokens when no header or option carries one", async () => {
    const ctx = makeCtx(10_000).ctx
    ;(ctx.llm as unknown as { resolveModelInfo: () => Promise<unknown> }).resolveModelInfo = async () => ({ context: { contextWindow: 272_000 }, defaultMaxTokens: 128_000 })
    const agent = agentWith(undefined, { provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol' })
    const budget = await measureBudget(ctx, agent as never)
    expect(budget.completionReserve).toBe(128_000)
    expect(budget.usableWindow).toBe(144_000)
    expect(budget.model).toBe('azure_openai/gpt-6.1-sol')
  })

  it('prefers the live header reservation over a stale creation-time maxTokens', async () => {
    const ctx = makeCtx(10_000).ctx
    ;(ctx.llm as unknown as { resolveModelInfo: () => Promise<unknown> }).resolveModelInfo = async () => ({ context: { contextWindow: 272_000 } })
    const agent = agentWith(
      { provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol', maxTokens: 128_000 },
      { provider: 'deepseek-official', model: 'deepseek/deepseek-flash', maxTokens: 384_000 },
    )
    const budget = await measureBudget(ctx, agent as never)
    expect(budget.completionReserve).toBe(128_000)
    expect(budget.usableWindow).toBe(144_000)
  })

  it('prefers the live header reservation over the adapter default', async () => {
    const ctx = makeCtx(10_000).ctx
    ;(ctx.llm as unknown as { resolveModelInfo: () => Promise<unknown> }).resolveModelInfo = async () => ({ context: { contextWindow: 272_000 }, defaultMaxTokens: 64_000 })
    const agent = agentWith(
      { provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol', maxTokens: 128_000 },
      { provider: 'mify-sol', model: 'azure_openai/gpt-6.1-sol' },
    )
    expect((await measureBudget(ctx, agent as never)).completionReserve).toBe(128_000)
  })
})

