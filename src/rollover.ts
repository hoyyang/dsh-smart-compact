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

type CompactionResult = NonNullable<Awaited<ReturnType<BasicCompactionEngine['compactIfNeeded']>>>

export interface RolloverEngineConfig {
  thresholdRatio: number
  fallbackBufferTokens: number
  auto: boolean
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
  /** Called after each successful rollover (ops observability). */
  onRollover?: (info: { generation: number; trigger: string }) => void
  /** Called when a forced rollover cannot run (ops observability for the "never silently swallowed" contract). */
  onRolloverRefused?: (info: { reason: string }) => void
  /** Called when budget measurement fails repeatedly (degraded visibility). */
  onBudgetDegraded?: (consecutiveFailures: number) => void
  /**
   * Notes-presence probe for the handoff anchor (advisory honesty): when it
   * definitively returns false, summarize() stops claiming the notes channel
   * holds the handoff (observed: a manual rollover of a session that never
   * wrote ctx_notes pointed the next window at an empty channel). Absent,
   * throwing, or true = keep the notes-first anchor.
   */
  hasNotes?: (sessionId: string) => Promise<boolean>
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
function openedWindowNumber(generation: number): number {
  return generation + 2
}

const ROLLOVER_TEMPLATE_MARKER = '[smart-compact rollover]'

/**
 * The fixed handoff checkpoint text for one window switch, factored out so the
 * availability probe (src/state.ts) can price the SAME bytes the engine would
 * write: the compaction transaction refuses to run when the framed checkpoint
 * does not price strictly smaller than the shadowed content, so "is a click
 * useful" is a token-mass comparison against exactly this text.
 */
export function handoffCheckpointText(generation: number, notesAssured: boolean): string {
  const notesLine = notesAssured
    ? 'Handoff: current goal, decisions, and next steps live in ctx_notes (read it first).'
    : 'Handoff: no ctx_notes were written in the previous window — there is nothing to read there.'
  const carryLine = notesAssured
    ? "Continue the user's task from the notes; do not assume anything not written there."
    : "Continue the user's task; reconstruct any missing context via ctx_history before assuming it."
  return [
    `${ROLLOVER_TEMPLATE_MARKER} Context window #${openedWindowNumber(generation)} opened.`,
    'The previous window was archived in full — no content was summarized or lost.',
    notesLine,
    'Missing details: ctx_history search/read recalls exact original events on demand.',
    carryLine,
  ].join(' ')
}
/** Consecutive budget-measurement failures before the degraded signal fires. */
const BUDGET_DEGRADED_AFTER = 5

/**
 * Human text for a thrown value of ANY shape. A rejection may be a string,
 * null or a plain object (third-party adapters do this), and reading .message
 * off it would throw from inside the catch handler — breaking the very step
 * loop this code exists to protect.
 */
function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unprintable rejection>'
  }
}

/**
 * One-line incident description with the first non-plugin stack frames. Both
 * path separators are accepted so a Windows-hosted runner still reports frames.
 */
function describeError(error: unknown): string {
  let frames: string[] = []
  try {
    const stack = error instanceof Error ? error.stack ?? '' : ''
    frames = stack.split('\n').slice(1)
      .map((line) => line.trim().replace(/^at\s+/, ''))
      .filter((line) => /[\\/]/.test(line) && !line.includes('dsh-smart-compact/lib/rollover.js'))
      .slice(0, 2)
  } catch { /* reading a stack must never throw either */ }
  const message = messageOf(error)
  return `error: ${message}${frames.length > 0 ? ` @ ${frames.join(' <- ')}` : ''}`
}

