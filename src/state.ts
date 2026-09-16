/**
 * Button availability state — "would a click right now actually commit?"
 *
 * The composer button's disabled state is semantic, not cosmetic. The engine's
 * own invariant (dsh-compaction-basic) is: the framed handoff checkpoint must
 * price STRICTLY SMALLER than the shadowed content — otherwise the transaction
 * aborts with "summary is not smaller than the shadowed content" and the user
 * sees a red no-op receipt (observed on a freshly rolled window: the fixed
 * template priced >= the few tokens of new content). The probe therefore
 * mirrors that exact comparison using the same token meter the engine uses,
 * plus the same retain=0 range the manual path selects. The client half reads
 * the verdict through one exact HTTP route served over the profile's loopback
 * web server; the payload carries window counters only — never content.
 *
 * @module dsh-smart-compact/state
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionArchiveReader, eventText, sessionEvents, type SessionEventLike, type SessionLogLike } from './history.js'
import { handoffCheckpointText } from './rollover.js'

export interface WindowAvailability {
  /** Live window number (windows start at #1; ctx_history's "live window" numbering). */
  windowNo: number
  /** Whether a /smart-compact click right now has anything useful to archive. */
  archivable: boolean
}

/** Priced surface node as produced by the token meter's measure(). */
export interface PricedNodeLike {
  seq: number
  tokens: number
}

/**
 * The framed-checkpoint token cost, estimated once: the checkpoint is a user
 * message with three text blocks (preamble+open tag, our fixed handoff
 * template, close tag) priced by the host meter, plus a safety margin so the
 * probe errs toward "inert" — a wrongly enabled click buys a red receipt,
 * a wrongly disabled click costs nothing (the command stays available).
 */
