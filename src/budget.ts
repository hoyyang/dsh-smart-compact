/**
 * get_context_remaining: expose the model's live context-window budget.
 * @module dsh-smart-compact/budget
 */

import type { SessionLogLike } from './history.js'

/** Structural view of the pieces of Agent we consume (no hard peer import). */
export interface AgentLike {
  session: SessionLogLike & { id: string }
  options?: { provider?: string; model?: string }
}

export interface CtxLike {
  tokenMeter: {
    measure(session: unknown): { totalTokens: number; surfaceTokens: number; baseline: { kind: string } }
  }
  llm: {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } }>
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
  const provider = agent.options?.provider ?? header?.provider
  const model = agent.options?.model ?? header?.model
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
  return {
    totalTokens: measurement.totalTokens,
    contextWindow,
    remaining: contextWindow - measurement.totalTokens,
    baselineKind: measurement.baseline.kind,
  }
}

/** Wrap-up advice shown when the session enters the pre-rollover grace band. */
export function wrapUpAdvice(remaining: number, fallbackBufferTokens: number): string | null {
  if (remaining > fallbackBufferTokens) return null
  return 'Context is low. Write your handoff state with ctx_notes (goal, decisions, next steps, where details live) before the automatic rollover; cross-session constraints can be persisted by the user via the landfill-project workflow.'
}
