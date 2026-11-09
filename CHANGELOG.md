# Changelog

## 0.6.3 — 2026-11-06

### Fixed
- **The budget bands now measure the model the session is actually routed to.** `resolveModelTarget` preferred `agent.options` (the model captured when the agent was created) over the session's latest `request/header`. A mid-session model switch — the normal PTC workflow: created on deepseek-flash, switched to 微软 Azure `azure_openai/gpt-6.1-sol` — left the engine measuring the 1M window while the route was 272k, so the switch point sat at 607,808 against a 144,000 usable wall and **no automatic switch ever fired**; the route then clamped the completion to ~16 tokens and the turn ended with nothing visible. The header now wins; options are the fallback before the first request.
- **The completion reservation follows the same truth.** `resolveCompletionReserve` now prefers the header's `maxTokens` (what the last request actually carried) over the stale creation-time option, and falls back to the adapter's `defaultMaxTokens` when neither exists — the pre-step of a fresh generation runs before the header is committed, so it used to compute `0.75 * window` (204k for azure, 60k ABOVE the wall).
- **The anti-churn floor is capped to the band left below the wall.** After a switch, baseline (~50k on PTC) + 100k exceeded the azure 144k usable band, so the guard could never unlock and the session died at the wall instead of switching. The cap only applies once a real post-switch baseline exists (first evaluation unchanged).
- **A degenerate turn always switches the window before continuing.** The continuation watcher gated the mechanical switch on `measured >= usableWindow`, which a stale routed target can never satisfy; it now switches when the measurement is unavailable or at/above half the usable band. The switch is zero-model and lossless.
- **The reminder resolves the live agent** from `ctx.agents` instead of measuring a bare `{ session }` with no options — the "cannot resolve the routed model (no agent options and no request header)" warning fired for 70 sessions on 2026-11-02..04, silently skipping briefings and nudges.
- **Audit trail**: `functioning.lastMeasure`/`lastSkipMeasure` and the per-session ledger now record `provider`/`model`, so a stale routed target is visible in `engine-state.json`; grace/rollover log lines carry the session id.

### Verification
- 184/184 vitest (4 new regression cases: header-over-options target, stale-option reservation, anti-churn cap, degenerate-turn switch), `tsc --noEmit` clean, built-artifact probe on `lib/` reports window 272,000 / reserve 128,000 / usable 144,000 / threshold 135,808 for the azure shape.
- Staging (`~/.dsh-staging`, link to this tree): `--dump-config` composition passes; `boot-check.sh` reports PASS for [A]/[B]/[E]/[F] on this plugin and no import failure naming it. The staging headless smoke cannot run: its stored credentials are rejected (AUTH invalid) and the plugin waits for `webServer` in a headless profile.
- **Not yet verified on a real instance** — the running host still executes 0.6.2 from memory; a restart/hot-reload window is required (pending user decision).

## 0.6.2 — 2026-11-03

### Added
- **Zero-output truncation recovery** (`autoContinue`, default on; `maxConsecutiveRecoveries`, default 2). A turn that ends `max-tokens` while its assistant message carried **neither text nor a tool call** is an unusable answer: the model spent the whole completion budget on reasoning and produced nothing visible. The host (`dsh-goal-round-driver`) disarms the goal on that exact reason and nothing retries the turn, so the session stops until a human types "继续". The new watcher (src/continue.ts) detects that turn, switches the window first when the measurement is already past the usable ceiling (zero model calls, lossless), then continues through **one** path only: `goals.resume()` when an active goal is disarmed, otherwise a single injected continuation message (`source.kind = plugin:dsh-smart-compact`). Guards: human sessions only, idle agent only, no queued messages, one recovery per turn, cap 2 consecutive recoveries, reset on a completed turn or a real user message. 174/174 vitest.
- **Usable-wall nudge**: past `usableWindow` (window − max_tokens) the reminder tells the model the next answer gets no room and points it at `new_context` — once per window.

