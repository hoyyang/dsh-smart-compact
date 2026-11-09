/**
 * /smart-compact — the human-facing trigger for a seamless window switch.
 *
 * Semantics: "100% rollover" — the command ONLY executes against this
 * plugin's RolloverCompactionEngine (whose compactNow installs a fresh
 * context window with the zero-model-call handoff template). If another
 * engine owns the compaction slot, the command refuses loudly instead of
 * silently degrading to a lossy summary.
 *
 * Receipt design: success leads with a short head line (status marker, new
 * window number, archived volume) so one-line GUI truncation cannot hide the
 * key numbers; the body after the first newline makes the dispatching UI
 * render the card expandable with the full text.
 * @module dsh-smart-compact/command
 */
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { deriveNotesFreshness } from './rollover.js'
import { sessionEvents, type SessionLogLike } from './history.js'
import type { RolloverCompactionEngine } from './rollover.js'

/** The slice of a compaction result the receipt renders. */
export interface SmartCompactOutcome {
  shadowedSeqs: number[]
  shadowedTokenCount: number
  summarySeq: number
  /** Handoff checkpoint blocks; the rollover template carries "Context window #N opened.". Untyped: ContentBlock is a closed union. */
  summary?: ReadonlyArray<unknown>
}

/** The slice of a budget snapshot the receipt renders. */
export interface BudgetLike {
  totalTokens: number
  contextWindow: number
  remaining: number
}

export interface SmartCompactEngine {
  compactNow(agent: unknown, signal?: AbortSignal, sourceCommandId?: string): Promise<SmartCompactOutcome | null>
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
  /**
   * Advisory budget probe, split in two so the receipt never awaits after the
   * switch commits: the async half (model window lookup) runs BEFORE compactNow
   * and returns a synchronous meter read for the post-switch window. Absent,
   * throwing, or null = the receipt omits the remaining line.
   */
  prepareRemaining?: (agent: unknown) => Promise<(() => BudgetLike | null) | null>
  /** Advisory notes probe; absent or throwing = the receipt omits the no-notes advisory line. */
  hasNotes?: (sessionId: string) => Promise<boolean>
  /** Epoch ms of the newest notes write; feeds the stale-notes receipt line. Absent/throwing/null = line omitted. */
  lastNoteWrittenAt?: (sessionId: string) => Promise<number | null>
}

const USAGE = '用法：/smart-compact（无需参数）'

/** Convert expected capability failures into concise human-only outcomes. */
export function expectedFailure(error: ManualCompactionError): CommandOutcome {
  switch (error.code) {
    case 'busy': return { kind: 'error', text: '❌ 未执行换窗：智能体正忙（任务运行中）。等当前任务结束或停止后重试。' }
    case 'cancelled': return { kind: 'error', text: '❌ 换窗已取消。' }
    case 'changed': return { kind: 'error', text: '❌ 未执行换窗：待压缩的历史在替换前发生了变化。对话未被改动；本次尝试已记入会话日志。' }
    case 'summary': {
      // This engine's only summary-stage failure is the size invariant: the
      // fixed handoff checkpoint must price strictly smaller than the shadowed
      // content, so a freshly-rolled window (too little new content) refuses
      // here. Surface THAT cause instead of the generic wording — the numbers
      // come from the engine's own diagnostic (cause.message).
      const cause = (error as { cause?: { message?: unknown } }).cause
      const match = typeof cause?.message === 'string'
        ? /not smaller than the shadowed content \((\d+) estimated framed tokens >= (\d+)\)/.exec(cause.message)
        : null
      if (match !== null) {
        return {
          kind: 'error',
          text: `❌ 未执行换窗：当前窗口内容太少（交接检查点约 ${formatTokens(Number(match[1]))} tok，待归档仅 ${formatTokens(Number(match[2]))} tok）。多发几条消息后再换窗；对话未被改动。`,
        }
      }
      return { kind: 'error', text: '❌ 未执行换窗：无法生成交接检查点。对话未被改动；本次尝试已记入会话日志。' }
    }
    case 'commit': return { kind: 'error', text: '❌ 换窗未干净完成：部分会话历史可能已变化。请先检查当前会话状态再重试。' }
    case 'persistence': return { kind: 'error', text: '❌ 换窗已完成，但会话保存失败。' }
    default: return { kind: 'error', text: `❌ 换窗失败：${String((error as Error).message ?? error)}` }
  }
}

function formatTokens(n: number): string {
  try { return n.toLocaleString('en-US') } catch { return String(n) }
}

