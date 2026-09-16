/**
 * Budget awareness: Codex-style tiered reminders injected through the
 * system-prompt waterfall, plus a standing one-time tool briefing.
 *
 * Three layers (each fires at most once per session per tier, tracked in
 * fiber-local WeakMaps — dispose drops all state):
 *   1. briefing  — injected on the first assembled prompt: tells the model
 *                  the mechanism exists at all (the携程-session gap: without
 *                  it the model never touches the tools).
 *   2. tiers     — at 25% / 50% / 75% context consumption, a short nudge.
 *   3. grace     — the engine's wrap-up band (consumption at/above
 *                  thresholdRatio, or remaining <= fallbackBufferTokens as a
 *                  belt-and-braces floor): write handoff notes now. Firing at
 *                  the threshold — not only when almost nothing is left — is
 *                  what makes the nudge arrive while there is still room to
 *                  act on it.
 * @module dsh-smart-compact/reminder
 */
import type { BudgetSnapshot } from './budget.js'

interface AssembledLike {
  system?: string
  developer?: string
  [key: string]: unknown
}

/** One reminder-pass outcome, surfaced into engine-state by the host wiring. */
export type ReminderObservation =
  | { kind: 'briefed' }
  | { kind: 'tier'; label: string }
  | { kind: 'grace' }
  | { kind: 'no-budget' }
  | { kind: 'pass-failed'; reason: string }

export interface ReminderDeps {
  /** Grace-band width in tokens; belt-and-braces floor for the grace reminder. */
  fallbackBufferTokens: number
  /**
   * The engine's grace-band entry (rollover.ts three-band policy): once
   * consumption reaches this fraction the next rollover is near, so the
   * write-notes nudge must fire NOW — a reminder that waits until only a few
   * thousand tokens remain arrives when there is no room left to act on it
   * (the engine's own log-only grace line had exactly that late-firing gap).
   */
  thresholdRatio: number
  /** Live budget, or null when the model/window is unknown. */
  getBudget(session: object): Promise<BudgetSnapshot | null>
  /** Current window generation (number of completed rollovers). */
  getWindowGeneration(session: object): number
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
  pluginName: string
  /**
   * Optional observability sink: every reminder-pass outcome lands here so
   * engine-state can show whether nudges actually reach the model. The
   * 2026-09-16 billing-session incident (a hot session fell through to the
   * host's LLM summarizer with zero reminders ever delivered) was invisible
   * precisely because this pass had no counters.
   */
  onObservation?: (observation: ReminderObservation) => void
}

/** Consumption tiers as fractions of the context window (Codex-style). */
export const TIERS: ReadonlyArray<{ fraction: number; label: string }> = [
  { fraction: 0.25, label: '25%' },
  { fraction: 0.5, label: '50%' },
  { fraction: 0.75, label: '75%' },
]

export const BRIEFING = `[dsh-smart-compact] This session runs Codex-style context window management:
- get_context_remaining: check your remaining context budget any time.
- ctx_notes: your working notes (goal / decisions / next steps / where details live). Write here BEFORE context pressure hits — notes survive rollover.
- ctx_history: after a rollover, recall exact original events (list windows, read seqs, search).
- new_context: you may request a fresh window when the current one is no longer useful.
Archive is lossless: nothing summarized away is ever lost.`

export function tierNudge(usedFraction: number, label: string): string {
  return `[dsh-smart-compact] Context consumption reached ${label} (${Math.round(usedFraction * 100)}% used). If key constraints and next steps are not in ctx_notes yet, write them now — a fresh window opens near the top of the range.`
}

export function graceNudge(remaining: number): string {
  return `[dsh-smart-compact] LOW CONTEXT (${remaining} tokens remaining). Write your handoff state into ctx_notes NOW — goal, decisions, next steps, and where details live — before the automatic rollover.`
}

/**
 * Register the reminder on the system-prompt waterfall. All state is
 * fiber-local (WeakMaps keyed by session), so unload drops everything and
 * each session tracks its own tier progress independently.
 */
export function attachReminder(
  ctx: { on(event: string, listener: (...args: unknown[]) => unknown): void },
  deps: ReminderDeps,
): void {
  let warnedNoField = false
  const briefed = new WeakSet<object>()
  const tiersDone = new WeakMap<object, Set<string>>()
  const graceDone = new WeakMap<object, number>()
  const noBudgetSeen = new WeakSet<object>()
  const observe = (observation: ReminderObservation): void => {
    try {
      deps.onObservation?.(observation)
    } catch {
      // Observability must never break the reminder pass.
    }
  }

  const appendTo = (assembled: AssembledLike, text: string): AssembledLike | null => {
    if (typeof assembled?.system === 'string') return { ...assembled, system: `${assembled.system}\n\n${text}` }
    if (typeof assembled?.developer === 'string') return { ...assembled, developer: `${assembled.developer}\n\n${text}` }
    return null
  }

  ctx.on('system-prompt/assemble', async (...args: unknown[]) => {
    const next = args[args.length - 1] as () => Promise<AssembledLike>
    const assembled = await next()
    try {
      const context = (args.length >= 2 ? args[args.length - 2] : undefined) as { agent?: { session?: object } } | undefined
      const session = context?.agent?.session
      if (!session) return assembled

      const budget = await deps.getBudget(session)
      if (!budget || budget.contextWindow <= 0) {
        if (!noBudgetSeen.has(session)) {
          noBudgetSeen.add(session)
          observe({ kind: 'no-budget' })
        }
        return assembled
      }
      const usedFraction = 1 - budget.remaining / budget.contextWindow

      const pieces: string[] = []
      if (!briefed.has(session)) {
        briefed.add(session)
        pieces.push(BRIEFING)
        observe({ kind: 'briefed' })
      }
      const done = tiersDone.get(session) ?? new Set<string>()
      for (const tier of TIERS) {
        if (usedFraction >= tier.fraction && !done.has(tier.label)) {
          done.add(tier.label)
          pieces.push(tierNudge(usedFraction, tier.label))
          observe({ kind: 'tier', label: tier.label })
        }
      }
      tiersDone.set(session, done)
      if (budget.remaining <= deps.fallbackBufferTokens || usedFraction >= deps.thresholdRatio) {
        // Isolate the generation probe: a host that cannot count windows must
        // not take the briefing and the tier nudges down with it (they share
        // this try block). Degraded = the grace nudge fires once, with a warn.
        let generation = 0
        try {
          generation = deps.getWindowGeneration(session)
        } catch (error) {
          deps.logger.warn(`[${deps.pluginName}] window-generation probe failed: ${(error as Error).message}; grace nudge will not repeat this session`)
        }
        if (graceDone.get(session) !== generation) {
          graceDone.set(session, generation)
          pieces.push(graceNudge(budget.remaining))
          observe({ kind: 'grace' })
        }
      }
      if (pieces.length === 0) return assembled

      const text = pieces.join('\n\n')
      const patched = appendTo(assembled, text)
      if (patched) return patched
      if (!warnedNoField) {
        warnedNoField = true
        deps.logger.warn(`[${deps.pluginName}] reminder could not find a system/developer field on the assembled prompt; falling back to log-only reminders`)
      }
      deps.logger.info(text)
      return assembled
    } catch (error) {
      observe({ kind: 'pass-failed', reason: (error as Error).message ?? String(error) })
      deps.logger.warn(`[${deps.pluginName}] reminder pass failed: ${(error as Error).message}; continuing with the unmodified prompt`)
      return assembled
    }
  })
}
