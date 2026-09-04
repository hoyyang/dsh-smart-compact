/**
 * @dsh-external/dsh-auto-compact — 工具包形态（由 dev_scaffold_plugin 生成）。
 * 规范：资源注册必须挂 ctx.effect（热重载/卸载自动清理——注入器踩坑记录）。
 *
 * 高性能铁律（DeepSeek V4 Pro 实测，参考 dsh-anchored-standard 98/99）：
 * 1. 工具 schema 精简：description 用短句点明用途，详解放 tool result / 静态引导文本，
 *    不要写进 schema——工具目录按字符计费进首轮 prefill，实测 6 插件可膨胀到 17.6 万字符，
 *    稀释首轮注意力且无缓存 prefill 最贵（缓存命中便宜 10 倍）。
 * 2. 首轮锚定：工具面大（≥5 个）时首轮只露最核心的 1-2 个工具，首个工具调用后恢复全部——
 *    首轮请求结构决定整条会话的策略轨迹，锚定在训练对齐的窄工具面再放开，能力不损。
 *    启用方法见 apply() 末尾的注释块。
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'

export const name = "@dsh-external/dsh-auto-compact"
export const inject = ['tools']

export interface Config {
  greeting: string
}

export const Config = z.object({
  greeting: z.string().default('你好'),
})

export function apply(ctx: Context, config: Config): void {
  // 工具注册（ctx.effect：fiber dispose 自动注销）
  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_auto_compact_hello',
    description: "Codex-style context window auto-management for DSH: budget visibility, rollover compaction engine, notes handoff, history recall",
    parameters: {
      name: { type: 'string', required: true, description: '谁' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { name: string }) {
      return config.greeting + '，' + args.name + '！'
    },
  })), '@dsh-external/dsh-auto-compact: hello tool')

  // ── 高性能引导：首轮锚定（工具面 ≥5 个或 description 总量大时启用）──────────
  // 机制：system-prompt/assemble 是 Waterfall（必须 await next() 再裁剪）；
  // 会话无任何持久化 tool/call 前，只保留本插件最核心的工具；首个工具调用落地后
  // 恢复全部。阶段从持久 session events 推导，resume/reload 不丢状态。
  // 启用步骤：① inject 数组加 'systemPrompt'；② 把下方 MINE 换成你的工具名集合；
  // ③ 把 '<核心工具>' 换成首轮要保留的那个工具名。
  // ctx.on('system-prompt/assemble', async (_assembly: unknown, context: any, next: () => Promise<any>) => {
  //   const assembled = await next()
  //   const agent = context.agent
  //   if (!agent || agent.session.events.some((e: any) => e.type === 'tool/call')) return assembled
  //   const MINE = new Set(['_dsh_external_dsh_auto_compact_hello'])
  //   const CORE = '<核心工具>'
  //   return { ...assembled, tools: assembled.tools.filter((t: any) => !MINE.has(t.name) || t.name === CORE) }
  // })
}