### Fixed
- **Two silent automatic-switch refusals are now visible.** The anti-churn hold-back (`minAddedTokens`) and the forced band's "nothing compactable" both returned `null` with no log line and no refusal record, so "above the wall and still not switching" looked exactly like "below threshold". Both now log (the anti-churn line once per window generation) and the forced band calls `onRolloverRefused` too.
- **Per-session engine evidence** (`functioning.sessions`). `engine-state.json` kept ONE global `lastMeasure`/`lastSkip` slot, so whichever session wrote last erased every other session's evidence — on 2026-11-03 the android-pane session's 40 silent evaluations were unrecoverable for exactly that reason. The ledger keeps the last 8 sessions with their measurement, skip reason, and refusal.

### Notes
- Incident: session-761460d5 (`dsh-android-pane 建设`) switched to `mify-sol/azure_openai/gpt-6.1-sol` (contextWindow 272000, maxTokens 128000) at 18:17, grew to 313k tokens in one turn, and then three consecutive turns ended `max-tokens` with `outputTokens: 16` and no visible content — 317k + 128k exceeds the window, so the provider clamped the completion budget to almost nothing. Two manual `/smart-compact` commands earlier that evening had both been HAND-ISSUED (`sourceCommandId`), and no automatic switch ran during the growth.

## 0.6.1 — 2026-10-26

### Fixed
- **The automatic switch now accounts for the completion reservation: the provider budget is an equation** (input + requested completion must fit the window). With `maxTokens` = 384000 on a 1M window the provider rejects at ~616k input while a 0.75 percentage threshold waits for 750k — so the automatic rollover could never fire, and every retry failed as `400 INVALID_REQUEST` until a manual `/smart-compact`. Observed live on 2026-10-26 (session f72cc258): three consecutive 400s, then an immediate recovery once a manual rollover removed 428k tokens. The pressure threshold is now `min(ratio * window, window - completionReserve - fallbackBufferTokens)`; the reservation is read from the request header (`config.maxTokens`) or the agent options, and the grace nudge honours the same ceiling. `completionReserve` / `usableWindow` are recorded in `engine-state.json` (`functioning.lastMeasure`), so the usable ceiling is auditable. 140/140 vitest.
- Root-cause note: at dsh 0.2.1-rc.2 DeepSeek's `Input token exceed the limit` wording is not recognized by the shared overflow classifier and surfaces as `INVALID_REQUEST`, so the host's automatic prune/compact/retry recovery does not run (documented in the dsh handbook troubleshooting guide). This plugin's own band now stays below the wall instead of relying on that recovery.

## 0.6.0 — 2026-10-26

### Fixed
- **The automatic switch now actually wins the pre-step race**: the default auto-switch point drops 0.85 → **0.75**, strictly below the official `dsh-compaction-basic` default (0.8). Both engines are called on every `agent/pre-step`; whoever crosses its own line first switches, so 0.85 could never win — measured on the real 2026-10-23..25 ptc session (272k-token windows, deepseek-official): **6 of 6** automatic compactions were the official model summary (`## Primary Request and Intent`), and all 16 smart-compact switches in that session were hand-issued `/smart-compact` commands. Kiro's 0.75 override stays (same numeric value now).
- **Anti-churn floor `minAddedTokens` (default 100000)**: an automatic switch is refused until that many tokens were added since the previous one. Small windows carry a fixed base (system prompt + tool schema + injected memory, measured 130–350k) that can sit close to the threshold; a pure percentage rule switched on nearly every step there. The baseline is refreshed after manual switches too, so a fresh window is never re-switched immediately.
- **Foreign compaction detection (fail loud)**: a `compaction/summary` without the `[smart-compact rollover]` prefix means another engine won. It is now recorded in `engine-state.json → functioning.foreignCompactions` and logged as a warning instead of being invisible.

### Added
- `functioning` observability block in `engine-state.json`: `evaluations`, `lastMeasure`, `lastSkipReason`, `foreignCompactions` — plus `effectiveThresholds`, so "is the auto band even evaluating?" is answerable without a probe build.
- `scripts/write-preset-overrides.mjs`: generates a **profile-layer** override (survives dsh upgrades) that turns the official preset engines to `auto: false` for ptc/standard/cordis, with backup, a drift lock and `--verify`. The App bundle's `presets/*.patch.yml` are replaced wholesale by an upgrade (observed 2026-10-18 02:03), so editing them is not durable.
- Tests 131 → 138 (anti-churn, baseline reset, foreign detection, calibration defaults).

