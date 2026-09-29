# Changelog

## 0.5.2 — 2026-09-29

### Added
- **Stale-notes gate（笔记新鲜度门）**: at rollover time the engine compares the newest ctx_notes segment stamp against the durable log. When timestamped window activity postdates the notes, the handoff anchor downgrades from "read the notes first; assume nothing beyond them" to an explicit ⚠️ STALE warning (last-write time + number of activity events) plus a mechanical recent-activity tail (last ≤3 tool names + clocks — names only, never arguments/results), and the ✅ receipt carries the matching advisory line. Fresh or unknown-freshness notes keep the classic wording verbatim; every probe hiccup degrades, never fails.
- `NotesStore.lastWrittenAtMs()` — in-band freshness anchor (the newest segment header stamp).
- `deriveNotesFreshness()` / `deriveRecentActivity()` — zero-model mechanical helpers, exported for the command receipt and tests.

### Context
- Live incident (session "ISS-202609-00089191A 反馈"): a manual /smart-compact at ~3% budget usage succeeded while the notes predated the window's latest work (the actual code commit and the STATE persist) by ~4 hours — the anchor actively vouched for the stale notes and the new window nearly continued from wrong state. The 100% archive was never at risk; the risk was silent mis-direction. Manual rollovers can happen at any budget level, so threshold-driven note reminders never fire — the gate closes that gap mechanically.

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
