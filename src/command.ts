/**
 * /smart-compact — the human-facing trigger for a seamless window switch.
 *
 * Semantics: "100% rollover" — the command ONLY executes against this
 * plugin's RolloverCompactionEngine (whose compactNow installs a fresh
 * context window with the zero-model-call handoff template). If another
 * engine owns the compaction slot, the command refuses loudly instead of
 * silently degrading to a lossy summary.
 * @module dsh-smart-compact/command
 */
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { RolloverCompactionEngine } from './rollover.js'

export interface SmartCompactEngine {
  compactNow(agent: unknown, signal?: AbortSignal, sourceCommandId?: string): Promise<{
    shadowedSeqs: number[]
    shadowedTokenCount: number
    summarySeq: number
  } | null>
}

export interface SmartCompactInvocation {
  rawInput: string
  agent: unknown
  signal: AbortSignal
  commandId: string
}

export interface CommandOutcome {
  kind: 'success' | 'error'
  text: string
  sourceEventSeq?: number
}

export interface SmartCompactDeps {
  /** This plugin's engine, or null when the slot was yielded to another owner. */
  engine: SmartCompactEngine | null
  /** Name of the engine that owns the slot when yielded. */
  slotHolder?: string
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
}

const USAGE = 'Usage: /smart-compact (no arguments)'

/** Convert expected capability failures into concise human-only outcomes (official wording). */
export function expectedFailure(error: ManualCompactionError): CommandOutcome {
  switch (error.code) {
    case 'busy': return { kind: 'error', text: 'Smart-compact is unavailable because the agent is not idle. Stop the running task and retry.' }
    case 'cancelled': return { kind: 'error', text: 'Smart-compact cancelled.' }
    case 'changed': return { kind: 'error', text: 'The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.' }
    case 'summary': return { kind: 'error', text: 'Smart-compact could not produce the handoff checkpoint. The conversation is unchanged; the attempt is recorded in the session log.' }
    case 'commit': return { kind: 'error', text: 'Smart-compact did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.' }
    case 'persistence': return { kind: 'error', text: 'Smart-compact finished, but the session could not be saved.' }
    default: return { kind: 'error', text: `Smart-compact failed: ${String((error as Error).message ?? error)}` }
  }
}

/** Execute one argument-free smart-compact request (always a window switch). */
export async function executeSmartCompact(deps: SmartCompactDeps, invocation: SmartCompactInvocation): Promise<CommandOutcome> {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  if (!deps.engine) {
    return { kind: 'error', text: `Smart-compact is not active: the compaction slot is owned by ${deps.slotHolder ?? 'another engine'}, so a lossless window switch is unavailable. Free the slot (see README) to enable this command.` }
  }
  try {
    const result = await deps.engine.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'error', text: 'Nothing to switch yet — the conversation has no compactable history.' }
    return {
      kind: 'success',
      text: `Smart-compact done: seamless window switch installed — ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens) archived losslessly. Continue working; recall details via ctx_history.`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: 'Smart-compact cancelled.' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/** Register /smart-compact for every composed human-command adapter. */
export function registerSmartCompactCommand(
  ctx: {
    commands: { register(definition: { name: string; description: string; handler: (invocation: SmartCompactInvocation) => Promise<CommandOutcome> }): unknown }
    effect(fn: () => unknown, label?: string): void
  },
  deps: SmartCompactDeps,
): void {
  const active = new Set<Promise<CommandOutcome>>()
  const handler = (invocation: SmartCompactInvocation): Promise<CommandOutcome> => {
    const operation = executeSmartCompact(deps, invocation)
    active.add(operation)
    const retire = (): void => {
      active.delete(operation)
    }
    operation.then(retire, retire)
    return operation
  }
  ctx.effect(function* () {
    yield async () => {
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      name: 'smart-compact',
      description: '100% 触发无缝换窗（归档旧窗口，开新窗口继续）/ Trigger a seamless lossless window switch',
      handler,
    })
  }, 'dsh-smart-compact: command lifecycle')
}
