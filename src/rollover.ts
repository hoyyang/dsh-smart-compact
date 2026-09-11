/**
 * RolloverCompactionEngine — the Codex-style "hard window switch".
 *
 * Extends the official BasicCompactionEngine and overrides exactly two hooks:
 *  - summarize(): returns a fixed structured handoff template — ZERO model
 *    calls (basic's regionDependencies dispatches to this.summarize).
 *  - compactIfNeeded(): three-band policy — quiet below the threshold, a
 *    wrap-up grace band (write ctx_notes) between threshold and threshold +
 *    fallbackBufferTokens, forced rollover above; plus new_context consumption.
 * Registration (agent/pre-step, agent/request-error) and the whole durable
 * compaction transaction (compaction/start|summary|end, tool-pairing balance)
 * are inherited from basic and dispatch dynamically to these overrides.
 * @module dsh-smart-compact/rollover
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { measureBudget, type AgentLike, type CtxLike } from './budget.js'
import { sessionEvents, type SessionLogLike } from './history.js'
import { consumeRollover, type PendingRollover } from './new-context.js'

export interface RolloverEngineConfig {
  thresholdRatio: number
  fallbackBufferTokens: number
  auto: boolean
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
  /** Called after each successful rollover (ops observability). */
  onRollover?: (info: { generation: number; trigger: string }) => void
  /** Called when budget measurement fails repeatedly (degraded visibility). */
  onBudgetDegraded?: (consecutiveFailures: number) => void
}

interface BasicEngineConfigInput {
  thresholdRatio?: number
  retainRatio?: number
  retainTokens?: number
  auto?: boolean
  [key: string]: unknown
}

/** Number of completed rollovers recorded in a session log (window generation). */
export function windowGeneration(events: ReadonlyArray<{ type: string }> | undefined): number {
  if (!events) return 0
  return events.filter((e) => e.type === 'compaction/summary').length
}

/** Session-window number of the window opened by the next rollover: windows start at #1, so it is generation + 2. */
export function openedWindowNumber(generation: number): number {
  return generation + 2
}

const ROLLOVER_TEMPLATE_MARKER = '[smart-compact rollover]'
/** Consecutive budget-measurement failures before the degraded signal fires. */
const BUDGET_DEGRADED_AFTER = 5

export class RolloverCompactionEngine extends BasicCompactionEngine {
  private readonly pending: PendingRollover
  private readonly rolloverCfg: RolloverEngineConfig
  private readonly ownCtx: CtxLike
  private remindedGeneration = new WeakMap<object, number>()
  private budgetFailures = new WeakMap<object, number>()

  constructor(ctx: CtxLike, config: BasicEngineConfigInput, rolloverCfg: RolloverEngineConfig, pending: PendingRollover) {
    super(ctx as never, config)
    this.ownCtx = ctx
    this.rolloverCfg = rolloverCfg
    this.pending = pending
  }

  /**
   * Log-generation for dedup/observability only: it may never break the
   * compaction path, so an unreadable log degrades to 0 with a warning here.
   * The user-facing paths (tools, summarize) call sessionEvents() directly and
   * fail loud instead.
   */
  private generationOf(agent: { session: SessionLogLike }): number {
    try {
      return windowGeneration(sessionEvents(agent.session))
    } catch (error) {
      this.rolloverCfg.logger.warn(`dsh-smart-compact: window generation unavailable (${(error as Error).message})`)
      return 0
    }
  }

  private noteRollover(agent: { session: SessionLogLike }, trigger: string): void {
    try {
      this.rolloverCfg.onRollover?.({ generation: this.generationOf(agent), trigger })
    } catch { /* observability must never break the compaction path */ }
  }

