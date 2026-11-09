#!/usr/bin/env node
/**
 * Generate profile-layer overrides that turn the OFFICIAL preset compaction
 * engine (dsh-compaction-basic) to auto:false, so a single compaction owner
 * remains: dsh-smart-compact's rollover engine.
 *
 * Why this layer: the App bundle's presets/*.patch.yml are replaced wholesale by
 * a dsh upgrade (observed 2026-10-18 02:03: v0.2.0-rc.2 → v0.2.1-rc.2 wiped the
 * hand-added "auto: false"). The profile patch (~/.dsh/profiles/web/cordis.patch.yml)
 * survives upgrades, and the preset files themselves document the seam:
 * "Edits saved from the Web editor override this row's config.plugins by id from
 * the profile patch."
 *
 * Cost (documented, mitigated): the override pins the preset tree, so an upgrade
 * that changes a preset's plugin list leaves a stale pin behind. --verify
 * compares the pinned plugin ids with the live preset and reports drift.
 *
 * Usage:
 *   node scripts/write-preset-overrides.mjs                 # dry-run, prints the block
 *   node scripts/write-preset-overrides.mjs --apply         # backup + write into the profile patch
 *   node scripts/write-preset-overrides.mjs --verify        # drift check against the lock
 * Options: --presets-dir <dir> --patch <profile cordis.patch.yml> --presets ptc,standard,cordis
 *          --out <file> (write the block to a file instead of stdout)
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BLOCK_START = '# >>> dsh-smart-compact: official preset compaction disabled (managed block — regenerate, do not hand-edit)'
const BLOCK_END = '# <<< dsh-smart-compact: managed block end'
const DEFAULT_PRESETS = ['ptc', 'standard', 'cordis']

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes(name)
const die = (message) => { console.error('✖ ' + message); process.exit(1) }

function presetsDir() {
  const explicit = arg('--presets-dir')
  if (explicit) return explicit
  const candidates = [
    join(dirname(process.execPath), '..', 'Resources', 'app', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets'),
    '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-web-app/presets',
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  die('could not locate the dsh-web-app presets dir — pass --presets-dir')
}

/** Shift one insert row (4-space nested under "- insert:") out to a top-level entry. */
function toTopLevelRow(file, presetId) {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  const starts = []
  lines.forEach((line, index) => { if (new RegExp('^    - id: preset-' + presetId + '$').test(line)) starts.push(index) })
  if (starts.length !== 1) die(file + ': expected exactly one "    - id: preset-' + presetId + '" row, found ' + starts.length)
  const block = lines.slice(starts[0])
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  const shifted = block.map((line) => {
    if (line.trim() === '') return ''
    if (!line.startsWith('    ')) die(file + ': row is not nested by exactly 4 spaces: ' + JSON.stringify(line))
    return line.slice(4)
  })
  // Inject auto:false under the official compaction engine inside this preset row.
  const out = []
  let patched = 0
  for (let i = 0; i < shifted.length; i += 1) {
    out.push(shifted[i])
    const idMatch = /^(\s*)- id: compaction-basic$/.exec(shifted[i])
    if (!idMatch) continue
    const indent = idMatch[1]
    const name = shifted[i + 1]
    if (!name || !/^\s*name: '@deepseek-ai\/dsh-compaction-basic'$/.test(name)) {
      die(file + ': compaction-basic is not followed by its package name — preset shape changed, refusing to patch')
    }
    out.push(name)
    i += 1
    const after = shifted[i + 1] ?? ''
    if (new RegExp('^' + indent + '  config:').test(after)) {
      die(file + ': compaction-basic already carries a config block — inspect before regenerating')
    }
    out.push(indent + '  config:')
    out.push(indent + '    auto: false')
    patched += 1
  }
  if (patched !== 1) die(file + ': expected exactly one compaction-basic node, patched ' + patched)
  const text = out.join('\n')
  if ((text.match(/auto: false/g) ?? []).length !== 1) die(file + ': generated row must carry exactly one auto:false')
  return { text, hash: createHash('sha256').update(source).digest('hex') }
}

