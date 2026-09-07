import { describe, expect, it, vi } from 'vitest'
import { attachReminder, BRIEFING, TIERS, tierNudge, graceNudge } from '../src/reminder.ts'
import type { BudgetSnapshot } from '../src/budget.ts'

interface Harness {
  listeners: Map<string, Array<(...args: unknown[]) => unknown>>
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> }
  /** Run the system-prompt/assemble waterfall with a fake agent context. */
  assemble(session: object | undefined, assembled?: Record<string, unknown>): Promise<Record<string, unknown>>
}

function makeHarness(budgetSource: BudgetSnapshot | (() => BudgetSnapshot), opts?: { fallbackBufferTokens?: number; getWindowGeneration?: () => number }): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  attachReminder(
    { on: (event: string, listener: (...args: unknown[]) => unknown) => { const b = listeners.get(event) ?? []; b.push(listener); listeners.set(event, b) } },
    {
      fallbackBufferTokens: opts?.fallbackBufferTokens ?? 8192,
      getBudget: async (session: object) => (session ? (typeof budgetSource === 'function' ? budgetSource() : budgetSource) : null),
      getWindowGeneration: opts?.getWindowGeneration ?? (() => 0),
      logger,
      pluginName: 'dsh-auto-compact',
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
const budget = (totalTokens: number, contextWindow = 100_000): BudgetSnapshot => ({ totalTokens, contextWindow, remaining: contextWindow - totalTokens, baselineKind: 'estimated' })

describe('attachReminder — tiered budget awareness', () => {
  it('briefs the model on the very first assembled prompt only', async () => {
    const h = makeHarness(budget(0))
    const first = await h.assemble(session)
    expect(String(first.system)).toContain('BASE')
    expect(String(first.system)).toContain('[dsh-auto-compact]')
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
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('[dsh-auto-compact]'))
  })

  it('keeps the prompt intact when the reminder pass throws', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
    attachReminder(
      { on: (e, l) => { const b = listeners.get(e) ?? []; b.push(l); listeners.set(e, b) } },
      { fallbackBufferTokens: 8192, getBudget: async () => { throw new Error('meter exploded') }, getWindowGeneration: () => 0, logger, pluginName: 'dsh-auto-compact' },
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
