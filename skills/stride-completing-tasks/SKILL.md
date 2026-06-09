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

**Attempting to complete a task from memory without this skill results in 3+ failed API calls** as you discover each missing field one at a time. This has been observed in practice.

## Overview

**Calling complete before validation = bypassed quality gates. Running hooks first = confident completion.**

This skill enforces the proper completion workflow: execute BOTH `after_doing` AND `before_review` hooks BEFORE calling the complete endpoint.

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

**Following every step IS the fast path. The loop is: claim → explore → implement → review → complete → claim. Every phase is mandatory.**

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

## The Critical Mistake

Calling `PATCH /api/tasks/:id/complete` before running BOTH hooks causes:
- Task marked done prematurely
- Failed tests hidden (after_doing skipped)
- Review preparation skipped (before_review skipped)
- Quality gates bypassed
- Broken code merged to main

**The API will REJECT your request if you don't include both hook results.**

## When to Use

Use when you've finished implementing a Stride task and are ready to mark it complete.

**Required:** Execute BOTH hooks BEFORE calling the complete endpoint.

## ⚠️ BEFORE CALLING COMPLETE: Verification Checklist ⚠️

**STOP. Before proceeding to completion, verify you completed these steps:**

- [ ] **Did you activate `stride-workflow` after claiming?** If no → activate it now. The orchestrator ensures exploration, review, and hooks all happen.
- [ ] **Did you explore the codebase before coding?** If no → read the task's `key_files`, search for `patterns_to_follow`, and understand the existing code before proceeding.
- [ ] **Did you review your changes against `acceptance_criteria`?** If no → walk through each acceptance criterion and verify your implementation meets it. Check `pitfalls` too.
- [ ] **Are you ready to run the `after_doing` hook (tests, linting)?** If no → fix any known issues first. The hook will fail if tests don't pass.
- [ ] **Is `workflow_steps` included in the complete payload?** If no → add it now. The array is required on every completion. It must contain one entry for each of the six step names (`explorer`, `planner`, `implementation`, `reviewer`, `after_doing`, `before_review`) — see the stride-workflow skill for the schema.
- [ ] **Are `explorer_result` and `reviewer_result` included?** If no → add them now. Both are required on every completion, either as a dispatched-custom-agent result or as a self-reported skip with a reason from the fixed enum. See the Explorer/Reviewer Result Schema section below.

**If ANY answer is NO → Go back and do it now. Do NOT proceed to completion.**

Skipping these steps is not faster — it produces lower quality work that takes longer to fix. This checklist exists because agents consistently skipped these steps under pressure to deliver quickly.

## The Complete Completion Process

1. **Finish your work** - All implementation complete.
2. **Pre-completion code review** - If medium+ complexity OR 2+ key_files, invoke the `task-reviewer` custom agent. Fix Critical/Important issues. Save output as `review_report`.
3. **Call `PATCH /api/tasks/:id/complete`** with all required fields, including placeholder `after_doing_result` and `before_review_result`. `hook-bridge` runs `after_doing` on the `tool_call` event (pre-curl) and will veto the request if it fails.
4. **If `hook-bridge` vetoed the curl** with a blocked-by-after_doing reason: read the failure (failed command + truncated output in the block reason). Fix the issue, then retry the same `/complete` curl — `hook-bridge` re-runs `after_doing` on each attempt.
5. **Curl succeeded?** `before_review` has already run on the post-curl `tool_result`. If it failed, the failure was logged but the task is already in Review.
6. **Check needs_review flag in the response:**
   - `needs_review=true`: STOP and wait for human review.
   - `needs_review=false`: Call `PATCH /api/tasks/:id/mark_reviewed` (where applicable for your workflow); `hook-bridge` runs `after_review` on the `tool_result`. Then activate `stride-claiming-tasks` and continue the loop.

## Completion Workflow Flowchart

