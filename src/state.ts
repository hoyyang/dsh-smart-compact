/**
 * Button availability state — "would a click right now do anything?"
 *
 * The composer button's disabled state is semantic, not cosmetic: a click is
 * useful exactly when the live window still holds archivable (non-handoff)
 * conversation content. Right after a rollover the fresh window contains only
 * the handoff checkpoint, so the button goes inert until the next real
 * exchange lands. The client half reads this through one exact HTTP route
 * served by the host half over the profile's own loopback web server; the
 * payload carries window counters only — never conversation content.
 *
 * @module dsh-smart-compact/state
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionArchiveReader, eventText, sessionEvents, type SessionEventLike, type SessionLogLike } from './history.js'

export interface WindowAvailability {
  /** Live window number (windows start at #1; ctx_history's "live window" numbering). */
  windowNo: number
  /** Whether a /smart-compact click right now has anything to archive. */
  archivable: boolean
}

/**
 * Compute button availability from a session's durable event stream — the
 * same "nothing to switch" condition the command receipt reports as
 * "当前对话还没有可归档的历史": the live window's events are everything not
 * shadowed by a completed rollover and not compaction bookkeeping, and a
 * click is useful only when at least one of them projects to real text.
 */
export function windowAvailability(events: readonly SessionEventLike[]): WindowAvailability {
  const windows = new SessionArchiveReader(events, 0).listWindows()
  const archived = new Set(windows.flatMap((w) => w.shadowedSeqs))
  const live = events.filter((e) => !e.type.startsWith('compaction/') && !archived.has(e.seq))
  return {
    windowNo: windows.length + 1,
    archivable: live.some((e) => eventText(e) !== ''),
  }
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

interface StateContext {
  webServer?: WebServerFace
  agents?: AgentsFace
  /** Scope-chain service resolution (returns undefined for absent services). */
  get?(name: string): unknown
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
      const { windowNo, archivable } = windowAvailability(sessionEvents(agent.session as SessionLogLike))
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
