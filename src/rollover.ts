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
import { eventText, sessionEvents, type SessionEventLike, type SessionLogLike } from './history.js'
import { consumeRollover, type PendingRollover } from './new-context.js'
import { redactText } from './redact.js'

type CompactionResult = NonNullable<Awaited<ReturnType<BasicCompactionEngine['compactIfNeeded']>>>

export interface RolloverEngineConfig {
  thresholdRatio: number
  /** Per-provider threshold resolver; absent = thresholdRatio for every provider. */
  thresholdFor?: (provider: string) => number
  fallbackBufferTokens: number
  /**
   * Anti-churn floor in tokens: an automatic switch is refused until at least
   * this many tokens were added since the previous switch. Absent/0 = no guard.
   */
  minAddedTokens?: number
  auto: boolean
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
  /** Called after each successful rollover (ops observability). */
  onRollover?: (info: { generation: number; trigger: string }) => void
  /** Called when a forced rollover cannot run (ops observability for the "never silently swallowed" contract). */
  onRolloverRefused?: (info: { reason: string; sessionId: string }) => void
  /** Called when budget measurement fails repeatedly (degraded visibility). */
  onBudgetDegraded?: (consecutiveFailures: number) => void
  /** Observability: every automatic-band threshold evaluation, with the measured numbers. */
  onEvaluate?: (info: { trigger: string; sessionId: string; provider: string; model?: string; totalTokens: number; contextWindow: number; thresholdTokens: number; completionReserve: number; usableWindow: number }) => void
  /** Observability: the automatic band declined to switch, with the reason. */
  onSkip?: (info: { trigger: string; sessionId: string; provider: string; model?: string; reason: string; totalTokens: number; contextWindow: number; thresholdTokens: number; completionReserve: number; usableWindow: number }) => void
  /**
   * Observability: a compaction this engine did not author was committed in the
   * session (the official summary engine won the race). Never silent — that is
   * exactly the "is it even working?" blind spot this hook exists to close.
   */
  onForeignCompaction?: (info: { count: number; at: number | null; snippet: string }) => void
  /**
   * Notes-presence probe for the handoff anchor (advisory honesty): when it
   * definitively returns false, summarize() stops claiming the notes channel
   * holds the handoff (observed: a manual rollover of a session that never
   * wrote ctx_notes pointed the next window at an empty channel). Absent,
   * throwing, or true = keep the notes-first anchor.
   */
  hasNotes?: (sessionId: string) => Promise<boolean>
  /**
   * Epoch ms of the newest notes write (in-band segment stamp), or null when
   * absent/unparseable. Feeds the stale-notes gate: when timestamped window
   * activity postdates the notes, summarize() stops vouching for them and says
   * so loudly. Absent, throwing, or null = freshness unknown = classic anchor.
   */
  lastNoteWrittenAt?: (sessionId: string) => Promise<number | null>
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

/** First text block of a compaction/summary event, or '' when the shape is unknown. */
function summaryTextOf(event: SessionEventLike): string {
  const data = event.data as { summary?: readonly { type?: string; text?: string }[] } | undefined
  const first = data?.summary?.[0]
  return typeof first?.text === 'string' ? first.text : ''
}

/** Hard char cap for each derived orientation line (the probe prices this worst case). */
export const HANDOFF_LINE_MAX = 80

/**
 * Mechanically derived task orientation for the handoff anchor. The anchor
 * used to be task-blind: continuation succeeded only when the cut happened to
 * land after the task finished (observed on 2026-09-16 — the next
 * window had to guess what the session was even about). Both lines are pure
 * projections of the durable log, so they cost zero model calls.
 */
export interface HandoffContext {
  /** Session task, from the latest session/title event. */
  task: string
  /** The last thing that happened, from the newest content event (first line only). */
  last: string
  /** Optional mechanical tail of tool activity after the last notes write (stale-notes anchor only). */
  recent?: string
}

/** Hard char cap for one recent-activity entry (tool name + clock, ASCII). */
export const ACTIVITY_ENTRY_MAX = 32
/** Max entries in the mechanical recent-activity tail. */
export const RECENT_ACTIVITY_MAX = 3

/**
 * Mechanical freshness verdict for the handoff notes (zero model calls).
 * Incident 2026-09-29: the anchor told the next window to trust ctx_notes
 * while the notes predated the session's latest work (the actual commit, the
 * STATE persist) by ~27 hours — presence was checked, freshness never was.
 */
export interface NotesFreshness {
  /** True when verifiable window activity happened after the last notes write. */
  stale: boolean
  /** Content events with a verified later timestamp than the last notes write. */
  eventsAfter: number
  /** Newest timestamped content-event time (ms), when any exist. */
  lastActivityAtMs: number | null
}

/**
 * Compare the last notes write against the durable log. Any timestamped
 * content event strictly after the note makes the notes stale. Events without
 * a timestamp stop the tail scan: they cannot prove staleness, and the anchor
 * must never claim a verdict it cannot prove (same honesty contract as
 * notesPresent — a probe of any shape degrades, it never invents).
 */
export function deriveNotesFreshness(events: ReadonlyArray<SessionEventLike>, lastNoteWrittenAtMs: number | null): NotesFreshness {
  let eventsAfter = 0
  let lastActivityAtMs: number | null = null
  try {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (typeof event.time !== 'number' || !Number.isFinite(event.time)) break
      const text = isContentEvent(event.type) ? eventText(event) : ''
      if (text.trim() === '') continue
      if (lastActivityAtMs === null) lastActivityAtMs = event.time
      if (lastNoteWrittenAtMs !== null && event.time > lastNoteWrittenAtMs) eventsAfter += 1
    }
  } catch { /* freshness is best-effort by contract */ }
  return { stale: lastNoteWrittenAtMs !== null && eventsAfter > 0, eventsAfter, lastActivityAtMs }
}

