---
name: stride-completing-tasks
description: INTERNAL — invoked only by stride:stride-workflow. Do NOT invoke from a user prompt. Contains the completion API contract (PATCH /api/tasks/:id/complete required fields including completion_summary, actual_complexity, after_doing_result, before_review_result, explorer_result, reviewer_result), used during the orchestrator's completion phase.
skills_version: 1.0
---

# Stride: Completing Tasks

## STOP — orchestrator check

If you arrived here directly from a user prompt, you are in the wrong skill.
Invoke `stride:stride-workflow` instead. Do not read further.
Sub-skills are dispatched by the orchestrator only.

## THIS SKILL IS MANDATORY — NOT OPTIONAL

**If you are about to call `PATCH /api/tasks/:id/complete`, you MUST have activated this skill first.**

The completion API requires fields that are ONLY documented here:
- `completion_summary` (required — not the same as `completion_notes`)
- `actual_complexity` (required — enum: "small", "medium", "large")
- `actual_files_changed` (required — comma-separated STRING, not array)
- `after_doing_result` (required — object with `exit_code`, `output`, `duration_ms`)
- `before_review_result` (required — object with `exit_code`, `output`, `duration_ms`)
- `explorer_result` (required — object: dispatched `task-explorer` custom agent result OR self-reported skip; see Explorer/Reviewer Result Schema)
- `reviewer_result` (required — object: dispatched `task-reviewer` custom agent result OR self-reported skip; see Explorer/Reviewer Result Schema)

History: `docs/completion-rationale.md` § Fields Found One Rejection at a Time.

## How Hooks Fire (Default: Automatic via `hook-bridge`)

As of stride-pi 0.3.0, the `hook-bridge` extension ships in the manifest. When loaded, it intercepts the `PATCH /api/tasks/:id/complete` curl and runs the lifecycle hooks on your behalf:

- **`after_doing`** runs on the `tool_call` event (pre-curl). If it fails, `hook-bridge` returns `{ block: true, reason }` and the `/complete` curl is **vetoed** — the request never reaches the API. The block reason is surfaced to you with the failed command name, exit code, and (truncated) output so you can fix the issue and retry. After a successful `after_doing`, `hook-bridge` captures per-file diffs and fire-and-forget PUTs them to `PUT /api/tasks/:id/changed_files` — the agent does **not** need to include `changed_files` in the `/complete` body. See **Per-File Diff Capture (Automatic)** below.
- **`before_review`** runs on the `tool_result` event (post-curl, after `/complete` has already succeeded). Failures are logged via stderr and `ctx.ui.notify`; they do **not** modify the response, because the task is already complete.
- **`after_review`** runs on the `tool_result` event for `PATCH /api/tasks/:id/mark_reviewed`. Same non-blocking semantics as `before_review`. The `.stride-env-cache` file is deleted after `after_review` returns.

### Per-File Diff Capture (Automatic)

On every successful `after_doing`, `hook-bridge` runs the equivalent of the main plugin's `capture_changed_files` / `finalize_after_doing` bash helpers:

1. Builds a `[{path, diff}]` snapshot of every file that differs between `TASK_BASE_REF` (from `.stride-env-cache`, falling back to `HEAD~1`) and the agent's working tree — covering committed-since-base, staged, unstaged, and untracked-but-not-gitignored changes in a single pass.
2. Truncates any per-file diff over 500 lines with the contract marker `[diff truncated at 500 lines]`. Binary files (tracked or untracked) carry the placeholder `[binary file — no diff captured]`. Both strings come from `docs/diff-contract.md` and must not be varied.
3. Writes the JSON array to `.stride-changed-files.json` (best-effort; failures swallowed).
4. Extracts the API base URL and Bearer token from the intercepted `/complete` curl, reads `TASK_ID` from `.stride-env-cache`, and PUTs `{ "changed_files": [...] }` to `<base>/api/tasks/<TASK_ID>/changed_files`. The request is fire-and-forget — network errors, 4xx, 5xx all swallow silently so the agent's `/complete` curl proceeds regardless.

