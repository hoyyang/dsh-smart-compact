/**
 * Test-run isolation for the ops probe.
 *
 * The plugin resolves <DSH_HOME>/dsh-smart-compact/engine-state.json through
 * DSH_HOME at call time, so without this every test run rewrote the REAL user
 * probe (observed: the live probe came back with a temp notesDir and a reset
 * rolloverCount). dsh-home-paths reads process.env on each call, so an
 * env-level override covers every module, and individual tests may still point
 * DSH_HOME at their own temp dir.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const testHome = mkdtempSync(join(tmpdir(), 'dsh-smart-compact-test-home-'))

export default defineConfig({
  test: {
    env: { DSH_HOME: testHome },
  },
})
