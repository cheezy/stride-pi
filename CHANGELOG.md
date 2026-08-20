# Changelog

All notable changes to the Stride extension for Pi Coding Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release record — tags without a GitHub release

*This is a record-keeping note, not a release. It describes no change to this plugin and carries no version.*

A fleet-wide audit found **3 tags** in this repository that are tagged and pushed but have no corresponding GitHub release. **The gap is accepted and will not be backfilled.** It is recorded here so the next release engineer does not rediscover and re-litigate it:

- `v0.2.0` — 2026-05-08
- `v0.3.0` — 2026-05-17
- `v0.4.0` — 2026-05-19

Why accepted rather than backfilled:

- **Nothing resolved through these releases.** A GitHub release is a human-readable record, not a resolution mechanism — nothing installs *through* one. The missing releases cost nothing at the time and cost nothing now.
- **Backfilling would be worse than the gap.** A release created today against a commit from April or May would be dated today, and would manufacture a record for a state no user ever resolved through — misrepresenting the very history it claims to document.
- **The convention itself is unchanged.** These are omissions from a few release cycles, not a policy shift. Every tag still gets a release going forward.

The audit also found **zero** GitHub releases without a matching tag, so the record is incomplete in only this one direction.

## [Unreleased]

### Added — Step 3 row precedence, the complexity fallback row, and the `reason_code` skip vocabulary (W2112, closing D253 and porting D239)

Two rules the fleet canon records for every port had no text behind them in this one, and the drift check reported all four in-scope rules missing here.

**Row precedence and the fallback row.** More than one row of the Step 3 decision matrix can describe the same task — a defect of `medium` complexity matches the complexity row and the type row at once — and nothing said which one governed, leaving the collision D232 had just cleared out of the surrounding prose alive inside the rows themselves. Step 3 gains a `Row Precedence` subsection stating the reading order: Branch A's row, then `small, 0-1 key_files` whatever the task's type, then `Defect type` ahead of the bare complexity rows, then the complexity row itself, then the fallback. That order follows the printed rows except in one place — `Defect type` prints sixth and is settled third. The matrix also gains a closing `Complexity absent or unrecognised` row (Decompose Skip, Explore YES, Plan YES, Review YES) for a task arriving with no complexity or an unfamiliar one, which until now matched no row whatsoever; the precedence text confines that row to exactly that case and rules out using it to break a tie. The `stride-subagent-workflow` mirror gains the same row in its own `Run`/`Skip` vocabulary, since that table is required to agree with Step 3 row for row — the order itself is stated once, in Step 3, and the mirror points at it. Putting the single-file row above the type row was deliberate: reversed, Explore and Review would flip to YES for every small single-file defect, contradicting Branch B, so this ordering resolves the ambiguity without moving any task onto a different route (D221, D232).

**The `reason_code` skip vocabulary (D239).** A `workflow_steps` entry with `dispatched: false` may now carry an optional `reason_code` beside its prose `reason`, never in place of it — the code is what a compliance breakdown can group on; the sentence is for the person reading the task. The Per-Step Schema table gains the key, and a new vocabulary subsection gives the six accepted values: `decision_matrix_skip`, `ran_inline`, `hook_body_empty`, `subsumed_by_task_spec`, `folded_into_prior_step`, `matrix_deviation`. The set is closed — anything outside it is refused with a `422` — while omitting the key stays valid, so a payload written before this field existed validates unchanged. `matrix_deviation` is the one value that records non-compliance, and it exists so that a step the matrix required and nobody ran cannot be filed as a sanctioned skip.

**Canon anchors.** The four in-scope rules — the failed-verdict note rule, the sole-decision-point rule, row precedence, and the `reason_code` vocabulary — each gain the canon marker comment beside this port's own statement of the rule, so the fleet drift check can tell "carried here" apart from "never checked". The markers only mark; no rule text was reworded to match another port. The verdict-note marker sits beside the Verdict-note rule in this runtime's nested reviewer prompt at `extensions/subagent-dispatch/agents/stride-task-reviewer.md`, which enumerates this port's four section verdicts and gains no fifth: there is no `behaviour_test_matrix` verdict on this runtime, and the canon records that divergence rather than smoothing it over.

Documentation-only and producer-side: no completion field becomes required, and no server behaviour changes.

## [1.16.0] - 2026-08-19


### Fixed — the failed-verdict `note` rule the server already enforces (D240)

This port's task-reviewer prompt described `note` as optional on every section verdict. The completion API has required it on a `"failed"` verdict since D231, and enforces that **unconditionally** — independently of the `strict_completion_validation` flag — so an agent on this runtime could emit a note-less failed verdict that its own prompt endorsed and be rejected with a `422`. The rejection is self-describing and recoverable, so nothing was broken; every such completion simply paid an avoidable round trip.

The prompt now states that on a `"failed"` section verdict `note` is **REQUIRED** and must name the specific violation or gap in at least **20 non-whitespace characters**, carries the anti-placeholder prohibition (no stub, `TODO`, empty string, or bare restatement of the status), and directs that an empty note means the *verdict* is wrong rather than that the note is unnecessary. `note` stays **optional** on `"passed"` and `"not_assessed"`, so the ordinary empty-section case gains no friction.

Producer-side only: the server-side check in `Kanban.Tasks.CompletionValidation.ReviewContract` is unchanged, and no port was accommodated by weakening it.

### Fixed — planner precedence: the decision matrix is the sole decision point (D232, propagating D221)

This port carried the same ambiguity D221 fixed in the canonical plugin: the `stride-workflow` Step 3 decision matrix row `small, 2+ key_files` says Plan = Skip, while Branch C prose independently said "If medium+ OR 3+ key_files OR 3+ acceptance criteria lines: Outline your implementation approach" — two separately-satisfiable planner triggers with no stated precedence. The same conflict pattern existed for the Explore and Review columns (`stride-workflow` Step 5, `stride-subagent-workflow` Phases 1–3 plus its role quick-table, `stride-completing-tasks`' pre-completion review items, and this port's unique `stride-task-explorer`/`stride-task-reviewer` skill activation lines), plus drifted narrower "medium+"-only restatements in the flowcharts and quick-reference cards. Measured consequence in canonical: two runners on identically-shaped tasks resolved the collision differently and wrote different skip reasons into `workflow_steps` telemetry.

