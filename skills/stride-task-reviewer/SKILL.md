---
name: stride-task-reviewer
description: Use this skill after finishing implementation of a Stride task but before running the after_doing hook. Review the git diff against the task's acceptance_criteria, pitfalls, patterns_to_follow, testing_strategy, and security_considerations, catching task-specific quality issues that automated tests miss. This is Pi's inline equivalent of the task-reviewer subagent in sibling plugins (Claude Code / Codex CLI).
---

# Stride: Task Reviewer (Inline)

## Purpose

Review code changes against Stride kanban task requirements. Verify that an implementation meets all task-specific criteria before automated quality gates (tests, linting) run.

**Pi context:** Pi does not ship with native subagent dispatch. In sibling plugins this runs as an isolated subagent; on Pi you execute these instructions inline. The review rigor and output shape are identical — only the isolation changes. **This inline skill and the dispatched ext-agent at `extensions/subagent-dispatch/agents/stride-task-reviewer.md` MUST describe the SAME structured block** (canonical `schema_version` `"1.3"`); the two paths differ only in isolation, never in output contract.

## When to invoke

**MANDATORY** after implementation is complete, before executing the `after_doing` hook, whenever the decision matrix in `stride-subagent-workflow` indicates review is required (medium+ complexity, 2+ key_files). Skip review for small tasks with 0–1 key_files per the matrix.

## Inputs (from your current context)

- A git diff of the changes you just made (generate it with `git diff` in your bash tool)
- Stride task metadata already in your context: `acceptance_criteria`, `pitfalls`, `patterns_to_follow`, `testing_strategy`, `security_considerations`, `description`, `what`, `why`

Use these fields as your review checklist.

## Steps

