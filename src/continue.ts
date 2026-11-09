/**
 * Zero-output truncation recovery.
 *
 * A reasoning model asked to answer with no completion budget left emits only
 * reasoning tokens and stops with finish_reason=length: the turn ends
 * `max-tokens` with **nothing visible** — no text, no tool call. The host
 * (dsh-goal-round-driver) disarms the goal on that reason and nothing retries
 * the turn, so the session simply stops until a human types "继续".
 *
 * Observed 2026-11-03 on mify-sol/azure_openai/gpt-6.1-sol at ~317k prompt on a
 * 272k window + 128k maxTokens (input + completion > window -> completion
 * clamped to ~16 tokens, three turns in a row, two sessions). After a window
 * switch the same session answered normally, so the state is recoverable
 * mechanically.
 *
 * Policy (one rule, two paths, one cap):
 *   - trigger: turn/end === max-tokens AND the last assistant message carried
 *     neither text nor a tool-call. Anything else is left exactly as the host
 *     already handles it.
 *   - first switch the window when the measurement is already past the usable
 *     wall (zero model calls, lossless), then continue.
 *   - continue through the goal (resume) when one is active-and-disarmed, else
 *     through one injected continuation message — never both.
 *   - give up after maxConsecutiveRecoveries consecutive recoveries for the
 *     same session; a completed turn or a real user message resets the count.
 * @module dsh-smart-compact/continue
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Producer-owned source kind for the continuation message (must not be the literal "plugin"). */
export const CONTINUATION_SOURCE_KIND = 'plugin:dsh-smart-compact'

export interface ContinuationEventLike {
  type: string
  seq?: number
  data?: unknown
}

export interface ContinuationSessionLike {
  id: string
}

/** Structural view of the pieces of Agent this module consumes (no hard peer import). */
export interface ContinuationAgentLike {
  id?: string
  session: ContinuationSessionLike
  status?: string
  whenIdle?: () => Promise<unknown>
  inbox?: { nextTurn?: readonly unknown[] }
  followup?: (message: unknown) => void
}

export interface GoalViewLike {
  id: string
  revision: number
  phase: string
  activation: string
}

export interface GoalsLike {
  get(agent: unknown): GoalViewLike | undefined
  resume(agent: unknown, ref: { id: string; revision: number }): unknown
}

/** What one assistant message actually produced (the only thing the classifier reads). */
export interface AssistantSummary {
  hasText: boolean
  hasToolCall: boolean
}

export type ContinuationAction = 'goal-resume' | 'goal-already-armed' | 'message' | 'skipped'

export interface RecoveryInfo {
  sessionId: string
  action: ContinuationAction
  /** Window number opened by the pre-recovery mechanical switch, when one ran. */
  rollover: number | null
  reason?: string
}

export interface GiveUpInfo {
  sessionId: string
  reason: string
}

export interface ContinuationWatchDeps {
  logger: { info(msg: string): void; warn(msg: string): void }
  /** Cap on consecutive recoveries before the session is left alone. */
  maxConsecutiveRecoveries: number
  /** Live agent registry (ctx.agents). */
  agents: { get(sessionId: string): ContinuationAgentLike | undefined }
  /** Optional goal service probe; absent profile = message path only. */
  goals?: () => GoalsLike | undefined
  /** Current pressure; null/absent when unmeasurable. */
  measure?: (agent: ContinuationAgentLike) => Promise<{ totalTokens: number; usableWindow: number } | null>
  /** Mechanical (zero model call) window switch; returns the new window number or null. */
  rollover?: (agent: ContinuationAgentLike) => Promise<number | null>
  /** Durable flush so the injected message survives a crash. */
  flush?: (agent: ContinuationAgentLike) => Promise<unknown>
  onRecovered?: (info: RecoveryInfo) => void
  onGaveUp?: (info: GiveUpInfo) => void
}