The fix mirrors canonical's D221 resolution: the Step 3 matrix now states it is the **sole decision point** for its columns, and every restatement reads its matrix column with "**Read the column; do not re-derive the condition here** (D221)" instead of re-deriving a condition. A small task carrying 3+ key_files or 3+ acceptance-criteria lines remains a mis-labelling signal to record in completion notes, never an independent planner trigger. Resolved toward the matrix (Plan = Skip for `small, 2+ key_files`), so no planner dispatch is added to the most common task shape.

Recorded verification grep (should return only row definitions, D221 history, and matrix-agreeing glosses — never a rule that could fire independently of the matrix):

```
grep -rniE "if medium|medium\+ OR|medium or large, OR|3\+ (key_files|criteria|acceptance)|2\+ key_files" --include="*.md" skills/ extensions/
```

## [1.15.0] - 2026-07-28

### Fixed — three stale workflow step cross-references (D176)

This port numbers Code Review as **Step 5**, Execute Hooks as **Step 6**, Complete as **Step 7** and Post-Completion as **Step 8**. Three references disagreed, sending a reader — or an agent — to the wrong step:

- **`skills/stride-completing-tasks/SKILL.md`** — the orchestrator entry point read "you arrive here at **Step 7-8**"; corrected to **Step 6-7** (Execute Hooks → Complete). The prerequisite line read "Code review was performed against acceptance criteria (Step 6)"; corrected to **(Step 5)**. Both now match the canonical `stride` plugin, which differs only in its `stride:` skill-namespace prefix — this port is unprefixed throughout, so that one token stays as it is.
- **`AGENTS.md`** — the `after_goal` instruction pointed at "`stride-workflow` SKILL.md **Step 7+9**". This port has no Step 9 at all. The whole five-step after_goal procedure lives in **Step 8**, and the `GOAL_*` env-var matrix the instruction depends on is in **Step 6**, so the pointer now names both rather than a range whose lower bound documents neither. Found by the sweep that verified the other two rather than by the original audit, and worth fixing here because `AGENTS.md` is guidance an agent reads directly.

Every reference was resolved against this port's own `## Step` headings rather than replaced in bulk — sibling ports legitimately number Code Review as Step 6, so a fleet-wide replacement would corrupt them. The references that cite "Extracting the structured review block" **by name and carry no step number** are correct as written and were deliberately left alone; that is why this port never had the seven-citation version of this defect that the Gemini port did.

### Added — `behaviour_test_matrix` in the Step 5 self-review checklist (W1949)

The Step 5 self-review checklist in `skills/stride-workflow/SKILL.md` gained a `behaviour_test_matrix` bullet, so the non-subagent path checks the field it was already told to write. Landed on main ahead of this release and is documented here rather than shipping unrecorded.

### Fixed — the enrichment surface documented create and update bodies without their `task` root key (D151)

`stride-enriching-tasks` documented submitting an enriched task with a bare body: `POST /api/tasks` carried `-d '{...enriched task JSON...}'` and no `agent_name`. The server requires a `{"task": {...}}` envelope and rejects a bare object with `422 Missing 'task' key`, so an agent following the enrichment skill literally built a rejected request and — once corrected by hand — created a task with no attribution fallback. The create example now shows the envelope with `"agent_name": "Pi"` beside the `task` key, matching the Request Envelope section in `stride-creating-tasks` and the plain agent name this port already sends on claim and complete.

The same file's `PATCH /api/tasks/:id` example was broken the same way and is fixed too — but its rule differs and the doc now says so: `PATCH` needs the identical `task` root key, yet takes **no** `agent_name`, because attribution is create-only and `created_by_agent` is forbidden on update. Conflating the two would have been its own defect.

The `task-enricher` agent doc is deliberately **left unwrapped**: its JSON is the agent's return value for the orchestrator to submit, not a request body, so an envelope there would be wrong. It gains a note saying exactly that, and pointing at who does the wrapping.

This surface was missed by goal G4687 (the fleet-wide `agent_name` rollout) because it sits outside that goal's tasks' `key_files` and outside both of their grep sweeps.

### Testing

Documentation-only; no test suite is exercised.

- **D176** — verified by grep sweep against this port's own `## Step` headings: `grep -n '^## Step' skills/stride-workflow/SKILL.md` confirms Code Review is Step 5, Execute Hooks Step 6, Complete Step 7 and Post-Completion Step 8, with no Step 9; a repo-wide sweep excluding `CHANGELOG.md` leaves no reference naming a step it does not mean, and the three by-name citations of "Extracting the structured review block" still carry no step number. Both corrected lines match the canonical `stride` plugin token for token apart from its `stride:` skill-namespace prefix.
- **W1949** — documentation-only checklist addition; nothing to exercise.
- **D151** — verified by grep sweep: the enrichment create example carries the envelope and this port's own agent name, matching its `stride-creating-tasks` Request Envelope section; every curl body in the file is brace-balanced; and no other file in the port documents a create body.

### Backward compatibility

Fully backward compatible. Documentation/skill-text only — no hook logic, `.stride.md`, env-var, or `.stride_auth.md` change. The documented shapes are corrected to what the server has always required; nothing that previously worked stops working.

### Source

This release bundles three tickets. As always for this port, it ends at the tag and GitHub release on this repo — **stride-pi has no marketplace catalog**; it installs by a curl-to-bash script from its own `main`.

- **D176** — part of goal G386, which reconciles step-reference and release-record drift across the Stride fleet. The canonical `stride` plugin's `skills/stride-completing-tasks/SKILL.md` is the reference wording for both corrected lines. Deliberately **not** a fleet fix: `stride-codex` and `stride-opencode` number Code Review as Step 6 correctly, so a blanket replacement would corrupt them.
- **W1949** — fleet-wide follow-up to G381 (`behaviour_test_matrix`); the bullet landed on `main` ahead of this release and is recorded here rather than shipping unlogged.
- **D151** — follow-up to goal G4687; the gap was recorded by the W1684 reviewer as out of scope at the time. Kanban `task_controller.ex` is the contract of record: `create/2` reads `agent_name` beside the `task` key, `update/2` requires `task` and reads no `agent_name`.