1. **Acceptance Criteria Verification**
   - Parse each line of `acceptance_criteria` as a separate requirement
   - For each criterion, search the diff for corresponding code changes that satisfy it
   - Mark each criterion as: Met (with file:line reference), Partially Met (with explanation of what's missing), or Not Met
   - If any criterion is Not Met, flag it as a **Critical** issue
   - If any criterion is Partially Met, flag it as an **Important** issue

2. **Pitfall Detection**
   - Read each entry in the `pitfalls` array
   - Scan the diff for any code that violates a listed pitfall
   - For each violation found, flag it as **Critical** with the specific file:line reference and the pitfall it violates
   - Pitfall violations are always Critical because the task author explicitly warned against them
   - Record the `pitfalls` section verdict in the JSON block: `"failed"` if any listed pitfall was violated, `"passed"` if the task supplied `pitfalls` and none were violated, `"not_assessed"` if the task listed no pitfalls

3. **Pattern Compliance**
   - If `patterns_to_follow` is provided, verify the implementation follows the referenced patterns
   - Check: module structure, function naming, error handling approach, return value format
   - Flag deviations as **Important** with a description of how the implementation differs from the expected pattern
   - Record the `patterns` section verdict in the JSON block: `"failed"` on a problematic deviation, `"passed"` if the task supplied `patterns_to_follow` and it was followed, `"not_assessed"` if the task supplied none

4. **Testing Strategy Alignment**
   - If `testing_strategy` is provided, check whether the diff includes appropriate tests
   - For `unit_tests`: verify test files exist for new functions
   - For `integration_tests`: verify end-to-end test scenarios are covered
   - For `edge_cases`: verify edge case handling in both code and tests
   - Flag missing test coverage as **Important**
   - Record the `testing_strategy` section verdict in the JSON block: `"failed"` on missing or inadequate tests, `"passed"` if the task supplied a `testing_strategy` and it was satisfied, `"not_assessed"` if the task supplied none

5. **Security Considerations Alignment**
   - If `security_considerations` is provided, check whether the diff actually addresses each listed implication — this is the gate that confirms the considerations were *implemented*, not just declared
   - Verify the relevant dimensions are handled where the considerations call for them: input validation/sanitization, authorization boundaries (does the requesting user own/have access to the resource?), secret/credential handling, injection surfaces (SQL — parameterized; command; XSS — output escaped), and data exposure across users or in error messages
   - Flag an unaddressed or inadequately-handled consideration as **Important**; flag it as **Critical** when it leaves an exploitable vulnerability in the diff
   - An explicit "None — …" consideration is satisfied by a diff that genuinely introduces no security surface; if the diff contradicts that claim (e.g. it does touch input or authz), flag it
   - Record the `security_considerations` section verdict in the JSON block: `"failed"` when you raised any `category: "security"` issue or a listed consideration is unaddressed; `"passed"` when the task supplied `security_considerations` and they were satisfied; `"not_assessed"` when the task supplied none

6. **General Code Quality**
   - Check for obvious bugs, off-by-one errors, or missing error handling in new code
   - Verify new functions have consistent return types (especially `{:ok, _} | {:error, _}` patterns)
   - Check for hardcoded values that should be configurable
   - Flag issues as **Minor** unless they could cause runtime failures (then Critical)

7. **Project-Level Checks**
   - Read `CODE-REVIEW.md` from the project root (use your bash/read tools). If the file does not exist, skip this step and emit `project_checks: []` in the JSON block.
   - If the file exists, parse each top-level Markdown bullet (lines beginning with `- ` or `* `) as a separate check. Nested or indented sub-bullets are NOT separate checks — treat them as context for their parent bullet.
   - If a bullet's text begins with the case-sensitive prefix `CRITICAL:`, the check has severity `critical`. Default severity is `important`. Strip the `CRITICAL:` prefix from the check text before recording it.
   - Evaluate each check against the diff using the same Met / Not Met semantics as step 1.
   - For every check whose status is `not_met`, also append a corresponding entry to `issues[]` with `category: "project_check"` and the derived severity. Project-check failures must show up in both `project_checks[]` (the per-check verdict) and `issues[]` (the actionable list).

8. **Produce Structured Review**
   - Begin with a one-line human-readable summary line: `"Approved"` (no issues) or `"X issues found (Y critical, Z important, W minor)"`. Orchestrator fallback paths grep this prose line when JSON parsing fails, so it must appear verbatim above the JSON block.
   - Below the summary line, list all issues grouped by severity (critical first, then important, then minor), then a short acceptance-criteria table showing each criterion and its status, and a parallel short project-checks table (omit the project-checks table when `project_checks` is empty).
   - End your response with a single fenced ```json block matching the canonical schema. The fenced block delimiters are not part of the JSON payload — they only mark the block for downstream parsers. Emit the block unconditionally, including for Approved reviews (in which case `issues` is `[]` and every acceptance_criteria entry has `status: "met"`).
   - The canonical `reviewer_result` schema lives in [`stride/agents/task-reviewer.md`](https://github.com/cheezy/stride/blob/main/agents/task-reviewer.md) at `schema_version` `"1.3"` and is the single source of truth for all six reviewer-variant prompts — including the dispatched stride-pi ext-agent at `extensions/subagent-dispatch/agents/stride-task-reviewer.md`, which this inline skill MUST agree with field-for-field. Do not redefine the schema here; the field list below is a citation, not a new definition.
   - The JSON object has these top-level fields (all required, snake_case throughout):
     - `schema_version`: string. Always `"1.3"` for this prompt version.
     - `summary`: string of at least 40 non-whitespace characters describing what you reviewed and your overall verdict.
     - `status`: enum, one of `"approved"` | `"changes_requested"`. Use `"changes_requested"` if any entry in `issues` has severity `"critical"` or `"important"`, or if any acceptance criterion has status `"not_met"`, or if any project_check has status `"not_met"`. Otherwise `"approved"`.
     - `issue_counts`: object with non-negative integer keys `critical`, `important`, `minor`. Each value equals the number of entries in `issues` with that severity (sum equals `len(issues)`).
     - `issues`: array (possibly empty). Each entry has these keys: `severity` (enum: `"critical"` | `"important"` | `"minor"`), `category` (enum: `"acceptance_criteria"` | `"pitfall"` | `"pattern"` | `"testing"` | `"security"` | `"code_quality"` | `"project_check"` — matching the seven numbered review steps above), `file` (string path relative to repo root), `line` (integer or `null` if not line-specific), `description` (string, one or two sentences), `suggested_fix` (string).
     - `acceptance_criteria`: array. One entry per criterion in the task's `acceptance_criteria` field — emit an empty array `[]` if the task has none. Each entry has: `criterion` (verbatim criterion text), `status` (enum: `"met"` | `"not_met"`), `evidence` (string — a file:line reference for `"met"`, or an explanation of what is missing for `"not_met"`). If a criterion is partially satisfied, set `status: "not_met"`, describe the gap in `evidence`, and add a corresponding `important` entry to `issues`.
     - `project_checks`: array (possibly empty). One entry per top-level bullet parsed from the project's `CODE-REVIEW.md` file — emit an empty array `[]` if the file does not exist or contains no bullets. Each entry has: `check` (verbatim bullet text with any leading `CRITICAL:` prefix stripped), `source` (always the literal string `"CODE-REVIEW.md"`), `status` (enum: `"met"` | `"not_met"`), `evidence` (string — a file:line reference for `"met"`, or an explanation of the gap for `"not_met"`). Every `"not_met"` entry MUST have a paired entry in `issues[]` with `category: "project_check"` and the severity derived from the bullet's `CRITICAL:` prefix (default `"important"`).
     - `testing_strategy`: object `{ "status": "passed" | "failed" | "not_assessed", "note": "<one-line rationale>" }` — the per-section verdict on whether the implementation followed the task's `testing_strategy` (review step 4). Use `"failed"` when you raised any `category: "testing"` issue or found required tests missing; `"passed"` when the task supplied a `testing_strategy` and it was satisfied; `"not_assessed"` when the task supplied no `testing_strategy` to check against. `note` is optional but recommended.
     - `patterns`: object `{ "status": "passed" | "failed" | "not_assessed", "note": "<one-line rationale>" }` — the per-section verdict on `patterns_to_follow` (review step 3). `"failed"` when you raised any `category: "pattern"` issue or found a problematic deviation; `"passed"` when the task supplied `patterns_to_follow` and the implementation followed it; `"not_assessed"` when the task supplied no `patterns_to_follow`. `note` optional.
     - `pitfalls`: object `{ "status": "passed" | "failed" | "not_assessed", "note": "<one-line rationale>" }` — the per-section verdict on the task's `pitfalls` list (review step 2). `"failed"` when you raised any `category: "pitfall"` issue (a listed pitfall was violated); `"passed"` when the task supplied `pitfalls` and none were violated; `"not_assessed"` when the task supplied no `pitfalls`. `note` optional.
     - `security_considerations`: object `{ "status": "passed" | "failed" | "not_assessed", "note": "<one-line rationale>" }` — the per-section verdict on the task's `security_considerations` list (review step 5), confirming the considerations were actually implemented. `"failed"` when you raised any `category: "security"` issue (a listed consideration was unaddressed or a vulnerability remains); `"passed"` when the task supplied `security_considerations` and they were satisfied; `"not_assessed"` when the task supplied no `security_considerations`. `note` optional but recommended.
     - **Consistency rule:** a `"failed"` section verdict MUST be backed by at least one `issues[]` entry of the matching category (`testing` / `pattern` / `pitfall` / `security`), and any such issue MUST flip its section to `"failed"`. This keeps the review-queue per-section tiles agreeing with the issue list. The Kanban review queue reads `testing_strategy.status` / `patterns.status` / `pitfalls.status` / `security_considerations.status` directly to render those tiles.

**Worked example** — a `changes_requested` review with one critical pitfall violation, one minor code-quality issue, one important project-check failure, and a not-met acceptance criterion. Mimic this shape exactly:

```json
{
  "schema_version": "1.3",
  "summary": "Reviewed 3 acceptance criteria, 4 pitfalls, 2 security considerations, 2 project checks from CODE-REVIEW.md, and 12 diff hunks against task patterns; found 1 critical pitfall violation, 1 important project-check failure, and 1 minor naming issue, all blocking approval.",
  "status": "changes_requested",
  "issue_counts": {
    "critical": 1,
    "important": 1,
    "minor": 1
  },
  "issues": [
    {
      "severity": "critical",
      "category": "pitfall",
      "file": "lib/kanban/tasks.ex",
      "line": 142,
      "description": "Direct Ecto query introduced inside the LiveView; pitfalls list explicitly forbids this.",
      "suggested_fix": "Move the query into Kanban.Tasks and call it from the LiveView."
    },
    {
      "severity": "important",
      "category": "project_check",
      "file": "lib/kanban/tasks.ex",
      "line": 172,
      "description": "New public function lacks a @doc string; CODE-REVIEW.md requires every public function in lib/kanban to be documented.",
      "suggested_fix": "Add a @doc heredoc above broadcast_move/2 describing inputs, return value, and side effects."
    },
    {
      "severity": "minor",
      "category": "code_quality",
      "file": "lib/kanban/tasks.ex",
      "line": 158,
      "description": "Function name 'calc_pos' is abbreviated; project convention is full descriptive names.",
      "suggested_fix": "Rename to 'calculate_position'."
    }
  ],
  "acceptance_criteria": [
    {
      "criterion": "All task positions recalculate when a card moves columns",
      "status": "met",
      "evidence": "lib/kanban/tasks.ex:142-168 implements column-aware repositioning; covered by test/kanban/tasks_test.exs:241-289."
    },
    {
      "criterion": "Existing position-stable behavior for same-column reorder is unchanged",
      "status": "met",
      "evidence": "test/kanban/tasks_test.exs:198-240 still passes; same-column branch is untouched."
    },
    {
      "criterion": "PubSub broadcast emitted exactly once per move",
      "status": "not_met",
      "evidence": "lib/kanban/tasks.ex:172 broadcasts twice (once after position update, once after column update); see the critical issue above."
    }
  ],
  "project_checks": [
    {
      "check": "All Ecto queries must live in context modules, not in LiveViews or controllers",
      "source": "CODE-REVIEW.md",
      "status": "met",
      "evidence": "lib/kanban/tasks.ex:142-168 is the only new query and lives in the Tasks context."
    },
    {
      "check": "Every public function in lib/kanban must have a @doc string",
      "source": "CODE-REVIEW.md",
      "status": "not_met",
      "evidence": "lib/kanban/tasks.ex:172 broadcast_move/2 is public but lacks @doc; see the paired project_check issue above."
    }
  ],
  "testing_strategy": {
    "status": "passed",
    "note": "New tests cover the column-move repositioning and the broadcast path (test/kanban/tasks_test.exs:241-289)."
  },
  "patterns": {
    "status": "passed",
    "note": "Repositioning mirrors the existing same-column reorder pattern; no problematic deviation."
  },
  "pitfalls": {
    "status": "failed",
    "note": "A direct Ecto query was introduced in the LiveView — see the critical pitfall issue above."
  },
  "security_considerations": {
    "status": "passed",
    "note": "Both listed considerations were implemented: the move query is scoped to the current user's board, and the position params are bounds-checked (lib/kanban/tasks.ex:142-168)."
  }
}
```

## Outputs: `review_report` and `reviewer_result`

The structured review narrative — the prose summary line, the per-severity issue list, the acceptance-criteria table, the project-checks table (when non-empty), **and** the fenced ```json block — becomes the `review_report` field on the Stride `/complete` payload. Always emit both the prose sections and the JSON block (including for Approved reviews) so both reader paths — human reviewers reading the prose in the task detail view, and downstream tooling parsing the first ```json fence — work consistently.

Separately, you must include `reviewer_result` using the **dispatched shape** (you genuinely performed the review, so the work was done inline). The dispatched shape carries BOTH the legacy summary fields AND the structured fields parsed from your JSON block — exactly as the dispatched ext-agent path does, so both paths land identically in Stride:

```json
"reviewer_result": {
  "dispatched": true,
  "summary": "<at least 40 non-whitespace characters summarising the review — what was checked, what was found>",
  "duration_ms": <wall-clock milliseconds spent in this skill>,
  "acceptance_criteria_checked": <integer count of criteria reviewed — the length of acceptance_criteria[]>,
  "issues_found": <integer count of issues across all severities — the sum of issue_counts>,
  "schema_version": "1.3",
  "status": "<approved|changes_requested>",
  "issue_counts": {"critical": <n>, "important": <n>, "minor": <n>},
  "issues": [<copy of issues[] from JSON block>],
  "acceptance_criteria": [<copy of acceptance_criteria[] from JSON block>],
  "project_checks": [<copy of project_checks[] from JSON block>],
  "testing_strategy": {<copy from JSON block>},
  "patterns": {<copy from JSON block>},
  "pitfalls": {<copy from JSON block>},
  "security_considerations": {<copy from JSON block>}
}
```

**Legacy + structured coexistence.** The legacy fields (`summary`, `duration_ms`, `acceptance_criteria_checked`, `issues_found`) are **required** in the dispatched shape and are kept for backwards compatibility with older Kanban deploys. The structured fields (`schema_version`, `status`, `issue_counts`, `issues`, `acceptance_criteria`, `project_checks`, `testing_strategy`, `patterns`, `pitfalls`, `security_considerations`) are copied verbatim from the JSON block you just emitted — they are the actual deliverable for the review-queue per-section tiles. The two sets coexist in the **same** `reviewer_result` map (persisted as `:jsonb`); legacy and structured never live under separate top-level API keys. Omit any structured key you did not emit (do not send empty placeholders). See `stride-completing-tasks/SKILL.md` for the full schema and `stride-subagent-workflow/SKILL.md` Phase 3 for the orchestrator-side extraction logic.

## Important constraints

- Only review the diff provided — do not explore unrelated code (reading `CODE-REVIEW.md` for step 7 is the one allowed exception)
- Do not run tests or execute code — you only review
- Do not interact with the Stride API — you only review; the `/complete` call happens later
- Be constructive and proportional — flag only issues that matter
- Do not flag issues outside the scope of the current task
- Keep `summary` substantive — it must clear the 40-character non-whitespace minimum
