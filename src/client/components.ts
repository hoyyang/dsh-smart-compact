/**
 * The one visible piece: the composer rollover button.
 *
 * @module dsh-smart-compact/client/components
 */

import React from 'react'

/** Copy table; the plugin registers no locale service (context economy). */
const COPY_ZH = {
  aria: '立即换窗',
  title: '立即换窗（等同执行 /smart-compact：归档本窗口全部内容后开启新窗口，草稿不会被清除）',
}
const COPY_EN = {
  aria: 'Rollover now',
  title: 'Rollover now (equivalent to running /smart-compact: archives this window in full and opens a new one; your draft is preserved)',
}
type Copy = typeof COPY_ZH

function copy(): Copy {
  return typeof navigator !== 'undefined' && navigator.language !== undefined && navigator.language.toLowerCase().startsWith('zh') ? COPY_ZH : COPY_EN
}

/** Props the conversation renderer injects into a session-scoped slot entry. */
export interface SeatProps {
  sessionId?: string
  /** Snapshot selector hook over the Session input machine (standard session props). */
  useInput?: (selector: (state: unknown) => unknown) => unknown
  /** Stable public input actions for this Session (standard session props). */
  inputActions?: InputActionsFace
  /** Older-host fallback: a point-in-time input snapshot. */
  input?: { draft?: unknown }
}

/** Minimal composer action face the button needs. */
export interface InputActionsFace {
  setDraft(text: string): void
  submit(): void
}

const COMMAND = '/smart-compact'
/** How long the click animation plays; pure cosmetics, not an execution estimate. */
const BUSY_MS = 1200

/**
 * The click flow, factored out for unit tests: freeze the command into the
 * composer, submit through the host's own send path, then restore a non-command
 * draft. Measured against the host input machine — the enter event captures the
 * draft synchronously at submit, and the bare-token consume that fires on
 * settlement only clears a composer whose text still equals the token, so the
 * restored draft survives.
 */
export function runRollover(text: string, actions: InputActionsFace): void {
  actions.setDraft(COMMAND)
  actions.submit()
  if (text !== '' && text !== COMMAND) actions.setDraft(text)
}

/** Read the live draft, preferring the injected hook and falling back to a snapshot prop. */
function readDraft(props: SeatProps): string {
  if (typeof props.useInput === 'function') {
    const value = props.useInput((state: unknown) => {
      const s = state as { draft?: unknown } | null
      return s !== null && s !== undefined && typeof s.draft === 'string' ? s.draft : ''
    })
    if (typeof value === 'string') return value
  }
  const fallback = props.input !== undefined ? props.input.draft : undefined
  return typeof fallback === 'string' ? fallback : ''
}

/** Crisp white glyph: two chevrons collapsing into the center slot — the
 * rollover mark. Pure SVG so it stays razor-sharp next to the host's 16px
 * icons; the vortex texture lives under it in the plate (::after in styles). */
function Glyph(): React.ReactElement {
  return React.createElement('svg', { className: 'dsc-glyph', viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' },
  React.createElement('g', { fill: 'none', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round', strokeLinejoin: 'round' },
  React.createElement('path', { className: 'dsc-g-top', d: 'M5 2.4L8 5.1L11 2.4' }),
  React.createElement('path', { className: 'dsc-g-slot', d: 'M3.4 8H12.6' }),
  React.createElement('path', { className: 'dsc-g-bot', d: 'M5 13.6L8 10.9L11 13.6' }),
  ),
  )
}

/**
 * The rollover button: one click writes the command into the composer and
 * submits it through the host's own send path — pixel-for-pixel the same route
 * an Enter press on a typed `/smart-compact` takes (adjudication, execution,
 * receipt rendering are all host-owned).
 *
 * Draft safety, measured against the host input machine: a bare-token command
 * consume clears the composer ONLY while the composer text equals the token,
 * so the pre-click draft is restored right after submit and survives the
 * command's asynchronous settlement untouched.
 */
export function CompactButton(props: SeatProps): React.ReactElement {
  const t = copy()
  const [busy, setBusy] = React.useState(false)
  const timer = React.useRef<number | null>(null)
  React.useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  const draft = readDraft(props)
  const actions = props.inputActions

  const onClick = React.useCallback(() => {
    if (busy) return
    if (props.sessionId === undefined || actions === undefined) return
    runRollover(draft, actions)
    setBusy(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setBusy(false), BUSY_MS)
  }, [actions, busy, draft, props.sessionId])

  return React.createElement('button', {
    type: 'button',
    className: 'dsc-btn',
    'data-busy': busy ? 'true' : 'false',
    'data-inert': props.sessionId === undefined || actions === undefined ? 'true' : 'false',
    'aria-label': t.aria,
    title: t.title,
    onClick,
  },
  React.createElement(Glyph, null),
  React.createElement('span', { className: 'dsc-burst', 'aria-hidden': 'true', key: String(busy) }),
  )
}