export class RolloverCompactionEngine extends BasicCompactionEngine {
  private readonly pending: PendingRollover
  private readonly rolloverCfg: RolloverEngineConfig
  private readonly ownCtx: CtxLike
  private remindedGeneration = new WeakMap<object, number>()
  private warnedGenerationUnavailable = false
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
      if (!this.warnedGenerationUnavailable) {
        this.warnedGenerationUnavailable = true
        this.rolloverCfg.logger.warn(`dsh-smart-compact: window generation unavailable (${messageOf(error)}); grace-band dedup degrades to once per session`)
      }
      return 0
    }
  }

  /**
   * Budget-measurement failure accounting, shared by the pressure band and the
   * forced-rollover pre-flight: an unmeasurable budget is a configuration
   * problem (no contextWindow), NOT a rollover refusal. Counting it here keeps
   * the degraded signal reachable on every path (review P1-A).
   */
  private noteBudgetFailure(agent: { session: object }, error: unknown): void {
    const failures = (this.budgetFailures.get(agent.session) ?? 0) + 1
    this.budgetFailures.set(agent.session, failures)
    const tail = failures >= BUDGET_DEGRADED_AFTER
      ? ' — BUDGET OBSERVABILITY DEGRADED: rollover thresholds are NOT being evaluated; check the model contextWindow config'
      : '; retrying next step'
    this.rolloverCfg.logger.warn(`dsh-smart-compact: budget measurement failed (${failures}x consecutive) (${messageOf(error)})${tail}`)
    if (failures === BUDGET_DEGRADED_AFTER) {
      try {
        this.rolloverCfg.onBudgetDegraded?.(failures)
      } catch { /* observability must never break the loop */ }
    }
  }

  private noticeRefusal(reason: string): void {
    try {
      this.rolloverCfg.onRolloverRefused?.({ reason })
    } catch { /* observability must never break the loop */ }
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
    // Anchor honesty: only promise the notes channel when the probe cannot
    // disprove it. A definitive "no notes" (observed on manual rollovers of
    // sessions that never wrote ctx_notes) must not point the next window at
    // an empty channel — say so and route reconstruction to ctx_history.
    const sessionId = typeof (agent.session as { id?: unknown }).id === 'string' ? (agent.session as { id: string }).id : null
    const notesAssured = sessionId === null || (await this.notesPresent(sessionId))
    const summary: ContentBlock[] = [{ type: 'text', text: handoffCheckpointText(generation, notesAssured) }]
    return {
      summary,
      provider: 'rollover-template',
      model: 'none',
    }
  }

  /** Advisory notes probe — absent probe, probe throw, or true all keep the notes-first anchor. */
  private async notesPresent(sessionId: string): Promise<boolean> {
    if (!this.rolloverCfg.hasNotes) return true
    try {
      return await this.rolloverCfg.hasNotes(sessionId)
    } catch {
      return true
    }
  }

  /**
   * Three-band policy on top of basic's threshold compaction, plus
   * new_context consumption: quiet → grace band (remind once, keep working)
   * → forced rollover. Non-pressure triggers (context-overflow) bypass the
   * bands straight to basic, matching "overflow forces one useful reduction".
   */
  override async compactIfNeeded(agent: AgentLike, trigger: string, signal?: AbortSignal) {
    if (this.pending.has(agent.session)) {
      // A pending request is an explicit instruction, and it is consumed only
      // when a rollover actually commits — otherwise it survives to the next
      // step ("never silently swallowed"). The regular pressure bands can
      // legitimately refuse (e.g. the tool-result pruner already pulled usage
      // below the threshold — observed end-to-end); the overflow path bypasses
      // thresholds (retain = 0) so a forced request really does force. Engine
      // errors must never break the step loop and are surfaced through the
      // ops probe instead (rolloverCount vs lastRolloverRefusedReason).
      // Advisory pre-flight: the base engine measures budget internally, and a
      // measurement failure thrown from there used to bypass the degraded
      // accounting entirely (review P1-A). Counting it here keeps the signal
      // reachable, but never gates the rollover — the base may still commit.
      try {
        await measureBudget(this.ownCtx, agent, signal)
        this.budgetFailures.delete(agent.session)
      } catch (error) {
        if (!signal?.aborted) this.noteBudgetFailure(agent, error)
      }
      let result: CompactionResult | null = null
      try {
        result = await super.compactIfNeeded(agent as never, trigger as never, signal as never)
        if (result === null) {
          result = await super.compactIfNeeded(agent as never, 'context-overflow' as never, signal as never)
        }
      } catch (error) {
        if (signal?.aborted) {
          // The step was cancelled, not refused: the explicit request stays
          // armed for the next step (dropping it here would be exactly the
          // silent swallow this branch exists to prevent) and no ops incident
          // is recorded.
          this.rolloverCfg.logger.info('dsh-smart-compact: forced rollover was aborted with the step — the new_context request stays pending')
          return null
        }
        const reason = describeError(error)
        this.rolloverCfg.logger.warn(`dsh-smart-compact: forced rollover failed — ${reason}`)
        this.noticeRefusal(reason)
        return null
      }
      if (result === null) {
        const reason = 'engine found nothing compactable (selectCompactableRange returned null on both pressure and overflow)'
        this.rolloverCfg.logger.warn(`dsh-smart-compact: forced rollover refused — ${reason}; the new_context request stays pending`)
        this.noticeRefusal(reason)
        return null
      }
      consumeRollover(this.pending, agent.session)
      this.noteRollover(agent, 'new_context')
      return result
    }
    if (trigger === 'pressure') {
      let budget
      try {
        budget = await measureBudget(this.ownCtx, agent, signal)
        this.budgetFailures.delete(agent.session)
      } catch (error) {
        this.noteBudgetFailure(agent, error)
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

  /**
   * Manual /smart-compact path bookkeeping: basic's compactNow runs the
   * compaction transaction directly (selectCompactableRange + compactSurfaceRegion)
   * WITHOUT passing through compactIfNeeded, where every onRollover hook lives —
   * so a successful manual window switch was invisible to the ops probe
   * (rolloverCount stayed 0 forever). Wrap it: bookkeep on success with the
   * 'manual' trigger. A null return ("nothing to switch") or a throw is
   * fail-loud through the command's receipt instead — it is not a rollover
   * and must not inflate rolloverCount.
   */
  override async compactNow(agent: AgentLike, signal?: AbortSignal, sourceCommandId?: string) {
    const result = await super.compactNow(agent as never, signal as never, sourceCommandId as never)
    if (result !== null) this.noteRollover(agent, 'manual')
    return result
  }
}
