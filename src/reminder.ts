/**
 * Wrap-up reminder: one nudge per window generation while the session sits in
 * the pre-rollover grace band, injected through the system-prompt waterfall.
 * @module dsh-auto-compact/reminder
 */
import type { AgentLike, BudgetSnapshot } from './budget.js'
import { wrapUpAdvice } from './budget.js'

interface AssembledLike {
  system?: string
  developer?: string
  [key: string]: unknown
}

export interface ReminderDeps {
  /** Grace-band width in tokens; reminders fire while remaining <= this. */
  fallbackBufferTokens: number
  /** Live budget, or null when the model/window is unknown. */
  getBudget(session: object): Promise<BudgetSnapshot | null>
  /** Current window generation (number of completed rollovers). */
  getWindowGeneration(session: object): number
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
  pluginName: string
}

/**
 * Register the reminder on the system-prompt waterfall. One reminder per
 * window generation: state rides a WeakMap keyed by the generation counter,
 * so a rollover naturally re-arms it and dispose drops everything.
 */
export function attachReminder(
  ctx: { on(event: string, listener: (...args: unknown[]) => unknown): void },
  deps: ReminderDeps,
): void {
  let warnedNoField = false
  const remindedGeneration = new WeakMap<object, number>()

  ctx.on('system-prompt/assemble', async (...args: unknown[]) => {
    const next = args[args.length - 1] as () => Promise<AssembledLike>
    const assembled = await next()
    try {
      const context = (args.length >= 2 ? args[args.length - 2] : undefined) as { agent?: AgentLike } | undefined
      const agent = context?.agent
      if (!agent) return assembled
      const budget = await deps.getBudget(agent.session)
      if (!budget) return assembled
      const advice = wrapUpAdvice(budget.remaining, deps.fallbackBufferTokens)
      if (!advice) return assembled
      const generation = deps.getWindowGeneration(agent.session)
      if (remindedGeneration.get(agent.session) === generation) return assembled
      remindedGeneration.set(agent.session, generation)
      const reminder = `[${deps.pluginName}] Context budget low (${budget.remaining} of ${budget.contextWindow} tokens remaining). ${advice}`
      if (typeof assembled?.system === 'string') {
        return { ...assembled, system: `${assembled.system}\n\n${reminder}` }
      }
      if (typeof assembled?.developer === 'string') {
        return { ...assembled, developer: `${assembled.developer}\n\n${reminder}` }
      }
      if (!warnedNoField) {
        warnedNoField = true
        deps.logger.warn(`[${deps.pluginName}] reminder could not find a system/developer field on the assembled prompt; falling back to log-only reminders`)
      }
      deps.logger.info(reminder)
      return assembled
    } catch (error) {
      deps.logger.warn(`[${deps.pluginName}] reminder pass failed: ${(error as Error).message}; continuing with the unmodified prompt`)
      return assembled
    }
  })
}
