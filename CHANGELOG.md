# Changelog

All notable changes to the Stride extension for Pi Coding Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-05-19

### Changed

- **`skills/stride-task-reviewer/SKILL.md`** — Rewrote Step 6 ("Produce Structured Review") and the Outputs section to require an unconditional fenced ```json block alongside the existing markdown prose. The block matches the canonical `reviewer_result` schema documented in [`stride/agents/task-reviewer.md`](https://github.com/cheezy/stride/blob/main/agents/task-reviewer.md) — `schema_version`, `summary`, `status`, `issue_counts`, `issues[]` (with `severity`/`category` enums), and `acceptance_criteria[]` (with `met`/`not_met` enum). Includes a verbatim worked `changes_requested` example. The prose summary line is preserved above the JSON block so orchestrator fallback paths that grep substring summaries continue to work when JSON parsing fails. The dispatched-shape `reviewer_result` now carries both the legacy summary fields and the structured fields parsed from the JSON block. No pi-specific schema variant introduced — the canonical schema is cited by path.
- **`skills/stride-subagent-workflow/SKILL.md`** — Added an "Extracting the structured review block" subsection to Phase 3 (Code Review). The orchestrator now extracts the first fenced ```json fence from the reviewer's response and populates `reviewer_result` in the completion PATCH payload with both (a) the legacy summary fields (`summary`, `issues_found` from `sum(issue_counts.values())`, `acceptance_criteria_checked` from the length of the structured array) and (b) the structured fields verbatim (`status`, `issue_counts`, `issues`, `acceptance_criteria`, `schema_version`). Includes a Pi-specific note that the inline-skill model means the reviewer's response IS the current context (same first-```json-fence extraction applies), a worked example, and a documented fallback path that keeps older agent versions and parse failures working: substring-match the prose summary, omit structured fields from the PATCH (never empty placeholders), do not abort the completion.
- **`package.json`** — Version bumped from `0.3.0` to `0.4.0`.

### Source

Ported from stride 1.13.0 (commits 9c19359 "Define structured JSON review-report schema in task-reviewer agent" and 8e94eca "Extract structured review block into reviewer_result PATCH payload"). Cross-plugin parity for Stride W685/W686 (implemented in stride-pi as W699). Note: the [0.3.0] hook-bridge release was tagged separately at HEAD~0 immediately before this commit to catch up the missing tag.

## [0.3.0] - 2026-05-17

### Added

- **`extensions/hook-bridge/`** — New Pi extension that intercepts Stride API curl calls on Pi's `tool_call` / `tool_result` events and runs the matching `.stride.md` hook section automatically. `after_doing` failure vetoes the `/complete` curl via `{ block: true, reason }`; `before_doing`, `before_review`, and `after_review` run post-call and log failures without blocking. 120 s per-hook timeout with SIGTERM → SIGKILL escalation. Task metadata cached to `.stride-env-cache` after a successful claim so subsequent hook commands see `$TASK_IDENTIFIER` etc., and the cache is deleted after `after_review`. 16 unit tests (`npm test --prefix stride-pi`). See `docs/ADR-002-hook-mechanism.md` for the design decision.

### Changed

- **`package.json`** — Bumped version 0.2.0 → 0.3.0. Replaced the directory-glob `pi.extensions: ["./extensions"]` with explicit per-extension paths (`./extensions/subagent-dispatch`, `./extensions/hook-bridge`) so the manifest declares exactly which extensions ship.
- **`skills/stride-claiming-tasks/SKILL.md`** — Rewrote the hook-execution sections to describe automatic firing via `hook-bridge` as the default. Manual line-by-line execution is now documented as a fallback for environments where the extension is not loaded.
- **`skills/stride-completing-tasks/SKILL.md`** — Same treatment. The agent now provides placeholder `after_doing_result` / `before_review_result` values because the extension runs the hooks and decides whether to veto the `/complete` curl. Manual execution remains as a fallback.

### Why this release

Before this release, the four Stride lifecycle hooks were advisory on Pi — the skills told the agent to run them manually before each API call, and an agent under pressure could (and did) skip them. With `hook-bridge` loaded, hooks fire automatically as a side effect of the agent's curl invocations and a failed `after_doing` blocks the `/complete` curl outright. This matches the quality-gate semantics already shipped by `stride-copilot` and `stride-gemini`.

## [0.2.0] - 2026-05-08

### Removed

- **`skills/stride-workflow/SKILL.md`** — Removed all three references to the user-private `stride-development-guidelines` skill: the Step 5 ("Activate Development Guidelines") section, the corresponding flowchart node, and the Quick Reference Card line. That skill is project-local to the plugin author's machine and is not distributed with this plugin, so end users would have seen Step 5 instructing them to activate a skill that does not exist for them. The Step 5 slot is left empty rather than renumbered to avoid breaking step-number cross-references elsewhere in the file.

### Changed

- **`package.json`** — Bumped version from 0.1.0 to 0.2.0.

### Why this release

Cross-skill references to non-plugin skills break the workflow for end users. This guard rail is being applied to all five Stride plugins (`stride`, `stride-codex`, `stride-gemini`, `stride-opencode`, `stride-pi`) in a coordinated release.

## [0.1.0] - prior

Initial Pi Coding Agent edition (no CHANGELOG entries before 0.2.0).
