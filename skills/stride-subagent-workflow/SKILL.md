---
name: stride-subagent-workflow
description: MANDATORY after claiming any Stride task. Contains the decision matrix for invoking the stride-task-explorer, stride-task-reviewer, stride-task-decomposer, and stride-hook-diagnostician inline skills. Skipping means no codebase exploration before implementation and no code review before completion — causing wrong approaches and missed acceptance criteria. Activate IMMEDIATELY after claim succeeds, BEFORE writing any code.
---

# Stride: Subagent Workflow (inline on Pi)

## THIS SKILL IS MANDATORY AFTER CLAIMING — NOT OPTIONAL

**If you just claimed a Stride task and are about to start implementation, you MUST activate this skill first.**

This skill contains the decision matrix that determines which inline skills to invoke:
- `stride-task-explorer` — Read key_files and discover patterns before coding
- `stride-task-reviewer` — Review your changes against acceptance criteria before completion
- `stride-task-decomposer` — Break goals into properly-sized subtasks
- `stride-hook-diagnostician` — Diagnose hook failures with prioritized fix plans

**Skipping this skill means:**
- No codebase exploration before implementation (wrong approach, 2+ hours wasted)
- No code review before completion hooks (acceptance criteria violations missed)
- No goal decomposition (goals attempted as monolithic work)

**Skill chain position:** `stride-claiming-tasks` -> **THIS SKILL** -> implementation -> `stride-completing-tasks`

## Overview

**Coding without context = wrong approach and rework. Exploring and planning first = confident, first-pass quality.**

This skill orchestrates inline skills at four points in the Stride workflow: decomposition for goals, exploration after claiming, planning for complex tasks, and code review before completion hooks. It tells you WHEN to invoke each inline skill — the agents themselves handle the HOW.

## Pi Inline Skills (Phase 2a)

