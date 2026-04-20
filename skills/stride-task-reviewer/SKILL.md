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
   - Begin with a one-line summary: `"Approved"` (no issues) or `"X issues found (Y Critical, Z Important, W Minor)"`
   - List all issues grouped by severity: Critical first, then Important, then Minor
   - For each issue, include: severity, category, file:line reference, description, and suggested fix
   - End with a list of acceptance criteria and their status (Met / Partially Met / Not Met)

## Outputs: `review_report` and `reviewer_result`

The structured review narrative becomes the `review_report` field on the Stride `/complete` payload.

Separately, you must include `reviewer_result` using the **dispatched shape** (you genuinely performed the review, so the work was done inline):

```json
"reviewer_result": {
  "dispatched": true,
  "summary": "<at least 40 non-whitespace characters summarising the review — what was checked, what was found>",
  "duration_ms": <wall-clock milliseconds spent in this skill>,
  "acceptance_criteria_checked": <integer count of criteria reviewed>,
  "issues_found": <integer count of issues across all severities>
}
```

The two integer fields (`acceptance_criteria_checked`, `issues_found`) are **required** in the dispatched shape. See `stride-completing-tasks/SKILL.md` for the full schema.

## Important constraints

- Only review the diff provided — do not explore unrelated code
- Do not run tests or execute code — you only review
- Do not interact with the Stride API — you only review; the `/complete` call happens later
- Be constructive and proportional — flag only issues that matter
- Do not flag issues outside the scope of the current task
- Keep `summary` substantive — it must clear the 40-character non-whitespace minimum
