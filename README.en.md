# dsh-smart-compact

![banner](assets/banner.svg)

[![dsh-plugin](https://img.shields.io/badge/dsh-plugin-blue)](https://github.com/topics/dsh-plugin)

[**中文**](README.md) · [Releases](https://github.com/hoyyang/dsh-smart-compact/releases) · [Changelog](CHANGELOG.md)

**Codex-style context window auto-management for DeepSeek Harness.**

Give the model Codex CLI's new context strategy: live budget visibility, wrap-up reminders, working notes that survive compaction, on-demand recall of archived original content, and a rollover compaction engine that switches to a fresh window with **zero summarization model calls**.

## Install / Update

```sh
dsh plugin --profile web add dsh-smart-compact
dsh plugin --profile web update dsh-smart-compact@latest
```

Then start `dsh web`. No build step on the user side.

## What the model gets

| Tool | What it does |
|---|---|
| `get_context_remaining` | Remaining token budget of the current session (total / window / remaining) |
| `ctx_notes` | Session working notes (write/append/read/search/list) — they survive compaction and window rollovers |
| `ctx_history` | Recall original events archived by rollover (list windows / read by seq / search by keyword) |
| `new_context` | The model requests a fresh window on demand (takes effect after the current step's sampling finishes, before the next step — never mid-step) |

## Human command

| Command | What it does |
|---|---|
| `/smart-compact` | **Triggers a seamless window switch 100% of the time**: opens a new window immediately and archives the old one losslessly (zero model calls); task continuity is carried by ctx_notes + ctx_history. If the compaction slot is held by another engine, the command errors loudly (fail loud) — it never silently degrades into summary compaction. Receipts are human-readable Chinese: success is prefixed ✅ with the new window number and the archived volume (short first line to survive GUI truncation; click the card to expand the full text, including the post-rollover budget); failures/aborts are prefixed ❌. **Honest handoff anchors (v0.3.2)**: if the session never wrote ctx_notes before the rollover, the new-window anchor automatically downgrades to ctx_history-recall mode (it no longer points at empty notes), and the receipt adds a ⚠️ hint — for important tasks, write notes before rolling over. |

## Composer button (v0.4.5)

The composer tool row carries a **26px perfect-circle button** (amber-gold vortex on a deep bronze plate) right between the context meter and the send key. One click is equivalent to running `/smart-compact`: it writes the command into the composer and submits through the host's own send path, so adjudication, execution, and the receipt render exactly as if you had typed it.

- **Perfect circle**: geometry is locked with `!important` and additionally clipped physically by **`clip-path: circle(50%)`** — even the host tool row's own `!important`-grade catch-all button styles cannot squash it (verified under adversarial overrides).
- **Draft safety**: unsent text is auto-saved on click and restored verbatim once the command is captured (checked against the host input machine source: the bare-token clear only fires when the draft is exactly the command).
- **Motion**: hover glow plus a faster vortex spin; a click fires a gold burst and a fast roll; honors `prefers-reduced-motion`.
- **Tooltip**: concise Chinese, state-aware (the command name stays English) — clickable: 「一键换窗 = /smart-compact（归档本窗口、开新窗，草稿保留）」; right after a rollover: 「窗口 #N 刚开、暂无可归档历史；发送下一条消息后可再次换窗」; slot held: 「换窗不可用：压缩槽位由 XX 持有」.
- **Semantic availability (v0.4.5)**: right after a rollover (the new window holds too little content), on a brand-new session with no history, or while the compaction slot is held by another engine, the button **greys out and cannot be clicked** (no hover glow, clicks do nothing); it re-enables automatically once enough content has accumulated. The decision uses the **same inequality as the compaction engine**: the host-meter price of the manual-rollover archive interval (retain=0, and **never including the newest surface node**) must be strictly greater than the handoff checkpoint estimate, otherwise the engine refuses with "summary is not smaller than the shadowed content" (v0.4.3 measured three consecutive red no-op receipts in a dsh-android-pane session: `215 ≥ 193` — this release closes the loop: the button greys out in exactly that state, and the receipt now carries honest numbers). The check is served by the host half over a same-origin webServer route, `GET /dsh-smart-compact/state?sessionId=…` (it returns only the window number and an archivable boolean, **no session content**; the route registers with the plugin fiber, so unmounting removes it). When the state is unreachable (route missing / fetch fails), the button falls back to **always clickable** (fail-open), and the command receipt is the safety net.
- **No new tool registrations**: the button adds no tools and does not touch the command surface; apart from the read-only state route above, the client depends only on the official slots service.
- **Regenerating the texture**: generate with dsh-image-gen (image-prompt `brand-identity-package` template, gold palette on pure black) → sips crop 700→128 JPEG → inline into `src/client/assets.ts`, overlaid inside the button with `mix-blend-mode: screen` (the black floor vanishes into the plate).

## Automatic rollover (on by default)

Automatic rollover is not an appendage of the button but an independent, **host-event-driven** path: the compaction engine registers as the host compaction service, and the host calls `compactIfNeeded` at every step boundary (`agent/pre-step`) and at model window-overflow recovery points (`context-overflow`). A three-band strategy escalates automatically:

- **quiet** (consumption < 85%): do nothing;
- **grace** (85% ~ 85%+8192 tok): remind once (write ctx_notes) and keep working;
- **forced** (≥ 85%+8192 tok): automatically run the **exact same** mechanical rollover as manual `/smart-compact` — zero model calls; the first message of the new window is the handoff anchor (`Context window #N opened`), and the GUI's "context compacted" banner still renders, but its content is a lossless rollover rather than an AI summary.

The automatic path is host-event-driven (`agent/pre-step` pressure check + window-overflow recovery) and escalates quiet → grace → forced rollover — all zero-model via the template summarizer override.

Reminders (25/50/75% + grace) reach the model context through system-prompt waterfall injection; since v0.5.0 their delivery (briefing/tier/grace counts and budget-measurement failures) is recorded in `engine-state.json` as `reminderObserved` — silent reminder failure is now observable (in the 0.4.x era, a hot session once received zero reminders and was finally rescued by the host's AI-summary fallback).

## Sanitization (v0.5.0, no switch)

Text **auto-generated** by the engine — the `Task:` / `Last action:` lines of the handoff anchor — is mandatorily sanitized before it enters a new window: phone numbers, emails, 18-digit national IDs, and company names (Chinese or English, detected by suffix). Hits are logged only as **counts and categories** (`handoff anchors sanitized — N redaction(s)`); the original text is never echoed.

Boundary (deliberate): the verbatim `ctx_history` archive is **not** sanitized — lossless recall of local sessions is the product's core contract; sanitization covers only engine-generated surfaces that propagate automatically. Tests and doc samples use synthetic data only (张三 / 138****8000 / example.com / 示例公司).

Engine-authored surfaces (the orientation anchors) are mandatorily sanitized before entering a new window — phone / email / national-ID / company-name patterns, counts logged, content never echoed. The verbatim archive stays untouched on purpose (lossless local recall is the core contract).

## How rollover works (in plain language)

When the context nears its limit (85% of the default window), instead of "compressing the old conversation into a summary", the engine: first archives the old window **verbatim** (the session's existing durable event stream — zero new storage) → leaves an 8192-token buffer for the model to write handoff notes → then opens a clean new window holding only a fixed template ("the old window has been fully archived; current state is in ctx_notes; check details with ctx_history"). The whole run **never calls a summarization model once**; old content stays lossless and can be read back precisely at any time.

The anchor template is generated from the actual notes state: if the session has written ctx_notes → point at the notes ("continue from the notes"); if it never has → state explicitly "this session has no notes so far" and instruct to rebuild context with ctx_history (plus any persisted project memory/STATE) — never pointing at an empty notes channel (v0.3.2 fix for the problem where manual rollovers ran without notes and the template unconditionally pointed at the notes channel, sending the new window on an archaeology dig).

The anchor carries task-orientation lines (v0.4.6): the template appends two **mechanically derived** lines (zero model calls, hard length caps) — `Task:` (from the latest session title) and `Last action:` (first line of the newest content event) — plus an explicit "the newest message still lives in this window; the archive covers everything else". The former eliminates blind task continuation (the new window no longer has to guess what this session is doing); the latter prevents misreading a sparse seq range in the archive interval as "the wrap-up report got lost". The availability probe prices both lines at their worst-case fixed lengths, so the compaction transaction's hard inequality — the checkpoint must be smaller than the content to be archived — is unaffected. The write-notes grace reminder now fires when consumption reaches the engine's grace band (`thresholdRatio`, default 85%) instead of waiting until only a few thousand tokens remain — a nudge that late arrives when there is no room to act on it.

Stale-notes gate (v0.5.2): at rollover time the engine reconciles the newest notes segment stamp against the durable log. If window activity postdates the notes (necessarily true for early manual rollovers: the write-notes mechanism is driven by budget thresholds and never overrides "the user may roll over manually at any time"), the anchor no longer unconditionally endorses the notes — it downgrades to a ⚠️ STALE warning (time of the last notes segment plus the number of activity events after it) plus a **mechanical recent-activity tail** (the last ≤3 tool names + clocks; names only, never arguments/results), and the ✅ receipt appends a matching "handoff notes are stale" advisory line. When the notes are fresh or freshness cannot be determined, the classic anchor wording stays verbatim; any probe failure degrades to omission, never failure (proven by a real incident: the rollover succeeded but the notes were 4 hours stale, and the old anchor actively led the new window to trust outdated state).

Window numbering: `Context window #N` in the handoff header is the **session window index** (the first window = #1) — the same numbering as the `window #N` printed by `ctx_history list`; list additionally prints `live window: #N` for the current window.

Window numbering is the session-window index: the handoff header's `Context window #N` and `ctx_history`'s `window #N` are the same numbering, and `ctx_history list` also prints the live window number. The count is the session log's `compaction/summary` events, so summaries written by another engine (or inherited from a fork parent) are counted too — the header and the list always agree because they read the same set.

When the context approaches its limit (85% by default), the engine does not write an LLM summary. Instead it archives the old window intact (the session's existing durable event stream — no new storage), grants a 8192-token grace band for the model to write handoff notes, then opens a fresh window whose anchor is a fixed template pointing at `ctx_notes` and `ctx_history`. Zero summarization calls; nothing is lost.

## Configuration (config.toml → plugin config)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; when false the plugin is fully silent |
| `auto` | `true` | Automatic rollover + reminders + new_context; when false, only manual /compact routes through rollover |
| `thresholdRatio` | `0.85` | Window-occupancy ratio at which the buffer band is entered |
| `retainRatio` | `0.16` (engine default) | Share of recent context kept after rollover; must be smaller than `thresholdRatio` |
| `fallbackBufferTokens` | `8192` | Buffer band width; exceeding it forces rollover |
| `maxToolOutputTokens` | `8192` | Truncation cap for a single tool output |
| `notesDir` | `<dsh home>/dsh-smart-compact/notes` | Notes storage directory |

## Compatibility

- **Single-slot first**: the `compaction` service is a single slot — after installation this plugin **takes over** that slot by default (rollover semantics) and must sit **before** the other compaction engines (dsh-glm / dsh-kiro / compaction-basic) in the profile bundles. Engines that yield the slot (e.g. dsh-glm) skip mounting automatically via their built-in deference check; their remaining features are unaffected. Confirm the current mode with the state probe: `cat <dsh home>/dsh-smart-compact/engine-state.json` (`engineMounted: true` = rollover took over; `false` = the slot is held by another engine and this plugin provides tools and reminders only). The probe also records **automatic and manual** rollovers: every successful rollover (auto threshold or manual `/smart-compact`) increments `rolloverCount` and writes `lastRolloverAt`, and `lastRolloverTrigger` is one of `new_context` / `pressure` / `manual` / `context-overflow`.
- The only command entry is `/smart-compact`: the profile's official `command-compact` (`/compact`) stays `disabled` — avoiding the path where `/compact` silently degrades into summary compaction while the slot is held by another engine, which would conflict with the lossless promise.
- **Requires dsh >= 0.1.5-rc**: session logs are read via `Session.snapshotEvents()` (`Session.events` was removed upstream before 0.1.5); if the host does not provide that API the plugin errors by name — it never goes silently amnesiac.
- **Isolation from third-party `toolResultPruner`**: that service is an optional third-party implementation that can lag behind dsh (a stale copy observed in the wild still read `session.events`, long removed upstream, and broke **every** rollover inside basic compaction). Because rollover archives the whole window mechanically and retention is decided by interval selection, upfront pruning has no benefit here — the engine therefore runs on a child context from `ctx.isolate('toolResultPruner')` and never consults that service. Cost: the manual `/smart-compact` path likewise performs no upfront pruning (it could only converge smaller when the window genuinely needs compaction). On apply, the engine self-checks that the isolation took effect and logs a warning if it did not.
- **Rollover requests are never silently swallowed**: a `new_context` request is consumed only when the rollover **actually commits**; when refused (no compressible interval) or on an engine error, the request stays in the pending set and is retried at each step, with the latest reason written to the probe (`lastRolloverRefusedAt` / `lastRolloverRefusedReason`; same-reason writes merge within 30s). An aborted step does not count as a refusal: the request stays pending and no ops event is recorded. An unmeasurable budget (e.g. the model has no `contextWindow` configured) is accounted separately from rollover failures; five consecutive occurrences trigger `budgetDegraded`.
- Peer deps track the dsh major version (currently `>=0.1.5-rc <2`). The plugin's bundled `node_modules` copy is the **real runtime resolution target** (the plugin's realpath is not on the host's `node_modules` resolution chain), so **after every dsh upgrade you must rerun `npm install` and rebuild `lib/`** — otherwise the old core API keeps being loaded.
- **Host token-meter tolerance patch (since v0.5.1, one-time)**: a host restore/remount can reset the turn count while an old step is still unfinished, corrupting the session's durable stream — meter replay then throws forever, and /smart-compact, budget reminders, and host auto-compaction all fail in that session (4 sessions hit on this machine). `node scripts/patch-token-meter.mjs` fixes it idempotently (automatic backup + syntax validation; zero impact on healthy streams); **rerun it after every dsh upgrade**. The pre-patch failure path also degrades gracefully: the command receipt names the underlying error instead of throwing a bare gateway toast.

## Uninstall

```sh
dsh plugin --profile web remove dsh-smart-compact
```

Uninstall removes every tool, listener, and engine with the plugin fiber; notes files are kept under `notesDir` (delete that directory manually if unwanted). Compaction behavior reverts to the DSH default.

## Verification status

- 98 Vitest unit tests (client regressions: the button click flow's three-stage call sequence "write command → submit → draft restore" + render structure and inert behavior without a session + semantic availability: `isInert` fail-open / post-rollover greying / slot-held greying + state tooltip copy; host-side: `windowAvailability` in seven shapes of the engine-aligned inequality + `framedCheckpointTokenEstimate` pricing + the receipt's "too little content" translation): budget reads, notes read/write & atomicity, history recall & truncation, the three rollover states, new_context consumption (including the anti-swallow fallback), lifecycle idempotence, three-tier reminders, plus host Session API adaptation (including the named error when `snapshotEvents()` is missing), window-numbering parity, `DSH_HOME` isolation (`vitest.config.ts` gives the whole test run a temporary home — running tests used to overwrite the real `engine-state.json` with synthetic data, reproduced and fixed), pruner-isolation wiring & self-check, non-Error throws / abort signals / budget accounting, manual-path probe accounting and receipt copy, and other regressions.
- **Client assembly proof (v0.4.3)**: lib/client.js built via tsdown (30.95 kB, inline gold vortex texture included) and registered in the host client-modules table (client check: lib/client.js); boot-check.sh cold-start three-fault static detection all green + the --dump-config combined re-check passed; injector self-test 8/8 PASS; perfect-circle numeric proof under adversarial overrides: 26.00×26.00 / radius 999px / clip-path circle(50%).
- **End-to-end proof (staging isolation, real model glm-5.3-flash)**: the model called `get_context_remaining` → `ctx_notes` (writing handoff notes) → `new_context` → `ctx_history` in sequence, full chain success; `new_context` triggered a real rollover (`rolloverCount: 1`), and `ctx_history` read back the archived window (window #1, ~5965 tokens archived).
- The isolated staging environment must pass the `dsh --dump-config` combined pre-check plus a real boot before promotion; the running mode is queryable via the `engine-state.json` probe.
- **Real-machine rollover proof (a real session on this machine)**: `new_context` → rollover committed (`rolloverCount: 1`, `lastRolloverTrigger: new_context`, `lastRolloverRefusedReason: null`) → window #1 fully archived (393 events / ~307k tokens) → the new window's handoff header read `Context window #2 opened` → cross-window `ctx_history search` hit 23 entries; the main home's `boot-check.sh` cold-start three-fault static detection all green.
- **State-route live proof (v0.4.3)**: `GET /dsh-smart-compact/state` returns `{ok:true, engineMounted:true, windowNo:2, archivable:true}` for the active session (window #2 with new conversation after rollover → clickable) and `{windowNo:1, archivable:false}` for a new session (nothing to archive → button inert); page fetch interception confirmed the client polls every 4s with the session's real id; missing sessionId → 400, non-GET → 405, cold session → `no-live-agent` (the client fail-opens and stays clickable). Note: the host submit plane refuses submissions while an agent run is in progress (locked/busy refuse), so clicking the button mid-run is a silent no-op — established host semantics.
- 0.3.0's adaptation basis: host 0.1.5-rc.1's `Session` removed `events`, so the plugin reads via `snapshotEvents()` instead; the bundled 0.1.5-rc.2's runtime `lib/` is byte-identical to host rc.1's, verified with `diff -rq`.

## License

BSD-3-Clause
