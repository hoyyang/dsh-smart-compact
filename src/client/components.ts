/**
 * The one visible piece: the composer rollover button.
 *
 * @module dsh-smart-compact/client/components
 */

import React from 'react'

/** Copy: concise Chinese for everyone — the user reads Chinese, the command
 * itself stays in English. No navigator-language guessing (the user's browser
 * reported a non-zh locale and shipped an English tooltip once). */
const COPY = {
  aria: '一键换窗',
  title: '一键换窗 = /smart-compact（归档本窗口、开新窗，草稿保留）',
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
  const t = COPY
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
  React.createElement('span', { className: 'dsc-burst', 'aria-hidden': 'true', key: String(busy) }),
  )
}