## 0.5.7 — 2026-10-14

### Fixed
- **Auto and manual window switches now produce the same window**: the forced pressure band delegated to basic's pressure path, which keeps a priced recent tail of `retainRatio` (0.16–0.22 of the window, tens of k tokens incl. images/tool results) visible after the switch, while `/smart-compact` (compactNow) archives everything but the newest exchange. The forced band now uses basic's zero-retention selection (the overflow path), same as manual and `new_context`. `retainRatio` no longer affects smart-compact rollovers. 131/131 vitest.

## 0.5.6 — 2026-10-12

### Fixed
- **"This operation was aborted" on a committed /smart-compact**: the receipt awaited three advisory probes (budget window lookup, notes, notes freshness) AFTER `compactNow` committed, leaving a ~110 ms window in which the host's command signal could abort and replace the success receipt with an error even though the window had switched. All async probes now run before the switch; the post-commit receipt is built synchronously (`prepareBudget` resolves the model window up front and returns a sync meter read). 131/131 vitest.

## 0.5.5 — 2026-10-10

### Added
- **Per-provider thresholds** (`providerThresholds`, default `{ "kiro-vision": 0.75 }`): when smart-compact owns the compaction slot, dsh-kiro yields its own 75% engine, so Kiro sessions silently moved to the global 85%. Kiro's upstream failures cluster above ~70% of its 1M window (500 high-load / 400 "input content length exceeds threshold"; 12.9% error rate at 700–800k vs ≤2% below). The pressure band, the grace nudge and basic's internal re-check (fed the lowest configured ratio) now all honour the routed provider's threshold. An empty map restores one global threshold.
- `BudgetSnapshot.provider`; `providerThresholds` in engine-state.json and the armed log line.

## 0.5.4 — 2026-10-09

### Fixed
- **Rollover aborted every turn on DSH 0.2.x (Desktop)**: npm had vendored the 0.1.5-rc.2 kernel (`dsh-compaction` & co.) into this plugin's `node_modules`, and linked installs resolve it before the host. That kernel frames the rollover checkpoint as `{kind:"plugin", plugin:"compact"}`, which session format v4 refuses on append ("format v4 message requires a producer-owned source kind") — the turn died at step 1 and the session stayed stuck. Kernel peers are now `peerDependenciesMeta.optional` (never auto-installed), so the host's 0.2.x kernel is used.
- **Fail loud on a stale kernel**: at apply the engine probes `compactCheckpointSource()`; a retired `"plugin"` kind logs an error naming the package and skips mounting the rollover engine (tools stay available, probe shows `slotHolder: "stale kernel"`) instead of corrupting sessions.
- Test fixtures moved to the v4 tool-result shape; 125/125 vitest.

## 0.5.3 — 2026-09-29

### Changed
- **README evidence restructure**: added Features / Quick start / Use cases / Demo output / Reliability & verification sections with real, deduplicated evidence entries (14 capability items, 10 numbered steps, 10 use cases, real command+output pairs from live sessions and clean staging); zero-config statement made explicit (all keys optional, defaults are the shipped behavior). README.en.md mirrors the same structure. No code changes — docs-only release aligning the published npm README with the repository (single source of truth).
- Verification counts refreshed: 123/123 vitest, dual install-form staging verification (npm prebuilt + GitHub source), gate-11 sanitize green, boot-check [A]-[F] green.

## 0.5.2 — 2026-09-29

### Added
- **Stale-notes gate（笔记新鲜度门）**: at rollover time the engine compares the newest ctx_notes segment stamp against the durable log. When timestamped window activity postdates the notes, the handoff anchor downgrades from "read the notes first; assume nothing beyond them" to an explicit ⚠️ STALE warning (last-write time + number of activity events) plus a mechanical recent-activity tail (last ≤3 tool names + clocks — names only, never arguments/results), and the ✅ receipt carries the matching advisory line. Fresh or unknown-freshness notes keep the classic wording verbatim; every probe hiccup degrades, never fails.
- `NotesStore.lastWrittenAtMs()` — in-band freshness anchor (the newest segment header stamp).
- `deriveNotesFreshness()` / `deriveRecentActivity()` — zero-model mechanical helpers, exported for the command receipt and tests.

