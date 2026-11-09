# dsh-smart-compact

![banner](assets/banner.svg)

**Give DeepSeek Harness a context window that manages itself: when the window fills up, roll over to a fresh one with zero model calls — the old window stays archived verbatim and readable line by line.**

Lossless, zero-model context rollover for DeepSeek Harness: switch before the provider wall, archive the old window verbatim, and resume from notes instead of a degraded summary.

[**中文**](README.md) · [Releases](https://github.com/hoyyang/dsh-smart-compact/releases) · [Changelog](CHANGELOG.md)

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-smart-compact"><img src="https://img.shields.io/npm/v/dsh-smart-compact" alt="npm version"></a>
  <img src="https://img.shields.io/badge/dsh%E2%89%A50.1.5--rc-plugin-blue" alt="dsh version">
  <img src="https://img.shields.io/badge/tests-184%20passed-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-green" alt="license">
</p>

## Install

```sh
dsh plugin --profile web add dsh-smart-compact
```

Alternative channel (GitHub source form; the npm name is the globally unique identifier, so prefer the command above): `dsh plugin --profile web add github:hoyyang/dsh-smart-compact`

**Works out of the box (zero configuration)**: every configuration key is optional and its default is the shipping behavior — it takes effect as soon as you start `dsh web` after installing. No build step on the user side. Requires dsh `>= 0.1.5-rc` (uses `Session.snapshotEvents()`).

Update: `dsh plugin --profile web update dsh-smart-compact@latest`

## What you get

- **Zero-model-call rollover**: when the window reaches the line, the engine mechanically switches to a fresh window without invoking a summarization model once — cheaper, zero hallucination, zero latency.
- **100% lossless archiving**: the old window enters the local durable stream exactly as it was — not a compressed summary; recall it verbatim at any time.
- **Handoff anchor**: the new window's first message carries `Task:` / `Last action:` orientation lines derived mechanically — no more guessing "what was I just doing".
- **Stale-notes gate (v0.5.2)**: when the handoff notes lag behind actual progress, the anchor downgrades to a ⚠️ STALE warning plus a mechanical activity tail — it never endorses outdated state.
- **Working notes ctx_notes**: write / append / read / search / list — five operations that survive compaction and window switches.
- **Lossless recall ctx_history**: window inventory, precise read-back by seq, full-text search over archived content.
- **Budget visibility get_context_remaining**: the session's total / window / remaining tokens, queryable in real time.
- **On-demand rollover new_context**: the model asks for a fresh window; it takes effect once the current step's sampling finishes — never mid-step.
- **Human command /smart-compact**: one command rolls over immediately; the receipt is human-readable with ✅ / ❌ prefixes — never a silent downgrade.
- **One-click rollover button**: a 26px perfect-circle button in the composer tool row; one click equals `/smart-compact`, with draft protection built in.
- **Three-band automatic rollover (v0.6.0)**: quiet → grace reminder → forced rollover, host-event-driven, threshold unified at 0.75 (with per-provider overrides).
- **Budget-equation threshold (v0.6.1)**: trigger = min(ratio × window, usable wall − buffer), where the usable wall = window − completion reservation (max_tokens). It never waits past the provider wall.
- **Zero-output truncation recovery (v0.6.2)**: a turn that ends `max-tokens` with neither text nor a tool call switches the window first and then continues — nobody has to type "continue".
- **Routed-model truth (v0.6.3)**: the window follows the provider/model of the latest real request, so a mid-session model switch (deepseek → azure) no longer measures the old 1M window.
- **Mandatory sanitization**: anchor text authored by the engine passes phone / email / national-ID / company-name sanitization; hits are logged as counts, never echoed.
- **Observability**: engine-state.json records every rollover trigger, refusal reason, budget measurement, and a per-session evidence ledger (last 8 sessions).

## Quick start

1. Install: `dsh plugin --profile web add dsh-smart-compact`.
2. Start `dsh web` — the engine arms itself automatically (auto is on by default; nothing to configure).
3. Open a session and work normally; the context meter next to the composer input updates live.
4. At 25 / 50 / 75% the model receives tiered reminders telling it to write handoff notes.
5. Above the trigger line and within trigger + 8192 tokens is the grace band: the model gets one "write ctx_notes now" reminder.
6. Past the grace band the engine rolls over automatically — zero model calls, the exact same path as manual `/smart-compact`.
7. After the rollover the new window's first message is the handoff anchor, naming the window number and the archived interval.
8. In the new window, `ctx_notes read` continues the notes and `ctx_history search` recalls old details.
9. Run `cat ~/.dsh/dsh-smart-compact/engine-state.json` anytime to check the mode, thresholds, and rollover count.
10. Done with it: `dsh plugin --profile web remove dsh-smart-compact` — uninstall leaves nothing behind.

## Usage

- **Check the remaining budget**: ask the model "how much context is left" and it calls `get_context_remaining` for total / window / remaining.
- **Roll over by hand**: type `/smart-compact` in the composer; the old window is archived and a fresh one opens, with the new window number and archive size on the receipt's first line.
- **Roll over with the button**: click the gold circle in the composer tool row — identical to `/smart-compact`, and your unsent draft is restored verbatim.
- **Write handoff notes**: have the model `ctx_notes write` the current task, the files already changed, and the next step — that is what it resumes from.
- **Append a note section**: `ctx_notes append` adds a titled segment to the end of the notes without overwriting earlier content.
- **Read the notes back**: `ctx_notes read` returns note segments — across windows and across sessions.
- **List archived windows**: `ctx_history list` prints each window's seq range, event count, and estimated tokens, and marks the live window.
- **Full-text search the archive**: `ctx_history search "error keyword"` scans every archived window and returns matching events with seqs.
- **Read by seq**: `ctx_history read seqs=[12,13,14]` returns the original events verbatim.
- **Let the model switch**: the model calls `new_context`; the switch happens right after the current step's sampling — good when the task has just wrapped up.
- **Inspect runtime state**: `cat ~/.dsh/dsh-smart-compact/engine-state.json` shows the mode, thresholds, last measurement, and refusal reason.

### Input and output

Each pair below is real output from this machine (2026-09 / 2026-10 sessions), not an illustration:

Input: `/smart-compact`
Output: `✅ 已换窗 → 窗口 #2 · 归档 window #1（223 events / ~121k tokens）`

Input: `ctx_history list`
Output: `window #1: seqs 10–827 (223 events, ~121034 tokens archived) · live window: #2`

Input: a committed rollover (any trigger)
Output: the new window's first message: `[smart-compact rollover] Context window #2 opened. The previous window was archived in full`

Input: `ctx_history search <term>`
Output: 23 cross-window hits, each with its event seq and summary line

Input: rollover while the notes lag behind
Output: the anchor downgrades to `⚠️ STALE` with the notes timestamp and the activity count since

Input: `ctx_notes read`
Output: note segments returned in order, with their timestamps

Input: `cat ~/.dsh/dsh-smart-compact/engine-state.json`
Output: a JSON snapshot with `version`, `effectiveThresholds`, `functioning.lastMeasure`, and `functioning.sessions`

Input: `node scripts/write-preset-overrides.mjs --verify`
Output: on drift, the added/missing plugin rows and exit code 1; on a match, a quiet exit 0

## Use cases

- **Long-session auto-extension**: an all-day coding session rolls over automatically as it fills up — the task never interrupts and no context is lost.
- **Early manual rollover**: wrap up a topic on your own terms, one click, without waiting for thresholds.
- **Cross-session relay**: continue yesterday's session today — the new window picks up from the anchor plus notes, no scrolling through chat history.
- **Incident retrospective**: "how exactly was that error pinpointed last week" — `ctx_history search` reads the original events back by seq.
- **Multi-window task orientation**: no blind continuation after a switch — the anchor's `Task:` line states the current task outright.
- **Stale-notes protection**: rolled over before the notes were written? The ⚠️ STALE anchor says so; the new window verifies first.
- **Sensitive-data protection**: anchors are sanitized for phone numbers / emails / national IDs / company names, so automatically propagated surfaces never leak personal data.
- **Cost control**: zero summarization calls — a rollover costs zero tokens, and budget reminders let the model plan the handoff.
- **Coexistence**: single-slot courtesy means it lives alongside the official compaction-basic, dsh-glm, and dsh-kiro.
- **Ops observability**: the engine-state probe records triggers, refusal reasons, and budget measurement state — no guessing when something breaks.

## Output

- **Rollover receipt**: returns a ✅-prefixed Chinese receipt whose first line names the new window and the archived volume (`223 events / ~121k tokens`); tapping the card expands the post-switch budget.
- **Handoff anchor**: generates the new window's first message `[smart-compact rollover] Context window #2 opened` plus the `Task:` and `Last action:` orientation lines.
- **Window inventory**: `ctx_history list` outputs each window's seq range, event count, and estimated tokens, and marks the live one.
- **Search hits**: `ctx_history search` outputs the matching events with their seqs and first-line summaries (23 hits measured across windows).
- **Verbatim read-back**: `ctx_history read` outputs the original event bodies, identical to what was archived.
- **Sanitization log**: writes `handoff anchors sanitized — 3 redaction(s)` — counts and categories only, never the original text.
- **State snapshot**: `engine-state.json` outputs `version`, `effectiveThresholds`, and `functioning.lastMeasure` (provider, model, usableWindow, thresholdTokens).
- **Failure receipt**: a failed `/smart-compact` outputs a ❌ line naming the underlying error (e.g. the slot is held), keeps the request pending, and never swallows it.
- **Drift alarm**: `write-preset-overrides.mjs --verify` outputs the added/missing plugin rows on structural drift, exit code 1.
- **Recovery record**: after a degenerate-turn switch the continuation message carries `source.kind = plugin:dsh-smart-compact` and the ledger records the `continuation` trigger.

## When it fits

- **Fits**: long-running sessions (coding, research, ops), agent workflows that regularly hit the context ceiling, teams with zero tolerance for summary distortion, anyone who wants rollovers that cost zero tokens.
- **Fits**: PTC workflows that switch provider/model mid-session — 0.6.3 measures the window of the latest real request, so the switch takes effect on the next step.
- **Does not fit**: light users who only occasionally run `/compact` — the host command is enough, and the plugin adds a layer.
- **Does not fit**: semantic compression that rewrites the old conversation into a paragraph — this plugin archives mechanically and hands off through pointers.
- **Does not fit**: fine-grained retention policies (keep tails by file path or tool type) — the plugin deliberately exposes only a few threshold keys.

## Comparison

| Capability | dsh-smart-compact 0.6.3 | Official dsh-compaction-basic | Host built-in /compact |
|---|---|---|---|
| Switch mechanism | Mechanical archive, zero model calls | LLM summary compaction | LLM summary compaction |
| Old content readable verbatim | ✅ `ctx_history` read-by-seq | ❌ summary only, original events gone | ❌ same |
| Rollover token cost | **0** | one summarization call | one summarization call |
| Trigger line | min(ratio×window, window−max_tokens−buffer), default ratio 0.75 | fixed ratio (default 0.8) | manual |
| Correct after a mid-session model switch | ✅ latest request header wins (0.6.3) | measured internally by the engine | n/a |
| Task orientation for the new window | ✅ `Task:` / `Last action:` | none | none |
| Stale-notes gate | ✅ ⚠️ STALE when notes lag | none | none |
| Zero-output truncation recovery | ✅ switch first, then continue (0.6.2) | none (the turn just ends) | none |
| Human entry point | `/smart-compact` + composer button | `/compact` | `/compact` |
| Telemetry | engine-state.json + per-session ledger | host logs | none |

Basis: the official engine's source (`@deepseek-ai/dsh-compaction-basic` summarizes through `llm.summarize`, pressure band defaults to 0.8) and this plugin's `src/rollover.ts` / `src/budget.ts`. Only measured differences are listed; where the other side is stronger, the cell stays factual.

## Advanced

### The /smart-compact command

Opens a fresh window immediately and archives the old one losslessly (zero model calls). When the compaction slot is held by another engine the command **fails loudly** — it never silently degrades to a summary. The receipt's first line is short (GUI truncation), the card expands to the full text including the post-switch budget; failures carry a ❌ prefix. Anchor honesty (v0.3.2): if the session never wrote `ctx_notes` before the switch, the anchor downgrades to "recall with ctx_history" and the receipt says so.

### The composer button (v0.4.5)

A **26px perfect circle** (amber-gold vortex on a deep bronze plate) between the context meter and the send key. One click equals `/smart-compact`: it writes the command into the composer and submits through the host's own send path.

- **Perfect circle**: geometry locked with `!important` plus a physical `clip-path: circle(50%)` crop, immune to the host's own important row-button rules.
- **Draft safety**: unsent text is saved on click and restored verbatim after the command is captured.
- **Semantic availability**: greyed out right after a switch (the fresh window has too little to archive), on a brand-new session, or while another engine holds the slot. The decision uses the same inequality as the engine (the archived range must price strictly above the handoff checkpoint). The host half serves it through `GET /dsh-smart-compact/state?sessionId=…`, which returns only the window number and an archivable flag — **no session content** — and is unregistered with the plugin fiber.
- **Fail-open**: if the state route is unreachable the button stays clickable and the command receipt is the fallback.

### The three automatic bands (v0.6.0 / v0.6.1 / v0.6.2)

Automatic rollover is a host-event-driven path: the engine registers as the host compaction service and is called at every step boundary (`agent/pre-step`) and at the window-overflow recovery point (`context-overflow`).

- **quiet**: below the trigger line — do nothing;
- **grace**: trigger line to trigger + 8192 tokens — remind once to write notes, keep working (once per window generation);
- **forced**: ≥ trigger + 8192 tokens — run exactly the same mechanical rollover as manual `/smart-compact`.

The trigger is a **budget equation** (v0.6.1): `threshold = min(ratio × contextWindow, (contextWindow − completionReserve) − 8192)`. `completionReserve` comes from the latest request header's `max_tokens`, falling back to the adapter's `defaultMaxTokens`. Measured on this machine:

| Route | Window | max_tokens | Usable wall | Threshold |
|---|---:|---:|---:|---:|
| deepseek-official/deepseek-flash | 1,000,000 | 384,000 | 616,000 | 607,808 |
| azure_openai/gpt-6.1-sol | 272,000 | 128,000 | 144,000 | 135,808 |

The anti-churn floor (v0.6.0, default 100,000 tokens) is capped on small windows to `min(configured, usable wall − post-switch baseline − buffer)`; otherwise a small window would lock itself out right after a switch and wait for the wall.

### Racing the official engine (v0.6.0)

The official `dsh-compaction-basic` defaults to `auto: true` with a 0.8 threshold and hangs off the same `agent/pre-step` — whoever crosses its line first wins, so this plugin must sit strictly below 0.8. The 0.85 of 0.5.x inevitably lost the race: all 6 automatic compactions in the 2026-10-23..25 ptc sessions were official LLM summaries.

A dsh upgrade replaces the whole App-bundle `presets/*.patch.yml` (verified 2026-10-18, when an upgrade wiped a hand-added `auto: false`), so v0.6.0 moves the sole owner into the user layer that upgrades do not touch:

```sh
node scripts/write-preset-overrides.mjs            # dry run: print the preset override block
node scripts/write-preset-overrides.mjs --apply    # back up the profile patch, then write (compaction-basic auto:false for ptc/standard/cordis)
node scripts/write-preset-overrides.mjs --verify   # drift check: exit 1 when the preset structure changed
```

The override lands in `<dsh home>/profiles/web/cordis.patch.yml` and produces `preset-override.lock.json` (source preset sha256 + plugin id order). The cost is a pinned tree: if a dsh upgrade changes the preset plugin list, `--verify` names the added/missing rows and `--apply` re-pins. Roll back by restoring `cordis.patch.yml.bak-preset-override-*` and deleting the lock.

Even without the override the engine never loses silently: a compaction summary not authored by this plugin is recorded in `functioning.foreignCompactions` with a warning.

### Mandatory sanitization (v0.5.0, no switch)

Engine-authored text — the anchor's `Task:` / `Last action:` lines — is sanitized before it enters the new window: phone numbers, emails, 18-digit national IDs, Chinese/English company names (suffix-based). Hits are logged as counts and categories (`handoff anchors sanitized — N redaction(s)`), never echoed. Boundary, on purpose: the verbatim `ctx_history` archive is **not** redacted — lossless local recall is the core contract; only automatically propagated surfaces are sanitized. Tests and docs use synthetic data only.

### Zero-output truncation recovery (v0.6.2)

A turn that ends `max-tokens` while its assistant message carried neither text nor a tool call is an unusable answer (the whole completion budget went into reasoning). The host disarms the goal on that reason and nothing retries, so the session stops. The watcher switches the window first (zero model calls; it switches when the measurement is unavailable or at/above half the usable band), then continues through exactly one path: `goals.resume()` when an active goal was disarmed, otherwise one injected continuation message with `source.kind = plugin:dsh-smart-compact`. Guards: human sessions only, idle agent only, no queued messages, one recovery per turn, at most 2 consecutive (`maxConsecutiveRecoveries`), reset on a completed turn or a real user message.

### Routed-model truth: the latest real request (v0.6.3)

Window and completion reservation are resolved from `session.requestHeader()`; `agent.options` (the seed model captured at creation) is the fallback before the first request. Reason: the model selector rewrites the header on every request while options never update — a PTC session created on deepseek and switched to azure was still measured as a 1M window, so a 607,808 threshold never met the 144,000 wall, the provider clamped the completion to ~16 tokens, and the turn died with nothing visible (407k prompt measured on 2026-11-06).

### Configuration (config.toml → plugin config)

Every key is optional; the default is the shipping behavior:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch; false keeps the plugin completely quiet |
| `auto` | `true` | automatic rollover + reminders + new_context; false leaves only manual `/smart-compact` |
| `thresholdRatio` | `0.75` | automatic trigger ratio; must stay below the official engine's 0.8 |
| `minAddedTokens` | `100000` | anti-churn floor: no switch until this many tokens were added; `0` disables |
| `autoContinue` | `true` | zero-output truncation recovery |
| `maxConsecutiveRecoveries` | `2` | consecutive recoveries per session (1–5) |
| `providerThresholds` | `{ "kiro-vision": 0.75 }` | per-provider ratio override; `{}` = global |
| `fallbackBufferTokens` | `8192` | grace band width |
| `maxToolOutputTokens` | `8192` | per-tool-output truncation cap |
| `notesDir` | `<dsh home>/dsh-smart-compact/notes` | notes directory |
| `retainRatio` | `0.16` (engine default) | config validation only; since 0.5.7 a rollover keeps just the latest round |

### Observability (engine-state.json)

`functioning` records `evaluations`, `lastMeasure` (provider / model / totalTokens / contextWindow / completionReserve / usableWindow / thresholdTokens), `lastSkipReason`, `foreignCompactions`, and — since 0.6.2 — a per-session ledger for the last 8 sessions. Together with `effectiveThresholds`, "is it evaluating, who won the race, why did it not switch" never needs a probe build.

### Compatibility

- **Single slot**: the `compaction` service is a single slot; this plugin takes it by default and must be listed before other compaction engines in the profile bundles. Yielding engines skip mounting through their own courtesy check; the `engineMounted` probe says who holds the slot.
- **Requires dsh >= 0.1.5-rc**: session logs are read through `Session.snapshotEvents()` (upstream removed `Session.events` before 0.1.5). When the host does not provide it the plugin fails loudly instead of silently forgetting.
- **Isolated from third-party toolResultPruner**: the engine runs on `ctx.isolate('toolResultPruner')` and never consults it (a stale copy aborts every rollover inside basic compaction).
- **Requests are never silently swallowed**: `new_context` is consumed only when a rollover actually commits; refusals and errors keep the request pending, retried each step, with the reason in `lastRolloverRefusedAt` / `lastRolloverRefusedReason` (same reason merged within 30s).
- **Rebuild after a dsh upgrade**: the plugin's bundled `node_modules` is the real resolution target at runtime — rerun `npm install` and rebuild `lib/` after upgrading dsh.
- **Host token-meter patch**: `node scripts/patch-token-meter.mjs` idempotently repairs the meter replay crash (backup + syntax check); rerun it after every dsh upgrade.

### Uninstall

```sh
dsh plugin --profile web remove dsh-smart-compact
```

Uninstalling removes every tool, listener, and engine with the plugin fiber; notes files are kept under `notesDir` (delete that directory manually if unwanted).

## How it works

When the context fills up the engine does not write an LLM summary. It archives the old window intact (the session's existing durable event stream — no new storage), grants an 8192-token grace band for the model to write handoff notes, then opens a clean new window containing only a fixed template ("the previous window is archived in full; current state is in ctx_notes; use ctx_history for detail"). Zero summarization calls; nothing is lost and everything can be read back exactly.

The anchor follows the notes: if the session wrote `ctx_notes`, it points at the notes; if it never did, it says so outright and points at `ctx_history` (and project memory) instead of an empty channel. It also carries two mechanically derived lines (zero model calls, fixed-length truncation): `Task:` from the latest session title and `Last action:` from the newest content event, plus a statement that the latest message stays in the new window.

Window numbering: the handoff header's `Context window #N` matches the session-window index (the first window is #1), and `ctx_history list` additionally prints `live window: #N`.

## Reliability & verification

- **184 unit tests green (v0.6.3)**: budget reading with header-first routing, notes read/write and atomicity, history read-back and truncation, the three bands, new_context consumption and anti-swallow, degenerate-turn switch, anti-churn cap, lifecycle idempotency, reminder tiers, DSH_HOME isolation, pruner isolation self-check, client button click flow and semantic availability.
- **Built-artifact probe (imports `lib/`, not source)**: the azure shape reports `window 272000 / reserve 128000 / usable 144000 / threshold 135808`; the deepseek shape reports `607808`.
- **Isolation verified**: in a clean staging home both `dsh plugin add` (npm prebuilt) and `dsh plugin add github:hoyyang/dsh-smart-compact` (source) mount, `--dump-config` shows a single entry, and boot-check's six cold-start classes [A]–[F] are all green.
- **Gate 11 sanitization**: sanitize-check scans the working tree, the full git history, and binaries; zero unhandled hits before push (run for 0.5.3 and again for 0.6.3).
- **Real rollover evidence**: `new_context` → committed switch (`rolloverCount: 1`, `lastRolloverTrigger: new_context`) → window #1 archived in full (393 events / ~307k tokens) → new handoff header `Context window #2 opened` → 23 cross-window `ctx_history search` hits.
- **Real automatic rollover (v0.6.1)**: 2026-10-26 10:32:23, a `compaction/summary` with no `sourceCommandId` (not command-driven) at measured 628,078 ≥ threshold 607,808; the same turn then continued for 64 steps with 0 new turns and 0 real user inputs; `INVALID_REQUEST` count after restart: 0.
- **Degenerate-turn evidence (v0.6.2)**: the 2026-11-03 android-pane session switched to azure, grew 136k → 313k with no automatic switch, and three consecutive turns ended `max-tokens` with `outputTokens: 16` and no visible text — since 0.6.2 "a degenerate turn always switches first" handles that shape.
- **State route verified live**: `GET /dsh-smart-compact/state` returns `{ok:true, engineMounted:true, windowNo:2, archivable:true}` for an active session and `{windowNo:1, archivable:false}` for a fresh one; missing sessionId → 400, non-GET → 405.
- **Troubleshooting order**: `engine-state.json`'s `lastMeasure` first (are provider/model/usableWindow right?), then `lastRolloverRefusedReason` and the command receipt's ❌ text, then `budgetDegraded` for unmeasurable budgets, then `reminderObserved.passFailures` for reminder delivery.
- **Known limits**: the manual `/smart-compact` path does no pre-pruning; the host's submit plane refuses submissions while an agent is running, so a click during a run is a no-op (established host semantics); on the very first step (before a request header exists) the window falls back to the adapter default and corrects on the next step.
- **Security boundary**: no credentials read, no retrieval/scoring infrastructure touched, all mounting changes go through staging first, and only peer-dependency ranges are declared.

## FAQ

**Does it roll over automatically when the context fills up?**
Yes. Auto is on by default: past the trigger line + 8192 tokens it performs the mechanical switch with zero model calls. Set `auto: false` to keep only the manual command.

**How is this different from context compaction?**
Compaction hands the old conversation to a model to write a summary (one summarization call, irreversible). This plugin archives the whole window and hands off through pointers — nothing is lost and the rollover costs zero tokens.

**Is the context lost after a rollover?**
No. The old window enters the local durable stream in full: `ctx_history list` shows ranges, `ctx_history read` returns events by seq, `ctx_history search` scans the archive.

**Do I need to configure anything after installing?**
No. Every key is optional and defaults to the shipping behavior; the only follow-up is `npm install` plus a `lib/` rebuild after upgrading dsh.

**Does it conflict with the official compaction?**
No, but they race. Both hang off pre-step and this plugin's 0.75 sits below the official 0.8; `scripts/write-preset-overrides.mjs --apply` disables the official auto in the user layer (untouched by upgrades), and the yielding engine skips mounting through its courtesy check.

**Why is the trigger not simply 85%?**
Because the provider budget is an equation: input + requested max_tokens ≤ window. A large max_tokens puts the usable input ceiling far below a percentage line, so a pure ratio waits past the wall — since v0.6.1 it is min(ratio×window, usable wall − buffer).

**Does it still work after switching models mid-session (e.g. to azure)?**
Yes, since v0.6.3. The window follows the provider/model of the latest real request, so the next step re-derives the threshold.

## Local build

```sh
npm install
npm run build          # host (lib/)
npm run build:client   # UI (tsdown)
npm run typecheck
npx vitest run
```

## License

BSD-3-Clause