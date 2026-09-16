/**
 * Mandatory sanitization for engine-authored text (v0.5.0).
 *
 * Every text the ENGINE authors — today the handoff checkpoint's Task /
 * Last-action anchors — passes through {@link redactText} before it is written
 * into a new window, a receipt, or a log line. Personal and company
 * information must never propagate through surfaces the engine composes
 * automatically, without a human in the loop.
 *
 * Scope boundary (deliberate): the verbatim archive (ctx_history) is NOT
 * redacted — lossless local recall of one's own session is the product's core
 * contract. This module covers authored surfaces only, and there is
 * deliberately no config switch (强制执行); the pattern set below is fixed.
 *
 * Redaction never echoes the matched content: logs and state carry counters
 * and labels only.
 *
 * @module dsh-smart-compact/redact
 */

export interface RedactionResult {
  /** Text with every match replaced by a labeled placeholder. */
  text: string
  /** Total number of replacements performed. */
  redactions: number
  /** Distinct labels that matched (e.g. 手机号, 邮箱, 企业名). */
  labels: string[]
}

interface Pattern {
  label: string
  re: RegExp
}

/**
 * Pattern set (Chinese-context first). Shapes are deliberately conservative:
 * a pattern must be near-certain (phone/email/national-ID shape, explicit
 * company suffixes) — a redaction that fires on ordinary prose is worse than
 * an occasional miss, because the anchors carry orientation value.
 */
const PATTERNS: readonly Pattern[] = [
  // CN mobile numbers, digit-bounded so longer numbers or version strings never clip.
  { label: '手机号', re: /(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])/g },
  // Email addresses.
  { label: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  // 18-digit national-ID shape (birthdate-structured), boundary-guarded.
  { label: '证件号', re: /(?<![\dXx])\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?![\dXx])/g },
  // CN company suffixes with their preceding name run.
  { label: '企业名', re: /[\u4e00-\u9fa5A-Za-z0-9·]{2,24}(?:有限公司|股份有限公司|集团有限公司|控股集团|集团公司)/g },
  // EN company suffixes. The trailing guard is a lookahead (not \b): 'Inc.'
  // ends in a non-word char, so \b would fail before a following space.
  { label: '企业名', re: /\b[A-Z][A-Za-z0-9&.'\u2019\- ]{0,48}?\s*(?:Inc\.|LLC|Ltd\.|GmbH|Corp\.|PLC)(?![a-zA-Z])/g },
]

/**
 * Redact every known pattern. Idempotent, never throws on any input: a
 * redaction hiccup returns the input unchanged rather than authoring a broken
 * anchor (the rollover transaction must not fail behind this layer).
 */
export function redactText(input: string): RedactionResult {
  let text = input
  let redactions = 0
  const labels = new Set<string>()
  try {
    for (const { label, re } of PATTERNS) {
      text = text.replace(re, () => {
        redactions += 1
        labels.add(label)
        return `【已脱敏:${label}】`
      })
    }
  } catch {
    return { text: input, redactions: 0, labels: [] }
  }
  return { text, redactions, labels: [...labels] }
}