```
Work Complete
    ↓
Check decision matrix for code review (if custom agents available)
    ↓
Medium+ OR 2+ key_files? ─YES→ Invoke task-reviewer custom agent
    ↓ NO (or no custom agent support)     ↓
    ↓                              Issues found? ─YES→ Fix issues
    ↓                                     ↓ NO            ↓
    ←─────────────────────────────────────←──────────────←─┘
    ↓
Call PATCH /api/tasks/:id/complete (placeholder hook_result fields)
    ↓
hook-bridge runs after_doing on the tool_call (pre-curl)
    ↓
after_doing succeeded? ─NO→ hook-bridge returns {block: true, reason}
    ↓ YES                       ↓
    ↓                       Read failure, fix issue, retry the curl
    ↓                           ↓
    ←───────────────────────────┘
Curl reaches API → /complete succeeds
    ↓
hook-bridge runs before_review on the tool_result (post-curl, non-blocking)
    ↓
needs_review=true? ─YES→ STOP (wait for human review)
    ↓ NO
PATCH /api/tasks/:id/mark_reviewed (if your workflow uses it)
    ↓
hook-bridge runs after_review on the tool_result (non-blocking, deletes env cache)
    ↓
Activate stride-claiming-tasks (NO user prompt)
    ↓
Claim next task and begin implementation
    ↓
(Loop continues until needs_review=true task is encountered)
```

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
  "schema_version": "1.4",
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

Until the server flips `:strict_completion_validation` to true, missing or invalid `explorer_result`/`reviewer_result` produces a structured warning log but the request succeeds. **Emit the fields correctly now** — agents that lag the rollout will start getting 422 rejections on the flip day.

**Schema reference:** The `workflow_steps` array must match the schema documented in the `stride-workflow` skill — key-for-key. Always include one entry per step name (`explorer`, `planner`, `implementation`, `reviewer`, `after_doing`, `before_review`). Skipped steps use `{"name": "<step>", "dispatched": false, "reason": "<why>"}`.

**Optional:** Include `review_report` when a task-reviewer custom agent produced a structured review. Omit it when no review was performed (e.g., small tasks with 0-1 key_files).

## Review vs Auto-Approval Decision

After the complete endpoint succeeds:

### If needs_review=true:
1. Task moves to Review column
2. Agent MUST STOP immediately
3. Wait for human reviewer to approve/reject
4. When approved, human calls `/mark_reviewed`
5. Execute after_review hook
6. Task moves to Done column

### If needs_review=false:
1. Task moves to Done column immediately
2. Execute after_review hook (60s timeout, blocking)
3. **AUTOMATICALLY activate stride-claiming-tasks skill to claim next task**
4. **Continue working WITHOUT prompting the user**

**The workflow IS the automation.** When needs_review=false, proceed to the next task by activating the stride-claiming-tasks skill. Do not prompt the user — but do not skip the exploration and review phases of the next task either. Following every step IS the fast path.

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

## Rationalization Table

| Excuse | Reality | Consequence |
|--------|---------|-------------|
| "Tests probably pass" | after_doing catches 40% of issues | Task marked done with failing tests |
| "I can fix later" | Task already marked complete | Have to reopen, wastes review cycle |
| "Just this once" | Becomes a habit | Quality standards erode completely |
| "before_review can wait" | API requires both hook results | Request rejected with 422 error |
| "Hooks take too long" | 2-3 minutes prevents 2+ hours rework | Rushing causes failed deployments |

## Common Mistakes

### Mistake 1: Only including after_doing result
```json
WRONG:
{
  "after_doing_result": {...}
}

RIGHT (both required — placeholders are fine with hook-bridge):
{
  "after_doing_result":   {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0},
  "before_review_result": {"exit_code": 0, "output": "Executed by Pi hook-bridge extension", "duration_ms": 0}
}
```

### Mistake 2: Continuing work after needs_review=true
```bash
# PATCH /api/tasks/W47/complete returns needs_review=true
#    Agent continues to claim next task

# PATCH /api/tasks/W47/complete returns needs_review=true
#    Agent STOPS and waits for human review
```

### Mistake 3: Ignoring an `after_doing` veto from `hook-bridge`
```bash
# /complete curl returns blocked: "after_doing failed (exit 1): mix test"
#    Agent retries with --no-veto or fabricates a passing after_doing_result

# /complete curl returns blocked: "after_doing failed (exit 1): mix test"
#    Agent reads the failure, fixes the failing test, retries the curl
#    (hook-bridge runs after_doing again on the retry)
```

