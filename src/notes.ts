/**
 * ctx_notes: per-session working notes that survive compaction and rollover.
 * Storage is one markdown file per session; every mutation is atomic.
 * @module dsh-smart-compact/notes
 */
import { mkdir, readFile, rename, appendFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { estimateTokens, truncateToTokens } from './config.js'

/** Make a session id safe to embed in a filesystem path. */
export function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_')
  if (safe.length === 0) throw new Error('dsh-smart-compact: session id sanitized to an empty string')
  return safe
}

export interface NoteSegment {
  index: number
  title: string
  writtenAt: string
  text: string
}

const SEGMENT_RE = /^## notes (\d+) — (\S+) (.*)$/

/** Split canonical notes markdown into ordered segments. */
export function parseSegments(markdown: string): NoteSegment[] {
  const segments: NoteSegment[] = []
  let current: NoteSegment | null = null
  for (const line of markdown.split('\n')) {
    const match = SEGMENT_RE.exec(line)
    if (match) {
      current = { index: Number(match[1]), writtenAt: match[2], title: match[3].trim(), text: '' }
      segments.push(current)
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line
    }
  }
  for (const segment of segments) segment.text = segment.text.replace(/\n+$/, '')
  return segments
}

/** Append-only store behind one canonical markdown file per session. */
export class NotesStore {
  constructor(private readonly root: string) {}

  private fileFor(sessionId: string): string {
    return join(this.root, sanitizeSessionId(sessionId), 'notes.md')
  }

  private async readRaw(sessionId: string): Promise<string> {
    try {
      return await readFile(this.fileFor(sessionId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw new Error(`dsh-smart-compact: cannot read notes for session ${sanitizeSessionId(sessionId)}: ${(error as Error).message}`)
    }
  }

  /** Replace the whole notes file atomically (temp file + rename). */
  async write(sessionId: string, content: string): Promise<void> {
    const file = this.fileFor(sessionId)
    try {
      await mkdir(dirname(file), { recursive: true })
      const stamp = new Date().toISOString()
      const body = `## notes 1 — ${stamp} (full replace)\n${content.trimEnd()}\n`
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, file)
    } catch (error) {
      throw new Error(`dsh-smart-compact: cannot write notes for session ${sanitizeSessionId(sessionId)} at ${this.root}: ${(error as Error).message}`)
    }
  }

  /** Append one titled segment; indices continue from the existing tail. */
  async append(sessionId: string, title: string, content: string): Promise<number> {
    const existing = await this.readRaw(sessionId)
    const nextIndex = parseSegments(existing).length + 1
    const file = this.fileFor(sessionId)
    try {
      await mkdir(dirname(file), { recursive: true })
      const stamp = new Date().toISOString()
      const block = `${existing ? '\n' : ''}## notes ${nextIndex} — ${stamp} ${title.trim() || '(untitled)'}\n${content.trimEnd()}\n`
      await appendFile(file, block, 'utf8')
      return nextIndex
    } catch (error) {
      throw new Error(`dsh-smart-compact: cannot append notes for session ${sanitizeSessionId(sessionId)} at ${this.root}: ${(error as Error).message}`)
    }
  }

  /** Read all notes, or one segment by 1-based index. */
  async read(sessionId: string, segmentIndex: number | undefined, maxTokens: number): Promise<string> {
    const markdown = await this.readRaw(sessionId)
    if (markdown === '') return '(notes are empty — write ctx_notes before the next rollover)'
    if (segmentIndex === undefined) return truncateToTokens(markdown.trim(), maxTokens, 'ctx_notes read')
    const segment = parseSegments(markdown).find((s) => s.index === segmentIndex)
    if (!segment) throw new Error(`dsh-smart-compact: no notes segment #${segmentIndex} for session ${sanitizeSessionId(sessionId)} (valid: ${parseSegments(markdown).map((s) => s.index).join(',') || 'none'})`)
    return truncateToTokens(`## notes ${segment.index} — ${segment.writtenAt} ${segment.title}\n${segment.text}`, maxTokens, `ctx_notes read #${segmentIndex}`)
  }

  /** Whether the session has any notes on disk (handoff-anchor honesty probe). */
  async hasNotes(sessionId: string): Promise<boolean> {
    return (await this.readRaw(sessionId)) !== ''
  }

  /**
   * Epoch ms of the newest segment's header stamp (each append records an ISO
   * stamp in-band), or null when there are no parseable segments. This is the
   * freshness anchor for the stale-notes gate (ISS-202609-00089191A: the
   * anchor vouched for notes that predated the session's latest work by a day).
   */
  async lastWrittenAtMs(sessionId: string): Promise<number | null> {
    const segments = parseSegments(await this.readRaw(sessionId))
    const last = segments.at(-1)
    if (!last) return null
    const ms = Date.parse(last.writtenAt)
    return Number.isFinite(ms) ? ms : null
  }

  /** Case-folded substring search across segments; returns segment headers plus matching lines. */
  async search(sessionId: string, keyword: string, maxTokens: number): Promise<string> {
    const needle = keyword.trim().toLowerCase()
    if (needle === '') throw new Error('dsh-smart-compact: ctx_notes search requires a non-empty keyword')
    const segments = parseSegments(await this.readRaw(sessionId))
    const hits: string[] = []
    for (const segment of segments) {
      const lines = `${segment.title}\n${segment.text}`.split('\n')
      const matched = lines.filter((line) => line.toLowerCase().includes(needle))
      if (matched.length > 0) hits.push(`#${segment.index} ${segment.title}\n${matched.map((l) => `  ${l.trim()}`).join('\n')}`)
    }
    if (hits.length === 0) return `(no notes segment matches ${JSON.stringify(keyword)})`
    return truncateToTokens(hits.join('\n'), maxTokens, 'ctx_notes search')
  }

  /** Estimated token size of the whole notes file (budget telemetry). */
  async estimateSizeTokens(sessionId: string): Promise<number> {
    return estimateTokens(await this.readRaw(sessionId))
  }
}

/** Shape of the ctx_notes tool arguments. */
export interface NotesArgs {
  action: 'write' | 'append' | 'read' | 'search' | 'list'
  content?: string
  title?: string
  segment?: number
  keyword?: string
}
