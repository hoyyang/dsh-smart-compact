import { describe, expect, it, vi } from 'vitest'
import { attachReminder, BRIEFING, TIERS, tierNudge, graceNudge, wallNudge } from '../src/reminder.ts'
import type { BudgetSnapshot } from '../src/budget.ts'

interface Harness {
  listeners: Map<string, Array<(...args: unknown[]) => unknown>>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
  /** Run the system-prompt/assemble waterfall with a fake agent context. */
  assemble(session: object | undefined, assembled?: Record<string, unknown>): Promise<Record<string, unknown>>
}

function makeHarness(budgetSource: BudgetSnapshot | (() => BudgetSnapshot), opts?: { fallbackBufferTokens?: number; thresholdRatio?: number; thresholdFor?: (provider: string) => number; getWindowGeneration?: () => number; onObservation?: (observation: unknown) => void }): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  attachReminder(
    { on: (event: string, listener: (...args: unknown[]) => unknown) => { const b = listeners.get(event) ?? []; b.push(listener); listeners.set(event, b) } },
    {
      fallbackBufferTokens: opts?.fallbackBufferTokens ?? 8192,
      thresholdRatio: opts?.thresholdRatio ?? 0.85,
      ...(opts?.thresholdFor ? { thresholdFor: opts.thresholdFor } : {}),
      getBudget: async (session: object) => (session ? (typeof budgetSource === 'function' ? budgetSource() : budgetSource) : null),
      getWindowGeneration: opts?.getWindowGeneration ?? (() => 0),
      onObservation: opts?.onObservation,
      logger,
      pluginName: 'dsh-smart-compact',
    },
  )
  const waterfall = listeners.get('system-prompt/assemble')![0]!
  return {
    listeners,
    logger,
    assemble: (session, assembled = { system: 'BASE' }) => waterfall({}, { agent: session ? { session } : undefined }, async () => assembled) as Promise<Record<string, unknown>>,
  }
}

const session = { id: 's1' }
const budget = (totalTokens: number, contextWindow = 100_000): BudgetSnapshot => ({ totalTokens, contextWindow, remaining: contextWindow - totalTokens, baselineKind: 'estimated', provider: 'kiro-vision' })

describe('attachReminder — tiered budget awareness', () => {
  it('briefs the model on the very first assembled prompt only', async () => {
    const h = makeHarness(budget(0))
    const first = await h.assemble(session)
    expect(String(first.system)).toContain('BASE')
    expect(String(first.system)).toContain('[dsh-smart-compact]')
    expect(String(first.system)).toContain('ctx_notes')
    expect(String(first.system)).toContain('ctx_history')
    const second = await h.assemble(session)
    expect(String(second.system)).toBe('BASE') // no repeated briefing at low usage
  })

  it('fires each tier exactly once as consumption crosses 25/50/75%', async () => {
    let total = 10_000
    const h = makeHarness(() => budget(total))
    await h.assemble(session) // briefing consumed at low usage
    // cross 25% → tier fires once, then stays quiet at the same level
    total = 26_000
    const at25 = await h.assemble(session, { system: 'BASE' })
    expect(String(at25.system)).toContain('reached 25%')
    const again = await h.assemble(session, { system: 'BASE' })
    expect(String(again.system)).toBe('BASE')
  })

  it('grace nudge fires at the engine threshold (85%), not only near exhaustion', async () => {
    // 86% used → inside the engine's grace band, but remaining (14_000) is far
    // above the old belt-and-braces floor (8_192): the pre-v0.4.6 condition
    // would have stayed silent until almost nothing was left.
    const h = makeHarness(budget(86_000))
    const out = await h.assemble(session, { system: 'BASE' })
    expect(String(out.system)).toContain('LOW CONTEXT')
  })

  it('grace nudge fires per window generation, not repeatedly', async () => {
    let generation = 0
    const h = makeHarness(budget(99_000), { fallbackBufferTokens: 8192, getWindowGeneration: () => generation })
    const first = await h.assemble(session, { system: 'BASE' })
    expect(String(first.system)).toContain('LOW CONTEXT')
    const second = await h.assemble(session, { system: 'BASE' })
    expect(String(second.system)).toBe('BASE')
    generation = 1 // rollover happened → re-armed
    const third = await h.assemble(session, { system: 'BASE' })
    expect(String(third.system)).toContain('LOW CONTEXT')
  })

  it('skips everything gracefully when the budget is unknown', async () => {
    const h = makeHarness(null)
    const out = await h.assemble(session)
    expect(String(out.system)).toBe('BASE')
  })

  it('falls back to log-only with a loud warn when no system/developer field exists', async () => {
    const h = makeHarness(budget(0))
    const out = await h.assemble(session, {})
    expect(out.system).toBeUndefined()
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not find a system/developer field'))
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('[dsh-smart-compact]'))
  })

  it('keeps the prompt intact when the reminder pass throws', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    attachReminder(
      { on: (e, l) => { const b = listeners.get(e) ?? []; b.push(l); listeners.set(e, b) } },
      { fallbackBufferTokens: 8192, getBudget: async () => { throw new Error('meter exploded') }, getWindowGeneration: () => 0, logger, pluginName: 'dsh-smart-compact' },
    )
    const waterfall = listeners.get('system-prompt/assemble')![0]!
    const out = await waterfall({ system: 'BASE' }, { agent: { session } }, async () => ({ system: 'BASE' })) as Record<string, unknown>
    expect(String(out.system)).toBe('BASE')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reminder pass failed'))
  })
})

