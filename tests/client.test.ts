// @vitest-environment node
/**
 * Client-half regression: the rollover click flow and the rendered shape.
 *
 * The click flow is the plugin's one behavioural promise — click == /smart-compact,
 * draft preserved — asserted here against a recorded action face; the markup test
 * pins the plate structure the stylesheet keys on.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompactButton, runRollover } from '../src/client/components.js'

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
  it('renders the plate with orbit, core and burst layers', () => {
    const html = renderToStaticMarkup(React.createElement(CompactButton, {
      sessionId: 's1',
      inputActions: recordActions(),
    }))
    expect(html).toContain('dsc-btn')
    expect(html).toContain('dsc-orbit')
    expect(html).toContain('dsc-core')
    expect(html).toContain('dsc-burst')
    expect(html).toContain('aria-label')
  })

  it('marks itself inert without session props', () => {
    const html = renderToStaticMarkup(React.createElement(CompactButton, {}))
    expect(html).toContain('data-inert="true"')
  })
})