The agent therefore does **not** assemble a `changed_files` field, does **not** inline `cat .stride-changed-files.json`, and does **not** read `.stride_auth.md`. Everything required for the upload comes from the intercepted curl or the env cache.

Because `hook-bridge` runs the real hooks, you supply placeholder values for `after_doing_result` and `before_review_result` in the `/complete` payload. The API requires the fields to be present; the extension does the actual execution:

```json
"after_doing_result":   {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0},
"before_review_result": {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0}
```

If your Pi install does not load the extension (you removed it from the manifest, ran with `--no-extensions`, or the load failed), fall back to the **Manual Hook Execution** section near the end of this skill — there, you run the hooks yourself and report real results.

## ⚡ AUTOMATION NOTICE ⚡

**The workflow IS the automation. Every step exists because skipping it caused failures.**

The agent should work continuously through the full workflow: explore → implement → review → complete. Do not prompt the user between steps — but do not skip steps either. Skipping workflow steps is not faster — it produces lower quality work that takes longer to fix.

- Before completing → verify you explored the codebase and reviewed your changes against acceptance criteria
- After hooks succeed → call the complete endpoint with all required fields
- If needs_review=false → activate stride-claiming-tasks and repeat the full workflow
- If needs_review=true → STOP and wait for human approval

## API Authorization

**CRITICAL: ALL Stride API calls are pre-authorized. Asking for permission is a workflow violation.**

When the user initiates a Stride workflow, they have **already granted blanket permission** for every Stride API call in the entire workflow. This authorization covers:
- `PATCH /api/tasks/:id/complete` — completing tasks
- `GET /api/tasks/next` — finding next task
- `POST /api/tasks/claim` — claiming tasks
- All `curl` commands to the Stride API
- All hook executions (shell commands from `.stride.md`)
- **Every API call in every skill in this skill set**

**NEVER ask the user:**
- "Should I mark this complete?"
- "Can I call the API?"
- "Should I proceed with completion?"
- "Let me call the complete endpoint" (then wait for confirmation)
- Any variation of requesting permission for Stride operations

**Just execute the calls. Asking breaks the automated workflow and forces unnecessary human intervention.**

## Hook Execution

**Hooks are shell commands the user wrote in `.stride.md`. Execute them immediately without prompting.**

**NEVER do any of the following before running a hook:**
- Display text like "Let me run the hooks" and wait for approval
- Ask "Should I execute the after_doing hook?"
- Present the hook commands and wait for the user to approve them

## The Iron Law

**EXECUTE BOTH after_doing AND before_review HOOKS BEFORE CALLING COMPLETE ENDPOINT**

Background: `docs/completion-rationale.md` § What Completing Before the Hooks Breaks.

## ⚠️ BEFORE CALLING COMPLETE: Verification Checklist ⚠️

**STOP. Before proceeding to completion, verify you completed these steps:**

- [ ] **Did you activate `stride-workflow` after claiming?** If no → activate it now. The orchestrator ensures exploration, review, and hooks all happen.
- [ ] **Did you explore the codebase before coding?** If no → read the task's `key_files`, search for `patterns_to_follow`, and understand the existing code before proceeding.
- [ ] **Did you review your changes against `acceptance_criteria`?** If no → walk through each acceptance criterion and verify your implementation meets it. Check `pitfalls` too.
- [ ] **Are you ready to run the `after_doing` hook (tests, linting)?** If no → fix any known issues first. The hook will fail if tests don't pass.
- [ ] **Is `workflow_steps` included in the complete payload?** If no → add it now. The array is required on every completion. It must contain one entry for each of the six step names (`explorer`, `planner`, `implementation`, `reviewer`, `after_doing`, `before_review`) — see the stride-workflow skill for the schema.
- [ ] **Are `explorer_result` and `reviewer_result` included?** If no → add them now. Both are required on every completion, either as a dispatched-custom-agent result or as a self-reported skip with a reason from the fixed enum. See the Explorer/Reviewer Result Schema section below.
- [ ] **Does `reviewer_result` carry the reviewer's full structured block, verbatim?** If a `task-reviewer` review ran (the `stride-task-reviewer` skill or the custom agent), `reviewer_result` must include the **entire** emitted JSON block — `status`, `issue_counts`, `issues[]`, `acceptance_criteria[]`, `project_checks[]`, and the section verdicts — produced by a mechanical **whole-object copy** of the parsed JSON (`reviewer_result = dict(structured)` then overlay legacy fields), NOT by hand-typing or sub-selecting keys. **Run the mandatory self-check before submitting (see the orchestrator's "Extracting the structured review block"): every section the reviewer produced must be present, and the submitted `project_checks` count must equal the count the reviewer emitted.** Hand-typing, re-typing, or a subset shortcut is FORBIDDEN — no exceptions, no small-task discount. Never re-enumerate which keys to copy; the structured key-set is owned by `agents/task-reviewer.md`. Background: `docs/completion-rationale.md` § The Server Contract Behind the Self-Check.