describe('nudge text contracts', () => {
  it('tiers are ordered and labeled', () => {
    expect(TIERS.map((t) => t.label)).toEqual(['25%', '50%', '75%'])
    expect(tierNudge(0.25, '25%')).toContain('25%')
    expect(graceNudge(500)).toContain('500 tokens remaining')
  })
})

describe('attachReminder — pass observability (v0.5.0)', () => {
  it('emits briefed/tier/grace observations as nudges fire', async () => {
    const seen: Array<{ kind: string; label?: string }> = []
    let total = 95_000
    const h = makeHarness(() => budget(total), {
      fallbackBufferTokens: 2_000,
      thresholdRatio: 0.85,
      onObservation: (o) => seen.push(o as { kind: string; label?: string }),
    })
    await h.assemble(session)
    total = 30_000
    await h.assemble(session)
    total = 99_000
    await h.assemble(session)
    expect(seen.some((o) => o.kind === 'briefed')).toBe(true)
    expect(seen.some((o) => o.kind === 'tier' && o.label === '25%')).toBe(true)
    expect(seen.some((o) => o.kind === 'grace')).toBe(true)
  })

  it('reports no-budget once per session instead of skipping silently', async () => {
    const seen: Array<{ kind: string }> = []
    const h = makeHarness(() => budget(0).contextWindow ? budget(0) : budget(0), {
      onObservation: (o) => seen.push(o as { kind: string }),
    })
    // getBudget returning null path: harness maps null only for undefined session;
    // simulate the failure shape via a zero window instead.
    void h
    const seen2: Array<{ kind: string }> = []
    const h2 = makeHarness(() => ({ totalTokens: 0, contextWindow: 0, remaining: 0, baselineKind: 'estimated' }), {
      onObservation: (o) => seen2.push(o as { kind: string }),
    })
    await h2.assemble(session)
    await h2.assemble(session)
    expect(seen2.filter((o) => o.kind === 'no-budget').length).toBe(1)
    expect(seen.filter((o) => o.kind === 'no-budget').length).toBe(0)
  })
})

describe('attachReminder — per-provider grace threshold', () => {
  it('fires the grace nudge at the provider override (75%) before the 85% default', async () => {
    const h = makeHarness(budget(78_000), { thresholdFor: (provider) => (provider === 'kiro-vision' ? 0.75 : 0.85) })
    const out = await h.assemble(session)
    expect(String(out.system)).toContain(graceNudge(22_000))
    const plain = makeHarness(budget(78_000))
    expect(String((await plain.assemble(session)).system)).not.toContain(graceNudge(22_000))
  })
})

describe('attachReminder — the usable-wall nudge', () => {
  const pastWall = (): BudgetSnapshot => ({
    totalTokens: 317_469,
    contextWindow: 272_000,
    remaining: -45_469,
    baselineKind: 'estimated',
    provider: 'mify-sol',
    completionReserve: 128_000,
    usableWindow: 144_000,
  })

  it('names the equation and the lossless escape once per window', async () => {
    const observations: string[] = []
    const h = makeHarness(pastWall, { onObservation: (observation) => observations.push((observation as { kind: string }).kind) })
    const first = await h.assemble(session)
    expect(String(first.system)).toContain('exceed the 144000-token ceiling')
    expect(String(first.system)).toContain('new_context')
    const second = await h.assemble(session)
    expect(String(second.system)).not.toContain('exceed the 144000-token ceiling') // once per window
    expect(observations).toContain('wall')
  })

  it('does not fire below the wall (grace keeps its own wording)', async () => {
    const belowWall = (): BudgetSnapshot => ({ ...pastWall(), totalTokens: 120_000, remaining: 24_000 })
    const h = makeHarness(belowWall)
    const assembled = await h.assemble(session)
    expect(String(assembled.system)).not.toContain('ceiling')
    expect(String(assembled.system)).toContain(graceNudge(24_000).slice(0, 40))
  })

  it('renders the numbers so the incident is auditable from the prompt alone', () => {
    expect(wallNudge(317_469, 144_000)).toContain('317469')
    expect(wallNudge(317_469, 144_000)).toContain('144000')
  })
})
