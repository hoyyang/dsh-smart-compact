/**
 * dsh-auto-compact configuration: load-time validated, fail-loud.
 * @module dsh-auto-compact/config
 */
import z from '@deepseek-ai/schemastery'

export interface ResolvedConfig {
  /** Master switch: false disables every tool and the engine (pure no-op). */
  enabled: boolean
  /** Whether the rollover engine auto-triggers on threshold/overflow. */
  auto: boolean
  /** Fraction of the model context window where wrap-up grace begins. */
  thresholdRatio: number
  /** Extra tokens granted after the threshold before a forced rollover. */
  fallbackBufferTokens: number
  /** Hard cap for any single tool output, estimated tokens. */
  maxToolOutputTokens: number
  /** Root directory for per-session notes files. */
  notesDir: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  auto: z.boolean().default(true),
  thresholdRatio: z.number().default(0.85),
  fallbackBufferTokens: z.number().default(8192),
  maxToolOutputTokens: z.number().default(8192),
  notesDir: z.string(),
})

/** Validate untrusted plugin config; every failure names the offending key. */
export function resolveConfig(config: unknown): ResolvedConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const enabled = raw.enabled ?? true
  const auto = raw.auto ?? true
  const thresholdRatio = raw.thresholdRatio ?? 0.85
  const fallbackBufferTokens = raw.fallbackBufferTokens ?? 8192
  const maxToolOutputTokens = raw.maxToolOutputTokens ?? 8192
  const notesDir = raw.notesDir
  if (typeof enabled !== 'boolean') throw new Error('dsh-auto-compact: `enabled` must be a boolean')
  if (typeof auto !== 'boolean') throw new Error('dsh-auto-compact: `auto` must be a boolean')
  if (typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio >= 1) {
    throw new Error(`dsh-auto-compact: \`thresholdRatio\` must be a number in (0, 1), got ${String(thresholdRatio)}`)
  }
  if (typeof fallbackBufferTokens !== 'number' || !Number.isInteger(fallbackBufferTokens) || fallbackBufferTokens < 1) {
    throw new Error(`dsh-auto-compact: \`fallbackBufferTokens\` must be a positive integer, got ${String(fallbackBufferTokens)}`)
  }
  if (typeof maxToolOutputTokens !== 'number' || !Number.isInteger(maxToolOutputTokens) || maxToolOutputTokens < 256) {
    throw new Error(`dsh-auto-compact: \`maxToolOutputTokens\` must be an integer >= 256, got ${String(maxToolOutputTokens)}`)
  }
  if (notesDir !== undefined && (typeof notesDir !== 'string' || notesDir.length === 0)) {
    throw new Error('dsh-auto-compact: `notesDir` must be a non-empty string when provided')
  }
  return { enabled, auto, thresholdRatio, fallbackBufferTokens, maxToolOutputTokens, notesDir } as ResolvedConfig
}

/** Rough char→token estimate used only for tool-output truncation budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Truncate text to a token budget on a line boundary, announcing the cut. */
export function truncateToTokens(text: string, budgetTokens: number, what: string): string {
  const budgetChars = budgetTokens * 4
  if (text.length <= budgetChars) return text
  const cut = text.slice(0, budgetChars)
  const lineCut = cut.slice(0, Math.max(cut.lastIndexOf('\n'), budgetChars - 200))
  return `${lineCut}\n…[truncated: ${what} exceeded the ${budgetTokens}-token output budget; narrow your query]`
}
