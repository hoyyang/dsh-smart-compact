import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { NotesStore, parseSegments, sanitizeSessionId } from '../src/notes.ts'

describe('sanitizeSessionId', () => {
  it('replaces path-hostile characters and rejects empty results', () => {
    expect(sanitizeSessionId('abc-123_X')).toBe('abc-123_X')
    expect(sanitizeSessionId('../../etc/passwd')).toBe('______etc_passwd')
    expect(sanitizeSessionId('///')).toBe('___')
    expect(() => sanitizeSessionId('')).toThrow(/session id sanitized to an empty string/)
  })
})

describe('parseSegments', () => {
  it('splits canonical segments and trims trailing newlines', () => {
    const md = '## notes 1 — 2026-01-01T00:00:00.000Z goal\ncontent one\n\n## notes 2 — 2026-01-02T00:00:00.000Z next\ncontent two'
    const segments = parseSegments(md)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ index: 1, title: 'goal', text: 'content one' })
    expect(segments[1]).toMatchObject({ index: 2, title: 'next', text: 'content two' })
  })
})

describe('NotesStore', () => {
  async function makeStore() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-auto-compact-notes-'))
    return { store: new NotesStore(root), root }
  }

  it('write replaces atomically: content readable and no tmp leftovers', async () => {
    const { store, root } = await makeStore()
    await store.write('s1', 'handoff state v1')
    await expect(store.read('s1', undefined, 8192)).resolves.toContain('handoff state v1')
    const dir = join(root, 's1')
    const leftovers = (await readdir(dir)).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('append continues indices and read(segment) returns exactly that segment', async () => {
    const { store } = await makeStore()
    const first = await store.append('s2', 'goal', 'ship the feature')
    const second = await store.append('s2', 'decision', 'postgres not mysql')
    expect([first, second]).toEqual([1, 2])
    const seg1 = await store.read('s2', 1, 8192)
    expect(seg1).toContain('ship the feature')
    expect(seg1).not.toContain('postgres not mysql')
    await expect(store.read('s2', 9, 8192)).rejects.toThrow(/no notes segment #9/)
  })

  it('search is case-folded and reports empty hits explicitly', async () => {
    const { store } = await makeStore()
    await store.append('s3', 'db', 'We chose PostgreSQL over MySQL')
    await expect(store.search('s3', 'postgresql', 8192)).resolves.toContain('PostgreSQL')
    await expect(store.search('s3', 'mongodb', 8192)).resolves.toContain('no notes segment matches')
    await expect(store.search('s3', '', 8192)).rejects.toThrow(/non-empty keyword/)
  })

  it('read on an empty session explains instead of failing', async () => {
    const { store } = await makeStore()
    await expect(store.read('s4', undefined, 8192)).resolves.toContain('(notes are empty')
  })

  it('write errors name the session and root (fail loud)', async () => {
    const store = new NotesStore('/proc/definitely/not/writable')
    await expect(store.write('s5', 'x')).rejects.toThrow(/cannot write notes for session s5/)
  })
})