**If ANY answer is NO → Go back and do it now. Do NOT proceed to completion.**

Background: `docs/completion-rationale.md` § Why the Checklist Exists.

## ⚠️ MANDATORY pre-submission self-check (hard gate) ⚠️

Run this **before every** `PATCH /api/tasks/:id/complete`. If ANY check fails, **DO NOT submit** — re-run the `stride-task-reviewer` skill (or the `task-reviewer` custom agent) with the full task inputs (the orchestrator's reviewer-dispatch step passes every supplied field), or fix the passthrough, then re-check. **One exit, and it is not a bypass.** A finding you cannot fix is not a passthrough defect: the reviewer reproduces it faithfully on every re-run, so the remedy above cannot terminate on it. Its exit is the stop-and-report defined in `stride-workflow` Step 5's cap — **leave the task claimed, send no PATCH, report the finding in this session, stop the loop.** Re-invoking a third time to get a quieter answer is the one response that is always wrong. Every check below still runs unchanged: this is an exit from the loop, never a relaxation of the gate. There is **no bypass**: not for small tasks, not for trivial tasks, and never by submitting now with a note promising to fix it later.

- [ ] **Every section present.** `reviewer_result` carries every section the reviewer emitted — the whole-object copy from "Extracting the structured review block" in the orchestrator. Nothing dropped.
- [ ] **`project_checks` complete.** The submitted `project_checks` count equals the count the reviewer emitted — never trimmed or sub-selected.
- [ ] **No `not_assessed` for a task-supplied section.** For each of `testing_strategy`, `patterns`, `pitfalls`, and `security_considerations`: if the **task** supplied that field, its verdict `status` is a real assessment (`passed`/`failed`), never `not_assessed` or absent. A task-supplied section coming back `not_assessed` means the reviewer was not handed it (fix the dispatch) or the verdict is wrong — re-run the reviewer; do not submit. **In particular: if the task carried `security_considerations`, `reviewer_result.security_considerations.status` MUST be `passed`/`failed`.**
- [ ] **Residual findings recorded when review reached the two-round ceiling (W2167).** When `stride-workflow` Step 5's cap was reached — round two ran and its parsed block still carries open `important` or `minor` entries — every one of them, **including any round-one finding round two did not re-enumerate**, is named in `completion_notes` and mirrored in one line of `completion_summary` by **severity, category and `file:line` only**, never the reviewer's `description` or `suggested_fix`, the JSON block, its prose, or any diff text — the bounded form is the redaction. They are **appended to nothing**: the residuals stay where the reviewer put them in `issues[]`, and duplicating them manufactures a blocked completion under the Consistency rule this gate already enforces. **`reviewer_result` will normally read `status: "changes_requested"` here, and that is the cap's designed terminal state, not a failure — submit it byte-identical and never edit the status.** Note a `minor` never flips that status, so "only minors remain" is not interchangeable with "approved". **Two things are never recorded under this item:** an unfixed **`critical`** at any round number, and any unfixed **`category: "security"`** entry at any severity — `Important` is the reviewer's documented default for a security finding, so recording one ships an unfixed weakness. For either, do not submit: fix it and invoke a further round scoped to that finding, or take Step 5's stop-and-report exit. This gate reads no `issues[]` entry key, so the item is **self-certified on the same terms as the cap it enforces**. **The COUNT-AND-STATUS portion of this item has nothing to verify when review ran a single round (the item below covers that path), when the decision matrix skipped the reviewer, or when the JSON did not parse — on those paths its absence is the normal case, never a gap.** **The two never-recorded exclusions bind on every path, including the carry-across.** So on the unparsed-JSON path you still carry the last parsed round's findings across before submitting the degraded payload — but an unfixed `critical`, or any unfixed `category: "security"` entry at any severity, still means **do not submit**: take `stride-workflow` Step 5's stop-and-report exit.
- [ ] **Fixes recorded when round two was not earned (W2610).** When none of `stride-workflow` Step 5's three triggers fired — round one's fixes changed no code path, and round one reported no `critical` and no `category: "security"` entry — round two did not run. Each finding you fixed is then named in `completion_notes` and on one line of `completion_summary` by **severity, category and `file:line` plus one line on what changed**, in your own words and never the diff's — that line never names a credential, token or secret value, or where one is kept — and a `minor` left unfixed is named the same way, marked as still standing. `reviewer_result` is round one's block byte-identical, whatever its `status`. **A critical or a security entry cannot be on this path:** either one is a trigger, so if you hold one here you misread Step 5 — run round two, do not submit. Self-certified like the item above: this gate cannot see which paths the fixes touched.
- [ ] **`cosmetic` findings are reported, never suppressed (W2168).** A `cosmetic: true` entry changes exactly one thing — whether its round bought another review round — so it **stays in `issues[]` with its honest `severity` and `category`, rides through the whole-object copy unchanged, and is named in `completion_notes` like any other unfixed finding**, by severity, category and `file:line` only. Never drop one, never add it to an enumerated copy list, and **never re-label a substantive finding cosmetic to avoid a round: that is a reviewer defect whose remedy is re-running the reviewer, never editing `reviewer_result`.** `cosmetic: true` on a non-`minor` severity, on `category: "security"`, or as a non-boolean is refused by the orchestrator's self-check in `stride-workflow` Step 5 — **do not submit; re-run the reviewer, do not coerce the value.** **This item has nothing to verify on a payload where no structured block parsed** — there `issues[]` is absent by construction and its absence is the normal case, never a gap. Its definition is owned by the two `stride-task-reviewer` surfaces.

This gate is **not bypassable** by submitting a self-reported skip (`dispatched: false`) when a `task-reviewer` review actually ran — a dispatched review must pass every check above. The self-check compares counts, keys, and status enums only; it never prints task content, diffs, or secrets. A self-check that fails here is a completion the server would refuse (background: `docs/completion-rationale.md` § The Server Contract Behind the Self-Check).

## The Complete Completion Process

1. **Finish your work** - All implementation complete.
2. **Pre-completion code review** - If the `stride-workflow` Step 3 decision matrix says YES in the **Review** column for this task's row, invoke the `task-reviewer` custom agent. **Read the column; do not re-derive the condition here** (D221). Fix Critical/Important issues. Save output as `review_report`.
3. **Call `PATCH /api/tasks/:id/complete`** with all required fields, including placeholder `after_doing_result` and `before_review_result`. `hook-bridge` runs `after_doing` on the `tool_call` event (pre-curl) and will veto the request if it fails.
4. **If `hook-bridge` vetoed the curl** with a blocked-by-after_doing reason: read the failure (failed command + truncated output in the block reason). Fix the issue, then retry the same `/complete` curl — `hook-bridge` re-runs `after_doing` on each attempt. Never answer the veto with a made-up passing `after_doing_result`.
5. **Curl succeeded?** `before_review` has already run on the post-curl `tool_result`. If it failed, the failure was logged but the task is already in Review.
6. **Check needs_review flag in the response:**
   - `needs_review=true`: STOP and wait for human review.
   - `needs_review=false`: Call `PATCH /api/tasks/:id/mark_reviewed` (where applicable for your workflow); `hook-bridge` runs `after_review` on the `tool_result`. Then activate `stride-claiming-tasks` and continue the loop.

## When Hooks Fail (Automatic Mode)

`hook-bridge` surfaces failures differently depending on the hook:

- **`after_doing` failure**: the `/complete` curl is vetoed with `{ block: true, reason }`. You see a message like `Stride after_doing hook failed (exit 1). Command: mix test` followed by truncated output. Fix the issue (failing test, lint error, etc.) and re-run the `/complete` curl — `hook-bridge` will run `after_doing` again on the retry.
- **`before_review` / `after_review` failure**: written to stderr and `ctx.ui.notify` (when available). The curl already succeeded by the time these run, so they cannot block — the task moves to Review / Done regardless. Treat the failure as a follow-up to fix in a subsequent commit, not as a reason to revert the completion.

### When to invoke `hook-diagnostician`

When the block reason for `after_doing` is complex or spans multiple tools (tests + credo + sobelow), invoke the `hook-diagnostician` custom agent (when available) with the hook name, exit code, output, and duration extracted from the block reason. It returns a prioritized fix plan. Without it, follow the manual debugging steps below.

## Common Failure Patterns

**Common `after_doing` failures** (vetoed `/complete` curl):
- Test failures → Fix tests first
- Build errors → Resolve compilation issues
- Linting errors → Fix code quality issues
- Coverage below target → Add missing tests
- Formatting issues → Run formatter

**Common `before_review` failures** (post-curl, non-blocking):
- PR already exists → Check if you need to update existing PR
- Authentication issues → Verify gh CLI is authenticated
- Branch issues → Ensure you're on correct branch
- Network issues → Retry after connectivity restored

## API Request Format

Call the complete endpoint with placeholder `after_doing_result` and `before_review_result` — `hook-bridge` runs the actual hooks. The API requires the fields to be present; the extension does the work:

```json
PATCH /api/tasks/:id/complete
{
  "agent_name": "Pi",
  "time_spent_minutes": 45,
  "completion_notes": "All tests passing. PR #123 created.",
  "completion_summary": "Brief one-line summary for tracking.",
  "actual_complexity": "medium",
  "actual_files_changed": "lib/foo.ex, lib/bar.ex, test/foo_test.exs",
  "skills_version": "1.0",
  "review_report": "## Review Summary\n\nApproved — 0 issues found.\n\n### Acceptance Criteria\n| # | Criterion | Status |\n|---|-----------|--------|\n| 1 | Feature works | Met |",
  "after_doing_result": {
    "exit_code": 0,
    "output": "Executed by Pi hook-bridge extension",
    "duration_ms": 0
  },
  "before_review_result": {
    "exit_code": 0,
    "output": "Executed by Pi hook-bridge extension",
    "duration_ms": 0
  },
  "explorer_result": {
    "dispatched": false,
    "reason": "self_reported_exploration",
    "summary": "Read lib/foo.ex and test/foo_test.exs manually and noted the existing error-tuple pattern to mirror"
  },
  "reviewer_result": {
    "dispatched": false,
    "reason": "self_reported_review",
    "summary": "Self-reviewed the diff against all 5 acceptance criteria and the 3 pitfalls; no issues found"
  },
  "workflow_steps": [
    {"name": "explorer",       "dispatched": true,  "duration_ms": 12450},
    {"name": "planner",        "dispatched": true,  "duration_ms": 8200},
    {"name": "implementation", "dispatched": true,  "duration_ms": 1820000},
    {"name": "reviewer",       "dispatched": true,  "duration_ms": 15300},
    {"name": "after_doing",    "dispatched": true,  "duration_ms": 45678},
    {"name": "before_review",  "dispatched": true,  "duration_ms": 2340}
  ]
}
```

**Critical:** `after_doing_result`, `before_review_result`, `explorer_result`, `reviewer_result`, and `workflow_steps` are all REQUIRED. The API will reject requests without them.

## Explorer/Reviewer Result Schema

Every `/complete` call **must** include both `explorer_result` and `reviewer_result` as top-level objects. Each is either a self-reported skip or a dispatched-custom-agent result. Server-side validation is pre-validated by `Kanban.Tasks.CompletionValidation`; invalid payloads are logged during the grace-period rollout and rejected with `422` once `:strict_completion_validation` flips.

### Shape 1 — self-reported skip (primary path for Pi)

Pi does not ship with native subagent dispatch, so the self-reported skip form is the default for most tasks. Use it whenever you explored or reviewed manually rather than dispatching a custom extension.

```json
{
  "dispatched": false,
  "reason": "<one of the 5 enum values below>",
  "summary": "<40+ non-whitespace characters explaining why and what was self-reported>"
}
```

The `reason` must be exactly one of:

| Reason | When to use |
|---|---|
| `no_subagent_support` | Platform has no subagent dispatch available (default for Pi; also Codex/OpenCode graceful fallback) |
| `small_task_0_1_key_files` | Decision matrix: task is small with 0–1 key_files |
| `trivial_change_docs_only` | Docs-only change with no code impact |
| `self_reported_exploration` | Explored the codebase manually rather than dispatching the explorer agent |
| `self_reported_review` | Self-reviewed the diff against acceptance criteria rather than dispatching the reviewer agent |

Free-form reasons are rejected — the enum is the contract.

### Shape 2 — dispatched custom agent (when custom agents are available)

```json
"explorer_result": {
  "dispatched": true,
  "summary": "<40+ non-whitespace characters describing what was explored>",
  "duration_ms": 12000
}

"reviewer_result": {
  "dispatched": true,
  "duration_ms": 8000,
  "summary": "<40+ non-whitespace characters describing what was reviewed>",
  "issues_found": 0,
  "acceptance_criteria_checked": 5,
  "schema_version": "1.7",
  "status": "approved",
  "issue_counts": {"critical": 0, "important": 0, "minor": 0},
  "issues": [],
  "acceptance_criteria": [
    {"criterion": "<verbatim criterion>", "status": "met", "evidence": "<file:line>"}
  ],
  "project_checks": [],
  "testing_strategy": {"status": "passed", "note": "<rationale>"},
  "patterns": {"status": "passed", "note": "<rationale>"},
  "pitfalls": {"status": "passed", "note": "<rationale>"},
  "security_considerations": {"status": "passed", "note": "<rationale>"}
}
```

`reviewer_result` additionally requires `acceptance_criteria_checked` and `issues_found` as non-negative integers when `dispatched` is `true`.

When `stride-task-reviewer` was dispatched (or run inline on Pi), `reviewer_result` is the reviewer's emitted **structured JSON block** (`schema_version`, `status`, `issue_counts`, `issues[]`, `acceptance_criteria[]`, `project_checks[]`, and the per-section `testing_strategy`/`patterns`/`pitfalls`/`security_considerations` verdicts) copied verbatim and **merged** with the dispatch telemetry plus the derived legacy summary fields. The structured fields are what the Kanban review queue renders (issue list, acceptance verdicts, code-review checks, security verdict). **Do NOT send only the thin legacy envelope** (`dispatched`/`duration_ms`/`summary`/`issues_found`/`acceptance_criteria_checked`) — it strips the issues, acceptance verdicts, project checks, and section verdicts the review queue needs. Extract the fenced ` ```json ` block per the `stride-subagent-workflow` skill's "Extracting the structured review block" — that section owns the legacy↔structured mapping (`issues_found = sum(issue_counts)`, `acceptance_criteria_checked = len(acceptance_criteria)`). The structured block's schema is owned by `stride/agents/task-reviewer.md`; do not redefine it here. The legacy `acceptance_criteria_checked` and `issues_found` integers remain required (for back-compat) when `dispatched` is `true`. If the reviewer emitted no parseable ` ```json ` fence, fall back to the legacy-only envelope and omit the structured keys — never invent them. Copy exactly the keys the reviewer produced: an approved review still emits `issues: []` and `project_checks: []` (the reviewer emits those arrays unconditionally), so the empty arrays above are real, not placeholders.

### Minimum summary length

Summaries must contain at least **40 non-whitespace characters**. Trivial summaries like `"explored files"` or `"reviewed code"` are rejected. The minimum is counted after stripping all whitespace, so inserting spaces does not help.

### 422 rejection example

When strict mode is on and a payload fails validation:

```json
{
  "error": "completion validation failed",
  "failures": [
    {
      "field": "explorer_result",
      "errors": [
        {"field": "summary", "message": "must be a string of at least 40 non-whitespace characters"}
      ]
    }
  ],
  "required_format": { /* both shapes documented above */ },
  "documentation": "https://.../AI-WORKFLOW.md#completing-tasks"
}
```

### Grace-period rollout

**Emit the fields correctly now**, whichever validation mode the server is in. History: `docs/orchestrator-rationale.md` § The Completion-Validation Rollout.

**Schema reference:** The `workflow_steps` array must match the schema documented in the `stride-workflow` skill — key-for-key. **`dispatch_count` (optional, W2130)** rides on a `dispatched: true` entry and records how many times that subagent was dispatched — on the `reviewer` entry, how many times the reviewer itself was dispatched, rounds and crashed re-dispatches alike, since a crashed dispatch still spent its tokens. It counts **dispatches, not rounds**, adds no seventh step name, and **omitting it stays valid**. On this runtime a reviewer that ran inline still counts: Step 5 reports both invocation paths as `dispatched: true`, so an inline review carries a duration and, where known, a count — even when `reviewer_result` itself is the self-reported skip form. **This paragraph is a mirror; the telemetry section of the `stride-workflow` skill owns the schema and carries the canon anchor — keep the two in sync, and an edit there needs the matching edit here.** Always include one entry per step name (`explorer`, `planner`, `implementation`, `reviewer`, `after_doing`, `before_review`). Skipped steps use `{"name": "<step>", "dispatched": false, "reason": "<why>"}`.

**Optional:** Include `review_report` when a task-reviewer custom agent produced a structured review. Omit it when no review was performed (e.g., small tasks with 0-1 key_files).

## Red Flags - STOP

- "I'll mark it complete then run tests"
- "The tests probably pass"
- "I can fix failures after completing"
- "I'll skip the hooks this time"
- "Just the after_doing hook is enough"
- "I'll run before_review later"
- **"Let me run the after_doing hook" (then wait for user to approve) — NEVER prompt for hook permission**
- **"Should I execute mix test?" — hooks are pre-authorized, just run them**
- **"Should I claim the next task?" (Don't ask, just do it when needs_review=false)**
- **"Would you like me to continue?" (Don't ask, auto-continue when needs_review=false)**

**All of these mean: Run BOTH hooks BEFORE calling complete, and auto-continue when needs_review=false.**

Background: `docs/completion-rationale.md` § The Excuses Table and § Before and After Figures.

---

## Completion Request Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_name` | string | Yes | Name of the completing agent |
| `time_spent_minutes` | integer | Yes | Actual time spent on the task |
| `completion_notes` | string | Yes | Summary of what was done |
| `completion_summary` | string | Yes | Brief summary for tracking |
| `actual_complexity` | enum | Yes | `"small"`, `"medium"`, or `"large"` |
| `actual_files_changed` | string | Yes | Comma-separated file paths (NOT an array) |
| `after_doing_result` | object | Yes | Hook result (see format below) |
| `before_review_result` | object | Yes | Hook result (see format below) |
| `workflow_steps` | array | Yes | Telemetry array with one entry per step name. See stride-workflow skill for full schema. |
| `explorer_result` | object | Yes | `task-explorer` custom agent dispatch result OR self-reported skip. See Explorer/Reviewer Result Schema section. |
| `reviewer_result` | object | Yes | `task-reviewer` custom agent dispatch result OR self-reported skip. See Explorer/Reviewer Result Schema section. |
| `review_report` | string | No | Structured review report from task-reviewer custom agent. Include when a review was performed; omit when no review was done. |
| `skills_version` | string | No | Your skills version from SKILL.md frontmatter |

**WRONG — actual_files_changed as array:**
```json
"actual_files_changed": ["lib/foo.ex", "lib/bar.ex"]
```

**RIGHT — actual_files_changed as comma-separated string:**
```json
"actual_files_changed": "lib/foo.ex, lib/bar.ex"
```

## Hook Result Format Reminder

Both `after_doing_result` and `before_review_result` use the same format and are required:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exit_code` | integer | Yes | 0 for success, non-zero for failure |
| `output` | string | Yes | Description of what produced the result |
| `duration_ms` | integer | Yes | How long the hook took in milliseconds |

**With `hook-bridge` loaded (default):** supply the placeholder shape — the extension does the real work on the curl event.

```json
"after_doing_result":   {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0}
"before_review_result": {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0}
```

**Without `hook-bridge` (Manual fallback):** supply the real values from `timeout 120 bash -c '...'` and the captured stdout/stderr.

**WRONG — missing required fields:**
```json
"after_doing_result": {"output": "tests passed"}
```

## Arriving from stride-workflow

If you are following the `stride-workflow` orchestrator, you arrive here at **Step 6-7** with all prerequisites already satisfied:
- Task was claimed with proper before_doing hook (Step 2)
- Codebase was explored and patterns identified (Step 3)
- Implementation is complete (Step 4)
- Code review was performed against acceptance criteria (Step 5)

**You can proceed directly to hook execution and completion.** The orchestrator has already guided you through all prior steps.

## Previous Skill Before Completing (Standalone Mode)

If you are using this skill standalone (not via the orchestrator), you should have already activated:

1. **`stride-workflow`** (recommended) — The orchestrator handles the full lifecycle. If you used it, you've already completed all prior steps.
2. **`stride-claiming-tasks`** — To claim the task with proper before_doing hook execution
3. **`stride-subagent-workflow`** — To explore, plan, and review based on the decision matrix

If you skipped any of these, the after_doing hook is likely to fail. Go back and verify.

## Manual Hook Execution (FALLBACK — only when `hook-bridge` is not loaded)

Use this section only when the `hook-bridge` extension is not loaded — e.g., you removed it from `package.json` `pi.extensions`, ran Pi with `--no-extensions`, or the extension failed to load at startup. In every other case, `hook-bridge` runs the hooks for you and the sections above apply.

When operating without `hook-bridge`, you run the hooks yourself before calling `/api/tasks/:id/complete` and report the real results in the payload:

1. **Run `after_doing` first** — read the `## after_doing` section from `.stride.md`, execute each command line one at a time via Bash (no permission prompts, no `&&` chaining), capture `exit_code`, `output`, and `duration_ms`:
   ```bash
   START_TIME=$(date +%s%3N)
   OUTPUT=$(timeout 120 bash -c 'mix test --cover' 2>&1)
   EXIT_CODE=$?
   DURATION=$(( $(date +%s%3N) - START_TIME ))
   ```
   If `EXIT_CODE != 0`: fix the issue (failing test, lint error, etc.), re-run, do **not** call `/complete`.

2. **Run `before_review` next** — same pattern with a 60 s timeout. On failure, fix and retry. Do **not** call `/complete` until both succeed.

3. **Call `/complete`** with the real captured values:
   ```json
   "after_doing_result": {
     "exit_code": 0,
     "output": "All 230 tests passed\nmix credo --strict: no issues",
     "duration_ms": 45678
   },
   "before_review_result": {
     "exit_code": 0,
     "output": "PR #123 created: https://github.com/org/repo/pull/123",
     "duration_ms": 2340
   }
   ```

4. **After `/complete` succeeds**, if `needs_review=false`, manually run the `## after_review` section from `.stride.md` before claiming the next task (60 s timeout, non-blocking — log failures but continue).

The placeholder form (`output: "Executed by Pi hook-bridge extension"`) is **wrong** when `hook-bridge` is not loaded, because nothing actually runs the tests, formatter, credo, or sobelow — and the `/complete` curl will not be vetoed on real failures.

---
**References:** For the full field reference, see `api_schema` in the onboarding response (`GET /api/agent/onboarding`). For endpoint details, see the [API Reference](https://raw.githubusercontent.com/cheezy/kanban/refs/heads/main/docs/api/README.md). For hook failure diagnosis, see the `hook-diagnostician` custom agent.