/**
 * Mechanically list the newest tool invocations after a point in time, for the
 * stale-notes anchor: even when the model skipped the notes, the next window
 * must SEE that work happened after they were written. Tool names and times
 * only — never arguments or results, which can carry user content.
 */
export function deriveRecentActivity(events: ReadonlyArray<SessionEventLike>, afterMs: number | null, max: number = RECENT_ACTIVITY_MAX): string {
  if (afterMs === null) return ''
  const entries: string[] = []
  try {
    for (let index = events.length - 1; index >= 0 && entries.length < max; index -= 1) {
      const event = events[index]!
      if (typeof event.time !== 'number' || !Number.isFinite(event.time) || event.time <= afterMs) continue
      if (event.type !== 'tool/call' && event.type !== 'tool/ptc-dispatch') continue
      const name = (event.data as { name?: unknown } | null | undefined)?.name
      if (typeof name !== 'string' || name.trim() === '') continue
      entries.push(`${firstLineOf(name, ACTIVITY_ENTRY_MAX)}@${new Date(event.time).toISOString().slice(11, 16)}`)
    }
  } catch { /* orientation is best-effort by contract */ }
  return entries.reverse().join(', ')
}

function firstLineOf(text: string, width: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  const clean = line.trim()
  return clean.length > width ? `${clean.slice(0, width)}…` : clean
}

/** Event-type prefixes that never carry conversation content. */
const NON_CONTENT_PREFIXES = ['compaction/', 'session/', 'request/', 'step/', 'turn/', 'agent/', 'model/', 'sandbox/', 'approval/', 'permission/']

function isContentEvent(type: string): boolean {
  return !NON_CONTENT_PREFIXES.some((prefix) => type.startsWith(prefix)) && type !== 'system/message'
}

/**
 * Derive the two orientation lines from the durable log. Never throws: a
 * probe of any shape degrades to an omitted line, and the anchor stays valid
 * without them (the probe's worst-case pricing covers both line counts).
 */
export function deriveHandoffContext(events: ReadonlyArray<SessionEventLike>): HandoffContext {
  let task = ''
  let last = ''
  try {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!
      if (task === '' && event.type === 'session/title') {
        const title = (event.data as { title?: unknown } | null | undefined)?.title
        if (typeof title === 'string' && title.trim() !== '') task = firstLineOf(title, HANDOFF_LINE_MAX)
      }
      if (last === '' && isContentEvent(event.type)) {
        const text = eventText(event)
        if (text.trim() !== '') last = firstLineOf(text, HANDOFF_LINE_MAX)
      }
      if (task !== '' && last !== '') break
    }
  } catch { /* orientation is best-effort by contract */ }
  return { task, last }
}

export interface HandoffStaleness {
  stale: boolean
  eventsAfter: number
  lastWriteAtMs: number
}

