/**
 * @dsh-external/dsh-auto-compact — Codex-style context window auto-management.
 *
 * Five components, all wired inside apply() so a fiber dispose removes every
 * one of them (lifecycle hygiene: no module-level state, no leaked listeners):
 *  1. get_context_remaining — live budget visibility
 *  2. ctx_notes             — per-session working notes (survive rollover)
 *  3. ctx_history           — recall original archived events
 *  4. new_context           — model-initiated fresh window request
 *  5. RolloverCompactionEngine — threshold/overflow/new_context window switch
 *    with a zero-model-call handoff template, plus the wrap-up reminder.
 * @module @dsh-external/dsh-auto-compact
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only side effects: pull in the cordis Context declaration merges for
// the services this plugin consumes at runtime.
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-llm'
import { resolveConfig, estimateTokens } from './config.js'
import { NotesStore, type NotesArgs } from './notes.js'
import { SessionArchiveReader, type HistoryArgs } from './history.js'
import { measureBudget, resolveModelTarget, wrapUpAdvice, type AgentLike } from './budget.js'
import { requestRollover, consumeRollover, type PendingRollover } from './new-context.js'
import { attachReminder } from './reminder.js'
import { RolloverCompactionEngine } from './rollover.js'

export const name = '@dsh-external/dsh-auto-compact'
export const inject = ['tools', 'llm', 'tokenMeter', 'sessions']

export { Config } from './config.js'

const PLUGIN = 'dsh-auto-compact'

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

  // ── Engine (rollover compaction) ─────────────────────────────────────────
  // Mutually exclusive with compaction-basic's automatic engine: two auto
  // engines would double-compact. Fail loud instead of silently racing.
  const basicEngine = (() => {
    try {
      return ctx.get('compaction-basic') as { config?: { auto?: boolean } } | undefined
    } catch {
      return undefined
    }
  })()
  if (basicEngine?.config?.auto) {
    throw new Error(`${PLUGIN}: compaction-basic has auto=true; disable one of the two automatic compaction engines before enabling both`)
  }

  const engine = new RolloverCompactionEngine(
    ctx as never,
    { thresholdRatio: cfg.thresholdRatio, auto: cfg.auto },
    { thresholdRatio: cfg.thresholdRatio, fallbackBufferTokens: cfg.fallbackBufferTokens, auto: cfg.auto, logger: ctx.logger },
    pending,
  )
  // basic's constructor registers its listeners on the current fiber; expose a
  // defensive dispose for hosts that require one.
  ctx.effect(() => () => {
    ctx.logger.debug(`${PLUGIN}: engine listeners are fiber-managed and dropped with this plugin`)
  }, `${PLUGIN}: rollover engine`)

  const getBudget = (session: object) => {
    const agent = session as AgentLike
    return measureBudget(ctx as never, agent)
  }

  if (cfg.auto) {
    attachReminder(ctx as never, {
      fallbackBufferTokens: cfg.fallbackBufferTokens,
      getBudget,
      getWindowGeneration: (session) => {
        const events = (session as AgentLike).session?.events
        return events ? events.filter((e) => e.type === 'compaction/summary').length : 0
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
      const events = (agent.session.events ?? []) as unknown as ConstructorParameters<typeof SessionArchiveReader>[0]
      const reader = new SessionArchiveReader(events, cfg.maxToolOutputTokens)
      switch (args.action) {
        case 'list': {
          const windows = reader.listWindows()
          if (windows.length === 0) return '(no rollover has happened yet — the whole conversation is still in the live window)'
          return windows.map((w) => `window #${w.index}: seqs ${w.startSeq}–${w.endSeq} (${w.shadowedSeqs.length} events, ~${w.shadowedTokenCount} tokens archived)`).join('\n')
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
  if (cfg.auto) {
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
