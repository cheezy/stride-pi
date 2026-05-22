# Changelog

All notable changes to the Stride extension for Pi Coding Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-22

### Added

- **`extensions/hook-bridge/changed-files.ts`** — New helper module mirroring the bash `capture_changed_files` / `finalize_after_doing` helpers in `stride/hooks/stride-hook.sh` byte-identically for the on-the-wire encoding. Exports `captureChangedFiles(baseRef, cwd)` (tracked + staged + unstaged + untracked working-tree-relative diff with the 500-line truncation marker and binary placeholder from `docs/diff-contract.md`, `HEAD~1` fallback when `baseRef` is empty or unresolvable, `[]` on any git failure), `extractApiBase` / `extractToken` (regex extraction from the intercepted `/complete` curl), `putChangedFiles` (fetch-based `PUT /api/tasks/:id/changed_files` with body shape `{ changed_files: [...] }` per `docs/api/put_tasks_id_changed_files.md` — the bash hook sends a bare array, corrected here), `finalizeAfterDoing` (orchestrates capture → write `.stride-changed-files.json` → PUT, with try/catch at every layer so capture or upload failure cannot veto the agent `/complete` curl), and `readFinalizerEnv` (reads `TASK_ID` and `TASK_BASE_REF` directly from `.stride-env-cache` without touching the existing `TASK_ENV_KEYS` allowlist).
- **`extensions/hook-bridge/changed-files.test.ts`** — 35 new `node:test` cases (51 total in the suite) covering every capture path, the truncation marker, both binary-file paths, the `HEAD~1` fallback, the no-changes empty return, the git-binary-missing fallback (via `PATH=/nonexistent`), URL/token regex extraction, all `putChangedFiles` swallow paths (404, 500, network rejection, missing-token / missing-task-id / missing-base skip), the full `finalizeAfterDoing` end-to-end with snapshot file write, and the `readFinalizerEnv` happy / missing / EISDIR paths. Fetch is mocked via a `stubFetch` helper that swaps `globalThis.fetch` in `beforeEach` and restores in `afterEach` — no real network traffic in any test.

### Changed

- **`extensions/hook-bridge/index.ts`** — In the `tool_call` / `after_doing` branch, after `runHook` succeeds (or no hook is configured) call `finalizeAfterDoing` inside a `try`/`catch` so capture and PUT failures cannot return `{ block: true, reason }`. The agent `/complete` curl now ships per-file diffs to `/api/tasks/:id/changed_files` automatically — no agent-side `--argjson cf` or `cat .stride-changed-files.json` required.
- **`skills/stride-completing-tasks/SKILL.md`** — Added a new "Per-File Diff Capture (Automatic)" subsection under "How Hooks Fire" documenting the four-step capture-and-upload sequence the hook-bridge now performs, including the explicit pitfalls (no config-file reads, no curl rewriting, no new runtime env vars). Updates the `after_doing` bullet to point at the new subsection so agents know diff capture is handled for them.
- **`package.json`** — Version bumped from `1.0.0` to `1.1.0`.

### Why this release

`1.0.0` shipped the foundational hook-bridge that automatically runs the four `.stride.md` lifecycle hooks for Pi users. This release puts stride-pi on the G161/G162 hook-PUT architecture day-one: after `after_doing` succeeds, the extension captures per-file diffs against the task base ref and PUTs them to `/api/tasks/:id/changed_files` as a fire-and-forget side effect — independent of, and immune to clobbering by, the agent `/complete` body. Pi-completed tasks now show inline diffs in the Stride review queue without any agent-side wiring. The deprecated G148/W719 agent-inline `changed_files` pattern is bypassed entirely for Pi users from this version forward.

### Source

Stride W741 (capture + PUT implementation) + W742 (test coverage). Cross-plugin parity for the main `stride` plugin G161/G162 hook-PUT rollout. No marketplace-pin step — `stride-pi` is not distributed via `stride-marketplace`.

## [1.0.0] - 2026-05-20

### Added

- **Stride lifecycle skills (`skills/`)** — 11 skills covering the full Stride task lifecycle: `stride-workflow` (orchestrator), `stride-claiming-tasks`, `stride-completing-tasks`, `stride-creating-tasks`, `stride-creating-goals`, `stride-enriching-tasks`, `stride-subagent-workflow`, `stride-task-explorer`, `stride-task-reviewer`, `stride-task-decomposer`, and `stride-hook-diagnostician`. Ported from `stride-codex` and adapted for Pi's skill-activation model (auto-discovery via `~/.pi/agent/skills/` and `.pi/skills/`, plus `/skill:name` invocation). Sub-agents (`task-explorer`, `task-reviewer`, `task-decomposer`, `hook-diagnostician`) ship as inline Pi skills per ADR-001 model 2a — Pi has no separate sub-agent surface, so the orchestrator dispatches them by invoking the matching skill.
- **`AGENTS.md`** — Pi-edition agent context that Pi auto-loads from `~/.pi/agent/AGENTS.md` and from `AGENTS.md` walked up the project tree. Documents Stride's API authorization model, when to invoke the workflow orchestrator, and the inline sub-agent dispatch convention.
- **`install.sh`** — One-line installer (`curl … | bash`) with `--project` flag. Global mode copies skills to `~/.pi/agent/skills/` and `AGENTS.md` to `~/.pi/agent/AGENTS.md`; project mode targets `.pi/skills/` and project-root `AGENTS.md`. Idempotent — re-running upgrades in place.
- **`extensions/hook-bridge/`** — Pi extension that intercepts the four Stride API curl calls (`claim`, `complete`, `mark_reviewed`, `unclaim`) on Pi's `tool_call` / `tool_result` events and runs the matching `.stride.md` hook section automatically. `after_doing` failure vetoes the `/complete` curl via `{ block: true, reason }`; the other three hooks run post-call and log failures without blocking. 120 s per-hook timeout with SIGTERM → SIGKILL escalation. Task metadata is cached to `.stride-env-cache` after a successful claim so subsequent hook commands see `$TASK_IDENTIFIER`, `$TASK_TITLE`, etc., and the cache is deleted after `after_review`. This turns the four Stride lifecycle hooks from advisory checks the agent had to remember into automatic quality gates — the most user-visible feature of the 1.0.0 release.
- **`extensions/subagent-dispatch/`** — Pi extension implementing the `dispatch_agent` tool the orchestrator skill uses to dispatch the four inline sub-agent skills under the ADR-001 model 2a path.
- **`README.md`** — Pi-specific install, setup, and usage walkthrough including the `.stride_auth.md` / `.stride.md` configuration contract.
- **`docs/ADR-001-subagent-model.md`, `docs/ADR-002-hook-mechanism.md`** — Architecture decision records for the inline sub-agent skill model and the `pi.on(tool_call)` hook-bridge mechanism.

### Changed

- **`package.json`** — Version bumped from `0.4.0` to `1.0.0`. Marks the first stable release of stride-pi; the wire shape (Stride API contracts, `.stride.md` hook sections, `.stride-env-cache` format) is the supported public surface from this version forward.

### Why this release

`0.1.0`–`0.4.0` were the bring-up sequence: initial skill port, removal of the user-private `stride-development-guidelines` reference, hook-bridge introduction, and structured review-report emission. `1.0.0` is the first release that bundles all foundational components — skills, AGENTS.md, install.sh, sub-agent model, and the hook-bridge quality gate — into a single supported surface for Pi users. Future minor/patch versions track the wire-shape compatibility promise from here.

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