/** UTC clock stamp used in stale-notes lines ("YYYY-MM-DD HH:MM UTC"). */
function utcStamp(ms: number): string {
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' } catch { return '<unknown time>' }
}

/**
 * The handoff checkpoint text for one window switch, factored out so the
 * availability probe (src/state.ts) can price the SAME shape the engine would
 * write: the compaction transaction refuses to run when the framed checkpoint
 * does not price strictly smaller than the shadowed content, so "is a click
 * useful" is a token-mass comparison against exactly this template.
 */
export function buildHandoffCheckpoint(generation: number, notesAssured: boolean, context?: HandoffContext, staleness?: HandoffStaleness): string {
  // Stale-notes gate: a notes channel that exists but
  // predates the window's latest work must not be vouched for. The anchor
  // downgrades from "read it first / assume nothing beyond it" to an explicit
  // staleness warning that routes verification through ctx_history. Fresh or
  // unknown freshness keeps the classic wording verbatim.
  const stale = staleness?.stale === true
  const stamp = stale && staleness ? utcStamp(staleness.lastWriteAtMs) : ''
  const notesLine = !notesAssured
    ? 'Handoff: this session has no ctx_notes yet — there is nothing to read there.'
    : stale
      ? `⚠️ Handoff notes are STALE: last ctx_notes write ${stamp}; ${staleness!.eventsAfter} activity event(s) happened after that in the archived window.`
      : 'Handoff: current goal, decisions, and next steps live in ctx_notes (read it first).'
  const carryLine = !notesAssured
    ? "Continue the user's task; reconstruct missing context via ctx_history (and any persisted project memory) before assuming it."
    : stale
      ? `Do NOT treat the notes as current: reconcile with ctx_history search/read (and git / project memory) before continuing; the notes cover only up to ${stamp}.`
      : "Continue the user's task from the notes; do not assume anything not written there."
  return [
    `${ROLLOVER_TEMPLATE_MARKER} Context window #${openedWindowNumber(generation)} opened.`,
    'The previous window was archived in full — nothing was summarized away or lost.',
    // Retain-last semantics of the base engine: the range always ends one
    // surface node short, so the newest message is never shadowed (documented
    // in src/state.ts and observed live). Saying so prevents the next window
    // from mis-reconstructing a "lost final reply" out of the sparse archive
    // range (observed on the same ISS audit).
    'The newest exchange remains visible in this window; the archive covers everything older (nothing was dropped).',
    ...(context?.task ? [`Task: ${context.task}`] : []),
    ...(context?.last ? [`Last action: ${context.last}`] : []),
    ...(stale && context?.recent ? [`Mechanical activity after the last note: ${context.recent}.`] : []),
    notesLine,
    'Missing details: ctx_history search/read recalls exact original events on demand.',
    carryLine,
  ].join(' ')
}

/** The static (no derived context) variant; kept for compatibility and tests. */
export function handoffCheckpointText(generation: number, notesAssured: boolean): string {
  return buildHandoffCheckpoint(generation, notesAssured)
}

/**
 * The longest template the engine can ever frame: late window number, both
 * orientation lines at their hard caps, STALE-notes wording, and a full
 * recent-activity tail of maxed entries. The availability probe prices THIS,
 * so its comparison always errs toward "inert" regardless of what the real
 * anchor ends up carrying (stale variant included).
 */