Pi (https://github.com/badlogic/pi-mono) does not ship with a native subagent dispatch mechanism. On sibling plugins (Claude Code, Codex CLI, Gemini CLI), the four roles named in this skill — `task-explorer`, `task-reviewer`, `task-decomposer`, `hook-diagnostician` — run as isolated subagents. On stride-pi, they run as **inline skills** in the main agent's context. Phase 2b (tracked as G69's W252) will evaluate whether to upgrade to a TypeScript extension that shells out to `pi -p` for isolation and parallelism; until then, inline is the supported path.

**Invoke these skills directly from your main context when the decision matrix says so:**

| Role | stride-pi skill | When to invoke |
|---|---|---|
| Exploration | `stride-task-explorer` | After claim, when complexity is medium+ or `key_files` has 2+ entries |
| Code review | `stride-task-reviewer` | After implementation, before the `after_doing` hook, same threshold |
| Goal decomposition | `stride-task-decomposer` | When a claimed task is a goal or large-undecomposed |
| Hook failure triage | `stride-hook-diagnostician` | When any blocking hook fails with non-zero exit |

The work each skill does is byte-for-byte identical to the subagent version — only the isolation differs. You perform the exploration/review/decomposition/diagnosis inline, in your main context, then proceed with the result.

**Recording results in the `/complete` payload:** Because you genuinely performed the work (not skipped it), use the **dispatched shape** (`dispatched: true`) for `explorer_result` and `reviewer_result`. See `stride-completing-tasks/SKILL.md` for the full schema. The skip-form (`dispatched: false` with a reason from the 5-value enum) is only for steps the decision matrix told you to skip, not for steps you performed inline.

## The Iron Law

**INVOKE INLINE SKILLS BASED ON TASK COMPLEXITY — NEVER SKIP FOR MEDIUM/LARGE TASKS, NEVER ADD OVERHEAD FOR SIMPLE TASKS**

## The Critical Mistake

Skipping exploration and planning for complex tasks causes:
- Implementing the wrong approach (2+ hours wasted)
- Missing existing patterns and utilities (duplicate code)
- Violating pitfalls the task author explicitly warned about
- Failing acceptance criteria discovered too late

Adding agent overhead to simple tasks causes:
- Unnecessary context window consumption
- Slower task completion with no quality benefit
- Exploration of files that don't need understanding

## When to Use

Activate this skill **after claiming a task** (via `stride-claiming-tasks`) and **before beginning implementation**. Also use the Code Review section **after implementation** but **before running the after_doing hook** (via `stride-completing-tasks`).

## Decision Matrix

Use this matrix to determine which inline skills to invoke based on task attributes:

| Task Attributes | stride-task-decomposer | stride-task-explorer | Plan | stride-task-reviewer |
|---|---|---|---|---|
| small, 0-1 key_files | Skip | Skip | Skip | Skip |
| small, 2+ key_files | Skip | Run | Skip | Run |
| medium (any) | Skip | Run | Run | Run |
| large (any) | Skip | Run | Run | Run |
| Defect type | Skip | Run | Skip (unless large) | Run |
| Goal type | Run | Skip* | Skip* | Skip* |
| Large complexity, not yet decomposed | Run | Skip* | Skip* | Skip* |
| 25+ hour estimate, not yet decomposed | Run | Skip* | Skip* | Skip* |

*After decomposition, each resulting child task follows its own row in this matrix when claimed individually.

**Quick rules:**
- If the task is a **goal** or has **large complexity without child tasks** or a **25+ hour estimate**: invoke the decomposer first. The decomposer breaks it into claimable child tasks — you don't implement goals directly.
- If the task is small with 0-1 key_files, skip all inline skills and code directly.
- Otherwise, at minimum run the explorer and reviewer.

## Phase 0: Decomposition (Goals and Large Undecomposed Tasks)

**When:** Task type is `goal`, OR task has `large` complexity with no child tasks, OR task has a 25+ hour estimate.

**What to do:** Invoke the `stride-task-decomposer` skill, passing the goal/task metadata.

Provide the agent with:
- The task's `title` and `description`
- The task's `acceptance_criteria`
- The task's `key_files` array (if any)
- The task's `where_context` text
- The task's `patterns_to_follow` text
- The project's technology stack context

The decomposer will return an ordered list of child tasks with:
- Titles and descriptions for each task
- Dependency ordering between tasks
- Complexity estimates per task
- Key files and testing strategies per task

**After decomposition:**
1. Use `POST /api/tasks` or `POST /api/tasks/batch` to create the child tasks under the goal
2. Do NOT implement the goal directly — claim and implement the child tasks individually
3. Each child task follows its own row in the Decision Matrix when claimed

**Skip decomposition when:**
- Task type is `work` or `defect` (already at implementation level)
- Goal already has child tasks (already decomposed)
- Task complexity is `small` or `medium` without a 25+ hour estimate

## Phase 1: Exploration (After Claim, Before Coding)

**When:** Task complexity is medium or large, OR task has 2+ key_files.

**What to do:** Invoke the `stride-task-explorer` skill, passing the task metadata.

Provide the agent with:
- The task's `key_files` array (file paths and notes)
- The task's `patterns_to_follow` text
- The task's `where_context` text
- The task's `testing_strategy` object

The explorer will return a structured summary of: each key file's current state, related test files, existing patterns found, and module APIs to reuse.

**Use the explorer's output** to inform your implementation — don't discard it. It tells you what exists, what patterns to follow, and what utilities to reuse.

## Phase 2: Planning (Conditional, Before Coding)

**When:** Task complexity is medium or large, OR task has 3+ key_files, OR task has 3+ acceptance criteria lines.

**What to do:** Plan the implementation approach, using:
- The explorer's output from Phase 1
- The task's `acceptance_criteria`
- The task's `testing_strategy`
- The task's `pitfalls` array
- The task's `verification_steps`

Produce an ordered implementation plan. Follow this plan during implementation.

**Skip planning for:** Small tasks, defects (unless large), tasks with simple/obvious implementations.

## Phase 3: Code Review (After Implementation, Before Hooks)

**When:** Task complexity is medium or large, OR task has 2+ key_files. Skip only for small tasks with 0-1 key_files.

**What to do:** Invoke the `stride-task-reviewer` skill, passing:
- The git diff of all your changes
- The task's `acceptance_criteria`
- The task's `pitfalls` array
- The task's `patterns_to_follow` text
- The task's `testing_strategy` object

The reviewer will return either "Approved" or a list of issues categorized as Critical, Important, or Minor.

**Capture the reviewer's output as `review_report`:** Save the full structured review output returned by the task-reviewer agent. You will include this as the `review_report` field in the completion API call (via `stride-completing-tasks`). Capture it regardless of whether the review found issues — an "Approved" report is still valuable for traceability. When the reviewer is skipped (small tasks with 0-1 key_files), simply omit `review_report` from the completion call.

**If issues are found:**
- Fix all Critical issues before proceeding
- Fix Important issues before proceeding
- Minor issues are optional but recommended
- After fixing, you do NOT need to re-run the reviewer — proceed to the after_doing hook

## Workflow Flowchart

```
Task Claimed
    |
    v
Is it a goal OR large+undecomposed OR 25+ hours?
    |
    +--> YES --> Invoke stride-task-decomposer skill
    |               |
    |               v
    |           Create child tasks via API
    |               |
    |               v
    |           Claim first child task --> (re-enter this flowchart)
    |
    +--> NO --> Check decision matrix
                    |
                    +--> Small, 0-1 key_files? --> Skip all agents --> Begin implementation
                    |
                    +--> Medium/Large OR 2+ key_files?
                            |
                            v
                        Invoke stride-task-explorer skill
                            |
                            v
                        Medium/Large OR 3+ key_files OR 3+ criteria?
                            |
                            +--> YES --> Plan implementation approach
                            |             |
                            |             v
                            +--> NO  --> Begin implementation (using explorer output)
                            |
                            v
                        Begin implementation (using explorer + plan output)
                            |
                            v
                        Implementation complete
                            |
                            v
                        Check decision matrix for reviewer
                            |
                            +--> Small, 0-1 key_files? --> Skip reviewer --> Run after_doing hook
                            |
                            +--> Otherwise --> Invoke stride-task-reviewer skill
                                                |
                                                v
                                            Issues found?
                                                |
                                                +--> YES --> Fix issues --> Run after_doing hook
                                                |
                                                +--> NO  --> Run after_doing hook
```

## Red Flags - STOP

- "This medium task is straightforward, I'll skip exploration"
- "I already know the codebase, no need to explore"
- "Planning takes too long, I'll just start coding"
- "The code review will slow me down"
- "I'll review my own code, no need for the reviewer agent"

**All of these lead to: wrong approach, missed patterns, violated pitfalls, and rework.**

## Rationalization Table

| Excuse | Reality | Consequence |
|--------|---------|-------------|
| "I know this codebase" | Task metadata has specific patterns/pitfalls | Missed pitfalls cause rework |
| "It's obvious what to do" | Medium+ tasks have hidden complexity | Wrong approach wastes 2+ hours |
| "Exploration is slow" | Explorer runs in 10-30 seconds | Skipping costs 1+ hour of undirected reading |
| "Planning is overkill" | Plans catch wrong approaches early | Coding without a plan doubles rework rate |
| "I'll catch issues in tests" | Tests miss acceptance criteria gaps | Reviewer catches what tests can't |
| "This small task has 3 key_files" | 2+ key_files = explore | Missing context causes merge conflicts |

## Quick Reference Card

```
INLINE SKILLS WORKFLOW:
|- 0. Task claimed successfully
|- 1. Is it a goal OR large+undecomposed OR 25+ hours?
|     |- YES -> Invoke stride-task-decomposer skill
|     |- Create child tasks via API
|     |- Claim first child task (re-enter workflow)
|- 2. Check decision matrix (complexity + key_files count)
|- 3. If medium+ OR 2+ key_files:
|     |- Invoke stride-task-explorer skill with task metadata
|     |- Read and use the explorer's output
|- 4. If medium+ OR 3+ key_files OR 3+ criteria:
|     |- Plan implementation approach using explorer output + task metadata
|     |- Follow the resulting plan
|- 5. Implement the task
|- 6. If medium+ OR 2+ key_files:
|     |- Invoke stride-task-reviewer skill with diff + task metadata
|     |- Fix any Critical/Important issues found
|- 7. Proceed to after_doing hook (stride-completing-tasks)

INLINE SKILLS (defined in agents/ directory):
  stride-task-decomposer    - Breaks goals into dependency-ordered child tasks
  stride-task-explorer      - Reads key_files, finds tests, searches patterns
  stride-task-reviewer      - Reviews diff against acceptance criteria & pitfalls
  stride-hook-diagnostician - Diagnoses hook failures with prioritized fix plans

INVOKE DECOMPOSER WHEN:
  Task type is goal, OR large complexity without children, OR 25+ hour estimate

SKIP ALL OTHER AGENTS WHEN:
  Task is small complexity AND has 0-1 key_files
```

## MANDATORY: Skill Chain Position

This skill sits between claiming and completing in the workflow:

1. **`stride-claiming-tasks`** <- You should have activated this BEFORE this skill
2. **`stride-subagent-workflow`** <- YOU ARE HERE
3. **`stride-completing-tasks`** <- Activate WHEN implementation is done

**FORBIDDEN:** Skipping from claiming directly to completing without checking the decision matrix here. Even for small tasks, you must check the matrix — it takes 5 seconds and prevents wrong decisions.

---
**References:** This skill works with `stride-claiming-tasks` (activate after claim) and `stride-completing-tasks` (code review before hooks). Inline skills are at `skills/stride-task-decomposer/SKILL.md`, `skills/stride-task-explorer/SKILL.md`, `skills/stride-task-reviewer/SKILL.md`, and `skills/stride-hook-diagnostician/SKILL.md`.
