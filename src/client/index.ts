/**
 * dsh-smart-compact — client half.
 *
 * One slot entry and nothing else:
 * - `conversation.input.right` — the circular rollover button, immediately
 *   before the composer submit action. The slot is a list and the host's
 *   trailing cluster is margin-left:auto, so existing buttons reflow left on
 *   their own (verified against @deepseek-ai/dsh-client-ui-conversation
 *   0.1.5-rc.1 slot contract and the shipped sibling buttons).
 *
 * The button has no host-side surface: clicking it drives the standard
 * inputActions (setDraft + submit) — the exact path an Enter press on a typed
 * `/smart-compact` takes.
 *
 * @module dsh-smart-compact/client
 */

import React from 'react'
import { CompactButton } from './components.js'
import { STYLE_ATTR, css } from './styles.js'

/** Required client services. */
export const inject = ['slots']

interface SlotsFace {
  inject(seat: string, fn: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    priority?: number
    order?: number
    locale?: string
    inject?: (sessionId: string) => unknown
  }, component: unknown): unknown
}

interface ClientContext {
  slots: SlotsFace
  effect(fn: () => unknown | (() => void), label?: string): void
}

/**
 * Attach the client half.
 *
 * @param ctx - client context carrying `slots`.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    document.querySelectorAll('style[data-plugin="' + STYLE_ATTR + '"]').forEach((node) => { node.remove() })
    const style = document.createElement('style')
    style.dataset.plugin = STYLE_ATTR
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-smart-compact: styles')

  if (ctx.slots === undefined) {
    console.error('[dsh-smart-compact] no slots service; composer button not registered')
    return
  }

  // Composer tool row, closest to the submit action (order above all siblings).
  ctx.effect(() => {
    try {
      return ctx.slots.inject('conversation.input.right', function* () {
        yield ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-smart-compact-button',
          order: 90,
          inject: (sessionId: string) => ({ sessionId }),
        }, (slotProps: Record<string, unknown>) => React.createElement(CompactButton, slotProps as never))
      })
    } catch (error) {
      console.error('[dsh-smart-compact] button slot registration failed', error)
      return () => {}
    }
  }, 'dsh-smart-compact: composer button')
}