  /**
   * The sole semantic override: instead of a model-written summary, install a
   * fixed structured handoff as the new window's anchor. Contract honored:
   * the framed checkpoint must price smaller than the shadowed content
   * (enforced loudly by the compaction transaction itself).
   */
  override async summarize(_input: unknown, agent: { session: SessionLogLike }, _signal?: AbortSignal) {
    // Numbering is the session-window index (ctx_history prints the same index
    // for the window it archived), not the rollover ordinal: summarize() runs
    // before this rollover's summary event is committed, so the window it opens
    // is generation + 2.
    const generation = windowGeneration(sessionEvents(agent.session))
    const text = [
      `${ROLLOVER_TEMPLATE_MARKER} Context window #${openedWindowNumber(generation)} opened.`,
      'The previous window was archived in full — no content was summarized or lost.',
      'Handoff: current goal, decisions, and next steps live in ctx_notes (read it first).',
      'Missing details: ctx_history search/read recalls exact original events on demand.',
      "Continue the user's task from the notes; do not assume anything not written there.",
    ].join(' ')
    const summary: ContentBlock[] = [{ type: 'text', text }]
    return {
      summary,
      provider: 'rollover-template',
      model: 'none',
    }
  }

  /**
   * Three-band policy on top of basic's threshold compaction, plus
   * new_context consumption: quiet → grace band (remind once, keep working)
   * → forced rollover. Non-pressure triggers (context-overflow) bypass the
   * bands straight to basic, matching "overflow forces one useful reduction".
   */
  override async compactIfNeeded(agent: AgentLike, trigger: string, signal?: AbortSignal) {
    const forced = consumeRollover(this.pending, agent.session)
    if (forced) {
      this.rolloverCfg.logger.info('dsh-smart-compact: new_context request consumed — forcing rollover before the next step')
      // A pending request is an explicit instruction. The regular pressure
      // bands can legitimately refuse (e.g. the tool-result pruner already
      // pulled usage below the threshold — observed end-to-end) — when that
      // happens, fall back to the overflow path which bypasses thresholds
      // (retain = 0) so an explicit request is never silently swallowed.
      let result = await super.compactIfNeeded(agent as never, trigger as never, signal as never)
      if (result === null) {
        result = await super.compactIfNeeded(agent as never, 'context-overflow' as never, signal as never)
      }
      if (result !== null) this.noteRollover(agent, 'new_context')
      return result
    }
    if (trigger === 'pressure') {
      let budget
      try {
        budget = await measureBudget(this.ownCtx, agent, signal)
        this.budgetFailures.delete(agent.session)
      } catch (error) {
        const failures = (this.budgetFailures.get(agent.session) ?? 0) + 1
        this.budgetFailures.set(agent.session, failures)
        const tail = failures >= BUDGET_DEGRADED_AFTER
          ? ' — BUDGET OBSERVABILITY DEGRADED: rollover thresholds are NOT being evaluated; check the model contextWindow config'
          : '; retrying next step'
        this.rolloverCfg.logger.warn(`dsh-smart-compact: budget measurement failed (${failures}x consecutive) (${(error as Error).message})${tail}`)
        if (failures === BUDGET_DEGRADED_AFTER) {
          try {
            this.rolloverCfg.onBudgetDegraded?.(failures)
          } catch { /* observability must never break the loop */ }
        }
        return null
      }
      const thresholdTokens = budget.contextWindow * this.rolloverCfg.thresholdRatio
      if (budget.totalTokens < thresholdTokens) return null
      const forceAt = thresholdTokens + this.rolloverCfg.fallbackBufferTokens
      if (budget.totalTokens >= forceAt) {
        const result = await super.compactIfNeeded(agent as never, trigger as never, signal as never)
        if (result !== null) this.noteRollover(agent, 'pressure')
        return result
      }
      // Grace band: remind once per window generation, keep working.
      const generation = this.generationOf(agent)
      if (this.remindedGeneration.get(agent.session) !== generation) {
        this.remindedGeneration.set(agent.session, generation)
        this.rolloverCfg.logger.info(
          `dsh-smart-compact: grace band entered (${budget.totalTokens}/${budget.contextWindow} tokens, forced rollover at ${Math.round(forceAt)}) — the model should write ctx_notes now`,
        )
      }
      return null
    }
    const result = await super.compactIfNeeded(agent as never, trigger as never, signal as never)
    if (result !== null) this.noteRollover(agent, trigger)
    return result
  }
}
