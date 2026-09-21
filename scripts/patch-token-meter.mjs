#!/usr/bin/env node
/**
 * Host patch: make the token meter tolerate a dangling step/start.
 *
 * A host restore/remount can start a new turn (counter reset) while the
 * durable stream still holds an open step/start with no matching step/end.
 * The meter's fail-loud fold then throws on EVERY measure() of that session
 * forever — bricking /smart-compact, the budget reminder and host compaction
 * for the session (observed live: "step/start at seq 2787 arrived before
 * turn 3/step 1 ended", 4 sessions affected on this host).
 *
 * This patch replaces the throw with a console.warn auto-close: the doomed
 * step is treated as ended (exactly what its missing step/end would have
 * done); healthy streams never hit the branch, so behavior is unchanged.
 *
 * Idempotent: skips files already patched. Backs up every file it touches to
 * <file>.bak-<timestamp> and restores the backup if the patched copy fails
 * `node --check`. Re-run after every dsh upgrade (node_modules is wiped).
 * Exit 0 only when every target ended up patched or already-patched.
 * @module dsh-smart-compact/scripts/patch-token-meter
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const DSH = process.env.DSH_MAIN_HOME ?? join(process.env.HOME ?? '', '.npm-global/lib/node_modules/@deepseek-ai/dsh')
const METER = join(DSH, 'node_modules/@deepseek-ai/dsh-token-meter')
const TARGETS = [join(METER, 'lib/index.js'), join(METER, 'lib/types/index.js')]
const MARK = 'auto-healed dangling step/start'
const CORE = 'token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended'
const ESCAPE = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const THROW_RE = new RegExp('throw new Error\\(`' + ESCAPE(CORE) + '`\\);', 'g')
const REPLACEMENT = 'console.warn(`token meter: ' + MARK + ' (turn ${state.stepStart.turn}/step ${state.stepStart.step} had no step/end) at new step/start seq ${event.seq}`);'

const ts = new Date().toISOString().replace(/[:.]/g, '-')
let failures = 0
for (const file of TARGETS) {
  if (!existsSync(file)) { console.error('FAIL missing ' + file); failures++; continue }
  const src = readFileSync(file, 'utf8')
  if (src.includes(MARK)) { console.log('SKIP already patched: ' + file); continue }
  const hits = [...src.matchAll(THROW_RE)]
  if (hits.length !== 1) { console.error('FAIL expected exactly 1 invariant site in ' + file + ', found ' + hits.length); failures++; continue }
  copyFileSync(file, file + '.bak-' + ts)
  writeFileSync(file, src.replace(THROW_RE, () => REPLACEMENT))
  try {
    execFileSync(process.execPath, ['--check', file])
  } catch (error) {
    copyFileSync(file + '.bak-' + ts, file)
    console.error('FAIL syntax check failed, backup restored: ' + file + '\n' + String(error))
    failures++
    continue
  }
  console.log('PATCHED (backup .bak-' + ts + '): ' + file)
}
process.exit(failures === 0 ? 0 : 1)
