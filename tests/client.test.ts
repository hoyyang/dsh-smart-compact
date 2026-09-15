// Client-half regression: the rollover click flow and the rendered shape.
//
// The click flow is the plugin's one behavioural promise — click == /smart-compact,
// draft preserved — asserted here against a recorded action face; the markup test
// pins the plate structure the stylesheet keys on.
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompactButton, buttonTitle, isInert, runRollover } from '../src/client/components.js'

function recordActions() {
  const calls = []
  return {
    calls,
    setDraft(text) { calls.push(['setDraft', text]) },
    submit() { calls.push(['submit']) },
  }
}

describe('runRollover', () => {
  it('writes the command and submits through the host actions', () => {
    const actions = recordActions()
    runRollover('', actions)
    expect(actions.calls).toEqual([
      ['setDraft', '/smart-compact'],
      ['submit'],
    ])
  })

  it('restores a user draft right after submit (consume-token no-ops on it)', () => {
    const actions = recordActions()
    runRollover('帮我看看这段代码', actions)
    expect(actions.calls).toEqual([
      ['setDraft', '/smart-compact'],
      ['submit'],
      ['setDraft', '帮我看看这段代码'],
    ])
  })

  it('does not restore when the draft already was the bare command', () => {
    const actions = recordActions()
    runRollover('/smart-compact', actions)
    expect(actions.calls).toEqual([
      ['setDraft', '/smart-compact'],
      ['submit'],
    ])
  })
})

describe('CompactButton markup', () => {
  it('renders the plate with the burst layer', () => {
    const html = renderToStaticMarkup(React.createElement(CompactButton, {
      sessionId: 's1',
      inputActions: recordActions(),
    }))
    expect(html).toContain('dsc-btn')
    expect(html).toContain('dsc-burst')
    expect(html).toContain('aria-label')
  })

  it('marks itself inert without session props', () => {
    const html = renderToStaticMarkup(React.createElement(CompactButton, {}))
    expect(html).toContain('data-inert="true"')
  })
})

describe('isInert (semantic availability decision)', () => {
  it('fails OPEN without state — an absent/failed route keeps the button clickable', () => {
    expect(isInert(false, null)).toBe(false)
    expect(isInert(false, undefined)).toBe(false)
    expect(isInert(false, { ok: false, reason: 'no-live-agent' })).toBe(false)
  })

  it('missing session props stays inert regardless of state', () => {
    expect(isInert(true, null)).toBe(true)
  })

  it('goes inert right after a completed rollover (nothing to archive)', () => {
    expect(isInert(false, { ok: true, engineMounted: true, windowNo: 2, archivable: false })).toBe(true)
  })

  it('stays clickable while the live window holds archivable content', () => {
    expect(isInert(false, { ok: true, engineMounted: true, windowNo: 2, archivable: true })).toBe(false)
  })

  it('goes inert when a foreign compaction engine owns the slot', () => {
    expect(isInert(false, { ok: true, engineMounted: false, slotHolder: 'GlmCompactionEngine', archivable: false })).toBe(true)
  })
})

describe('buttonTitle (why-is-it-inert tooltip)', () => {
  it('explains the fresh-window case with the live window number', () => {
    expect(buttonTitle({ ok: true, engineMounted: true, windowNo: 2, archivable: false })).toBe(
      '窗口 #2 刚开、暂无可归档历史；发送下一条消息后可再次换窗',
    )
  })

  it('explains a foreign slot holder', () => {
    expect(buttonTitle({ ok: true, engineMounted: false, slotHolder: 'GlmCompactionEngine' })).toBe(
      '换窗不可用：压缩槽位由GlmCompactionEngine持有',
    )
  })

  it('falls back to the default copy for the clickable state', () => {
    expect(buttonTitle({ ok: true, engineMounted: true, windowNo: 2, archivable: true })).toBe(
      '一键换窗 = /smart-compact（归档本窗口、开新窗，草稿保留）',
    )
    expect(buttonTitle(null)).toContain('/smart-compact')
  })
})
