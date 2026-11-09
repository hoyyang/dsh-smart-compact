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
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
// Type-only side effects: pull in the cordis Context declaration merges for
// the services this plugin consumes at runtime.
import type {} from '@deepseek-ai/dsh-token-meter'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { resolveConfig, estimateTokens, thresholdFor } from './config.js'
import { NotesStore, type NotesArgs } from './notes.js'
import { SessionArchiveReader, renderWindowListing, sessionEvents, type HistoryArgs, type SessionLogLike } from './history.js'
import { measureBudget, prepareBudget, resolveModelTarget, wrapUpAdvice, type AgentLike } from './budget.js'
import { requestRollover, consumeRollover, type PendingRollover } from './new-context.js'
import { attachReminder } from './reminder.js'
import { RolloverCompactionEngine, windowGeneration } from './rollover.js'
import { registerSmartCompactCommand } from './command.js'
import { registerStateRoute, mergeSessionLedger, type SessionMeasure } from './state.js'
import { ContinuationWatch, type ContinuationAgentLike, type GoalsLike } from './continue.js'

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
  // A stale vendored kernel (0.1.x) frames checkpoints as {kind:'plugin'}, which
  // session format v4 refuses on append — every rollover then aborts the whole
  // turn ("format v4 message requires a producer-owned source kind"). Refuse to
  // mount the engine on such a kernel instead of breaking the session.
  const checkpointKind = (compactCheckpointSource as unknown as (id: string) => { kind?: unknown })('probe').kind
  const staleKernel = checkpointKind === 'plugin'
  if (staleKernel) {
    engineMounted = false
    slotHolder = 'stale kernel'
    ctx.logger.error(`${PLUGIN}: the loaded @deepseek-ai/dsh-compaction frames checkpoints as kind "plugin" (retired by session format v4) — rollover engine NOT mounted. Remove the vendored @deepseek-ai packages from this plugin's node_modules so the host kernel is used.`)
  }
  // The pressure bands gate per provider; basic re-checks its own single
  // threshold inside super.compactIfNeeded, so it gets the lowest one or a
  // provider override below the default would be vetoed there.
  const providerThresholdFor = (provider: string) => thresholdFor(cfg, provider)
  const basicThresholdRatio = Math.min(cfg.thresholdRatio, ...Object.values(cfg.providerThresholds))
  // Observability sinks, filled in once the state writer exists below (the engine
  // is constructed before it). Hoisted no-ops keep the wiring total.
  type EvaluateInfo = { trigger: string; sessionId: string; provider: string; model?: string; totalTokens: number; contextWindow: number; thresholdTokens: number; completionReserve: number; usableWindow: number }
  let observeEvaluate: (info: EvaluateInfo) => void = () => {}
  let observeSkip: (info: EvaluateInfo & { reason: string }) => void = () => {}
  let observeForeign: (info: { count: number; at: number | null; snippet: string }) => void = () => {}
  if (!staleKernel) try {
    engine = new RolloverCompactionEngine(
      engineCtx as never,
      { thresholdRatio: basicThresholdRatio, auto: false, ...(cfg.retainRatio === undefined ? {} : { retainRatio: cfg.retainRatio }) },
      {
        thresholdRatio: cfg.thresholdRatio,
        thresholdFor: providerThresholdFor,
        fallbackBufferTokens: cfg.fallbackBufferTokens,
        minAddedTokens: cfg.minAddedTokens,
        auto: cfg.auto,
        logger: ctx.logger,
        onEvaluate: (info) => observeEvaluate(info),
        onSkip: (info) => observeSkip(info),
        onForeignCompaction: (info) => observeForeign(info),
        onRollover: (info) => writeState({ rolloverCount: (runtimeState.rolloverCount as number) + 1, lastRolloverAt: new Date().toISOString(), lastRolloverTrigger: info.trigger }),
        onRolloverRefused: (info) => {
          // A request that cannot commit is retried every step, so identical
          // refusals are coalesced instead of rewriting the probe on each one.
          const now = Date.now()
          if (info.reason === lastRefusal.reason && now - lastRefusal.at < REFUSAL_STATE_COOLDOWN_MS) return
          lastRefusal = { reason: info.reason, at: now }
          const at = new Date(now).toISOString()
          // A refusal is the ONE signal that explains "above the wall but still
          // not switching"; keep it per session so it survives another
          // session's write.
          const refused = functioning()
          refused.sessions = mergeSessionLedger(refused.sessions as Record<string, SessionMeasure> | undefined, info.sessionId, { at, refusal: info.reason })
          writeState({ lastRolloverRefusedAt: at, lastRolloverRefusedReason: info.reason, functioning: { ...refused } })
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
  if (!engineMounted && !staleKernel) {
    ctx.logger.info(`${PLUGIN}: compaction slot occupied by ${slotHolder} — mounting tools + reminder only; rollover engine skipped (free the slot to enable it, see README)`)
  }

  // ── Automatic pressure + overflow wiring on the raw context ──────────────
  // basic's own listeners are registered on the constructor ctx — the
  // isolate('toolResultPruner') shadow — which does not receive agent
  // lifecycle events on the live host (probe-verified 2026-10-18: a pre-step
  // at 97% usage never reached compactIfNeeded). basic therefore runs with
  // auto: false and this plugin owns the wiring here, on the raw ctx that
  // demonstrably receives agent events (the reminder uses the same ctx).
  if (engineMounted && engine && cfg.auto) {
    const overflowRetries = new WeakMap<object, number>()
    ctx.on('agent/pre-step', async (payload, next) => {
      const { agent, signal } = payload
      if (!agent || signal?.aborted) return next()
      try {
        const result = await engine.compactIfNeeded(agent as never, 'pressure', signal as never)
        if (result !== null) ctx.logger.info(`${PLUGIN}: step pressure rollover committed for ${agent.session.id}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`${PLUGIN}: step compaction failed: ${message}; continuing the turn`)
      }
      // Fail loud when the official engine (or a host engine) compacts instead of
      // us: silence was the whole reason "is it working?" had no answer.
      try { engine.noticeForeignCompactions(agent as never) } catch { /* probe must never break the step */ }
      return next()
    })
    ctx.on('agent/status', (payload) => {
      if (payload.status === 'idle' && payload.agent) overflowRetries.delete(payload.agent)
    })
    ctx.on('agent/request-error', async (payload, next) => {
      const { agent, failure, signal } = payload
      if (!agent || !failure || failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal?.aborted) return next()
      const retries = overflowRetries.get(agent) ?? 0
      if (retries >= 1) return next()
      let result: unknown
      try {
        result = await engine.compactIfNeeded(agent as never, 'context-overflow', signal as never)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`${PLUGIN}: context-overflow compaction failed: ${message}; preserving the original request error`)
        return next()
      }
      if (result === null || result === undefined) return next()
      overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' } as never
    })
    ctx.logger.info(`${PLUGIN}: automatic pressure/overflow wiring registered on the raw context`)
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
      prepareRemaining: async (agent) => {
        try { return await prepareBudget(engineCtx as never, agent as AgentLike) } catch { return null }
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
    providerThresholds: cfg.providerThresholds,
    effectiveThresholds: { default: cfg.thresholdRatio, ...cfg.providerThresholds },
    minAddedTokens: cfg.minAddedTokens,
    fallbackBufferTokens: cfg.fallbackBufferTokens,
    notesDir: notesRoot,
    rolloverCount: 0,
    lastRolloverAt: null,
    lastRolloverTrigger: null,
    lastRolloverRefusedAt: null,
    lastRolloverRefusedReason: null,
    budgetDegraded: false,
    budgetConsecutiveFailures: 0,
    // "Is the automatic band even looking?" — answerable without a probe build:
    // every evaluation and every skip lands here (coalesced writes).
    functioning: {
      evaluations: 0,
      lastMeasure: null as null | { at: string; totalTokens: number; contextWindow: number; thresholdTokens: number; completionReserve: number; usableWindow: number },
      lastSkipAt: null as string | null,
      lastSkipReason: null as string | null,
      foreignCompactions: [] as Array<{ at: string | null; count: number; snippet: string }>,
      lastForeignCompactionAt: null as string | null,
      // Per-session ledger: the single global slot above let one session's write
      // erase another's evidence (2026-11-03 diagnosis).
      sessions: {} as Record<string, SessionMeasure>,
    },
    continuation: {
      recoveries: 0,
      lastRecoveryAt: null as string | null,
      lastAction: null as string | null,
      giveUps: 0,
      lastGiveUpAt: null as string | null,
      lastGiveUpReason: null as string | null,
    },
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

  // Coalesced observability: a pre-step fires on every step, so evaluations are
  // written at most once per 30s while skips are recorded whenever the reason
  // changes (both stay readable in engine-state.json).
  let lastEvaluationWriteAt = 0
  const functioning = () => runtimeState.functioning as Record<string, unknown>
  observeEvaluate = (info) => {
    const now = Date.now()
    const seen = functioning()
    seen.evaluations = (seen.evaluations as number) + 1
    const at = new Date(now).toISOString()
    // provider/model make a stale routed target auditable: the 2026-11-05
    // failure (options said 1M, the route was 272k) was invisible here.
    seen.lastMeasure = { at, provider: info.provider, ...(info.model === undefined ? {} : { model: info.model }), totalTokens: info.totalTokens, contextWindow: info.contextWindow, thresholdTokens: Math.round(info.thresholdTokens), completionReserve: info.completionReserve, usableWindow: info.usableWindow }
    seen.sessions = mergeSessionLedger(seen.sessions as Record<string, SessionMeasure> | undefined, info.sessionId, {
      at,
      totalTokens: info.totalTokens,
      contextWindow: info.contextWindow,
      thresholdTokens: Math.round(info.thresholdTokens),
      usableWindow: info.usableWindow,
    })
    if (now - lastEvaluationWriteAt < 30_000) return
    lastEvaluationWriteAt = now
    writeState({ functioning: { ...seen } })
  }
  observeSkip = (info) => {
    const seen = functioning()
    const at = new Date().toISOString()
    const next = {
      ...seen,
      lastSkipAt: at,
      lastSkipReason: info.reason,
      lastSkipMeasure: { provider: info.provider, ...(info.model === undefined ? {} : { model: info.model }), totalTokens: info.totalTokens, contextWindow: info.contextWindow, thresholdTokens: Math.round(info.thresholdTokens), completionReserve: info.completionReserve, usableWindow: info.usableWindow },
      sessions: mergeSessionLedger(seen.sessions as Record<string, SessionMeasure> | undefined, info.sessionId, {
        at,
        totalTokens: info.totalTokens,
        contextWindow: info.contextWindow,
        thresholdTokens: Math.round(info.thresholdTokens),
        usableWindow: info.usableWindow,
        skipReason: info.reason,
      }),
    }
    if (seen.lastSkipReason === info.reason && typeof seen.lastSkipAt === 'string' && Date.now() - Date.parse(seen.lastSkipAt) < 30_000) {
      runtimeState.functioning = next
      return
    }
    writeState({ functioning: next })
  }
  observeForeign = (info) => {
    const seen = functioning()
    const list = Array.isArray(seen.foreignCompactions) ? seen.foreignCompactions as Array<{ at: string | null; count: number; snippet: string }> : []
    const at = info.at === null ? null : new Date(info.at).toISOString()
    const next = { ...seen, foreignCompactions: [...list, { at, count: info.count, snippet: info.snippet }].slice(-5), lastForeignCompactionAt: at ?? new Date().toISOString() }
    writeState({ functioning: next })
    ctx.logger.warn(`${PLUGIN}: a compaction this plugin did not author was committed in the session (${info.count} foreign so far) — another compaction engine (the official dsh-compaction-basic with auto enabled, or a host engine) won the pre-step race; see engine-state.json『functioning.foreignCompactions』`)
  }

  // ── Zero-output truncation recovery ──────────────────────────────────────
  // A max-tokens turn whose assistant message carried neither text nor a tool
  // call is an unusable answer: the host disarms the goal and nothing retries,
  // so the session dies until a human types "继续" (2026-11-03, three turns in
  // a row on a session already past its window). Recover it mechanically.
  if (engineMounted && engine && cfg.auto && cfg.autoContinue) {
    const activeEngine = engine
    const goals = (): GoalsLike | undefined => {
      try {
        const service = (ctx as unknown as { get(name: string): unknown }).get('goals')
        return service as GoalsLike | undefined
      } catch {
        // Profiles without dsh-goal simply have no goal service; the message
        // path covers them.
        return undefined
      }
    }
    const continuation = (runtimeState.continuation as Record<string, unknown>)
    const recordContinuation = (patch: Record<string, unknown>): void => {
      Object.assign(continuation, patch)
      writeState({ continuation: { ...continuation } })
    }
    const watch = new ContinuationWatch({
      logger: ctx.logger,
      maxConsecutiveRecoveries: cfg.maxConsecutiveRecoveries,
      agents: ctx.agents as unknown as { get(sessionId: string): ContinuationAgentLike | undefined },
      goals,
      measure: async (agent) => {
        try {
          const budget = await measureBudget(ctx as never, agent as never)
          return { totalTokens: budget.totalTokens, usableWindow: budget.usableWindow }
        } catch {
          return null
        }
      },
      rollover: async (agent) => {
        const result = await activeEngine.rolloverForContinuation(agent as never)
        if (result === null) return null
        try {
          return windowGeneration(sessionEvents((agent as unknown as { session: SessionLogLike }).session)) + 1
        } catch {
          return null
        }
      },
      flush: async (agent) => {
        await (ctx.sessions as unknown as { flush(session: unknown): Promise<unknown> }).flush(agent.session)
      },
      onRecovered: (info) => {
        recordContinuation({
          recoveries: (continuation.recoveries as number) + 1,
          lastRecoveryAt: new Date().toISOString(),
          lastAction: `${info.action}${info.rollover === null ? '' : ` after window #${info.rollover}`}`,
        })
      },
      onGaveUp: (info) => {
        recordContinuation({
          giveUps: (continuation.giveUps as number) + 1,
          lastGiveUpAt: new Date().toISOString(),
          lastGiveUpReason: `${info.sessionId}: ${info.reason}`.slice(0, 300),
        })
      },
    })
    ctx.on('session/event', (session: { id: string } | undefined, event: never) => {
      if (session === undefined) return
      try {
        watch.observe(session, event)
      } catch (error) {
        ctx.logger.warn(`${PLUGIN}: continuation watcher failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    ctx.logger.info(`${PLUGIN}: zero-output recovery armed (maxConsecutiveRecoveries=${cfg.maxConsecutiveRecoveries})`)
  }

  const getBudget = (session: object) => {
    // measureBudget expects an AgentLike and reads agent.session — handing it
    // the bare Session measured `undefined` and threw "Invalid value used as
    // weak map key" inside the meter, killing every reminder pass silently
    // (the billing-session zero-touch bug, caught live by reminderObserved).
    // Resolve the LIVE agent when the registry has it: a bare { session } has no
    // agent options, so every reminder pass before the first request header
    // failed with "cannot resolve the routed model" (70 sessions on 2026-11-02..04).
    const id = (session as { id?: unknown }).id
    let agent: AgentLike | undefined
    if (typeof id === 'string') {
      try {
        const live = (ctx as unknown as { agents?: { get?(id: string): unknown } }).agents?.get?.(id) as AgentLike | undefined
        if (live !== undefined && live.session !== undefined) agent = live
      } catch { /* registry probe is best-effort; the bare session still measures when it can */ }
    }
    return measureBudget(ctx as never, agent ?? ({ session } as AgentLike))
  }

  const reminderObserved = { briefed: 0, tiers: 0, grace: 0, noBudgetSessions: 0, passFailures: 0, lastPassFailure: '' }
  let lastFailureWriteAt = 0
  if (cfg.auto) {
    attachReminder(ctx as never, {
      fallbackBufferTokens: cfg.fallbackBufferTokens,
      thresholdRatio: cfg.thresholdRatio,
      thresholdFor: providerThresholdFor,
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

  ctx.logger.info(`${PLUGIN}: armed (auto=${cfg.auto}, thresholdRatio=${cfg.thresholdRatio}, providerThresholds=${JSON.stringify(cfg.providerThresholds)}, buffer=${cfg.fallbackBufferTokens} tokens, notes at ${notesRoot})`)
}