export function framedCheckpointTokenEstimate(estimateMessage?: (message: unknown) => number): number {
  // Longest template variant (the no-notes wording) at a late window number.
  const template = handoffCheckpointText(98, false)
  const blocks = [
    { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.\n\n<compacted-summary>' },
    { type: 'text', text: template },
    { type: 'text', text: '</compacted-summary>' },
  ]
  let base: number
  if (typeof estimateMessage === 'function') {
    try {
      base = estimateMessage({ role: 'user', content: blocks })
    } catch {
      base = Math.ceil(template.length / 4)
    }
  } else {
    base = Math.ceil(template.length / 4)
  }
  // Margin covers host framing drift and keeps the comparison strictly biased
  // toward refusing a useless click.
  return base + 48
}

/**
 * Compute button availability from the durable event stream plus the SAME
 * priced surface measurement the engine's manual path selects with. With
 * retain=0 the shadowed range is the priced nodes from the first non-system
 * node to the end; a click is useful exactly when that mass exceeds the
 * framed checkpoint estimate (the engine refuses at >=). A null measurement
 * (meter unavailable) degrades to the old text-presence heuristic, which
 * fails open.
 */
export function windowAvailability(
  events: readonly SessionEventLike[],
  pricedNodes: readonly PricedNodeLike[] | null,
  framedTemplateTokens: number = framedCheckpointTokenEstimate(),
): WindowAvailability {
  const windows = new SessionArchiveReader(events, 0).listWindows()
  const windowNo = windows.length + 1
  if (pricedNodes === null || pricedNodes.length === 0) {
    const archived = new Set(windows.flatMap((w) => w.shadowedSeqs))
    const live = events.filter((e) => !e.type.startsWith('compaction/') && !archived.has(e.seq))
    return { windowNo, archivable: live.some((e) => eventText(e) !== '') }
  }
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const headEvent = bySeq.get(pricedNodes[0].seq)
  const firstIdx = headEvent !== undefined && headEvent.type === 'system/message' ? 1 : 0
  if (pricedNodes.length <= firstIdx) return { windowNo, archivable: false }
  let shadowedRouteTokens = 0
  for (let index = firstIdx; index < pricedNodes.length; index += 1) shadowedRouteTokens += pricedNodes[index].tokens
  return { windowNo, archivable: shadowedRouteTokens > framedTemplateTokens }
}

/** Narrow face of the profile web server the route registers against. */
export interface WebServerFace {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface StateRouteDeps {
  /** False = the compaction slot is foreign-owned; a click can only error. */
  engineMounted: boolean
  /** Owner name surfaced to the user when engineMounted is false. */
  slotHolder?: string
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
}

interface AgentsFace {
  get(id: string): { session?: unknown } | undefined
}

interface TokenMeterFace {
  measure(session: unknown): { nodes?: readonly PricedNodeLike[] }
  estimateMessage?(message: unknown): number
}

interface StateContext {
  webServer?: WebServerFace
  agents?: AgentsFace
  tokenMeter?: TokenMeterFace
}

/** The one route path; the client fetches it same-origin. */
export const STATE_ROUTE = '/dsh-smart-compact/state'

/**
 * Serve GET /dsh-smart-compact/state?sessionId=... with a JSON body
 * { ok, engineMounted, windowNo, archivable }.
 *
 * Registered only when the profile actually carries a webServer service
 * (headless profiles have none — the client then never gets state and fails
 * open to the always-clickable behavior). The registration rides ctx.effect,
 * so plugin unload removes the route with the fiber (no hot-reload residue).
 */
export function registerStateRoute(ctx: object, deps: StateRouteDeps): void {
  // The web server arrives through the plugin's inject list (same pattern as
  // dsh-html-dev's panel API) — that binds the ALREADY-LISTENING root
  // instance. A scope-chain get() probe was tried and rejected: on this cordis
  // it force-instantiated a SECOND WebServer on the plugin scope, whose init
  // then died on the taken port and failed the whole plugin fiber.
  const scope = ctx as StateContext
  let webServer: WebServerFace | undefined
  try {
    webServer = scope.webServer
  } catch {
    webServer = undefined
  }
  if (webServer === undefined || typeof webServer.register !== 'function') {
    deps.logger.info('dsh-smart-compact: no webServer service in this profile — button state route skipped (button stays click-through)')
    return
  }
  const agents = (ctx as StateContext).agents
  const tokenMeter = (ctx as StateContext).tokenMeter
  const respond = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if ((req.method ?? 'GET') !== 'GET') {
      respond(res, 405, { ok: false, reason: 'method-not-allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId === '') {
      respond(res, 400, { ok: false, reason: 'missing-sessionId' })
      return
    }
    if (!deps.engineMounted) {
      respond(res, 200, { ok: true, engineMounted: false, slotHolder: deps.slotHolder ?? null, windowNo: null, archivable: false })
      return
    }
    const agent = agents?.get(sessionId)
    if (agent === undefined) {
      // Unknown/cold session: fail open — the client keeps the button usable
      // and a click gets the authoritative receipt from the command path.
      respond(res, 200, { ok: false, reason: 'no-live-agent' })
      return
    }
    try {
      const events = sessionEvents(agent.session as SessionLogLike)
      let pricedNodes: readonly PricedNodeLike[] | null = null
      try {
        // Same meter instance the engine's manual path prices with.
        pricedNodes = tokenMeter?.measure(agent.session)?.nodes ?? null
      } catch {
        pricedNodes = null
      }
      const framed = framedCheckpointTokenEstimate(tokenMeter?.estimateMessage?.bind(tokenMeter))
      const { windowNo, archivable } = windowAvailability(events, pricedNodes, framed)
      respond(res, 200, { ok: true, engineMounted: true, windowNo, archivable })
    } catch (error) {
      respond(res, 200, { ok: false, reason: 'events-unavailable', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const cordis = ctx as { effect(fn: () => unknown, label?: string): void }
  cordis.effect(() => {
    try {
      const dispose = webServer.register({ kind: 'exact', path: STATE_ROUTE, handler })
      deps.logger.info('dsh-smart-compact: button state route registered at ' + STATE_ROUTE)
      return typeof dispose === 'function' ? dispose : undefined
    } catch (error) {
      // A route collision must never fail the plugin fiber: the button just
      // stays click-through (fail-open) and the incident is logged.
      deps.logger.warn('dsh-smart-compact: button state route registration failed — ' + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }, 'dsh-smart-compact: button state route')
}