function pluginIds(text) {
  return text.split('\n').map((line) => /^\s*- id: (\S+)$/.exec(line)?.[1]).filter((id) => id && !id.startsWith('preset-'))
}

function buildBlock(presets) {
  const dir = presetsDir()
  const rows = []
  const lock = { generatedAt: new Date().toISOString(), presetsDir: dir, presets: {} }
  for (const preset of presets) {
    const file = join(dir, 'preset-placeholder')
    const target = join(dir, preset + '.patch.yml')
    if (!existsSync(target)) die('missing preset file: ' + target)
    const { text, hash } = toTopLevelRow(target, preset)
    rows.push('# preset "' + preset + '" — generated from ' + target.replace(HOME, '~'))
    rows.push(text)
    lock.presets[preset] = { source: target, sha256: hash, pluginIds: pluginIds(text) }
    void file
  }
  return { block: [BLOCK_START, ...rows, BLOCK_END].join('\n') + '\n', lock }
}

function writeBlock(patchPath, block) {
  const current = readFileSync(patchPath, 'utf8')
  const startAt = current.indexOf(BLOCK_START)
  const endAt = current.indexOf(BLOCK_END)
  let base = current
  if (startAt >= 0 && endAt > startAt) {
    const tailAfter = current.slice(endAt + BLOCK_END.length)
    base = current.slice(0, startAt) + tailAfter.replace(/^\n/, '')
  } else if (startAt >= 0 || endAt >= 0) {
    die(patchPath + ': half a managed block found — remove it manually first')
  }
  const backup = patchPath + '.bak-preset-override-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  copyFileSync(patchPath, backup)
  // An empty overlay is written as the literal "[]"; keep one valid document by
  // dropping the placeholder before appending list items.
  const emptied = base.replace(/^\s*\[\]\s*$/m, '')
  const next = emptied.endsWith('\n') || emptied === '' ? emptied + block : emptied + '\n' + block
  writeFileSync(patchPath, next, 'utf8')
  return backup
}

function verify() {
  const lockPath = join(HOME, 'dsh-smart-compact', 'preset-override.lock.json')
  if (!existsSync(lockPath)) die('no lock file at ' + lockPath + ' — run --apply first')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const dir = presetsDir()
  let drift = 0
  for (const [preset, pinned] of Object.entries(lock.presets)) {
    const target = join(dir, preset + '.patch.yml')
    if (!existsSync(target)) { console.error('DRIFT ' + preset + ': preset disappeared'); drift += 1; continue }
    const live = pluginIds(toTopLevelRow(target, preset).text)
    const added = live.filter((id) => !pinned.pluginIds.includes(id))
    const removed = pinned.pluginIds.filter((id) => !live.includes(id))
    if (added.length === 0 && removed.length === 0) { console.log('ok    ' + preset + ' (' + live.length + ' plugin rows)'); continue }
    drift += 1
    console.error('DRIFT ' + preset + ': +[' + added.join(', ') + '] -[' + removed.join(', ') + '] — the pinned preset is stale; rerun with --apply')
  }
  if (drift > 0) process.exit(1)
}

const presets = (arg('--presets') ?? DEFAULT_PRESETS.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
if (flag('--verify')) { verify(); process.exit(0) }

const { block, lock } = buildBlock(presets)
const outFile = arg('--out')
if (outFile) {
  writeFileSync(outFile, block, 'utf8')
  console.log('wrote ' + block.split('\n').length + ' lines to ' + outFile + ' (dry-run, nothing else touched)')
  process.exit(0)
}
if (!flag('--apply')) {
  console.log('--- generated managed block (dry-run) ---')
  console.log(block)
  console.log('--- end block; rerun with --apply to write it into the profile patch ---')
  process.exit(0)
}
const patchPath = arg('--patch') ?? join(HOME, 'profiles', 'web', 'cordis.patch.yml')
if (!existsSync(patchPath)) die('profile patch not found: ' + patchPath)
const backup = writeBlock(patchPath, block)
const lockPath = join(HOME, 'dsh-smart-compact', 'preset-override.lock.json')
mkdirSync(dirname(lockPath), { recursive: true })
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8')
console.log('applied: ' + patchPath + '\nbackup:  ' + backup + '\nlock:    ' + lockPath)