export function handoffCheckpointWorstCaseText(): string {
  // CJK filler: per-char tokenization is the heavy end for this plugin's
  // content — an ASCII filler would merge into fewer tokens and could
  // underprice a real 80-char Chinese line.
  const filler = '汉'.repeat(HANDOFF_LINE_MAX)
  // Tool names are ASCII; one char ≈ one token is the honest heavy end there.
  const tailEntry = 'o'.repeat(ACTIVITY_ENTRY_MAX)
  const recent = Array.from({ length: RECENT_ACTIVITY_MAX }, () => tailEntry).join(', ')
  return buildHandoffCheckpoint(98, true, { task: filler, last: filler, recent }, { stale: true, eventsAfter: 99999, lastWriteAtMs: 0 })
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
  /** Last generation whose anti-churn skip was logged (a skip is otherwise silent). */
  private debouncedGeneration = new WeakMap<object, number>()
  private warnedGenerationUnavailable = false
  private budgetFailures = new WeakMap<object, number>()
  /** Measured surface size right after the last switch (anti-churn baseline). */
  private postRolloverTotals = new WeakMap<object, number>()
  /** Compactions not authored by this engine already reported (dedup). */
  private foreignSeen = new WeakMap<object, number>()
  /** Sessions whose pre-existing history was adopted as the foreign baseline. */
  private foreignBaseline = new WeakSet<object>()

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

  private noticeRefusal(reason: string, sessionId: string): void {
    try {
      this.rolloverCfg.onRolloverRefused?.({ reason, sessionId })
    } catch { /* observability must never break the loop */ }
  }

  private noteRollover(agent: { session: SessionLogLike }, trigger: string): void {
    try {
      this.rolloverCfg.onRollover?.({ generation: this.generationOf(agent), trigger })
    } catch { /* observability must never break the compaction path */ }
  }

  /** Record the post-switch surface size so the next automatic switch must add real content. */
  private rememberPostRollover(agent: { session: object }, preTotalTokens: number, result: { shadowedTokenCount?: number } | null): void {
    const shadowed = typeof result?.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0
    this.postRolloverTotals.set(agent.session, Math.max(0, preTotalTokens - shadowed))
  }

  /**
   * Report compactions this engine did not author. The official
   * dsh-compaction-basic (or a host engine) can win a pre-step race; without
   * this probe the loss is invisible and the plugin looks broken/harmless.
   * The first call adopts the session's existing history as the baseline, so a
   * resumed session never reports older windows as foreign.
   */
  noticeForeignCompactions(agent: { session: SessionLogLike }): void {
    let events: readonly SessionEventLike[]
    try {
      events = sessionEvents(agent.session)
    } catch {
      return
    }
    // Our own handoffs are self-identifying (the template marker), so a summary
    // without it is, by construction, authored by another engine.
    let foreign = 0
    for (const event of events) {
      if (event.type !== 'compaction/summary') continue
      if (!summaryTextOf(event).startsWith(ROLLOVER_TEMPLATE_MARKER)) foreign += 1
    }
    if (!this.foreignBaseline.has(agent.session)) {
      this.foreignBaseline.add(agent.session)
      this.foreignSeen.set(agent.session, foreign)
      return
    }
    const seen = this.foreignSeen.get(agent.session) ?? 0
    if (foreign <= seen) return
    this.foreignSeen.set(agent.session, foreign)
    let snippet = ''
    let at: number | null = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'compaction/summary') continue
      const text = summaryTextOf(event)
      if (text.startsWith(ROLLOVER_TEMPLATE_MARKER)) continue
      snippet = text.slice(0, 160)
      at = typeof event.time === 'number' ? event.time : null
      break
    }
    try {
      this.rolloverCfg.onForeignCompaction?.({ count: foreign, at, snippet })
    } catch { /* observability must never break the step loop */ }
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
    const events = sessionEvents(agent.session)
    const generation = windowGeneration(events)
    // Anchor honesty: only promise the notes channel when the probe cannot
    // disprove it. A definitive "no notes" (observed on manual rollovers of
    // sessions that never wrote ctx_notes) must not point the next window at
    // an empty channel — say so and route reconstruction to ctx_history.
    const sessionId = typeof (agent.session as { id?: unknown }).id === 'string' ? (agent.session as { id: string }).id : null
    const notesAssured = sessionId === null || (await this.notesPresent(sessionId))
    // Stale-notes gate: freshness is mechanical (segment stamp vs event time).
    // Any probe hiccup degrades to null = freshness unknown = classic anchor.
    let lastNoteAtMs: number | null = null
    if (notesAssured && sessionId !== null && typeof this.rolloverCfg.lastNoteWrittenAt === 'function') {
      try { lastNoteAtMs = await this.rolloverCfg.lastNoteWrittenAt(sessionId) } catch { lastNoteAtMs = null }
    }
    const freshness = deriveNotesFreshness(events, lastNoteAtMs)
    // Task orientation lines are mechanical (zero model calls) and hard-capped;
    // the availability probe prices their worst case, so the size invariant of
    // the compaction transaction is never surprised by them.
    const context = deriveHandoffContext(events)
    // The activity tail exists ONLY to expose post-note work when the notes
    // are stale (tool names + clocks — no arguments, no results). Sanitized
    // like every authored surface, and priced by the worst-case template.
    const recent = freshness.stale ? redactText(deriveRecentActivity(events, lastNoteAtMs)) : null
    // Mandatory sanitization (v0.5.0): the anchors are engine-authored and must
    // never carry personal/company information into the new window. The
    // verbatim archive stays untouched — authored surfaces only. Logs carry
    // counts and labels, never the matched content.
    const task = redactText(context.task)
    const last = redactText(context.last)
    const redactionCount = task.redactions + last.redactions + (recent?.redactions ?? 0)
    if (redactionCount > 0) {
      this.rolloverCfg.logger.info(`dsh-smart-compact: handoff anchors sanitized — ${redactionCount} redaction(s) [${[...new Set([...task.labels, ...last.labels, ...(recent?.labels ?? [])])].join(', ')}]`)
    }
    const staleness = freshness.stale && lastNoteAtMs !== null
      ? { stale: true, eventsAfter: freshness.eventsAfter, lastWriteAtMs: lastNoteAtMs }
      : undefined
    const summary: ContentBlock[] = [{ type: 'text', text: buildHandoffCheckpoint(generation, notesAssured, { task: task.text, last: last.text, ...(recent ? { recent: recent.text } : {}) }, staleness) }]
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
        this.noticeRefusal(reason, agent.session.id)
        return null
      }
      if (result === null) {
        const reason = 'engine found nothing compactable (selectCompactableRange returned null on both pressure and overflow)'
        this.rolloverCfg.logger.warn(`dsh-smart-compact: forced rollover refused — ${reason}; the new_context request stays pending`)
        this.noticeRefusal(reason, agent.session.id)
        return null
      }
      consumeRollover(this.pending, agent.session)
      try {
        const budget = await measureBudget(this.ownCtx, agent, signal)
        this.postRolloverTotals.set(agent.session, budget.totalTokens)
      } catch { /* best effort: the guard degrades to 0 baseline */ }
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
      const ratio = this.rolloverCfg.thresholdFor?.(budget.provider) ?? this.rolloverCfg.thresholdRatio
      // The provider budget is an EQUATION: input + requested completion must fit
      // the window (dsh handbook: 664,728 messages + 384,000 completion = 1,048,728
      // > 1,048,576 -> 400). With a large max_tokens the usable input ceiling sits
      // far below ratio*window, so a pure percentage threshold can wait past the
      // wall: observed 2026-10-26, a 1M-window session was rejected at ~665k while
      // 0.75 waited for 750k — the automatic switch could never fire and every
      // retry failed with 400 INVALID_REQUEST until a manual rollover.
      const completionReserve = budget.completionReserve ?? 0
      const usableWall = Math.max(1, budget.contextWindow - completionReserve)
      const thresholdTokens = Math.min(
        budget.contextWindow * ratio,
        Math.max(1, usableWall - this.rolloverCfg.fallbackBufferTokens),
      )
      // Every evaluation is observable: "is the auto band even looking?" must be
      // answerable from engine-state alone (the 2026-10 invisible-loss incident).
      const measured = { trigger, sessionId: agent.session.id, provider: budget.provider, ...(budget.model === undefined ? {} : { model: budget.model }), totalTokens: budget.totalTokens, contextWindow: budget.contextWindow, thresholdTokens, completionReserve, usableWindow: usableWall }
      if (budget.totalTokens < thresholdTokens) {
        this.rolloverCfg.onSkip?.({ ...measured, reason: 'below threshold' })
        return null
      }
      // Anti-churn: refusing a switch that would land where the previous one did
      // (small windows carry a fixed base near the threshold) — and after a
      // manual switch the baseline is refreshed so auto never immediately re-fires.
      const baseline = this.postRolloverTotals.get(agent.session) ?? 0
      const addedTokens = budget.totalTokens - baseline
      const configuredMinAdded = this.rolloverCfg.minAddedTokens ?? 0
      // Cap the anti-churn floor to the band that actually remains below the
      // wall. After a switch the baseline is the retained tail (tens of k on a
      // PTC session), and an absolute 100k floor then demands more input than
      // the provider accepts: 272k window - 128k completion = 144k usable,
      // baseline ~50k + 100k = 150k > 144k, so the guard could never unlock and
      // the turn died at the wall instead of switching before it. Only applies
      // once a real post-switch baseline exists (first evaluation: unchanged).
      const minAdded = configuredMinAdded > 0 && baseline > 0
        ? Math.min(configuredMinAdded, Math.max(0, usableWall - baseline - this.rolloverCfg.fallbackBufferTokens))
        : configuredMinAdded
      try { this.rolloverCfg.onEvaluate?.(measured) } catch { /* observability must never break the loop */ }
      if (minAdded > 0 && addedTokens < minAdded) {
        // Silence here cost a whole diagnosis session (2026-11-03): the session
        // sat above the threshold for 40 steps and the only trace was a state
        // slot another session overwrote. Log it once per window generation.
        const generation = this.generationOf(agent)
        if (this.debouncedGeneration.get(agent.session) !== generation) {
          this.debouncedGeneration.set(agent.session, generation)
          this.rolloverCfg.logger.info(`dsh-smart-compact: automatic switch held back — only ${Math.round(addedTokens)} tokens added since the last switch (< ${minAdded} anti-churn floor); measured ${budget.totalTokens} ≥ threshold ${Math.round(thresholdTokens)} of window ${budget.contextWindow}`)
        }
        this.rolloverCfg.onSkip?.({ ...measured, reason: `only ${Math.round(addedTokens)} tokens added since the last switch (< ${minAdded})` })
        return null
      }
      const forceAt = thresholdTokens + this.rolloverCfg.fallbackBufferTokens
      if (budget.totalTokens >= forceAt) {
        // v0.5.7: the forced band is a window switch, so it uses the same
        // zero-retention selection as the manual /smart-compact (compactNow
        // passes retainTokens = 0). Basic's pressure path kept a priced tail of
        // retainRatio (0.16-0.22 of the window, i.e. tens of k tokens with
        // every image and tool result in it) visible in the "new" window, so
        // auto and manual switches produced different windows. The overflow
        // path of basic is exactly selectCompactableRange(..., 0) on the
        // current surface; threshold already proven above.
        const result = await super.compactIfNeeded(agent as never, 'context-overflow' as never, signal as never)
        if (result === null) {
          // Same silence trap one band lower: the forced band used to return
          // null with no log and no refusal record, so "above the wall and
          // still not switching" looked exactly like "below threshold".
          const reason = `forced band: nothing compactable at ${budget.totalTokens} tokens (window ${budget.contextWindow}, usable ${usableWall})`
          this.rolloverCfg.logger.warn(`dsh-smart-compact: automatic switch refused — ${reason}`)
          this.noticeRefusal(reason, agent.session.id)
          return null
        }
        this.rememberPostRollover(agent, budget.totalTokens, result)
        this.noteRollover(agent, 'pressure')
        return result
      }
      // Grace band: remind once per window generation, keep working.
      const generation = this.generationOf(agent)
      if (this.remindedGeneration.get(agent.session) !== generation) {
        this.remindedGeneration.set(agent.session, generation)
        this.rolloverCfg.logger.info(
          `dsh-smart-compact: grace band entered for ${agent.session.id} (${budget.totalTokens}/${budget.contextWindow} tokens on ${budget.provider}${budget.model === undefined ? '' : '/' + budget.model}, forced rollover at ${Math.round(forceAt)}) — the model should write ctx_notes now`,
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
  /**
   * Window switch requested by the continuation watcher after a degenerate
   * (zero-output) turn. Identical lossless path to the manual command, but
   * booked under its own trigger so the ops probe never claims a human asked.
   */
  async rolloverForContinuation(agent: AgentLike) {
    const result = await super.compactNow(agent as never, undefined as never, undefined as never)
    if (result !== null) {
      this.noteRollover(agent, 'continuation')
      try {
        const budget = await measureBudget(this.ownCtx, agent)
        this.postRolloverTotals.set(agent.session, budget.totalTokens)
      } catch { /* best effort: the guard degrades to 0 baseline */ }
    }
    return result
  }

  override async compactNow(agent: AgentLike, signal?: AbortSignal, sourceCommandId?: string) {
    const result = await super.compactNow(agent as never, signal as never, sourceCommandId as never)
    if (result !== null) {
      this.noteRollover(agent, 'manual')
      // A manual switch resets the anti-churn baseline: the user just asked for a
      // fresh window, so the next automatic switch must earn its own added volume.
      try {
        const budget = await measureBudget(this.ownCtx, agent, signal)
        this.postRolloverTotals.set(agent.session, budget.totalTokens)
      } catch { /* best effort */ }
    }
    return result
  }
}
