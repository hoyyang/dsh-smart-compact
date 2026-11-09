import { describe, expect, it } from 'vitest'
import { resolveConfig, thresholdFor } from '../src/config.ts'

describe('auto-switch calibration', () => {
  it('defaults to 0.75 — strictly below the official compaction engine (0.8), so this band wins the pre-step race', () => {
    const cfg = resolveConfig({})
    expect(cfg.thresholdRatio).toBe(0.75)
    expect(thresholdFor(cfg, 'deepseek-official')).toBe(0.75)
    expect(thresholdFor(cfg, 'mify-vision')).toBe(0.75)
  })

  it('defaults the anti-churn floor to 100k added tokens, and accepts 0 as "no guard"', () => {
    expect(resolveConfig({}).minAddedTokens).toBe(100_000)
    expect(resolveConfig({ minAddedTokens: 0 }).minAddedTokens).toBe(0)
    expect(() => resolveConfig({ minAddedTokens: -1 })).toThrow(/minAddedTokens/)
    expect(() => resolveConfig({ minAddedTokens: 1.5 })).toThrow(/minAddedTokens/)
  })
})

describe('providerThresholds', () => {
  it('defaults kiro-vision to 75% and leaves other providers on thresholdRatio', () => {
    const cfg = resolveConfig({})
    expect(cfg.providerThresholds).toEqual({ 'kiro-vision': 0.75 })
    expect(thresholdFor(cfg, 'kiro-vision')).toBe(0.75)
    expect(thresholdFor(cfg, 'zhipuai')).toBe(0.75)
    expect(thresholdFor(cfg, undefined)).toBe(0.75)
  })

  it('an explicit map replaces the defaults (empty map = one global threshold)', () => {
    expect(thresholdFor(resolveConfig({ providerThresholds: {} }), 'kiro-vision')).toBe(0.75)
    expect(thresholdFor(resolveConfig({ providerThresholds: { zhipuai: 0.7 } }), 'zhipuai')).toBe(0.7)
  })

  it('fails loud on a bad ratio or a retainRatio above an override, naming the key', () => {
    expect(() => resolveConfig({ providerThresholds: { 'kiro-vision': 1.2 } })).toThrow(/providerThresholds\.kiro-vision/)
    expect(() => resolveConfig({ providerThresholds: [] })).toThrow(/providerThresholds/)
    // A retainRatio at/above the global threshold is caught by the global check
    // first (0.75 default); the per-provider branch needs a lower override.
    expect(() => resolveConfig({ retainRatio: 0.8 })).toThrow(/retainRatio.*must be less than.*thresholdRatio/)
    expect(() => resolveConfig({ retainRatio: 0.7, providerThresholds: { zhipuai: 0.65 } })).toThrow(/providerThresholds\.zhipuai/)
  })

  it('defaults zero-output recovery on, capped at 2 consecutive recoveries', () => {
    const cfg = resolveConfig({})
    expect(cfg.autoContinue).toBe(true)
    expect(cfg.maxConsecutiveRecoveries).toBe(2)
  })

  it('clamps the recovery cap to 1..5 and rejects non-integers', () => {
    expect(resolveConfig({ maxConsecutiveRecoveries: 1 }).maxConsecutiveRecoveries).toBe(1)
    expect(resolveConfig({ maxConsecutiveRecoveries: 5 }).maxConsecutiveRecoveries).toBe(5)
    expect(() => resolveConfig({ maxConsecutiveRecoveries: 0 })).toThrow(/maxConsecutiveRecoveries.*1\.\.5/)
    expect(() => resolveConfig({ maxConsecutiveRecoveries: 6 })).toThrow(/maxConsecutiveRecoveries.*1\.\.5/)
    expect(() => resolveConfig({ maxConsecutiveRecoveries: 2.5 })).toThrow(/maxConsecutiveRecoveries/)
    expect(() => resolveConfig({ autoContinue: 'yes' })).toThrow(/autoContinue.*boolean/)
  })
})
