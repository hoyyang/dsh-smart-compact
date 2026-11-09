/**
 * dsh-smart-compact configuration: load-time validated, fail-loud.
 * @module dsh-smart-compact/config
 */
import z from '@deepseek-ai/schemastery'

export interface ResolvedConfig {
  /** Master switch: false disables every tool and the engine (pure no-op). */
  enabled: boolean
  /** Whether the rollover engine auto-triggers on threshold/overflow. */
  auto: boolean
  /** Fraction of the model context window where wrap-up grace begins. */
  thresholdRatio: number
  /**
   * Anti-churn floor: another automatic switch is refused until at least this
   * many tokens were added since the last one. Small windows carry a fixed base
   * (system prompt + tool schema) that can sit close to the threshold, so a % rule
   * alone would switch on nearly every step. 0 disables the guard.
   */
  minAddedTokens: number
  /** Extra tokens granted after the threshold before a forced rollover. */
  fallbackBufferTokens: number
  /** Hard cap for any single tool output, estimated tokens. */
  maxToolOutputTokens: number
  /** Root directory for per-session notes files. */
  notesDir: string
  /** Retained recent-context fraction handed to the compaction engine (basic default 0.16). */
  retainRatio?: number
  /** Per-provider thresholdRatio overrides (provider id → ratio); unlisted providers use thresholdRatio. */
  providerThresholds: Record<string, number>
  /**
   * Recover a turn that ended at the output cap with NOTHING visible (reasoning
   * only). The host disarms the goal on that reason and nothing retries the
   * turn, so without this a session stops until a human types "继续".
   */
  autoContinue: boolean
  /** Consecutive recoveries allowed before the session is left alone (clamped 1..5). */
  maxConsecutiveRecoveries: number
}

/**
 * Kiro's upstream errors cluster above ~70% of its 1M window (500 high-load /
 * 400 "input content length exceeds threshold"), the same reason dsh-kiro's own
 * engine defaults to 75% — keep that policy when smart-compact owns the slot.
 */
export const DEFAULT_PROVIDER_THRESHOLDS: Readonly<Record<string, number>> = { 'kiro-vision': 0.75 }

/**
 * Default auto-switch point. 0.75 is deliberately below the official
 * dsh-compaction-basic default (0.8): whichever engine crosses its own line
 * FIRST in a pre-step wins, so the rollover engine must sit strictly lower or
 * the official model-summary compaction preempts it every time (measured on
 * 2026-10-23..25: 100% of automatic compactions in ptc sessions were official).
 */
export const DEFAULT_THRESHOLD_RATIO = 0.75

/** Default anti-churn floor (tokens added since the previous switch). */
export const DEFAULT_MIN_ADDED_TOKENS = 100_000

/** Default: recover zero-output max-tokens turns automatically. */
export const DEFAULT_AUTO_CONTINUE = true

/** Default consecutive-recovery cap (a third failure means the window, not the turn, is the problem). */
export const DEFAULT_MAX_CONSECUTIVE_RECOVERIES = 2

/** Effective threshold for a routed provider. */
export function thresholdFor(cfg: Pick<ResolvedConfig, 'thresholdRatio' | 'providerThresholds'>, provider: string | undefined): number {
  return (provider !== undefined ? cfg.providerThresholds[provider] : undefined) ?? cfg.thresholdRatio
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  auto: z.boolean().default(true),
  thresholdRatio: z.number().default(DEFAULT_THRESHOLD_RATIO),
  minAddedTokens: z.number().default(DEFAULT_MIN_ADDED_TOKENS),
  fallbackBufferTokens: z.number().default(8192),
  maxToolOutputTokens: z.number().default(8192),
  notesDir: z.string(),
  providerThresholds: z.dict(z.number()).default({ ...DEFAULT_PROVIDER_THRESHOLDS }),
  autoContinue: z.boolean().default(DEFAULT_AUTO_CONTINUE),
  maxConsecutiveRecoveries: z.number().default(DEFAULT_MAX_CONSECUTIVE_RECOVERIES),
})

