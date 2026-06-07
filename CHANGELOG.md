# Changelog

All notable changes to the Stride extension for Pi Coding Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-06-07

Parity + correctness release. Closes the full stride-pi-vs-stride gap audit (goal G166): brings every skill, agent, and TypeScript extension up to the canonical Claude Code plugin's feature set — schema_version 1.3 review reports with `security_considerations`, the missing `task-enricher` subagent, the `## after_goal` `GOAL_*` env fix, claim-baseline `changed_files` anchoring, and a zero-config default install — while keeping the intentional Pi-specific adaptations explicit.

### Added

- **`task-enricher` subagent (W1013, W1014)** — the previously-missing fifth agent. New `extensions/subagent-dispatch/agents/stride-task-enricher.md` ports the canonical four-phase enrichment procedure (intent parse → six-step codebase exploration → complexity → 17-item checklist incl. `security_considerations`) to the Pi agent format, and a matching inline `stride-enriching-tasks` skill path. `task-enricher` is wired into the dispatch registry (extracted to a pi-free `extensions/subagent-dispatch/agents-registry.ts`, imported by `index.ts`), so the dispatch tool now resolves **5** agents. First-ever subagent-dispatch test suite added (`index.test.ts`).
- **`security_considerations` as a first-class review_queue-scored field** across the creation, enrichment, decomposition, and review skills/agents (W1007, W1008, W1011) — added to the scored-field banners, the per-task field templates, every worked example, the Embedded-Object-Formats subsection (array-of-strings, with the `"None — …"` escape hatch), and the `## Consuming Provided Context` (`--dir` bundle) sections.
- **Doc-level orchestrator gating** on every internal sub-skill (W1007, W1008, W1015, W1016, W1017, W1018) — `INTERNAL` frontmatter descriptions, `## STOP — orchestrator check` blocks, and `skills_version: 1.0`. This is deliberately **doc-level only**: stride-pi does not ship the Claude plugin's PreToolUse skill-gate hook (Pi has no equivalent), so the gating is framing, not enforcement.

### Fixed

- **`after_goal` now actually forwards `GOAL_*` env (W1019)** — the 1.2.0 changelog claimed `GOAL_ID` / `GOAL_IDENTIFIER` / `GOAL_TITLE` / `GOAL_DESCRIPTION` were forwarded into the `## after_goal` child process, but no code parsed the server's `hook.env`. New `extractGoalEnvFromResult` in `after-goal-detector.ts` sources `GOAL_*` (plus `BOARD_*` / `COLUMN_*` / `AGENT_NAME`) verbatim from `hook.env`; omitted canonical keys default to empty strings; prototype-pollution keys and non-string values are dropped; the API token is never injected. `buildHookEnv` / `runHook` gained an `extraEnv` parameter.
- **`after_goal` env-cache deletion ordering on the mark_reviewed route (W1019)** — the env cache was deleted *before* `after_goal` ran on `/mark_reviewed`. Extracted the post-hook sequence into a pure, import-free `after-goal-runner.ts` (`runAfterGoalAndCleanup`) that runs `after_goal` first, then cleans up — mirroring canonical `stride-hook.sh` ordering.
- **`TASK_BASE_REF` persistence so `changed_files` anchors to the claim baseline (W1020)** — `changed-files.ts` read `TASK_BASE_REF` to anchor diffs, but nothing computed or persisted it, so the snapshot always fell back to `HEAD~1` and mis-reported the delta whenever the commit count since claim ≠ 1. `index.ts` now runs `git rev-parse HEAD` at claim time, adds `TASK_BASE_REF` to `TASK_ENV_KEYS`, and persists it via `writeEnvCache` (with `taskToEnv` refactored to a git-free `TASK_FIELD_MAP`). Empty refs preserve the `HEAD~1` fallback.
- **Missing required completion fields (W1016)** — every `/complete` JSON example in `stride-completing-tasks` omitted `completion_summary`, `actual_complexity`, and `actual_files_changed` (a copy-paste-level bug that fails strict validation); added to both examples plus `skills_version`. The dispatched `reviewer_result` shape was upgraded from the thin legacy envelope to the full structured block with the "do not send only the thin envelope" warning.

### Changed