interface SessionState {
  /** Last assistant message content summary of the current turn. */
  lastAssistant: AssistantSummary | null
  /** Consecutive degenerate recoveries (reset by a completed turn / real user message). */
  streak: number
  /** Turn number already handled, so a replayed event never double-recovers. */
  lastHandledTurn: number | null
  /** Whether a real human message was ever seen (subagent/automation guard). */
  human: boolean
  /** Set after the cap was hit; cleared by a completed turn or a real user message. */
  gaveUp: boolean
  lastAction: ContinuationAction | null
  lastRecoverAt: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

/** Classify one assistant message by the block types it actually carried. */
export function summarizeAssistantContent(content: unknown): AssistantSummary {
  const blocks = Array.isArray(content) ? content : []
  let hasText = false
  let hasToolCall = false
  for (const block of blocks) {
    const record = asRecord(block)
    if (record === null) continue
    if (record.type === 'text') {
      const text = typeof record.text === 'string' ? record.text : ''
      if (text.trim() !== '') hasText = true
    } else if (record.type === 'tool-call') {
      hasToolCall = true
    }
  }
  return { hasText, hasToolCall }
}

/**
 * The single trigger condition: an output-budget stop with no visible output.
 * A max-tokens turn that did produce text or a tool call is "unfinished work"
 * and stays entirely with the host's existing policy.
 */
export function isDegenerateTurnEnd(event: ContinuationEventLike, lastAssistant: AssistantSummary | null): boolean {
  if (event.type !== 'turn/end') return false
  const data = asRecord(event.data)
  const reason = asRecord(data?.reason)
  if (reason?.kind !== 'max-tokens') return false
  if (lastAssistant === null) return false
  return !lastAssistant.hasText && !lastAssistant.hasToolCall
}

/** Continuation prompt injected on the message path. */
export function recoveryPrompt(options: { rollover?: number | null } = {}): string {
  const switched = typeof options.rollover === 'number' && options.rollover > 0 ? `，已机械换窗 #${options.rollover}` : ''
  return `[smart-compact 续跑] 上一轮在输出上限处结束且没有产生可见输出（输出预算被夹到几乎为 0）${switched}。直接继续当前任务：结论先写进正文，不要重复前面的推理；需要停下来时明确说明。`
}

/** Build the continuation message (producer-owned source, so session format v4 accepts it). */
export function buildContinuationMessage(prompt: string): unknown {
  return createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: CONTINUATION_SOURCE_KIND, form: 'continuation' },
  } as never)
}

function emptyState(): SessionState {
  return { lastAssistant: null, streak: 0, lastHandledTurn: null, human: false, gaveUp: false, lastAction: null, lastRecoverAt: null }
}

/** Bounded per-session state map (one entry per live session; oldest dropped). */
const MAX_TRACKED_SESSIONS = 32

export class ContinuationWatch {
  private readonly states = new Map<string, SessionState>()
  /** The recovery currently running (awaitable via drain, e.g. before dispose/tests). */
  private inFlight: Promise<void> | null = null

  constructor(private readonly deps: ContinuationWatchDeps) {}