/** Opened window number parsed from the zero-model handoff template ("Context window #N opened."). */
function openedWindowNo(result: SmartCompactOutcome): string | null {
  for (const block of result.summary ?? []) {
    const text = (block as { text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    const match = /Context window #(\d+) opened/.exec(text)
    if (match) return match[1]
  }
  return null
}

/** Async half of the remaining-budget probe (pre-commit); any hiccup drops the line. */
async function prepareRemainingLine(deps: SmartCompactDeps, agent: unknown): Promise<(() => string | null) | null> {
  if (!deps.prepareRemaining) return null
  try {
    const read = await deps.prepareRemaining(agent)
    return read === null ? null : () => remainingLine(read)
  } catch { return null }
}

/** Synchronous "remaining budget" line read after the switch; any hiccup just drops the line. */
function remainingLine(read: () => BudgetLike | null): string | null {
  try {
    const budget = read()
    if (!budget || !(budget.contextWindow > 0)) return null
    const pct = Math.round((budget.remaining / budget.contextWindow) * 100)
    return `当前剩余预算：约 ${pct}%（${formatTokens(budget.remaining)} / ${formatTokens(budget.contextWindow)} tok）。`
  } catch { return null }
}

/**
 * Human receipt for a committed window switch. First line is short and
 * carries every key number (status marker, new window number, archived
 * volume) so GUI one-line truncation cannot hide them; the leading "\n"
 * makes the dispatching UI render the card expandable with the full text.
 */
function successReceipt(result: SmartCompactOutcome, remaining: string | null, notesAdvisory: string | null, staleAdvisory: string | null): string {
  const windowNo = openedWindowNo(result)
  const head = `✅ 换窗完成：${windowNo ? `新窗口 #${windowNo}` : '新窗口已就绪'} · 归档 ${result.shadowedSeqs.length} 条 (~${formatTokens(result.shadowedTokenCount)} tok)`
  const body = [
    '旧窗口已 100% 机械归档（零模型调用、零摘要损耗）；细节用 ctx_history 逐字召回，工作笔记（若有）在 ctx_notes。',
    notesAdvisory,
    staleAdvisory,
    remaining,
  ].filter((line): line is string => line !== null)
  return [head, ...body].join('\n')
}

/** Advisory "no notes" line (pre-commit); absent probe, missing session id, or any hiccup just drops the line. */
async function missingNotesLine(deps: SmartCompactDeps, agent: unknown): Promise<string | null> {
  if (!deps.hasNotes) return null
  try {
    const sessionId = (agent as { session?: { id?: unknown } } | null | undefined)?.session?.id
    if (typeof sessionId !== 'string') return null
    if (await deps.hasNotes(sessionId)) return null
    return '⚠️ 本会话至今未写过 ctx_notes：新窗口的交接锚点已按「ctx_history 召回」模式生成；重要任务建议换窗前先写笔记（关键结论若已落盘到项目记忆/STATE，新窗口可直接引用，无需重做）。'
  } catch {
    return null
  }
}

/**
 * Advisory "stale notes" line (pre-commit: measured against the window being
 * archived, before the checkpoint lands) — the receipt-side mirror of the anchor's ⚠️
 * (Incident 2026-09-29: the switch succeeded while the notes predated the
 * window's latest work, and nothing in the receipt flagged it). Advisory only:
 * any probe hiccup just drops the line.
 */
async function staleNotesLine(deps: SmartCompactDeps, agent: unknown): Promise<string | null> {
  if (!deps.lastNoteWrittenAt) return null
  try {
    const sessionId = (agent as { session?: { id?: unknown } } | null | undefined)?.session?.id
    if (typeof sessionId !== 'string') return null
    const events = sessionEvents((agent as { session?: SessionLogLike }).session as SessionLogLike)
    const lastNoteAtMs = await deps.lastNoteWrittenAt(sessionId)
    const freshness = deriveNotesFreshness(events, lastNoteAtMs)
    if (!freshness.stale) return null
    const stamp = new Date(lastNoteAtMs ?? 0).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    return `⚠️ 交接笔记滞后：最后一段笔记写于 ${stamp}，其后本窗口仍有 ${freshness.eventsAfter} 条活动事件；新窗口续接请先以 ctx_history 核对最新进度，勿直接信任笔记。`
  } catch {
    return null
  }
}

/** Execute one argument-free smart-compact request (always a window switch). */
export async function executeSmartCompact(deps: SmartCompactDeps, invocation: SmartCompactInvocation): Promise<CommandOutcome> {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  if (!deps.engine) {
    return { kind: 'error', text: `❌ 未执行换窗：压缩槽位由 ${deps.slotHolder ?? '其它压缩引擎'} 持有，无损换窗不可用。释放槽位的方法见 README。` }
  }
  // Incident 2026-10-12 ("This operation was aborted" on a committed switch):
  // the advisory probes used to be awaited AFTER compactNow, leaving a ~110 ms
  // window in which the host's command signal could abort and replace the
  // receipt of an already-committed rollover with an error. Every async probe
  // now runs before the switch; after compactNow the receipt is built
  // synchronously and returned in the same tick.
  const [readRemaining, notesAdvisory, staleAdvisory] = await Promise.all([
    prepareRemainingLine(deps, invocation.agent),
    missingNotesLine(deps, invocation.agent),
    staleNotesLine(deps, invocation.agent),
  ])
  try {
    const result = await deps.engine.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'error', text: '❌ 未执行换窗：当前对话还没有可归档的历史。' }
    return {
      kind: 'success',
      text: successReceipt(result, readRemaining?.() ?? null, notesAdvisory, staleAdvisory),
      sourceEventSeq: result.summarySeq,
    }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: '❌ 换窗已取消。' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    // Unexpected engine/host failures (e.g. a token-meter replay throw on a
    // session with a corrupted stream) used to escape as a raw
    // "command.execute failed: gateway/internal: …" toast with the plugin's
    // name on a host-internal error. Fail loud, but on OUR receipt: name the
    // underlying error verbatim, keep the stack in the session log.
    const message = error instanceof Error ? error.message : String(error)
    deps.logger.warn(`dsh-smart-compact: command failed (${message})`)
    return { kind: 'error', text: `❌ 换窗失败：${message}。对话未被改动；详情见会话日志。` }
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