- **Reviewer review-report contract upgraded to `schema_version` 1.3 (W1009, W1010, W1015, W1017)** — both reviewer variants (the dispatched ext-agent and the inline skill) emit the full canonical fenced ```json block: `status`, `issue_counts`, `issues[]` with the 7-value category enum (incl. `security` and `project_check`), `acceptance_criteria[]`, `project_checks[]` (CODE-REVIEW.md mechanism), and the four per-section verdicts (`testing_strategy` / `patterns` / `pitfalls` / `security_considerations`). The two variants are reconciled to describe the **same** block (no dual-variant contradiction). The orchestrator (`stride-workflow` Step 6) and `stride-subagent-workflow` gained the structured-block extraction + legacy↔structured field mapping and parse-failure fallback.
- **`task-decomposer` and `hook-diagnostician` fleshed out to canonical depth (W1011, W1012)** — the decomposer gained the full methodology (scope analysis, boundary identification, dependency ordering, complexity table, dependency-graph patterns, special cases, a complete worked example) and removed a duplicate `## Constraints` header; the diagnostician gained the 6-category Failure Pattern Catalog, structured-JSON-vs-raw-text input detection (documenting **both** the Pi hook-bridge result shape and the cross-plugin `stride-hook.sh` shape), timeout thresholds, and two worked examples.
- **Default install now ships the extensions (W1021)** — `install.sh` installs the `hook-bridge` + `subagent-dispatch` extensions **by default**, so `.stride.md` lifecycle hooks auto-fire out of the box (matching the Claude plugin's zero-config wiring). Added a `--no-extensions` (alias `--skills-only`) opt-out; `--with-extension` is kept as a deprecated no-op. Removed the empty `prompts` declaration from `package.json` and the unused `.gitkeep`-only `prompts/` and top-level `agents/` placeholder dirs.
- **`stride-claiming-tasks` sends `skills_version` on every claim (W1018)** with a stale-skills handling pointer.

### Validation & Tests

- **All `node --test` suites green: 85/85** (hook-bridge 79, subagent-dispatch 6). New coverage: `extractGoalEnvFromResult` + `runAfterGoalAndCleanup` (W1019, 13 tests), `TASK_BASE_REF` round-trip + anchored-diff (W1020, 2 tests), and the `AGENT_NAMES` registry resolution (W1014, 6 tests).
- **`dispatch_agent` event contract verified live (W1022)** — ran `pi --mode json -p` against `pi-coding-agent@0.67.68` and confirmed the final assistant answer arrives as a `message_end` event with `message.content[].text`, validating `extractMessageText`'s filter. The full content-bearing happy-path and the `tool_result_end` name remain unverified on the test box (no working LLM provider) and are documented as such in `docs/smoke-test-w277-dispatch-agent.md` and `docs/validation-phase3.md`.

### Intentional Pi-specific deviations (not gaps)

- **Doc-level gating, no enforcement hook.** Internal sub-skills carry `## STOP — orchestrator check` framing and `INTERNAL` descriptions, but stride-pi does **not** ship the Claude plugin's PreToolUse skill-gate (Pi has no PreToolUse hook). The gate is documentation, by design.
- **Dual dispatch/inline path.** Pi has no native subagent dispatch, so every subagent role ships **both** as a dispatched `dispatch_agent` extension agent and as an inline skill fallback (`--no-extensions`). The work and output shape are identical; only isolation differs.
- **hook-bridge re-platforming.** Lifecycle hooks run via the `hook-bridge` Pi extension intercepting the curl `tool_call`/`tool_result` events (with a placeholder `*_result` in the request body), rather than the Claude plugin's `hooks.json`. The single `HOOK_TIMEOUT_MS = 120000` deadline replaces the server-supplied per-hook timeouts.

### Source

G166 / W1007–W1023. Final parity audit, version bump, and CHANGELOG/README/AGENTS update closing the stride-pi-vs-stride gap analysis.

## [1.2.1] - 2026-05-25

### Updated

- **`skills/stride-creating-tasks/SKILL.md`** (W869) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING" callout that names the four fields the review_queue dashboard scores on every completion (`acceptance_criteria`, `testing_strategy`, `pitfalls`, `patterns_to_follow`) and frames the consequence of omitting any of them: a visible, public, persistent **empty pill** on the dashboard that does not get back-filled later. Reinforces with four new bullets in the existing **Red Flags - STOP** list and four new rows in the existing **Rationalization Table**. Wording matches the stride/ Claude Code variant for cross-plugin consistency.
- **`skills/stride-enriching-tasks/SKILL.md`** (W870) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING — ENRICHMENT IS THE LAST CHANCE" callout. Promotes the four scored fields to individual mandatory-for-review items in the Phase 4 16-item pre-submission checklist (replacing the prior single-line bundling), each with its specific empty-pill condition. Adds four new Red Flags - STOP bullets.
- **`skills/stride-creating-goals/SKILL.md`** (W871) — Adds a top-of-file "⚠️ REVIEW QUEUE SCORING — NESTED TASKS ARE NOT EXEMPT" callout stressing the four-field minimum bar applies to every nested task individually — no "it's just a subtask" discount. Strengthens Task Nesting Rules with a per-field block enumerating each scored field with its empty-pill condition. Adds four new Red Flags - STOP bullets and four new Rationalization Table rows.

### Backward compatibility

Content-only release. No hook script, parser contract, env-var matrix, API field shape, or workflow step changed — every behavior is byte-identical to 1.2.0. The three SKILL.md edits strengthen guidance only; existing task-creation, enrichment, and goal-creation calls continue to validate without modification. No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes are required.

### Source

G166 / W869 / W870 / W871 / W872. Patch release — documentation-only emphasis updates across three SKILL.md files. The change set mirrors the stride/ plugin's 1.17.3 release (Claude Code variant) and the goal is to raise the floor on the four fields the review_queue dashboard scores at completion, so empty pills become rare rather than common.

## [1.2.0] - 2026-05-22

### Added

- **`## after_goal` hook section** — fifth `.stride.md` hook, fires after the parent goal's final child task completes. Blocking, same single-bash-fence parsing rule as the four existing hooks. The `stride-pi-hook-bridge` extension's `tool_result` handler now inspects the response payload of `/complete` and `/mark_reviewed` for an `after_goal` entry and executes the local `## after_goal` section as a blocking hook when present (W797). The extension emits structured JSON (`{hook, status, exit_code, output, failed_command?, duration_ms}`) on stdout so the Pi agent can forward the result via `PATCH /api/tasks/:goal_id/after_goal` to flip the parent goal to Done. Missing section is a clean no-op (back-compat). For users not installing the hook-bridge extension, the agent runs the after_goal lifecycle manually using the five-step procedure documented in `skills/stride-workflow/SKILL.md` Step 9.
- **`responseHasAfterGoal(content, details)`** — new module in `extensions/hook-bridge/after-goal-detector.ts` (W797 implementation, W798 refactor for testability). Handles the three transport shapes that pi's existing `extractTaskEnvFromResult` handles: structured `details.output` (preferred), raw `content` (fallback), and the Bash-tool `{stdout: "<inner-json>"}` wrapper. Returns false on any parse failure — additive behavior preserves pre-W797 routing for the four existing hooks.
- **`StrideHookName` widened** to include `"after_goal"` in `extensions/hook-bridge/curl-matcher.ts`. `detectStrideHook` still routes only the four URL-driven hooks; the new value flows in via the response-payload detector.
- **`GOAL_*` env vars** — `GOAL_ID`, `GOAL_IDENTIFIER`, `GOAL_TITLE`, `GOAL_DESCRIPTION` intended to be forwarded into the `## after_goal` child process environment, sourced verbatim from the server-supplied `hook.env`. `BOARD_*`, `COLUMN_*`, `AGENT_NAME`, and `HOOK_NAME` remain present across all five hooks. **Correction (W1019, see [1.3.0]):** this forwarding was documented but never implemented in 1.2.0 — `buildHookEnv` merged only the six `TASK_*` keys plus `HOOK_NAME` and nothing parsed `hook.env` for the after_goal entry, so `GOAL_*` were empty at runtime. The 1.3.0 fix actually implements it.
- **`skills/stride-workflow/SKILL.md`** (W799) — Step 7 (Execute Hooks) opens with a Hooks Reference table listing all five hooks (timing/blocking/timeout/purpose), Hook Environment Variables matrix (`TASK_*` vs `GOAL_*` per hook), and Canonical Hook Examples block. Step 9 (Post-Completion Decision) gains a subsection covering the goal-Done transition with two explicit paths: **with-extension** (auto-fires via W797 routing) and **without-extension** (5-step manual procedure: detect → read → export → execute → POST). Examples explicitly note the hook is general-purpose (Slack notifications, artifact archival, release pipelines, project-level smoke tests are all valid uses).
- **`AGENTS.md`** (W799) — Hook Execution section rewritten to describe both paths (with-extension auto-fires all 5 hooks, without-extension runs the manual procedure) with explicit after_goal coverage in both, plus cross-reference to SKILL.md Step 7+9.
- **`extensions/hook-bridge/index.test.ts`** (W798) — 13 new tests in a `describe("responseHasAfterGoal", ...)` block covering: wrapped Bash-tool payload, raw API JSON payload, `details.output` preferred over content, fallback when `details.output` is missing, absent after_goal, empty hooks array, missing hooks key, malformed outer JSON, malformed inner stdout JSON (falls back cleanly), both candidates empty, non-string `details.output` skipped, defensive non-object entries in the hooks array, and candidate iteration order. Suite total: 64/64 pass (51 prior + 13 new) via `node --test --experimental-strip-types`.

### Backward compatibility

A `.stride.md` without a `## after_goal` section continues to work unchanged. The four existing hook routes produce behaviorally identical output (empirically confirmed by all 51 pre-existing tests passing unchanged after the new W797 routing block was added). Older agent runtimes that don't speak the after_goal protocol — including those that don't make the PATCH POST — are covered by the server-side grace-window worker, which promotes the goal to Done automatically with a synthetic attempt tagged `source: "after_goal_grace_worker"`.

### Note on the v1.1.0 tag gap

Commit `<sha> Release 1.1.0` was committed but never tagged on origin (latest origin tag was v1.0.0 before this release). This v1.2.0 release captures the prepared v1.1.0 work alongside the new after_goal feature, so installing v1.2.0 picks up both.

### Migration

Install via your normal stride-pi install flow. No `.stride.md`, `.stride_auth.md`, or `.gitignore` changes are required. To opt into the new hook, add a `## after_goal` section to `.stride.md`. Users with the `stride-pi-hook-bridge` extension installed get automatic execution; users without it follow the manual five-step procedure documented in `skills/stride-workflow/SKILL.md` Step 9.

### Source

G166 / W797 (extension hook-bridge routing in index.ts + curl-matcher.ts), W798 (13-test responseHasAfterGoal coverage in index.test.ts + extraction to after-goal-detector.ts), W799 (SKILL.md + AGENTS.md), W800 (this release). Pattern mirrors the Claude plugin's v1.17.1 release.

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