## [1.14.0] - 2026-07-16

### Added — every documented create payload carries a top-level `agent_name` (W1694)

Ports the canonical `stride` plugin's W1684 change (released as `stride` v1.37.0) into the Pi extension. `stride-creating-tasks`, `stride-creating-goals`, and **both** decomposer docs — `skills/stride-task-decomposer/SKILL.md` and `extensions/subagent-dispatch/agents/stride-task-decomposer.md`, which carry the contract in parallel — now document a top-level `agent_name` on every create request: beside the `task` root key for `POST /api/tasks` and beside the `goals` root key for `POST /api/tasks/batch`, set to the exact same plain agent name the extension already sends as `agent_name` on claim and complete (`"Pi"`, never the `ai_agent:<model>` token form).

Per-task `created_by_agent` is forgotten in practice and cannot be backfilled (`PATCH` rejects it), so tasks lost their attribution permanently and the `/agents` feed rendered them with a `?` avatar. The root-level param is the always-sent fallback that kanban D137 teaches the server to read. Both creation skills gain the full five-step server resolution order (explicit `created_by_agent` → token `ai_agent:<model>` → top-level `agent_name` → token's last agent name → unset), an `agent_name` row in their field tables, and an explicit note that `agent_name` is display metadata only — never an authorization signal.

**Scope note:** documentation-only. The extension's TypeScript builds no create payload — the hook bridge handles curl matching, `changed_files` capture/PUT, and the `after_goal` PATCH, while the agent itself issues the create request. A repo-wide grep confirms no `POST /api/tasks` call and no `agent_name` reference in any non-test `.ts`, so there is no builder to update. `skills/stride-workflow/SKILL.md` was likewise checked and left unchanged: it references the create endpoints in prose only and embeds no payload shape.

### Fixed — `stride-creating-tasks` documented the single-create body without its `task` root key

The skill's complete example was a bare task object, but `POST /api/tasks` requires a `{"task": {...}}` envelope and returns `422 Missing 'task' key` without it. Surfaced while placing `agent_name` "beside the task root key" — the key it had to sit beside was never documented. A new Request Envelope section shows the wrapper with `agent_name` as its top-level sibling, and the Quick Reference heading now names the block as the value of the `task` key rather than the request body; the single-goal format in both decomposer docs is corrected the same way. The extension inherited this defect from the canonical plugin, where W1684 fixed it.

### Testing

Documentation-only; no `.ts` file changed and the `node --test` suite is untouched. Verified by the task's grep sweeps: both creation skills document the top-level `agent_name`, both decomposer docs carry it symmetrically, every literal create and batch payload in the repo carries it, and every non-illustrative `json` fence across the four changed docs parses as valid JSON.

### Backward compatibility

Fully backward compatible, and safe to ship ahead of the server. No `.ts`, hook, `.stride.md`, env-var, or `.stride_auth.md` change. Unknown top-level keys are ignored by older servers, so sending `agent_name` before kanban D137 reaches production is a no-op. `created_by_agent` guidance is unchanged and still highest precedence — the new param is a fallback, never a replacement.

### Source

W1694 — mirrors the canonical `stride` plugin's W1684 (`stride` v1.37.0) and the `stride-codex` (v1.25.0), `stride-copilot` (v2.26.0), `stride-gemini` (v1.36.0), and `stride-opencode` (v1.28.0) ports. Kanban D137 ships the server half. Released by W1695 as `stride-pi` v1.14.0 (tag + GitHub release on this repo only — stride-pi has no marketplace catalog).

## [1.13.0] - 2026-07-14

Ports all three of the canonical `stride` plugin's D142 base-ref / snapshot fixes (released as `stride` v1.36.0) into the Pi hook bridge. `TASK_BASE_REF` was captured at claim time — in the `tool_result` before_doing branch, **before** `runHook` executed the `## before_doing` section's `git pull` — so the after_doing `changed_files` diff spanned commits pulled from **another clone** (the D132/W1678 incident), and the W1529 dirty-baseline filter silently dropped committed task work (D137). This is a **minor** bump (1.12.1 → 1.13.0): additive trust-guard + reorder, no wire-shape changes. Per the ADR-002 structural constraint, all new logic lives in the pure, unit-tested modules (`env-cache.ts`, `changed-files.ts`); `index.ts` only wires them.

### Fixed — capture `TASK_BASE_REF` after the before_doing section (D132)

- **`extensions/hook-bridge/env-cache.ts`, `index.ts`** — `resolveClaimEnvCache` is inverted to persist task **identity only** and strip any inherited `TASK_BASE_REF` / `TASK_BASE_REF_TRUSTED`; a new pure `resolveFinalizeBeforeDoingEnv` writes the base plus the `TASK_BASE_REF_TRUSTED` marker, which `index.ts` now calls **after** `runHook` returns for the before_doing route (regardless of hook exit code), re-recording the claim-time dirty baseline against the post-pull tree. `TASK_BASE_REF_TRUSTED` is added to `TASK_ENV_KEYS`.

### Fixed — trust-guard the snapshot base (D132)

- **`extensions/hook-bridge/changed-files.ts`** — New exported `resolveSnapshotBase(baseRef, cwd, trusted)` implements the three reference rules (empty/unresolvable, non-ancestor-of-`HEAD`, and — for **unmarked** inherited bases only — strict-ancestor-of-branch-point) from the merge-base of `HEAD` and the origin default branch, with a loud `console.error` recompute (a repo with no origin passes the base through). `finalizeAfterDoing` and `selfHealChangedFilesUpload` resolve the base **once per task window** and persist it as a `base=` line in `.stride-diff-upload-state` (`recordDiffUploadState` / `readDiffUploadState` gain the field), reusing it on the post-gate refresh and the before_review self-heal so an after_doing `git push` advancing `origin/main` cannot recompute a correct base to `HEAD` and empty the snapshot. `readFinalizerEnv` now reports the trust marker.

### Fixed — never drop committed task work from the snapshot (D137)

- **`extensions/hook-bridge/changed-files.ts`** — `captureChangedFiles` overrides the W1529 dirty-baseline exclusion for any path in the `base..HEAD` committed range: committed range = task work, by definition.

### Testing

`npm test` (`node --test`) grows from 195 to 213 tests, all passing. New coverage: `resolveSnapshotBase` unit tests over a two-clone bare-origin cross-pull fixture (recompute for older/empty/unresolvable/non-ancestor, passthrough for trusted / branch-point-equal / no-origin, and the loud stderr notice), the committed-range override (D137), the `base=` round-trip, `readFinalizerEnv` trust-marker parsing, the inverted `resolveClaimEnvCache` + `resolveFinalizeBeforeDoingEnv`, and two `finalizeAfterDoing` integration tests (two-clone cross-pull excludes the other clone's pulled file and records the trusted post-pull base; push-in-after_doing reuses the persisted base so the refresh does not empty the snapshot). The new tests reference `resolveSnapshotBase` (absent pre-fix), so they fail by construction against the old code.

### Backward compatibility

Backward-compatible and additive. The `TASK_BASE_REF_TRUSTED` cache key and the `base=` state line are tolerated when absent (an inherited cache simply gets the full trust guard; older state files report `base` as `undefined`). No marketplace update — the extension installs via a `github:` ref pin.

## [1.12.1] - 2026-07-10

changed_files upload reliability fix: ports the two Claude Code hook changes (D127 + W1658) that stop completed review tasks from landing with an empty `changed_files` array. The hook was uploading the per-file diff to the task id from the env cache, which goes stale when the claim response is hidden from the hook — so the diff was PUT to the *previous* task and the current task's `changed_files` stayed empty, silently. This is a **patch** bump (1.12.0 → 1.12.1): no wire shapes change and the upload target resolution is now derived from the authoritative `/complete` URL.

### Fixed — target the changed_files upload by the /complete URL id (D127)

- **`extensions/hook-bridge/curl-matcher.ts`, `changed-files.ts`** (W1671) — New `taskIdFromCommand()` parses the bare **numeric** id from a `/complete` or `/mark_reviewed` command URL (mirrors `task_id_from_command` in `stride/hooks/stride-hook.sh`; pure string parse, no network call, non-numeric segments rejected). `finalizeAfterDoing` and `selfHealChangedFilesUpload` now resolve the upload target as `taskIdFromCommand(command) || opts.taskId`, so a stale env-cache `TASK_ID` can no longer misroute the diff; the env id remains the fallback only on the claim path (whose URL carries no id). 8 unit tests + stale-env targeting integration tests for both finalize and self-heal.

### Fixed — fail loud on a terminal changed_files upload failure (W1658)

- **`extensions/hook-bridge/changed-files.ts`** (W1672) — When the `before_review` self-heal's last-retry PUT returns non-2xx, the hook now emits a distinct `CHANGED_FILES UPLOAD UNRESOLVED for task <id> (HTTP <code>)` message to stderr and appends `unresolved=yes` to `.stride-diff-upload-state`, so a definitively-lost diff is queryable rather than silent. Fail-soft: the completion is never vetoed. A later successful (2xx) PUT overwrites the state file and self-clears the mark; a legitimately-empty diff that PUTs 2xx takes the success path. Only the id + HTTP code are recorded — never the bearer token. 3 tests. The `node --test extensions/hook-bridge/*.test.ts` suite grew to **195 passing** tests.

### Backward compatibility

No hook-bridge **wire shapes** changed — the claim/complete/changed_files payloads and the structured hook-result JSON are identical. The change is confined to how the upload target id is resolved (URL-derived, env-cache fallback) and an added terminal fail-loud signal.

## [1.12.0] - 2026-07-09

after_goal reliability release: the hook-bridge no longer depends on Pi's truncatable `tool_result` payload to detect the `after_goal` lifecycle. A truncated `/complete` or `/mark_reviewed` response — where the echoed `reviewer_result` alone can run to tens of KB — previously dropped the `after_goal` entry and silently skipped the goal-completion hook. The extension now writes an untruncated canonical response file, reads it in preference to the intercepted output, and falls back to an independent server-truth GET as the guarantee. Because this adds new hook-bridge runtime behavior (a new pure module plus wiring in `after-goal-detector.ts` / `after-goal-runner.ts` / `index.ts`), this is a **minor** bump (1.11.0 → 1.12.0).

### Added — after_goal detection reliability (canonical file + fresh GET)

- **`extensions/hook-bridge/after-goal-status.ts`** (W1641) — New pure, dependency-injected module ported from stride D118/D119: `readCanonicalResponse(cwd)` / `writeCanonicalResponse(cwd, text)` for `<cwd>/.stride/.last-api-response.json` (the writer refuses non-JSON, so a truncated payload never clobbers a good file), and `getAfterGoalStatus({fetch, apiBase, token, taskId})` → `{armed, goalId, env}` (injected `fetch`, no-ops on missing creds / network error / non-2xx / unparseable body). `.stride/` is excluded from `changed_files` and gitignored. 16 tests.
- **`extensions/hook-bridge/after-goal-detector.ts`, `index.ts`** (W1642) — `collectCandidates` now consults an injected canonical-file reader **first**, falling back to the tool-output candidates; threaded through `responseHasAfterGoal` / `extractGoalEnvFromResult` as an optional trailing param (2-arg calls stay valid). On `before_review` / `after_review` the tool_result handler captures the first complete-valid-JSON candidate to the canonical file (a truncated one is skipped; a complete one overwrites a stale prior-call file). 12 tests.
- **`extensions/hook-bridge/after-goal-runner.ts`, `index.ts`** (W1643) — D119 reliability guarantee: `runAfterGoalAndCleanup` gains an optional `freshAfterGoalStatus` dep. The fast path (file/output) is tried first; a run-once guard consults the fresh `GET /api/tasks/:id/after_goal_status` **only** when the fast path found nothing, so `after_goal` fires at most once. Keyed off the claim-time task id (env cache) with creds lifted from the completion curl; a disarmed/unreachable status is a clean no-op; `GOAL_ID` falls back to the status `goalId` when the server env omits it. 9 tests.
- **End-to-end tests** (W1644) — New suite across the three pure modules proving detection + `GOAL_*` extraction + the run decision under a truncated output with a present canonical file, plus a no-file + stubbed-GET fallback and no-false-positive controls (disarmed GET, no fresh dep, after_goal-less file). All side effects stubbed; no real network or push. The `node --test extensions/hook-bridge/*.test.ts` suite grew to **180 passing** tests.

### Changed — documentation

- **`skills/stride-workflow/SKILL.md`** (W1645) — The "finishes the parent goal's last child" section now documents the canonical-file + fresh-GET detection guarantee (the extension writes the file itself — the agent does not `| tee`) and a **push-verification** step (`git log origin/main..main --oneline`), stated so it does not imply the grace-window worker pushes (it only flips the goal to Done).
- **`skills/stride-hook-diagnostician/SKILL.md`** (W1645) — The `after_goal` failure modes now note that detection is reliable (canonical file + fresh GET, so a missed hook is not a truncation problem), and Mode B calls out that a Done goal is not proof the push landed when `## after_goal` pushes — verify with `git log origin/main..main`.

### Backward compatibility

No hook-bridge **wire shapes** changed — the claim/complete/changed_files payloads and the structured hook-result JSON are identical. The detector signature change is additive (an optional trailing reader param; existing 2-arg calls are unchanged), and `freshAfterGoalStatus` is an optional dep (omitting it preserves the pre-D119 fast-path-only behavior). One new gitignore entry is required: `.stride/`.

### Source

Parent goal (after_goal reliability port) — W1641, W1642, W1643, W1644, and this release/docs task W1645. stride-pi is **not** distributed through stride-marketplace, so there is no marketplace pin, `marketplace.json`, or marketplace README to update — the release is commit `main` + tag `v1.12.0` + a `gh release` on the stride-pi repo only.

## [1.11.0] - 2026-07-04

Stride-Pi Enhancements release: a sweep that corrects the plugin's user-facing docs to match the shipped code and hardens the hook-bridge executor. Because two executor behavior changes ship alongside the documentation fixes (the `.stride.md` parser now supports backslash line-continuation, and the changed-files capture now subtracts pre-claim working-tree edits), this is a **minor** bump (1.10.0 → 1.11.0), not a patch.

### Fixed — documentation now matches the shipped design

- **`README.md`** (W1525) — Rewrote the **Hook Execution** section: it wrongly claimed "Pi has no automatic hook interception" and opened with a manual four-step procedure, contradicting the Setup/Subagent sections, `AGENTS.md`, and the default-installed hook-bridge extension. It now leads with the auto-firing extension path (all five hooks fire automatically; the agent supplies placeholder results) and frames the manual line-by-line procedure as the `--no-extensions` fallback. Added the fifth `after_goal` row to the Hook Lifecycle table (blocking, 60s), matching `HOOK_TIMEOUTS_MS`.
- **`README.md`, `NOTES-phase1-validation.md`** (W1526) — Corrected the skill-surface count from 7 to **11**: the sample `[Skills]` block, the "loaded all N skills" prose, the chain-of-reference count, and the Skills table now list all eleven shipped skills (the four inline subagent skills cross-referenced to the Subagent Support section). Appended a dated superseding note to the historical NOTES validation record rather than rewriting it.
- **`extensions/hook-bridge/index.ts`, `extensions/hook-bridge/curl-matcher.ts`** (W1527) — Refreshed the stale executor module docstrings: five hooks (not four), per-hook `HOOK_TIMEOUTS_MS` budgets (`after_doing` 300s, others 60s) enforced by a sequential per-command loop (not a single 120s `Promise.race`), dangling `extensions.md`/`runner.js` line references removed, and a note that `after_goal` is response-payload-driven rather than URL-routed. Comment-only; no behavior change.
- **`skills/stride-hook-diagnostician/SKILL.md`, `extensions/subagent-dispatch/agents/stride-hook-diagnostician.md`** (W1530) — Restored dual-path parity for the fifth hook: both copies now enumerate all five hooks and carry an identical `after_goal` Failure Pattern Catalog entry (Mode A: the hook command failed — same stdout result shape; Mode B: the `PATCH /api/tasks/:goal_id/after_goal` forwarding failed → server grace-window worker), with the 60s threshold. The inline copy's stale single-120s timeout data was corrected to the per-hook map.
- **`skills/stride-workflow/SKILL.md`** (W1531) — Closed the missing-Step-5 numbering gap: renumbered Steps 6–9 down to 5–8 across the prose, the workflow-steps vocabulary table, the ASCII flowchart, and the Quick Reference card, so the sequence is contiguous 0..8. Numbers-only; the `workflow_steps` step-NAME vocabulary is unchanged.

### Added — hook-bridge executor hardening

- **`.stride.md` backslash line-continuation** (W1528) — `parseHookSection` now joins a physical line ending in an unescaped trailing backslash with the following line into one logical command before the comment/blank filters run, matching bash continuation. A `#` comment's trailing backslash stays literal (never swallows the next command), and a dangling continuation at the fence close or EOF flushes gracefully. 7 new tests.
- **Changed-files pre-claim-edit guard** (W1529) — At claim time the bridge records the files already dirty relative to `HEAD` (path → working-tree blob SHA) in a new `.stride-claim-dirty.json` state artifact (mode `0600`, no credentials). The `after_doing` snapshot now subtracts any of those paths whose content is unchanged at completion, so a task claimed against a dirty tree reports only its own claim→completion delta. Fail-open: any git/read failure degrades to the prior capture-everything behavior. 12 new tests. **Gitignore `.stride-claim-dirty.json`** alongside the other `.stride-*` state artifacts.

### Backward compatibility

No hook-bridge **wire shapes** changed — the claim/complete/changed_files payloads and the structured hook-result JSON are identical. The parser and changed-files changes are additive hardening (a previously-shredded multi-line command now runs as one; pre-claim dirt is now excluded), and everything else is documentation. The `node --test extensions/hook-bridge/*.test.ts` suite grew from 115 to **134 passing** tests. One new gitignore entry is required: `.stride-claim-dirty.json`.

### Source

G300 (Stride-Pi Enhancements) — W1525, W1526, W1527, W1528, W1529, W1530, W1531, and this release task W1532. stride-pi is **not** distributed through stride-marketplace, so there is no marketplace pin, `marketplace.json`, or marketplace README to update — the release is commit `main` + tag `v1.11.0` + a `gh release` on the stride-pi repo only.

## [1.10.0] - 2026-07-01

### Added — `API Notes & Limitations` section in the workflow orchestrator skill (G286 / W1421)

Two recurring API gotchas were undocumented, and agents kept rediscovering them the hard way: attempting to move a task to a different goal via `PATCH` (impossible — `parent_id` is creation-only and there is no DELETE endpoint), and calling the hosted API from an HTTP library whose default User-Agent the edge rejects.

- **`skills/stride-workflow/SKILL.md`** — Added an **API Notes & Limitations** section directly after **API Authorization**, mirroring the canonical stride wording: (a) tasks cannot be reparented and there is no DELETE endpoint — moving a task between goals or removing it is a human board-UI action, never to be worked around by recreating the task as a supersede; (b) raw HTTP calls must use curl or a curl/browser-like `User-Agent`, because the hosted API edge returns `403` with `error code: 1010` to default library User-Agents (e.g. `python-urllib`).

### Backward compatibility

Documentation/skill-text only. No `src/` change (the test suite is unchanged at 115 passing), no hook or wire-shape changes.

### Source

G286 — W1421 (mirrors the canonical stride W1416 wording).

## [1.9.0] - 2026-06-29

### Added — `create-tasks`/`create-goals` now have an explicit terminal state, plus a Backlog claim-fail guard (G284 / W1405)

In an autonomous/build context the create-tasks/create-goals request could create a task and then fall straight through the `stride-workflow` orchestrator's build loop — auto-claiming and building the just-created task. The claim fails because newly created tasks sit in the Backlog (not Ready), and the agent would then build the work outside the Stride lifecycle (no claim, no hooks, no completion record). The orchestrator had no terminal state for creation, unlike `stride-ideation` which stops at the written document.

- **`skills/stride-workflow/SKILL.md`** — Added top-level **Creation Terminal State** and **Backlog Claim-Fail Guard** sections before Step 0 (pi has no Context-Informed Creation section or activation marker — no-marker variant). On a create-tasks/create-goals request the orchestrator now reports the created identifiers and STOPS without entering Task Discovery, claiming, or implementation; a failed claim is a terminal stop, never a fallback to building outside the lifecycle. The build loop (Steps 1–9) is unchanged.
- **`skills/stride-creating-tasks/SKILL.md`**, **`skills/stride-creating-goals/SKILL.md`** — Added a `## Terminal state` note: creation ends the turn; building is a separate, explicitly-invoked action.

Documentation-only: no wire-shape, hook, or auth change. stride-pi is not distributed through a marketplace, so there is no marketplace pin to update.

## [1.8.0] - 2026-06-20

Documentation parity release: brings the Pi variant to canonical stride **v1.30.0 (G254)**, porting the `created_by_agent` creation-skill documentation into the Pi skills. Feature minor (1.7.0 → 1.8.0). stride-pi is not distributed through a marketplace, so there is no marketplace pin to update.

### Added — the creation skills now document `created_by_agent`

Agent-created tasks previously landed with `created_by_agent` nil, so the `/agents` activity feed rendered an uninformative `?` avatar on every `created` row. The creation skills now document the field on the create request bodies:

- **`skills/stride-creating-tasks/SKILL.md`** — `created_by_agent` added to the complete-task example, the Field Quick Reference table (string, create-only, forbidden on `PATCH`), and an explanatory note: set it to the plugin's own agent name (`"Pi"` — the exact value sent as `agent_name` on claim/complete), never the `ai_agent:<model>` token form, so one agent stays one roster identity.
- **`skills/stride-creating-goals/SKILL.md`** — `created_by_agent` added to the batch goal example with a note that the server propagates the goal's value to every nested child task.

Documentation-only: no wire-shape, hook, or auth change; `created_by_agent` is optional on create, was already accepted by the API, and is forbidden on `PATCH`.

## [1.7.0] - 2026-06-19

Documentation parity release: brings the Pi variant to canonical stride **v1.29.0 (G225)**, porting the `technical_details` task-field documentation rollout into the Pi skills. Feature minor (1.6.0 → 1.7.0). stride-pi is not distributed through a marketplace, so there is no marketplace pin to update.

### Added — the `technical_details` task field is now documented across the plugin

`technical_details` is an **optional, free-form JSON object** a task may carry to hold any additional technical context that does not fit the structured fields — data shapes, gotchas, key decisions, reference links. Unlike `testing_strategy`, it has **no fixed keys**: a task author or enricher uses whatever keys best describe the work, and leaves it as `{}` when there is nothing substantive to record. It is **not** one of the five review_queue-scored fields (`acceptance_criteria`, `testing_strategy`, `security_considerations`, `pitfalls`, `patterns_to_follow`), so a blank value is never a scoring gap. The plugin previously had no documentation for this field; agents now have one consistent definition to follow.

- **`skills/stride-creating-tasks/SKILL.md`** (W1203) — documents `technical_details` in the Field Quick Reference table, the complete-task example, and the Embedded Object Formats section (as a free-form object, explicitly contrasted with `testing_strategy`, which has fixed `valid_keys`).
- **`skills/stride-creating-goals/SKILL.md`** (W1203) — notes that nested tasks MAY carry an optional free-form `technical_details` object and that it is not a review_queue-scored field.
- **`skills/stride-enriching-tasks/SKILL.md`** (W1204) — adds `technical_details` to the enrichment guidance as an optional field the enricher MAY populate from discovered context — never fabricated, left as `{}` otherwise — with a no-secrets reminder since the object is free-form. (Pi folds enrichment into the skill; there is no separate task-enricher agent.)
- **`skills/stride-task-decomposer/SKILL.md`** (W1204) — notes that a decomposed task MAY include an optional `technical_details` object.
- **`skills/stride-workflow/SKILL.md`** (W1205) — adds `technical_details` to the Step 1 task-field review list (optional free-form context; not a scored field).
- **`skills/stride-task-explorer/SKILL.md`** (W1205) — the explorer folds any recorded `technical_details` into its summary so implementation benefits from it.

### Backward compatibility

Documentation-only. No hook-bridge (TypeScript), wire-shape, `.stride.md`, or `.stride_auth.md` changes; `technical_details` is optional everywhere it appears and is never added to any scored-field set. Tasks that omit it behave exactly as before.

### Source

Goal G248 — the Pi port of canonical stride v1.29.0 (G225 / G243, W1179–W1182), across child tasks W1203 (creation contracts), W1204 (enrichment + decomposition), W1205 (workflow + exploration surfacing), and W1206 (this release-notes/version task). stride-pi is not distributed through a marketplace, so no marketplace pin update.

## [1.6.0] - 2026-06-14

Parity release: brings the Pi variant up to canonical stride **v1.24.0–v1.28.0** (goal G233). Covers the diff-upload survival + state self-heal work, the hook-state-artifact exclusion, the `commands_output` success shape, the unconditional claim-time base-ref refresh, and the G222/D66 reviewer-contract tightening across the skills and both lockstep reviewer-prompt copies. Feature minor (1.5.0 → 1.6.0).

Two canonical items are **N/A for Pi** and were intentionally not ported: W1095 PowerShell parity (a single TypeScript implementation covers all platforms) and G224's persisted-output `jq` fallback (Pi derives the base ref from local git, not from the claim response JSON — only the unconditional-refresh hardening applies).

### Added

- **`extensions/hook-bridge/changed-files.ts`** (W1125 — W1093/W1094/W1096) — Diff-upload **survival + self-heal**. `putChangedFiles` now returns the HTTP status code; `finalizeAfterDoing` records the upload outcome to a new `.stride-diff-upload-state` file (task id + HTTP code **only** — never URL or token, mode `0o600`); a new `selfHealChangedFilesUpload` re-uploads the snapshot at `before_review` when the recorded state is missing, for a different task, or non-2xx (resolving credentials **before** overwriting the snapshot so a missing token leaves the prior snapshot intact).
- **`extensions/hook-bridge/index.ts`** (W1125) — The `after_doing` diff snapshot is now captured and PUT **before** the gate commands run (post-gate refresh kept), so a gate failure/timeout no longer loses the diff; the `before_review` self-heal and claim/after_review cleanup of the state files are wired in; and the single `HOOK_TIMEOUT_MS = 120000` is replaced by a per-hook `HOOK_TIMEOUTS_MS` map (`after_doing` = 300000, others 60000).
- **`extensions/hook-bridge/index.ts` / `hook-result.ts`** (D79 / D65) — The success hook-result shape now carries a tail-truncated `commands_output` array (`{command, output}` per command, last 50 lines, matching the canonical `tail -50`) so passing-gate output is structured rather than error-shaped. The failure shape is unchanged. `formatHookResultJson`, `tailLines`, and the `HookResult`/`CommandOutput` types were extracted into a pure `hook-result.ts` module so they are unit-testable without the Pi runtime.

### Changed

- **`extensions/hook-bridge/changed-files.ts`** (D78 — D67) — `captureChangedFiles` now excludes the hook's own root artifacts (`.stride-diff-upload-state` and `.stride-changed-files.json`) from its diff by an exact repo-root match, so they never leak into the snapshot even after an `after_doing` auto-commit stages them; a same-named file in a subdirectory is still captured.
- **`extensions/hook-bridge/index.ts` / `env-cache.ts`** (D80 — G224 residual) — `TASK_BASE_REF` is now refreshed on **every** detected claim — even when the claim response cannot be parsed into task fields — preserving the existing `TASK_` identity lines and clearing the two state files, so a stale base ref from a prior claim can no longer make the `after_doing` diff span unrelated commits. Skipped silently when HEAD is unresolvable (non-git dir). The pure `resolveClaimEnvCache` merge policy and the env-cache key set were extracted into `env-cache.ts` for testability.
- **`extensions/subagent-dispatch/agents/stride-task-reviewer.md`** and **`skills/stride-task-reviewer/SKILL.md`** (W1126 — W1073/D66, kept field-for-field identical) — Both reviewer-prompt copies gain the strict `not_assessed` verdict rule (`not_assessed` is reserved STRICTLY for a section the task itself left empty — a task-supplied section MUST get a real `passed`/`failed` verdict) and the `acceptance_criteria` 1:1 verbatim hard rule (exactly one entry per criterion line, verbatim, never split/merge/reword/add/drop; array length equals the task's criterion-line count).
- **`skills/stride-workflow/SKILL.md`, `skills/stride-completing-tasks/SKILL.md`, `skills/stride-subagent-workflow/SKILL.md`** (W1127 — G222/D66 parity) — The reviewer dispatch in Step 6 (stride-workflow) and Phase 3 (stride-subagent-workflow) now passes **all 8** review fields the task supplies (`acceptance_criteria`, `pitfalls`, `patterns_to_follow`, `testing_strategy`, `security_considerations`, `description`, `what`, `why`) instead of 4; the `reviewer_result` extraction in stride-workflow is now a mechanical **whole-object copy** with a mandatory self-check (every reviewer section present; submitted `project_checks` count equals the reviewer's; `acceptance_criteria` count equals the task's criterion-line count — the W1099 `6/5` guard); `stride-completing-tasks` gains a **MANDATORY pre-submission self-check (hard gate)**; and `stride-workflow` gains the D66 re-review rule (a re-review must pass `acceptance_criteria` unchanged and keep the array identical to the task's canonical list). Mirrors canonical stride G222 (W1072–W1076) + the D66 self-check, with pi framing (the inline `stride-task-reviewer` skill name).
- **`README.md`** — Documented the corrected hook timeout table (`after_doing` 300s) + time-budget note, the gitignored hook state artifacts and their exclusion from the snapshot, and the claim-time base-ref refresh semantics (including that the `jq` persisted-output fallback is N/A for Pi).
- **`.gitignore`** — Added `.stride-diff-upload-state`, `.stride-env-cache`, and `.stride-changed-files.json`.

### Forcing function

The new `stride-completing-tasks` pre-submission **hard gate** will cause previously-passing **thin or count-inconsistent** self-reviews to fail at submit time. This is intended — the Kanban server now hard-rejects such reports, so the local gate catches them before the `/complete` call rather than after a server `422`.

### Backward compatibility

Hook-bridge wire shapes are additive: the success hook-result JSON gains `commands_output` (existing `exit_code`/`output`/`duration_ms` retained for the after_goal forwarding consumer); the failure shape is unchanged. `.stride-diff-upload-state` is a new gitignored temp file. The reviewer-prompt and skill changes are documentation/prompt tightening — `reviewer_result` is still persisted verbatim as `:jsonb`. The hook-bridge test suites pass (`node --test extensions/hook-bridge/*.test.ts` → 115/0).

### Source

Goal G233 (W1125, W1126, W1127, D78, D79, D80) — the Pi port of canonical stride v1.24.0–v1.28.0.

## [1.5.0] - 2026-06-08

Parity release: brings the Pi variant to G220/G219 parity for the reviewer `project_checks` `not_applicable` status and full-checklist emission (canonical: stride v1.23.0, commit a4e7e6f, W1057). Feature minor (1.4.0 → 1.5.0).

### Updated

- **`extensions/subagent-dispatch/agents/stride-task-reviewer.md`** and **`skills/stride-task-reviewer/SKILL.md`** (kept field-for-field in agreement — the dispatched ext-agent and the inline Pi skill describe the SAME structured block) — The `project_checks[]` per-entry `status` enum gains a third value, **`not_applicable`**, alongside `met` / `not_met`, and the reviewer is now required to **emit one entry for every top-level `CODE-REVIEW.md` bullet — never omit one**. Previously, with only `met` / `not_met` available, the reviewer silently dropped bullets that had no bearing on the diff under review (a small one-line fix surfaced only 2 of ~9 checks), so the Kanban review queue's "Code review" panel rendered a partial, ambiguous checklist. Now bullets that do not apply are marked `not_applicable` with a one-line reason in `evidence`; `not_applicable` is **approval-neutral** — it produces no paired `issues[]` entry and never contributes to `changes_requested` (only `not_met` does). `schema_version` bumps `"1.3"` → `"1.4"`, and both worked examples demonstrate a `not_applicable` row.
- **`README.md`, `AGENTS.md`, `skills/stride-completing-tasks/SKILL.md`, `skills/stride-workflow/SKILL.md`, `skills/stride-subagent-workflow/SKILL.md`** — All example/prose `schema_version` strings bumped `"1.3"` → `"1.4"` in lockstep so no stale `"1.3"` remains; the README and AGENTS reviewer summaries now note the `met`/`not_met`/`not_applicable` enum and full-checklist emission.

### Backward compatibility

Documentation/agent-prompt change only — no wire-shape, hook, `.stride.md`, `.stride_auth.md`, `.gitignore`, or extension-code changes (the `extensions/*/package.json` versions are independent of the plugin version and were not touched). The change is additive: `reviewer_result` is stored as `:jsonb` by the Kanban server and persisted verbatim (the v1.4.0 passthrough change), so the new `not_applicable` status value flows through with no consumer edit. Payloads from reviewers on the prior `"1.3"` schema (emitting only `met` / `not_met`) remain valid. The Kanban review-queue panel renders `not_applicable` as a neutral "N/A" pill (kanban-side, ships independently).

### Source

W1064 under goal G220 — the Pi port of W1057 (reviewer `not_applicable` status + full-checklist emission) from goal G219. The canonical implementation is stride v1.23.0 (commit a4e7e6f).

## [1.4.0] - 2026-06-08

Bundled release covering two ports from the main `stride` plugin (G217 + G218 parity).

### Added

- **`extensions/hook-bridge/changed-files.ts`** (W1047 / D61) — `putChangedFiles` now uploads the per-file diff snapshot to `/api/tasks/:id/changed_files` as a **transport-encoded envelope** — `{"changed_files":{"encoding":"base64","data":"<base64>"}}` — instead of the raw `{"changed_files":[...]}` array. An edge request filter (WAF) in front of the Stride server can misread a dense code diff as an attack payload and silently drop the upload, leaving `changed_files` empty in the review queue; base64-wrapping the body (via `Buffer.from(JSON.stringify(files)).toString("base64")`) neutralizes that false positive while the server decodes it back to the identical list. Falls back to the raw `{"changed_files":files}` object (never a bare array) if encoding fails, and a non-2xx response (and any fetch error) is surfaced via `console.error` without throwing — the bearer token is never logged. `changed-files.test.ts` asserts the encoded envelope, raw-text absence, base64 round-trip, and the non-2xx warning (`node --test` 79/0).

### Changed

- **`skills/stride-workflow/SKILL.md`, `skills/stride-subagent-workflow/SKILL.md`** (W1055 / D63) — The "Extracting the structured review block" guidance built `reviewer_result` from an enumerated copy-list of structured keys. Pi's lists already included `project_checks`, so there was no active drop, but the enumerated pattern is the latent defect that silently dropped `project_checks` on sibling plugins. Both skills now use a **verbatim passthrough**: copy the reviewer's entire parsed JSON object into `reviewer_result` and overlay only the legacy summary fields — so any field the schema gains flows through automatically with no consumer edit.
- **`extensions/subagent-dispatch/agents/stride-task-reviewer.md`, `skills/stride-task-reviewer/SKILL.md`** (W1055 / W1049) — Both reviewer surfaces gain an explicit **consumption invariant**: the canonical schema is the only place the structured key-set is enumerated, and the completion path MUST persist the reviewer's emitted JSON verbatim and MUST NOT maintain its own allow-list of keys to copy.

### Backward compatibility

Wire-shape: the `changed_files` envelope requires a Stride server that accepts the `base64` / `gzip+base64` encodings on `/changed_files` (ships in the kanban repo); the raw-object fallback path remains compatible with the prior shape. The `reviewer_result` changes are documentation/skill-instruction only — `project_checks[]` already existed, was already enumerated by Pi, and is already rendered by the review queue; this release hardens the pattern so it cannot regress. No `.stride.md` / `.stride_auth.md` / `.gitignore` changes required. Not distributed through a marketplace.

### Source

W1047 (D61 base64 changed_files transport port), W1055 (D63 passthrough hardening + W1049 consumption invariant). Mirrors the main `stride` plugin's 1.22.0 (D61) and 1.22.1 (project_checks) releases.

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