### Context
- Live incident (2026-09-29 session): a manual /smart-compact at ~3% budget usage succeeded while the notes predated the window's latest work (the actual code commit and the STATE persist) by ~4 hours — the anchor actively vouched for the stale notes and the new window nearly continued from wrong state. The 100% archive was never at risk; the risk was silent mis-direction. Manual rollovers can happen at any budget level, so threshold-driven note reminders never fire — the gate closes that gap mechanically.

### Verified
- 123/123 vitest (8 new: freshness verdicts, stale/fresh/unknown anchors, receipt advisory, activity-tail privacy, worst-case pricing still covers the STALE variant).
- Real-data replay through the built lib: the incident-time stream (2707 events) + the real notes.md (segment 7, 02:12Z) now produces the STALE anchor with tail `read@06:18, write@06:18, bash@06:18` (exactly the work the old anchor failed to mention); with segment 8 present the classic anchor is kept.

## 0.5.1 — 2026-09-21

### Fixed
- **/smart-compact now fails with an honest receipt instead of a raw gateway toast**: unexpected host errors thrown by the engine (previously rethrown and surfaced as `command.execute failed: gateway/internal: token meter: …`) are rendered as a human receipt naming the underlying error verbatim; the stack goes to the session log. Live case: the "dsh-kiro 建设" session.

### Added
- `scripts/patch-token-meter.mjs` — idempotent host patch (backup + `node --check` + auto-restore) that makes the token meter tolerate a dangling `step/start` (a host restore/remount can reset the turn counter mid-step, leaving the durable stream permanently unmeasurable; observed on 4 sessions, bricking manual/automatic compaction and the budget reminder for those sessions). The meter now warns and treats the doomed step as ended; healthy streams are unaffected. **Re-run after every dsh upgrade** (`node scripts/patch-token-meter.mjs`); a producer-side fix (write the missing step/end on restore) is reported upstream.

### Verified
- 664 stored sessions replayed under the patched fold: zero throws; exactly the 4 previously-bricked sessions hit the auto-heal branch.
- 115/115 vitest (2 new receipt tests).

## 0.5.0 — 2026-09-16

### Added
- **Mandatory sanitization of engine-authored anchors**（强制脱敏）: the handoff checkpoint's `Task:` / `Last action:` lines pass a fixed pattern set (CN mobile / email / 18-digit national-ID shape / CN+EN company suffixes) before entering the new window. Logs and state carry counts and labels only, never matched content. No config switch — by design.
- **Reminder observability**: every reminder-pass outcome (briefing / tier / grace / no-budget / pass-failure) is counted into `engine-state.json` → `reminderObserved`. The 2026-09-16 billing-session incident (a hot session fell through to the host's LLM summarizer with zero reminders ever delivered) had been invisible because this pass had no counters.

### Documented
- The automatic rollover path that already ships: the engine registers as the host compaction service, the host fires `compactIfNeeded(agent, "pressure")` on `agent/pre-step` (and `"context-overflow"` on window-overflow recovery), and the three-band policy escalates quiet → grace → forced rollover — all zero-model via the `summarize()` template override. The grace band's engine-side line is log-only; the model-visible nudge comes from the reminder pass.

### Fixed
- Handoff anchors no longer propagate personal/company information (sanitization above).
- **Reminder pass never delivered a nudge**: the host wiring handed the bare Session to `measureBudget` (which reads `agent.session`), so every pass died on "Invalid value used as weak map key" inside the token meter — caught live by the new `reminderObserved` counter minutes after deploy; the budget is now measured against `{ session }`.

## 0.4.6 — 2026-09-16
- Handoff anchor task orientation (`Task:` / `Last action:`), retain-last archive note, session-scoped wording, threshold-timed grace reminder, sparse window-listing note.

## 0.4.5b — 2026-09-16
- Button inert-cursor fix.

## 0.4.5 — 2026-09-16
- Manual archive range mirrors the engine: never shadow the newest node.

## 0.4.4 / 0.4.3 — 2026-09-16
- Button availability mirrors the engine size invariant; semantic availability via the host state route.
