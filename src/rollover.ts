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
 * @module dsh-auto-compact/rollover
 */
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { measureBudget, type AgentLike, type CtxLike } from './budget.js'
import { consumeRollover, type PendingRollover } from './new-context.js'

export interface RolloverEngineConfig {
  thresholdRatio: number
  fallbackBufferTokens: number
  auto: boolean
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
}

interface BasicEngineConfigInput {
  thresholdRatio?: number
  retainRatio?: number
  retainTokens?: number
  auto?: boolean
  [key: string]: unknown
}

/** Number of completed rollovers = window generation for this session. */
export function windowGeneration(events: ReadonlyArray<{ type: string }> | undefined): number {
  if (!events) return 0
  return events.filter((e) => e.type === 'compaction/summary').length
}

const ROLLOVER_TEMPLATE_MARKER = '[auto-compact rollover]'

export class RolloverCompactionEngine extends BasicCompactionEngine {
  private readonly pending: PendingRollover
  private readonly rolloverCfg: RolloverEngineConfig
  private readonly ownCtx: CtxLike
  private remindedGeneration = new WeakMap<object, number>()

  constructor(ctx: CtxLike, config: BasicEngineConfigInput, rolloverCfg: RolloverEngineConfig, pending: PendingRollover) {
    super(ctx as never, config)
    this.ownCtx = ctx
    this.rolloverCfg = rolloverCfg
    this.pending = pending
  }

  /**
   * The sole semantic override: instead of a model-written summary, install a
   * fixed structured handoff as the new window's anchor. Contract honored:
   * the framed checkpoint must price smaller than the shadowed content
   * (enforced loudly by the compaction transaction itself).
   */
  override async summarize(_input: unknown, agent: { session: { events?: ReadonlyArray<{ type: string }> } }, _signal?: AbortSignal) {
    const generation = windowGeneration(agent.session.events)
    const text = [
      `${ROLLOVER_TEMPLATE_MARKER} Context window #${generation + 1} opened.`,
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
      this.rolloverCfg.logger.info('dsh-auto-compact: new_context request consumed — forcing rollover before the next step')
      return super.compactIfNeeded(agent as never, trigger as never, signal as never)
    }
    if (trigger === 'pressure') {
      let budget
      try {
        budget = await measureBudget(this.ownCtx, agent, signal)
      } catch (error) {
        this.rolloverCfg.logger.warn(`dsh-auto-compact: budget measurement failed (${(error as Error).message}); skipping the grace-band check this step`)
        return null
      }
      const thresholdTokens = budget.contextWindow * this.rolloverCfg.thresholdRatio
      if (budget.totalTokens < thresholdTokens) return null
      const forceAt = thresholdTokens + this.rolloverCfg.fallbackBufferTokens
      if (budget.totalTokens >= forceAt) {
        return super.compactIfNeeded(agent as never, trigger as never, signal as never)
      }
      // Grace band: remind once per window generation, keep working.
      const generation = windowGeneration(agent.session.events)
      if (this.remindedGeneration.get(agent.session) !== generation) {
        this.remindedGeneration.set(agent.session, generation)
        this.rolloverCfg.logger.info(
          `dsh-auto-compact: grace band entered (${budget.totalTokens}/${budget.contextWindow} tokens, forced rollover at ${Math.round(forceAt)}) — the model should write ctx_notes now`,
        )
      }
      return null
    }
    return super.compactIfNeeded(agent as never, trigger as never, signal as never)
  }
}