  /** Current state for a session (read-only view for tests/observability). */
  inspect(sessionId: string): Readonly<SessionState> | undefined {
    return this.states.get(sessionId)
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      if (this.states.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.states.keys().next()
        if (!oldest.done) this.states.delete(oldest.value)
      }
      state = emptyState()
      this.states.set(sessionId, state)
    }
    return state
  }

  /**
   * Feed one session event. Synchronous by contract: the host publishes session
   * events without awaiting listeners, and a recovery is started in the
   * background so a slow measurement never stalls the event loop.
   */
  observe(session: ContinuationSessionLike, event: ContinuationEventLike): void {
    if (typeof session?.id !== 'string' || event === null || typeof event.type !== 'string') return
    const state = this.stateOf(session.id)
    const data = asRecord(event.data)
    switch (event.type) {
      case 'turn/start':
        state.lastAssistant = null
        return
      case 'assistant/message': {
        const message = asRecord(data?.message)
        const content = message?.content ?? data?.content
        state.lastAssistant = summarizeAssistantContent(content)
        return
      }
      case 'user/message': {
        const source = asRecord((asRecord(data?.message)?.source) ?? data?.source)
        if (source?.kind === 'user') {
          state.human = true
          state.streak = 0
          state.gaveUp = false
        }
        return
      }
      case 'turn/end': {
        const reason = asRecord(data?.reason)
        if (reason?.kind === 'completed') {
          state.streak = 0
          state.gaveUp = false
          state.lastAssistant = null
          return
        }
        if (!isDegenerateTurnEnd(event, state.lastAssistant)) return
        const turn = typeof data?.turn === 'number' ? data.turn : null
        if (turn !== null && state.lastHandledTurn === turn) return
        if (turn !== null) state.lastHandledTurn = turn
        if (state.gaveUp) return
        if (!state.human) {
          this.deps.logger.info(`dsh-smart-compact: degenerate turn in ${session.id} ignored — no human message in this session (subagent/automation)`)
          return
        }
        if (state.streak >= this.deps.maxConsecutiveRecoveries) {
          state.gaveUp = true
          this.giveUp(session.id, `${state.streak} consecutive recoveries did not produce visible output`)
          return
        }
        state.streak += 1
        state.lastRecoverAt = new Date().toISOString()
        const task = this.recover(session.id, state).catch((error: unknown) => {
          this.deps.logger.warn(`dsh-smart-compact: continuation recovery failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        })
        this.inFlight = task
        void task
        return
      }
      default:
        return
    }
  }

  /** Wait for the in-flight recovery (tests, and a graceful dispose). */
  async drain(): Promise<void> {
    const current = this.inFlight
    if (current !== null) await current
  }

  private async recover(sessionId: string, state: SessionState): Promise<void> {
    const agent = this.deps.agents.get(sessionId)
    if (agent === undefined || agent.session?.id !== sessionId) return
    // Never race a live turn: the driver publishes turn/end before it parks.
    try {
      if (agent.status !== 'idle' && typeof agent.whenIdle === 'function') await agent.whenIdle()
    } catch { /* best effort */ }
    if (agent.status !== undefined && agent.status !== 'idle') {
      this.record(sessionId, state, 'skipped', null, 'agent did not become idle')
      return
    }

    let rollover: number | null = null
    if (this.deps.rollover !== undefined) {
      try {
        const budget = this.deps.measure === undefined ? null : await this.deps.measure(agent)
        // A degenerate turn is itself proof that the output budget was
        // exhausted, so this switch must not be vetoed by a measurement that
        // says otherwise. The 2026-11-05 azure failure did exactly that: a stale
        // routed target reported 407k of 616k usable while the real 272k route
        // had already clamped the completion to 16 tokens, so the only working
        // recovery was skipped and the turn ended with nothing visible. The
        // switch is zero-model and lossless; half the usable band is the most
        // conservative point where "died at the output cap" and "the window is
        // actually full" cannot be told apart. A null/absent measurement also
        // switches (unknown is not evidence of room).
        const exhausted = budget === null || budget.totalTokens >= budget.usableWindow * 0.5
        if (exhausted) {
          rollover = await this.deps.rollover(agent)
          this.deps.logger.info(`dsh-smart-compact: mechanical window switch before continuing ${sessionId} (window #${rollover ?? 'unchanged'}${budget === null ? ', measurement unavailable' : `, measured ${budget.totalTokens}/${budget.usableWindow} usable`})`)
        }
      } catch (error) {
        this.deps.logger.warn(`dsh-smart-compact: pre-continuation window switch failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const goal = this.readGoal(agent)
    if (goal.kind === 'disarmed') {
      try {
        this.deps.goals?.()?.resume(agent, { id: goal.id, revision: goal.revision })
        this.record(sessionId, state, 'goal-resume', rollover)
        return
      } catch (error) {
        this.giveUp(sessionId, `goal resume rejected: ${error instanceof Error ? error.message : String(error)}`)
        state.gaveUp = true
        return
      }
    }
    if (goal.kind === 'armed') {
      // The host already re-armed it and is driving the next round itself.
      this.record(sessionId, state, 'goal-already-armed', rollover)
      return
    }
    if (goal.kind === 'paused') {
      // A human paused/completed the goal: the goal is not ours to restart.
      this.record(sessionId, state, 'skipped', rollover, 'goal is paused or complete (human decision)')
      return
    }
    const queued = agent.inbox?.nextTurn?.length ?? 0
    if (queued > 0) {
      this.record(sessionId, state, 'skipped', rollover, `${queued} message(s) already queued`)
      return
    }
    if (typeof agent.followup !== 'function') {
      this.giveUp(sessionId, 'agent has no followup() to continue through')
      state.gaveUp = true
      return
    }
    const message = buildContinuationMessage(recoveryPrompt({ rollover }))
    agent.followup(message)
    if (this.deps.flush !== undefined) {
      try { await this.deps.flush(agent) } catch { /* durability is best effort; the message is already queued */ }
    }
    this.record(sessionId, state, 'message', rollover)
  }

  private readGoal(agent: ContinuationAgentLike): { kind: 'none' | 'armed' | 'paused' } | { kind: 'disarmed'; id: string; revision: number } {
    let service: GoalsLike | undefined
    try {
      service = this.deps.goals?.()
    } catch {
      service = undefined
    }
    if (service === undefined) return { kind: 'none' }
    let view: GoalViewLike | undefined
    try {
      view = service.get(agent)
    } catch {
      return { kind: 'none' }
    }
    if (view === undefined) return { kind: 'none' }
    if (view.phase !== 'active') return { kind: 'paused' }
    if (view.activation === 'armed') return { kind: 'armed' }
    return { kind: 'disarmed', id: view.id, revision: view.revision }
  }

  private record(sessionId: string, state: SessionState, action: ContinuationAction, rollover: number | null, reason?: string): void {
    state.lastAction = action
    state.lastRecoverAt = new Date().toISOString()
    this.deps.logger.info(`dsh-smart-compact: continuation ${action} for ${sessionId}${rollover === null ? '' : ` after window #${rollover}`}${reason === undefined ? '' : ` (${reason})`}`)
    try {
      this.deps.onRecovered?.({ sessionId, action, rollover, ...(reason === undefined ? {} : { reason }) })
    } catch { /* observability must never break the recovery */ }
  }

  private giveUp(sessionId: string, reason: string): void {
    this.deps.logger.warn(`dsh-smart-compact: continuation gave up for ${sessionId} — ${reason}`)
    try {
      this.deps.onGaveUp?.({ sessionId, reason })
    } catch { /* observability must never break the recovery */ }
  }
}