/** Validate untrusted plugin config; every failure names the offending key. */
export function resolveConfig(config: unknown): ResolvedConfig {
  const raw = (config ?? {}) as Record<string, unknown>
  const enabled = raw.enabled ?? true
  const auto = raw.auto ?? true
  const thresholdRatio = raw.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const minAddedTokens = raw.minAddedTokens ?? DEFAULT_MIN_ADDED_TOKENS
  const fallbackBufferTokens = raw.fallbackBufferTokens ?? 8192
  const maxToolOutputTokens = raw.maxToolOutputTokens ?? 8192
  const notesDir = raw.notesDir
  const retainRatio = raw.retainRatio
  const providerThresholds = raw.providerThresholds ?? { ...DEFAULT_PROVIDER_THRESHOLDS }
  const autoContinue = raw.autoContinue ?? DEFAULT_AUTO_CONTINUE
  const maxConsecutiveRecoveries = raw.maxConsecutiveRecoveries ?? DEFAULT_MAX_CONSECUTIVE_RECOVERIES
  if (typeof enabled !== 'boolean') throw new Error('dsh-smart-compact: `enabled` must be a boolean')
  if (typeof auto !== 'boolean') throw new Error('dsh-smart-compact: `auto` must be a boolean')
  if (typeof thresholdRatio !== 'number' || !Number.isFinite(thresholdRatio) || thresholdRatio <= 0 || thresholdRatio >= 1) {
    throw new Error(`dsh-smart-compact: \`thresholdRatio\` must be a number in (0, 1), got ${String(thresholdRatio)}`)
  }
  if (typeof minAddedTokens !== 'number' || !Number.isInteger(minAddedTokens) || minAddedTokens < 0) {
    throw new Error(`dsh-smart-compact: \`minAddedTokens\` must be a non-negative integer, got ${String(minAddedTokens)}`)
  }
  if (typeof fallbackBufferTokens !== 'number' || !Number.isInteger(fallbackBufferTokens) || fallbackBufferTokens < 1) {
    throw new Error(`dsh-smart-compact: \`fallbackBufferTokens\` must be a positive integer, got ${String(fallbackBufferTokens)}`)
  }
  if (typeof maxToolOutputTokens !== 'number' || !Number.isInteger(maxToolOutputTokens) || maxToolOutputTokens < 256) {
    throw new Error(`dsh-smart-compact: \`maxToolOutputTokens\` must be an integer >= 256, got ${String(maxToolOutputTokens)}`)
  }
  if (notesDir !== undefined && (typeof notesDir !== 'string' || notesDir.length === 0)) {
    throw new Error('dsh-smart-compact: `notesDir` must be a non-empty string when provided')
  }
  if (retainRatio !== undefined && (typeof retainRatio !== 'number' || !Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio >= 1)) {
    throw new Error(`dsh-smart-compact: \`retainRatio\` must be a number in (0, 1), got ${String(retainRatio)}`)
  }
  if (retainRatio !== undefined && typeof thresholdRatio === 'number' && retainRatio >= thresholdRatio) {
    throw new Error(`dsh-smart-compact: \`retainRatio\` (${retainRatio}) must be less than \`thresholdRatio\` (${thresholdRatio})`)
  }
  if (typeof autoContinue !== 'boolean') throw new Error('dsh-smart-compact: `autoContinue` must be a boolean')
  if (typeof maxConsecutiveRecoveries !== 'number' || !Number.isInteger(maxConsecutiveRecoveries) || maxConsecutiveRecoveries < 1 || maxConsecutiveRecoveries > 5) {
    throw new Error(`dsh-smart-compact: \`maxConsecutiveRecoveries\` must be an integer in 1..5, got ${String(maxConsecutiveRecoveries)}`)
  }
  if (typeof providerThresholds !== 'object' || providerThresholds === null || Array.isArray(providerThresholds)) {
    throw new Error('dsh-smart-compact: `providerThresholds` must be an object mapping provider id → ratio')
  }
  for (const [provider, ratio] of Object.entries(providerThresholds as Record<string, unknown>)) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
      throw new Error(`dsh-smart-compact: \`providerThresholds.${provider}\` must be a number in (0, 1), got ${String(ratio)}`)
    }
    if (retainRatio !== undefined && typeof retainRatio === 'number' && retainRatio >= ratio) {
      throw new Error(`dsh-smart-compact: \`retainRatio\` (${retainRatio}) must be less than \`providerThresholds.${provider}\` (${ratio})`)
    }
  }
  return { enabled, auto, thresholdRatio, minAddedTokens, fallbackBufferTokens, maxToolOutputTokens, notesDir, retainRatio, providerThresholds, autoContinue, maxConsecutiveRecoveries } as ResolvedConfig
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
