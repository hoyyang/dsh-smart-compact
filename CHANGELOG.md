# Changelog

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
