import { describe, expect, it, vi } from 'vitest'
import { executeSmartCompact, registerSmartCompactCommand, type SmartCompactDeps } from '../src/command.js'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'

const invocation = (rawInput = ''): Parameters<typeof executeSmartCompact>[1] => ({
  rawInput,
  agent: { id: 'a1' },
  signal: new AbortController().signal,
  commandId: 'cmd-1',
})

const result = { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 5400, summarySeq: 9 }

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
    expect(out.text).toContain('3 history items')
    expect(out.text).toContain('5400 tokens')
    expect(out.sourceEventSeq).toBe(9)
    expect(deps.engine!.compactNow).toHaveBeenCalledWith(inv.agent, inv.signal, 'cmd-1')
  })

  it('refuses loudly when the slot is owned by another engine (no silent summary fallback)', async () => {
    const deps = makeDeps({ engine: null, slotHolder: 'GlmCompactionEngine' })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('error')
    expect(out.text).toContain('GlmCompactionEngine')
    expect(out.text).toContain('not active')
  })

  it('rejects arguments with usage text', async () => {
    const out = await executeSmartCompact(makeDeps(), invocation('extra'))
    expect(out.kind).toBe('error')
    expect(out.text).toBe('Usage: /smart-compact (no arguments)')
  })

  it('reports nothing-to-switch when compactNow returns null', async () => {
    const deps = makeDeps({ engine: { compactNow: vi.fn(async () => null) } })
    const out = await executeSmartCompact(deps, invocation())
    expect(out.kind).toBe('error')
    expect(out.text).toContain('no compactable history')
  })

  it('maps busy to a friendly retry message and cancelled to a short note', async () => {
    const busy = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('busy', 'agent busy') }) } })
    expect((await executeSmartCompact(busy, invocation())).text).toContain('agent is not idle')
    const cancelled = makeDeps({ engine: { compactNow: vi.fn(async () => { throw new ManualCompactionError('cancelled', 'x') }) } })
    const signal = new AbortController(); signal.abort()
    expect((await executeSmartCompact(cancelled, { ...invocation(), signal: signal.signal })).text).toContain('cancelled')
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
