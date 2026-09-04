/**
 * new_context: the model's escape hatch — request a fresh context window.
 * The request is parked on a session-keyed set and consumed at the next
 * agent/pre-step boundary, matching Codex's semantics (no mid-sample abort).
 * @module dsh-auto-compact/new-context
 */
import type { AgentLike } from './budget.js'

/** Session-keyed pending rollover requests. Owned by apply(), never module-level. */
export type PendingRollover = WeakSet<object>

export function requestRollover(pending: PendingRollover, agent: AgentLike): string {
  pending.add(agent.session)
  return 'Rollover requested. Finish the current step; before the next step a fresh context window will be opened (archived content stays recallable via ctx_history). If you have not written ctx_notes yet, do it in this step.'
}

/** Consume a pending request; true exactly once per request. */
export function consumeRollover(pending: PendingRollover, session: object): boolean {
  if (!pending.has(session)) return false
  pending.delete(session)
  return true
}
