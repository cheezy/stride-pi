---
name: stride-task-reviewer
description: Use this skill after finishing implementation of a Stride task but before running the after_doing hook. Review the git diff against the task's acceptance_criteria, pitfalls, patterns_to_follow, and testing_strategy, catching task-specific quality issues that automated tests miss. This is Pi's inline equivalent of the task-reviewer subagent in sibling plugins (Claude Code / Codex CLI).
---

# Stride: Task Reviewer (Inline)

## Purpose

Review code changes against Stride kanban task requirements. Verify that an implementation meets all task-specific criteria before automated quality gates (tests, linting) run.

**Pi context:** Pi does not ship with native subagent dispatch. In sibling plugins this runs as an isolated subagent; on Pi you execute these instructions inline. The review rigor and output shape are identical — only the isolation changes.

## When to invoke

**MANDATORY** after implementation is complete, before executing the `after_doing` hook, whenever the decision matrix in `stride-subagent-workflow` indicates review is required (medium+ complexity, 2+ key_files). Skip review for small tasks with 0–1 key_files per the matrix.

## Inputs (from your current context)

- A git diff of the changes you just made (generate it with `git diff` in your bash tool)
- Stride task metadata already in your context: `acceptance_criteria`, `pitfalls`, `patterns_to_follow`, `testing_strategy`, `description`, `what`, `why`

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

3. **Pattern Compliance**
   - If `patterns_to_follow` is provided, verify the implementation follows the referenced patterns
   - Check: module structure, function naming, error handling approach, return value format
   - Flag deviations as **Important** with a description of how the implementation differs

4. **Testing Strategy Alignment**
   - If `testing_strategy` is provided, check whether the diff includes appropriate tests
   - For `unit_tests`: verify test files exist for new functions
   - For `integration_tests`: verify end-to-end test scenarios are covered
   - For `edge_cases`: verify edge case handling in both code and tests
   - Flag missing test coverage as **Important**

5. **General Code Quality**
   - Check for obvious bugs, off-by-one errors, or missing error handling in new code
   - Verify new functions have consistent return types (especially `{:ok, _} | {:error, _}` patterns)
   - Flag issues as **Minor** unless they could cause runtime failures (then Critical)

6. **Produce Structured Review**
   - Begin with a one-line human-readable summary line: `"Approved"` (no issues) or `"X issues found (Y critical, Z important, W minor)"`. Orchestrator fallback paths grep this prose line when JSON parsing fails, so it must appear verbatim above the JSON block.
   - Below the summary line, list all issues grouped by severity (critical first, then important, then minor), then a short acceptance-criteria table showing each criterion and its status (Met / Partially Met / Not Met).
   - End your response with a single fenced ```json block matching the canonical schema. The fenced block delimiters are not part of the JSON payload — they only mark the block for downstream parsers. Emit the block unconditionally, including for Approved reviews (in which case `issues` is `[]` and every acceptance_criteria entry has `status: "met"`).
   - The canonical `reviewer_result` schema lives in [`stride/agents/task-reviewer.md`](https://github.com/cheezy/stride/blob/main/agents/task-reviewer.md) and is the single source of truth for all six reviewer-variant prompts. Do not redefine the schema here; the field list below is a citation, not a new definition.
   - The JSON object has these top-level fields (all required, snake_case throughout):
     - `schema_version`: string. Always `"1.0"` for this prompt version.
     - `summary`: string of at least 40 non-whitespace characters describing what you reviewed and your overall verdict.
     - `status`: enum, one of `"approved"` | `"changes_requested"`. Use `"changes_requested"` if any entry in `issues` has severity `"critical"` or `"important"`, or if any acceptance criterion has status `"not_met"`. Otherwise `"approved"`.
     - `issue_counts`: object with non-negative integer keys `critical`, `important`, `minor`. Each value equals the number of entries in `issues` with that severity (sum equals `len(issues)`).
     - `issues`: array (possibly empty). Each entry has these keys: `severity` (enum: `"critical"` | `"important"` | `"minor"`), `category` (enum: `"acceptance_criteria"` | `"pitfall"` | `"pattern"` | `"testing"` | `"code_quality"` — matching the five numbered review steps above), `file` (string path relative to repo root), `line` (integer or `null` if not line-specific), `description` (string, one or two sentences), `suggested_fix` (string).
     - `acceptance_criteria`: array. One entry per criterion in the task's `acceptance_criteria` field — emit an empty array `[]` if the task has none. Each entry has: `criterion` (verbatim criterion text), `status` (enum: `"met"` | `"not_met"`), `evidence` (string — a file:line reference for `"met"`, or an explanation of what is missing for `"not_met"`). If a criterion is partially satisfied, set `status: "not_met"`, describe the gap in `evidence`, and add a corresponding `important` entry to `issues`.

**Worked example** — a `changes_requested` review with one critical pitfall violation, one minor code-quality issue, and a not-met acceptance criterion. Mimic this shape exactly:

```json
{
  "schema_version": "1.0",
  "summary": "Reviewed 3 acceptance criteria, 4 pitfalls, and 12 diff hunks against task patterns; found 1 critical pitfall violation and 1 minor naming issue, both blocking approval.",
  "status": "changes_requested",
  "issue_counts": {
    "critical": 1,
    "important": 0,
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
  ]
}
```

## Outputs: `review_report` and `reviewer_result`

The structured review narrative — the prose summary line, the per-severity issue list, the acceptance-criteria table, **and** the fenced ```json block — becomes the `review_report` field on the Stride `/complete` payload. Always emit both the prose sections and the JSON block (including for Approved reviews) so both reader paths — human reviewers reading the prose in the task detail view, and downstream tooling parsing the first ```json fence — work consistently.

Separately, you must include `reviewer_result` using the **dispatched shape** (you genuinely performed the review, so the work was done inline). The dispatched shape now carries BOTH the legacy summary fields AND the structured fields parsed from your JSON block:

```json
"reviewer_result": {
  "dispatched": true,
  "summary": "<at least 40 non-whitespace characters summarising the review — what was checked, what was found>",
  "duration_ms": <wall-clock milliseconds spent in this skill>,
  "acceptance_criteria_checked": <integer count of criteria reviewed>,
  "issues_found": <integer count of issues across all severities>,
  "schema_version": "1.0",
  "status": "<approved|changes_requested>",
  "issue_counts": {"critical": <n>, "important": <n>, "minor": <n>},
  "issues": [<copy of issues[] from JSON block>],
  "acceptance_criteria": [<copy of acceptance_criteria[] from JSON block>]
}
```

The legacy fields (`summary`, `duration_ms`, `acceptance_criteria_checked`, `issues_found`) are **required** in the dispatched shape. The structured fields are copied verbatim from the JSON block you just emitted — omit any structured key you did not emit (do not send empty placeholders). See `stride-completing-tasks/SKILL.md` for the full schema and `stride-subagent-workflow/SKILL.md` Phase 3 for the orchestrator-side extraction logic.

## Important constraints

- Only review the diff provided — do not explore unrelated code
- Do not run tests or execute code — you only review
- Do not interact with the Stride API — you only review; the `/complete` call happens later
- Be constructive and proportional — flag only issues that matter
- Do not flag issues outside the scope of the current task
- Keep `summary` substantive — it must clear the 40-character non-whitespace minimum