### Mistake 4: Sending real timing values for the hook_result fields
```json
WRONG (pretending the agent ran the hook itself):
{
  "after_doing_result": {
    "exit_code": 0,
    "output": "230 tests, 0 failures\nmix credo --strict: No issues found",
    "duration_ms": 45678
  }
}

RIGHT (placeholder — hook-bridge does the real work):
{
  "after_doing_result": {
    "exit_code": 0,
    "output": "Executed by Pi hook-bridge extension",
    "duration_ms": 0
  }
}
```

## Implementation Workflow

1. **Complete all work** - Implementation finished.
2. **Pre-completion code review** - If medium+ complexity OR 2+ key_files, invoke `task-reviewer` and fix Critical/Important findings.
3. **Call complete endpoint** - Include placeholder `after_doing_result` and `before_review_result` (hook-bridge runs the real hooks).
4. **If the curl is vetoed** (after_doing failure surfaced as block reason) - Fix the underlying issue and retry the same curl.
5. **Curl succeeded?** - The task is in Review (or Done, if no review needed). `before_review` already ran on the post-curl event; check the response for `needs_review`.
6. **needs_review=true** → STOP, wait for human review.
7. **needs_review=false** → Call `mark_reviewed` if applicable (hook-bridge runs `after_review` on the tool_result), then claim the next task.

## Quick Reference Card

```
├─ 1. Work is complete
├─ 2. (Optional) Pre-completion task-reviewer for medium+ / 2+ key_files
├─ 3. Call PATCH /api/tasks/:id/complete with placeholder hook_result fields
├─ 4. hook-bridge runs after_doing on the tool_call (pre-curl)
├─ 5. Veto raised? → Read failure, fix issue, retry the curl
├─ 6. Curl succeeds → before_review fires post-curl (non-blocking)
├─ 7. needs_review=true? → STOP, wait for human
└─ 8. needs_review=false? → mark_reviewed (after_review fires), claim next

API ENDPOINT: PATCH /api/tasks/:id/complete
REQUIRED BODY: {
  "agent_name": "Pi",
  "time_spent_minutes": 45,
  "completion_notes": "...",
  "completion_summary": "Brief one-line summary for tracking.",
  "actual_complexity": "medium",
  "actual_files_changed": "lib/foo.ex, lib/bar.ex, test/foo_test.exs",
  "skills_version": "1.0",
  "review_report": "..." (optional — include when task-reviewer ran),
  "after_doing_result": {
    "exit_code": 0,
    "output": "Hook output here",
    "duration_ms": 45678
  },
  "before_review_result": {
    "exit_code": 0,
    "output": "Hook output here",
    "duration_ms": 2340
  },
  "explorer_result": {
    "dispatched": false,
    "reason": "self_reported_exploration",
    "summary": "<40+ non-whitespace chars>"
  },
  "reviewer_result": {
    "dispatched": false,
    "reason": "self_reported_review",
    "summary": "<40+ non-whitespace chars>"
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

SKIP FORM for explorer_result / reviewer_result (when subagent not dispatched):
  {"dispatched": false, "reason": "<enum>", "summary": "<40+ non-whitespace chars>"}
Reason enum: no_subagent_support, small_task_0_1_key_files, trivial_change_docs_only,
             self_reported_exploration, self_reported_review
```

## Real-World Impact

**Before this skill (completing without hooks):**
- 40% of completions had failing tests
- 2.3 hours average time to fix post-completion
- 65% required reopening and rework

**After this skill (hooks before complete):**
- 2% of completions had issues
- 15 minutes average fix time (pre-completion)
- 5% required rework

**Time savings: 2+ hours per task (90% reduction in post-completion rework)**

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

If you are following the `stride-workflow` orchestrator, you arrive here at **Step 7-8** with all prerequisites already satisfied:
- Task was claimed with proper before_doing hook (Step 2)
- Codebase was explored and patterns identified (Step 3)
- Implementation is complete (Step 4)
- Code review was performed against acceptance criteria (Step 6)

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
