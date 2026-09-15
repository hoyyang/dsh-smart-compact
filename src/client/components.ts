/**
 * The one visible piece: the composer rollover button.
 *
 * Availability is semantic (v0.4.3): the button goes inert while the live
 * window has nothing to archive — right after a completed /smart-compact the
 * fresh window holds only the handoff checkpoint, so a second click would
 * just buy the host's "nothing to archive" error. The host half publishes
 * that condition on one same-origin state route; until state arrives (or if
 * it never does) the button fails OPEN and stays clickable.
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
/** Steady-state poll interval for the availability route (localhost JSON, cheap). */
const POLL_MS = 4000
/** Post-click catch-up probes: the rollover commits asynchronously, so the
 * first refresh may still read the pre-click window. */
const CLICK_REFRESH_MS = [BUSY_MS + 150, BUSY_MS + 1400, BUSY_MS + 3000]

/** The host-reported availability state (see src/state.ts for the authority). */
export interface WindowState {
  ok: boolean
  engineMounted?: boolean
  slotHolder?: string | null
  windowNo?: number | null
  archivable?: boolean
  reason?: string
  detail?: string
}

/**
 * Fetch the availability route. Any failure (route absent on an older host
 * half, headless profile, transient hiccup) resolves null — the caller fails
 * open. Returns null on non-2xx too: the state route speaks only in bodies.
 */
export async function fetchWindowState(sessionId: string, signal?: AbortSignal): Promise<WindowState | null> {
  try {
    const res = await fetch('/dsh-smart-compact/state?sessionId=' + encodeURIComponent(sessionId), { signal })
    if (!res.ok) return null
    const body = (await res.json()) as WindowState
    return body !== null && typeof body === 'object' ? body : null
  } catch {
    return null
  }
}

/**
 * The inert decision, factored out for unit tests. A missing state (route
 * absent, fetch failed, first load in flight) fails OPEN: the button stays
 * clickable and a click gets the authoritative receipt from the host.
 */
export function isInert(propsMissing: boolean, state: WindowState | null | undefined): boolean {
  if (propsMissing) return true
  if (!state || state.ok !== true) return false
  if (state.engineMounted === false) return true
  return state.archivable === false
}

/** Tooltip text for the current state; explains WHY the button is inert. */
export function buttonTitle(state: WindowState | null | undefined): string {
  if (state !== null && state !== undefined && state.ok === true) {
    if (state.engineMounted === false) {
      return '换窗不可用：压缩槽位由' + (state.slotHolder ?? '其它压缩引擎') + '持有'
    }
    if (state.archivable === false) {
      return '窗口 #' + String(state.windowNo ?? '?') + ' 刚开、暂无可归档历史；发送下一条消息后可再次换窗'
    }
  }
  return COPY.title
}

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
 * Availability: inert while the host reports "nothing to archive" (fresh
 * window after a rollover) or a foreign compaction engine holds the slot —
 * polled so it re-enables by itself once the next real exchange lands.
 *
 * Draft safety, measured against the host input machine: a bare-token command
 * consume clears the composer ONLY while the composer text equals the token,
 * so the pre-click draft is restored right after submit and survives the
 * command's asynchronous settlement untouched.
 */
export function CompactButton(props: SeatProps): React.ReactElement {
  const t = COPY
  const [busy, setBusy] = React.useState(false)
  const [windowState, setWindowState] = React.useState<WindowState | null>(null)
  const timers = React.useRef<Set<number>>(new Set())
  React.useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current.clear()
  }, [])

  const sessionMissing = props.sessionId === undefined || props.inputActions === undefined
  const inert = isInert(sessionMissing, windowState)

  // Availability poll: fetch once per session, then keep the truth fresh at a
  // slow tick (auto-rollovers and other windows flip the state too). Stops
  // clearing timers on session switch — the cleanup covers both loops.
  React.useEffect(() => {
    if (typeof props.sessionId !== 'string') {
      setWindowState(null)
      return undefined
    }
    const sessionId = props.sessionId
    let alive = true
    const schedule = (fn: () => void, ms: number): void => {
      const id = window.setTimeout(() => {
        timers.current.delete(id)
        if (alive) fn()
      }, ms)
      timers.current.add(id)
    }
    const tick = (): void => {
      void (async () => {
        const state = await fetchWindowState(sessionId)
        if (!alive) return
        setWindowState(state)
        schedule(tick, POLL_MS)
      })()
    }
    tick()
    return () => { alive = false }
  }, [props.sessionId])

  const refresh = React.useCallback((sessionId: string) => {
    for (const ms of CLICK_REFRESH_MS) {
      const id = window.setTimeout(() => {
        timers.current.delete(id)
        void (async () => {
          const state = await fetchWindowState(sessionId)
          setWindowState((previous) => (state === null ? previous : state))
        })()
      }, ms)
      timers.current.add(id)
    }
  }, [])

  const actions = props.inputActions
  const draft = readDraft(props)

  const onClick = React.useCallback(() => {
    if (busy || inert) return
    if (props.sessionId === undefined || actions === undefined) return
    runRollover(draft, actions)
    setBusy(true)
    refresh(props.sessionId)
    const id = window.setTimeout(() => {
      timers.current.delete(id)
      setBusy(false)
    }, BUSY_MS)
    timers.current.add(id)
  }, [actions, busy, draft, inert, props.sessionId, refresh])

  return React.createElement('button', {
    type: 'button',
    className: 'dsc-btn',
    'data-busy': busy ? 'true' : 'false',
    'data-inert': inert ? 'true' : 'false',
    'aria-label': t.aria,
    'aria-disabled': inert ? 'true' : 'false',
    title: buttonTitle(windowState),
    onClick,
  },
  React.createElement('span', { className: 'dsc-burst', 'aria-hidden': 'true', key: String(busy) }),
  )
}
