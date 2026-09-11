import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.ts'

/** Registered-tool harness: apply() on a fake ctx, then drive the real execute() bodies. */
function harness(totalTokens = 0) {
  const tools = new Map<string, { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    tools: { register: (t: { name: string }) => { tools.set(t.name, t as never); return () => tools.delete(t.name) } },
    commands: { register: () => () => {} },
    // Mirror cordis: run the effect factory now and keep its disposer. A
    // generator factory (command registration) is created but not driven, so
    // commands.register stays untouched in this harness.
    effect: vi.fn((factory: () => unknown) => {
      const disposer = factory()
      return () => {
        if (typeof disposer === 'function') (disposer as () => void)()
      }
    }),
    on: vi.fn(),
    reflect: { provide: () => {} },
    get: vi.fn(() => undefined),
    tokenMeter: { measure: () => ({ totalTokens, surfaceTokens: 0, baseline: { kind: 'estimated' } }) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }) },
  }
  return { ctx, tools }
}

function archivedEvents() {
  return [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'postgres migration is forbidden' }] } },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'understood' }] } } },
    { seq: 2, type: 'compaction/summary', data: { shadowedSeqs: [0, 1], shadowedRange: { start: 0, end: 1 }, shadowedTokenCount: 100, provider: 'rollover-template', model: 'none', summary: [{ type: 'text', text: '[smart-compact rollover] Context window #2 opened.' }] } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'live window content only' }] } },
  ]
}

function session(events: Array<{ seq: number; type: string; data?: unknown }>) {
  return { id: 'sess-tools', seq: events.length, snapshotEvents: () => events }
}

async function withTools(events: Array<{ seq: number; type: string; data?: unknown }>, totalTokens = 0) {
  const { ctx, tools } = harness(totalTokens)
  const notesDir = await mkdtemp(join(tmpdir(), 'dsh-smart-compact-tools-'))
  apply(ctx as never, { notesDir, auto: true })
  const exec = { agent: { session: session(events), options: { provider: 'p', model: 'm' } }, signal: new AbortController().signal }
  return { tools, exec }
}

describe('host Session contract (runtime guard)', () => {
  it('exposes snapshotEvents() and no longer exposes events', () => {
    expect(typeof (Session.prototype as unknown as { snapshotEvents?: unknown }).snapshotEvents).toBe('function')
    expect('events' in Session.prototype).toBe(false)
  })
})

describe('ctx_history tool (registered execute bodies)', () => {
  it('lists archived windows and names the live window', async () => {
    const { tools, exec } = await withTools(archivedEvents())
    const out = String(await tools.get('ctx_history')!.execute({ action: 'list' }, exec))
    expect(out).toContain('window #1: seqs 0–1')
    expect(out).toContain('live window: #2')
  })

  it('names the first window as live before any rollover', async () => {
    const { tools, exec } = await withTools([{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }])
    const out = String(await tools.get('ctx_history')!.execute({ action: 'list' }, exec))
    expect(out).toContain('no rollover has happened yet')
    expect(out).toContain('live window: #1')
  })

  it('searches archived content by default and the live window on request', async () => {
    const { tools, exec } = await withTools(archivedEvents())
    const archived = String(await tools.get('ctx_history')!.execute({ action: 'search', keyword: 'postgres' }, exec))
    expect(archived).toContain('seq 0')
    const liveOnly = String(await tools.get('ctx_history')!.execute({ action: 'search', keyword: 'live window content' }, exec))
    expect(liveOnly).toContain('no archived event matches')
    const wider = String(await tools.get('ctx_history')!.execute({ action: 'search', keyword: 'live window content', archivedOnly: false }, exec))
    expect(wider).toContain('seq 3')
  })

  it('reads an original archived event and the rollover checkpoint back verbatim', async () => {
    const { tools, exec } = await withTools(archivedEvents())
    const body = String(await tools.get('ctx_history')!.execute({ action: 'read', seqs: [0] }, exec))
    expect(body).toContain('postgres migration is forbidden')
    const checkpoint = String(await tools.get('ctx_history')!.execute({ action: 'read', seqs: [2] }, exec))
    expect(checkpoint).toContain('Context window #2 opened')
  })

  it('fails loud when the host session cannot expose its log', async () => {
    const { tools, exec } = await withTools(archivedEvents())
    const legacy = { agent: { session: { id: 'legacy' }, options: { provider: 'p', model: 'm' } }, signal: exec.signal }
    await expect(tools.get('ctx_history')!.execute({ action: 'list' }, legacy)).rejects.toThrow(/does not expose snapshotEvents\(\)/)
  })
})

describe('get_context_remaining / ctx_notes tools', () => {
  it('reports the live budget', async () => {
    const { tools, exec } = await withTools(archivedEvents(), 12_345)
    const out = String(await tools.get('get_context_remaining')!.execute({}, exec))
    expect(out).toContain('remaining: 87655')
    expect(out).toContain('measurement baseline: estimated')
  })

  it('round-trips working notes', async () => {
    const { tools, exec } = await withTools(archivedEvents())
    const written = String(await tools.get('ctx_notes')!.execute({ action: 'write', content: 'goal: ship 0.3.0' }, exec))
    expect(written).toContain('notes replaced')
    const read = String(await tools.get('ctx_notes')!.execute({ action: 'read' }, exec))
    expect(read).toContain('goal: ship 0.3.0')
  })
})
