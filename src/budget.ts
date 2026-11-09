/**
 * get_context_remaining: expose the model's live context-window budget.
 * @module dsh-smart-compact/budget
 */

import type { SessionLogLike } from './history.js'

/** Structural view of the pieces of Agent we consume (no hard peer import). */
export interface AgentLike {
  session: SessionLogLike & { id: string }
  options?: { provider?: string; model?: string; maxTokens?: number }
}

export interface CtxLike {
  tokenMeter: {
    measure(session: unknown): { totalTokens: number; surfaceTokens: number; baseline: { kind: string } }
  }
  llm: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
      context?: { contextWindow?: number }
      /** Adapter-published completion reservation for this model, when it has one. */
      defaultMaxTokens?: number
    }>
  }
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
}

export interface ModelTarget {
  provider: string
  model: string
}

/** Best-effort routed model target for an agent; throws naming the agent when unknown. */
export function resolveModelTarget(agent: AgentLike): ModelTarget {
  const header = (agent.session as unknown as { requestHeader?: () => { config?: { provider?: string; model?: string } } }).requestHeader?.()?.config
  // The session's latest request header is the model that ACTUALLY served the
  // conversation: the model picker rewrites it per request, while agent options
  // are only the seed captured when the agent was created. Preferring options
  // made a mid-session switch invisible to the budget bands — observed
  // 2026-11-05: a session on 微软 Azure (azure_openai/gpt-6.1-sol, 272k window,
  // 128k completion) still measured deepseek-flash's 1M window, so the switch
  // point sat at 607,808 while the route clamped at 144,000 and the turn died
  // with a ~16-token completion.
  const provider = header?.provider ?? agent.options?.provider
  const model = header?.model ?? agent.options?.model
  if (!provider || !model) {
    throw new Error(`dsh-smart-compact: cannot resolve the routed model for session ${agent.session.id} (no agent options and no request header)`)
  }
  return { provider, model }
}

export interface BudgetSnapshot {
  totalTokens: number
  contextWindow: number
  remaining: number
  baselineKind: string
  /** Routed provider the window belongs to (drives per-provider thresholds). */
  provider: string
  /** Routed model that produced this measurement (audit: a stale target is visible here). */
  model?: string
  /**
   * Completion tokens this host reserves on every request (max_tokens). The
   * provider budget is an EQUATION: input + requested completion must fit the
   * window, so the usable input ceiling is window - completionReserve, not the
   * window itself. 0 = unknown (behave as before).
   */
  completionReserve: number
  /** Input ceiling the provider will actually accept: contextWindow - completionReserve. */
  usableWindow: number
}

/** Completion reservation the host puts on each request (max_tokens), best effort. */
export function resolveCompletionReserve(agent: AgentLike, defaultMaxTokens = 0): number {
  // Header first, for the same reason the routed target is header-first: the
  // header is the reservation the last request ACTUALLY carried, while
  // agent options keep the value captured at creation. A model switch changes
  // the reservation (azure 128k vs deepseek 384k) without touching options, and
  // trusting the stale one under-reserves or over-reserves the wall by 3x.
  const header = (agent.session as unknown as { requestHeader?: () => { config?: { maxTokens?: number } } }).requestHeader?.()?.config
  const fromHeader = header?.maxTokens
  if (typeof fromHeader === 'number' && Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader
  const fromOptions = agent.options?.maxTokens
  if (typeof fromOptions === 'number' && Number.isFinite(fromOptions) && fromOptions > 0) return fromOptions
  // Before the first request header of a generation there is nothing to read
  // (the header event is committed AFTER the pre-step assembly — measured 28ms
  // apart on 2026-11-05). Returning 0 then made the threshold 0.75*window,
  // which sits ABOVE the provider wall on any model with a >25% completion
  // reservation (mify-sol/azure: 204,000 > the 144,000 wall). The adapter's
  // per-model default is the honest fallback (compaction-basic uses the same).
  if (typeof defaultMaxTokens === 'number' && Number.isFinite(defaultMaxTokens) && defaultMaxTokens > 0) return defaultMaxTokens
  return 0
}

/** Measure current pressure against the routed model's window. */
export async function measureBudget(ctx: CtxLike, agent: AgentLike, signal?: AbortSignal): Promise<BudgetSnapshot> {
  const measurement = ctx.tokenMeter.measure(agent.session)
  const target = resolveModelTarget(agent)
  const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const contextWindow = info.context?.contextWindow
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    throw new Error(`dsh-smart-compact: no context window configured for model ${target.provider}/${target.model}; set contextWindow on that adapter model`)
  }
  const completionReserve = resolveCompletionReserve(agent, info.defaultMaxTokens ?? 0)
  return {
    totalTokens: measurement.totalTokens,
    contextWindow,
    remaining: contextWindow - measurement.totalTokens,
    baselineKind: measurement.baseline.kind,
    provider: target.provider,
    model: target.model,
    completionReserve,
    usableWindow: Math.max(1, contextWindow - completionReserve),
  }
}

/**
 * Resolve the model window now and hand back a synchronous meter read for
 * later (the /smart-compact receipt reads the post-switch window without an
 * await after the commit). Throws like measureBudget when the window is unknown.
 */
export async function prepareBudget(ctx: CtxLike, agent: AgentLike, signal?: AbortSignal): Promise<() => BudgetSnapshot> {
  const target = resolveModelTarget(agent)
  const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const contextWindow = info.context?.contextWindow
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    throw new Error(`dsh-smart-compact: no context window configured for model ${target.provider}/${target.model}; set contextWindow on that adapter model`)
  }
  const completionReserve = resolveCompletionReserve(agent, info.defaultMaxTokens ?? 0)
  return () => {
    const measurement = ctx.tokenMeter.measure(agent.session)
    return {
      totalTokens: measurement.totalTokens,
      contextWindow,
      remaining: contextWindow - measurement.totalTokens,
      baselineKind: measurement.baseline.kind,
      provider: target.provider,
      model: target.model,
      completionReserve,
      usableWindow: Math.max(1, contextWindow - completionReserve),
    }
  }
}

/** Wrap-up advice shown when the session enters the pre-rollover grace band. */
export function wrapUpAdvice(remaining: number, fallbackBufferTokens: number): string | null {
  if (remaining > fallbackBufferTokens) return null
  return 'Context is low. Write your handoff state with ctx_notes (goal, decisions, next steps, where details live) before the automatic rollover; cross-session constraints can be persisted by the user via the landfill-project workflow.'
}
