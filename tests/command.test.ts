import { describe, expect, it, vi } from 'vitest'
import { executeSmartCompact, registerSmartCompactCommand, type SmartCompactDeps } from '../src/command.js'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'

const invocation = (rawInput = ''): Parameters<typeof executeSmartCompact>[1] => ({
  rawInput,
  agent: { id: 'a1', session: { id: 'sess-1' } },
  signal: new AbortController().signal,
  commandId: 'cmd-1',
})

const result = {
  shadowedSeqs: [1, 2, 3],
  shadowedTokenCount: 5400,
  summarySeq: 9,
  summary: [{ type: 'text', text: '[smart-compact rollover] Context window #4 opened. The previous window was archived in full.' }],
}

function makeDeps(overrides?: Partial<SmartCompactDeps>): SmartCompactDeps {
  return {
    engine: { compactNow: vi.fn(async () => result) },
    slotHolder: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    ...overrides,
  }
}

describe('/smart-compact — 100% lossless window switch', () => {
  it('delegates to this plugin engine and reports archived stats', async () => {
    const deps = makeDeps()
    const inv = invocation()
    const out = await executeSmartCompact(deps, inv)
    expect(out.kind).toBe('success')
    expect(out.text.startsWith('✅ 换窗完成：新窗口 #4 · 归档 3 条 (~5,400 tok)')).toBe(true)
    expect(out.text).toContain('ctx_history')
    expect(out.text).toContain('\n')
    expect(out.sourceEventSeq).toBe(9)
    expect(deps.engine!.compactNow).toHaveBeenCalledWith(inv.agent, inv.signal, 'cmd-1')
  })

  it('appends the no-notes advisory when the session never wrote ctx_notes', async () => {
    const deps = makeDeps({ hasNotes: async () => false })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('success')
    expect(out.text).toContain('⚠️ 上一窗口未写过 ctx_notes')
    expect(out.text).toContain('ctx_history 召回')
  })

  it('omits the notes advisory when notes exist or the probe is absent', async () => {
    const withNotes = await executeSmartCompact(makeDeps({ hasNotes: async () => true }), invocation())
    expect(withNotes.text).not.toContain('⚠️')
    const noProbe = await executeSmartCompact(makeDeps(), invocation())
    expect(noProbe.text).not.toContain('⚠️')
  })

  it('omits the window number when the result carries no handoff summary', async () => {
    const bare = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 5400, summarySeq: 9 }
    const deps = makeDeps({ engine: { compactNow: vi.fn(async () => bare) } })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.text.startsWith('✅ 换窗完成：新窗口已就绪 · 归档 3 条')).toBe(true)
  })

  it('appends the remaining-budget line when the budget probe is wired', async () => {
    const deps = makeDeps({ measureRemaining: async () => ({ totalTokens: 12_000, contextWindow: 100_000, remaining: 88_000 }) })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.text).toContain('当前剩余预算：约 88%（88,000 / 100,000 tok）。')
  })

  it('drops the budget line when the probe fails (advisory only, never fails the receipt)', async () => {
    const deps = makeDeps({ measureRemaining: async () => { throw new Error('no context window') } })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('success')
    expect(out.text).not.toContain('剩余预算')
  })

  it('refuses loudly when the slot is owned by another engine (no silent summary fallback)', async () => {
    const deps = makeDeps({ engine: null, slotHolder: 'GlmCompactionEngine' })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('error')
    expect(out.text).toContain('GlmCompactionEngine')
    expect(out.text).toContain('❌ 未执行换窗')
  })

  it('rejects arguments with usage text', async () => {
    const out = await executeSmartCompact(makeDeps(), invocation('extra'))
    expect(out.kind).toBe('error')
    expect(out.text).toBe('用法：/smart-compact（无需参数）')
  })

  it('reports nothing-to-switch when compactNow returns null', async () => {
    const deps = makeDeps({ engine: { compactNow: vi.fn(async () => null) } })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('error')
    expect(out.text).toContain('没有可归档')
  })

  it('maps busy to a friendly retry message and cancelled to a short note', async () => {
    const busy = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('busy', 'agent busy') }) } })
    expect((await executeSmartCompact(busy, invocation())).text).toContain('正忙')
    const cancelled = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('cancelled', 'x') }) } })
    const signal = new AbortController(); signal.abort()
    expect((await executeSmartCompact(cancelled, { ...invocation(), signal: signal.signal })).text).toContain('已取消')
  })

  it('translates the size-invariant refusal (fresh window, template >= content) into honest guidance', async () => {
    // The exact diagnostic the engine emits on a just-rolled window (observed
    // live on dsh-android-pane 建设: three red no-op receipts at ~1% content).
    const cause = new Error('summary is not smaller than the shadowed content (215 estimated framed tokens >= 193)')
    const tiny = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary', { cause }) }) } })
    const text = (await executeSmartCompact(tiny, invocation())).text
    expect(text).toContain('内容太少')
    expect(text).toContain('215')
    expect(text).toContain('193')
    expect(text).toContain('对话未被改动')
    // A summary failure WITHOUT the pricing cause keeps the generic wording.
    const generic = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('summary', 'manual compaction could not produce a smaller summary') }) } })
    expect((await executeSmartCompact(generic, invocation())).text).toContain('无法生成交接检查点')
  })

  it('register wires the command and disposes in-flight handlers', async () => {
    const registered: Array<Record<string, unknown>> = []
    const effects: Array<() => void> = []
    const ctx = {
      commands: { register: vi.fn((d: Record<string, unknown>) => { registered.push(d); return () => {} }) },
      effect: vi.fn((factory: () => Generator) => {
        // Mirror cordis: run the generator now (first next = collect, second = register)
        const g = factory()
        g.next()
        g.next()
        effects.push(() => g.next())
      }),
    }
    registerSmartCompactCommand(ctx as never, makeDeps())
    expect(ctx.effect).toHaveBeenCalledTimes(1)
    expect(registered).toHaveLength(1)
    expect(registered[0].name).toBe('smart-compact')
  })
})
