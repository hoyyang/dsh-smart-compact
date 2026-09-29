/**
 * dsh-smart-compact — Codex-style context window auto-management.
 *
 * Five components, all wired inside apply() so a fiber dispose removes every
 * one of them (lifecycle hygiene: no module-level state, no leaked listeners):
 *  1. get_context_remaining — live budget visibility
 *  2. ctx_notes             — per-session working notes (survive rollover)
 *  3. ctx_history           — recall original archived events
 *  4. new_context           — model-initiated fresh window request
 *  5. RolloverCompactionEngine — threshold/overflow/new_context window switch
 *    with a zero-model-call handoff template, plus the wrap-up reminder.
 * @module dsh-smart-compact
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only side effects: pull in the cordis Context declaration merges for
// the services this plugin consumes at runtime.
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-llm'
import { resolveConfig, estimateTokens } from './config.js'
import { NotesStore, type NotesArgs } from './notes.js'
import { SessionArchiveReader, renderWindowListing, sessionEvents, type HistoryArgs, type SessionLogLike } from './history.js'
import { measureBudget, resolveModelTarget, wrapUpAdvice, type AgentLike } from './budget.js'
import { requestRollover, consumeRollover, type PendingRollover } from './new-context.js'
import { attachReminder } from './reminder.js'
import { RolloverCompactionEngine, windowGeneration } from './rollover.js'
import { registerSmartCompactCommand } from './command.js'
import { registerStateRoute } from './state.js'

export const name = 'dsh-smart-compact'
// 'webServer' powers the composer button's availability route and 'agents'
// resolves the live session for it (cordis rule: every ctx.<service> a plugin
// touches must be declared here — an undeclared access throws). Profiles
// without a web server do not mount this plugin (headless bundles it out),
// so the requirements are safe.
export const inject = ['tools', 'commands', 'llm', 'tokenMeter', 'sessions', 'webServer', 'agents']

export { Config } from './config.js'

const PLUGIN = 'dsh-smart-compact'

/** Minimum gap between two identical refusal records in the ops probe (hot-path write throttle). */
const REFUSAL_STATE_COOLDOWN_MS = 30_000

/** Require an agent-backed execution; tools are meaningless without a session. */
function requireAgent(exec: { agent?: unknown }, toolName: string): AgentLike {
  if (!exec.agent) throw new Error(`${PLUGIN}: ${toolName} was called without an owning agent session`)
  return exec.agent as AgentLike
}

