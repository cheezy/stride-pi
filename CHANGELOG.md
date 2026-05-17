# Changelog

All notable changes to the Stride extension for Pi Coding Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