export function apply(ctx: Context, config: unknown): void {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info(`${PLUGIN}: disabled by configuration (enabled=false) — no tools, no engine`)
    return
  }

  const notesRoot = cfg.notesDir ?? dshHomePath(`${PLUGIN}/notes`)
  const notes = new NotesStore(notesRoot)
  const pending: PendingRollover = new WeakSet()

  // ── Engine (rollover compaction) — polite slot acquisition ───────────────
  // The `compaction` service is a single slot (dsh-glm's GlmCompactionEngine,
  // kiro, compaction-basic all mount there). Detection is construction-catch
  // ONLY: a ctx.get('compaction') probe would itself force-instantiate a
  // lazily-declared engine on an otherwise clean profile and occupy the slot
  // against ourselves (observed on headless — the probe is self-defeating).
  // When the constructor's provide() collides with an existing owner, we
  // yield and fall back to tools+reminder mode.
  let engineMounted = true
  let slotHolder = 'unknown'
  let engine: RolloverCompactionEngine | null = null
  // The optional `toolResultPruner` service is a third-party implementation that
  // may lag the running dsh (observed: a stale 0.1.0-rc.8 copy vendored by
  // another plugin still read the removed `session.events`, which aborted every
  // rollover inside base compaction). Rollover archives the whole window and
  // derives retention from the range selection, so pruning tool outputs first
  // buys nothing here — isolate the service so the engine never consults it.
  const engineCtx = ctx.isolate('toolResultPruner')
  // Isolation is a whole-context shadow, so prove it took effect — a no-op
  // would silently hand the lagging pruner back to the engine. The isolated
  // view reports undefined WITHOUT instantiating the service (the service map
  // is keyed by the isolate shadow), so the probe is free in the normal case.
  // Trade-off (documented in the README): the isolation also hides the pruner
  // from the manual /smart-compact path, which therefore compacts unpruned.
  if ((engineCtx as unknown as { get(name: string): unknown }).get('toolResultPruner') !== undefined) {
    ctx.logger.warn(`${PLUGIN}: ctx.isolate('toolResultPruner') did not take effect — a lagging pruner can abort rollovers`)
  }
  let lastRefusal: { reason: string; at: number } = { reason: '', at: 0 }
  try {
    engine = new RolloverCompactionEngine(
      engineCtx as never,
      { thresholdRatio: cfg.thresholdRatio, auto: cfg.auto, ...(cfg.retainRatio === undefined ? {} : { retainRatio: cfg.retainRatio }) },
      {
        thresholdRatio: cfg.thresholdRatio,
        fallbackBufferTokens: cfg.fallbackBufferTokens,
        auto: cfg.auto,
        logger: ctx.logger,
        onRollover: (info) => writeState({ rolloverCount: (runtimeState.rolloverCount as number) + 1, lastRolloverAt: new Date().toISOString(), lastRolloverTrigger: info.trigger }),
        onRolloverRefused: (info) => {
          // A request that cannot commit is retried every step, so identical
          // refusals are coalesced instead of rewriting the probe on each one.
          const now = Date.now()
          if (info.reason === lastRefusal.reason && now - lastRefusal.at < REFUSAL_STATE_COOLDOWN_MS) return
          lastRefusal = { reason: info.reason, at: now }
          writeState({ lastRolloverRefusedAt: new Date().toISOString(), lastRolloverRefusedReason: info.reason })
        },
        onBudgetDegraded: (failures) => writeState({ budgetDegraded: true, budgetConsecutiveFailures: failures }),
        hasNotes: (sessionId) => notes.hasNotes(sessionId),
        lastNoteWrittenAt: (sessionId) => notes.lastWrittenAtMs(sessionId),
      },
      pending,
    )
    // basic's constructor registers its listeners on the current fiber; expose a
    // defensive dispose for hosts that require one.
    ctx.effect(() => () => {
      ctx.logger.debug(`${PLUGIN}: engine listeners are fiber-managed and dropped with this plugin`)
    }, `${PLUGIN}: rollover engine`)
    void engine
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const holderMatch = /has been registered at <([^>]+)>/.exec(message)
    if (/service ["']?compaction["']? has been registered/i.test(message)) {
      engineMounted = false
      slotHolder = holderMatch?.[1] ?? 'another compaction engine'
    } else {
      throw error
    }
  }
  if (!engineMounted) {
    ctx.logger.info(`${PLUGIN}: compaction slot occupied by ${slotHolder} — mounting tools + reminder only; rollover engine skipped (free the slot to enable it, see README)`)
  }

  // ── Command: /smart-compact (100% lossless window switch) ────────────────
  registerSmartCompactCommand(
    ctx as never,
    {
      engine: engineMounted ? engine : null,
      slotHolder: engineMounted ? slotHolder : undefined,
      logger: ctx.logger,
      // Advisory post-switch budget for the receipt's "remaining" line; it
      // shares the engine's isolated context (pruner shadowing is irrelevant
      // to budget measurement) and must never fail the receipt.
      measureRemaining: async (agent) => {
        try { return await measureBudget(engineCtx as never, agent as AgentLike) } catch { return null }
      },
      hasNotes: (sessionId) => notes.hasNotes(sessionId),
      lastNoteWrittenAt: (sessionId) => notes.lastWrittenAtMs(sessionId),
    },
  )

  // ── Button state route: semantic availability for the composer button ────
  // The client button is inert while the live window has nothing to archive
  // (fresh window right after a rollover, brand-new session) — the exact
  // "nothing to switch" condition the command receipt reports. Skipped with
  // an info line on profiles without a webServer; fail-open for the client.
  let stateRouteError: string | null = null
  try {
    registerStateRoute(ctx as never, {
      engineMounted,
      slotHolder: engineMounted ? undefined : slotHolder,
      logger: ctx.logger,
    })
  } catch (error) {
    stateRouteError = (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 2000)
  }

  const pkgVersion = (() => { try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown' } catch { return 'unknown' } })()

  // ── Status probe: durable, human-inspectable RUNTIME state ───────────────
  // Ops surface for "is dsh-smart-compact actually working?" — read
  // <dsh home>/dsh-smart-compact/engine-state.json at any time. The file is a
  // live record: mount decision at boot, rollover count as sessions proceed,
  // and a budgetDegraded flag when measurement keeps failing (the携程-session
  // gap: silent degradation made "is it working?" unanswerable).
  const stateFile = join(dshHomePath(PLUGIN), 'engine-state.json')
  const runtimeState: Record<string, unknown> = {
    plugin: PLUGIN,
    version: pkgVersion,
    engineMounted: false,
    slotHolder: null,
    auto: cfg.auto,
    thresholdRatio: cfg.thresholdRatio,
    fallbackBufferTokens: cfg.fallbackBufferTokens,
    notesDir: notesRoot,
    rolloverCount: 0,
    lastRolloverAt: null,
    lastRolloverTrigger: null,
    lastRolloverRefusedAt: null,
    lastRolloverRefusedReason: null,
    budgetDegraded: false,
    budgetConsecutiveFailures: 0,
    armedAt: new Date().toISOString(),
  }
  const writeState = (patch: Record<string, unknown>): void => {
    try {
      Object.assign(runtimeState, patch)
      // A fresh DSH_HOME has no plugin directory yet; without it the probe write
      // failed with ENOENT and the ops surface silently never appeared.
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify(runtimeState, null, 2)}\n`, 'utf8')
    } catch (error) {
      ctx.logger.warn(`${PLUGIN}: could not write engine-state.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  writeState({ engineMounted, slotHolder: engineMounted ? null : slotHolder, ...(stateRouteError !== null ? { stateRouteError } : {}) })

  const getBudget = (session: object) => {
    // measureBudget expects an AgentLike and reads agent.session — handing it
    // the bare Session measured `undefined` and threw "Invalid value used as
    // weak map key" inside the meter, killing every reminder pass silently
    // (the billing-session zero-touch bug, caught live by reminderObserved).
    const agent = { session } as AgentLike
    return measureBudget(ctx as never, agent)
  }

  const reminderObserved = { briefed: 0, tiers: 0, grace: 0, noBudgetSessions: 0, passFailures: 0, lastPassFailure: '' }
  let lastFailureWriteAt = 0
  if (cfg.auto) {
    attachReminder(ctx as never, {
      fallbackBufferTokens: cfg.fallbackBufferTokens,
      thresholdRatio: cfg.thresholdRatio,
      getBudget,
      getWindowGeneration: (() => {
        let warned = false
        return (session: object): number => {
          try {
            return windowGeneration(sessionEvents(session as SessionLogLike))
          } catch (error) {
            // Keep the reminder pass alive (briefing + tier nudges share its try
            // block) and warn once instead of on every assembled prompt.
            if (!warned) {
              warned = true
              ctx.logger.warn(`${PLUGIN}: window generation unavailable — ${(error as Error).message}`)
            }
            return 0
          }
        }
      })(),
      onObservation: (observation) => {
        switch (observation.kind) {
          case 'briefed': reminderObserved.briefed += 1; break
          case 'tier': reminderObserved.tiers += 1; break
          case 'grace': reminderObserved.grace += 1; break
          case 'no-budget': reminderObserved.noBudgetSessions += 1; break
          case 'pass-failed': {
            reminderObserved.passFailures += 1
            reminderObserved.lastPassFailure = observation.reason.slice(0, 200)
            // A persistently failing pass would otherwise rewrite the state
            // file on every assembled prompt — coalesce to one write / 30s.
            const now = Date.now()
            if (now - lastFailureWriteAt < 30_000) return
            lastFailureWriteAt = now
            break
          }
        }
        writeState({ reminderObserved: { ...reminderObserved } })
      },
      logger: ctx.logger,
      pluginName: PLUGIN,
    })
  }

  // ── Tool: get_context_remaining ──────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_context_remaining',
    description: '查询当前会话剩余 token 预算 / Get remaining context-window tokens for this session',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(_args: unknown, exec: { agent?: unknown; signal?: AbortSignal }) {
      const agent = requireAgent(exec, 'get_context_remaining')
      const budget = await measureBudget(ctx as never, agent, exec.signal)
      const advice = wrapUpAdvice(budget.remaining, cfg.fallbackBufferTokens)
      return [
        `total: ${budget.totalTokens} tokens`,
        `context window: ${budget.contextWindow}`,
        `remaining: ${budget.remaining}`,
        `measurement baseline: ${budget.baselineKind}`,
        ...(advice ? [`advice: ${advice}`] : []),
      ].join('\n')
    },
  })), `${PLUGIN}: get_context_remaining`)

  // ── Tool: ctx_notes ──────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ctx_notes',
    description: '会话工作笔记（跨压缩存活）：list/read/search/write/append / Session working notes that survive compaction',
    parameters: {
      action: { type: 'string', required: true, description: 'write | append | read | search | list' },
      content: { type: 'string', description: 'write/append 的正文' },
      title: { type: 'string', description: 'append 的段标题' },
      segment: { type: 'number', description: 'read 的段号（1 起）' },
      keyword: { type: 'string', description: 'search 的关键词' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: NotesArgs, exec: { agent?: unknown }) {
      const agent = requireAgent(exec, 'ctx_notes')
      const sessionId = agent.session.id
      const max = cfg.maxToolOutputTokens
      switch (args.action) {
        case 'write': {
          if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error(`${PLUGIN}: ctx_notes write requires non-empty \`content\``)
          await notes.write(sessionId, args.content)
          return `notes replaced (1 segment; ~${estimateTokens(args.content)} tokens). Keep goal/decisions/next-steps and where details live.`
        }
        case 'append': {
          if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error(`${PLUGIN}: ctx_notes append requires non-empty \`content\``)
          const index = await notes.append(sessionId, args.title ?? '', args.content)
          return `appended segment #${index}${args.title ? ` (${args.title})` : ''}`
        }
        case 'read':
          return notes.read(sessionId, args.segment, max)
        case 'search': {
          if (typeof args.keyword !== 'string') throw new Error(`${PLUGIN}: ctx_notes search requires \`keyword\``)
          return notes.search(sessionId, args.keyword, max)
        }
        case 'list': {
          const markdown = await notes.read(sessionId, undefined, max)
          return markdown
        }
        default:
          throw new Error(`${PLUGIN}: unknown ctx_notes action ${JSON.stringify(String(args.action))} (valid: write|append|read|search|list)`)
      }
    },
  })), `${PLUGIN}: ctx_notes`)

  // ── Tool: ctx_history ────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ctx_history',
    description: '回查被 rollover 归档的原始会话内容 / Recall original events archived by rollover (list windows, read seqs, search)',
    parameters: {
      action: { type: 'string', required: true, description: 'list | read | search' },
      seqs: { type: 'array', description: 'read 的事件 seq 列表' },
      keyword: { type: 'string', description: 'search 的关键词' },
      archivedOnly: { type: 'boolean', description: 'search 是否仅搜已归档内容（默认 true）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: HistoryArgs, exec: { agent?: unknown }) {
      const agent = requireAgent(exec, 'ctx_history')
      const reader = new SessionArchiveReader(sessionEvents(agent.session), cfg.maxToolOutputTokens)
      switch (args.action) {
        case 'list': {
          return renderWindowListing(reader.listWindows())
        }
        case 'read': {
          if (!Array.isArray(args.seqs) || args.seqs.length === 0) throw new Error(`${PLUGIN}: ctx_history read requires non-empty \`seqs\` (run action=list first)`)
          return reader.readSeqs(args.seqs)
        }
        case 'search': {
          if (typeof args.keyword !== 'string') throw new Error(`${PLUGIN}: ctx_history search requires \`keyword\``)
          return reader.search(args.keyword, args.archivedOnly ?? true)
        }
        default:
          throw new Error(`${PLUGIN}: unknown ctx_history action ${JSON.stringify(String(args.action))} (valid: list|read|search)`)
      }
    },
  })), `${PLUGIN}: ctx_history`)

  // ── Tool: new_context ────────────────────────────────────────────────────
  if (engineMounted && cfg.auto) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'new_context',
      description: '请求开启全新上下文窗口（本步完成后生效）/ Request a fresh context window; takes effect after this step',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(_args: unknown, exec: { agent?: unknown }) {
        const agent = requireAgent(exec, 'new_context')
        if (consumeRollover(pending, agent.session)) {
          return 'a rollover was already requested for this step'
        }
        return requestRollover(pending, agent)
      },
    })), `${PLUGIN}: new_context`)
  } else {
    ctx.logger.info(`${PLUGIN}: auto=false — new_context tool not registered (rollover happens only via /compact)`)
  }

  // Fail-loud self check: the model target must be resolvable lazily, but a
  // broken tokenMeter service should surface now, not at first tool call.
  if (typeof ctx.tokenMeter?.measure !== 'function') {
    throw new Error(`${PLUGIN}: ctx.tokenMeter.measure is unavailable — the token-meter plugin must be loaded`)
  }

  ctx.logger.info(`${PLUGIN}: armed (auto=${cfg.auto}, thresholdRatio=${cfg.thresholdRatio}, buffer=${cfg.fallbackBufferTokens} tokens, notes at ${notesRoot})`)
}
