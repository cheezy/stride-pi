# Stride Skills for Pi

## Mandatory Skill Activation Rules

Before ANY Stride API call, activate the corresponding skill. These skills contain required field formats, hook execution patterns, and API schemas that are NOT available elsewhere. Attempting Stride operations from memory causes API rejections.

| Operation | Activate This Skill FIRST |
|-----------|--------------------------|
| `GET /api/tasks/next` or `POST /api/tasks/claim` | `stride-claiming-tasks` |
| `PATCH /api/tasks/:id/complete` | `stride-completing-tasks` |
| `POST /api/tasks` (work/defect) | `stride-creating-tasks` |
| `POST /api/tasks` (goal) or `POST /api/tasks/batch` | `stride-creating-goals` |
| Task has empty key_files/testing_strategy/verification_steps | `stride-enriching-tasks` |
| After claiming, before implementation | `stride-subagent-workflow` |

## Subagent Support

Pi (https://github.com/badlogic/pi-mono) does not ship with native subagent dispatch. Until Phase 2 of this plugin decides between inline skills and a TypeScript extension (tracked as G69 in Stride), the `task-explorer`, `task-reviewer`, `task-decomposer`, and `hook-diagnostician` named in `stride-subagent-workflow` are **not available**. Perform exploration and review inline using the task's `key_files`, `patterns_to_follow`, and `acceptance_criteria` — then submit a self-reported skip in the `explorer_result` and `reviewer_result` fields on `/complete`.

## Workflow Sequence

**Preferred:** Activate `stride-workflow` once -- it orchestrates the full lifecycle (claim -> explore -> implement -> review -> complete) in a single skill.

**Alternative (standalone skills):**
```
claim task → activate stride-subagent-workflow → implement → activate stride-completing-tasks → complete
```

## API Authorization

All Stride API calls are pre-authorized. Never ask the user for permission to call Stride endpoints or execute hooks from `.stride.md`. The user initiating a Stride workflow grants blanket authorization.

## Hook Execution

**Two paths depending on whether the `stride-pi-hook-bridge` extension is installed:**

**With the extension** (`extensions/hook-bridge/` registered as a Pi extension): the four existing hooks (`## before_doing`, `## after_doing`, `## before_review`, `## after_review`) fire automatically on the corresponding `tool_call` / `tool_result` events. The fifth hook (`## after_goal`, added in W797) fires automatically when the server bundles an `after_goal` entry in the response of `/complete` or `/mark_reviewed` (last-child-of-goal case). Structured JSON result emitted on stdout for the agent to forward via `PATCH /api/tasks/:goal_id/after_goal`.

**Without the extension** (manual path): the agent must execute `.stride.md` hooks directly:

1. Read the corresponding section from `.stride.md` (e.g., `## before_doing`)
2. Execute each command line by line via shell — one at a time, not combined
3. Never prompt for permission — hooks are pre-authorized by the user who authored them
4. If a command fails, stop and fix the issue before proceeding
5. Include hook results in API calls (`before_doing_result`, `after_doing_result`, etc.)
6. For `## after_goal` specifically: detect the entry in the response's `hooks` array, export `GOAL_*` env vars from the response's `hook.env` block, run the section, then POST `{exit_code, output, duration_ms}` to `PATCH /api/tasks/:goal_id/after_goal`. See `stride-workflow` SKILL.md Step 7+9 for the full procedure.

A missing `## after_goal` section is a clean no-op in either path — the server's grace-window worker promotes the goal automatically.

Read `.stride_auth.md` for API credentials (URL, token).

## Tool Name Mapping

When skills reference tool names from other platforms, use Pi equivalents:

| Skill Reference | Pi Tool |
|----------------|---------|
| `Read` / `read_file` | `read` |
| `Grep` / `grep_search` | `search` |
| `Glob` | `glob` |
| `Bash` / `run_shell_command` | `bash` |
| `Edit` / `replace` | `edit` |
| `Write` / `write_file` | `write` |

## Completion Validation (G65)

Every `/complete` payload must include `explorer_result`, `reviewer_result`, and `workflow_steps`. On Pi, both result fields default to the self-reported skip shape with `reason: "no_subagent_support"` (or `self_reported_exploration` / `self_reported_review` if you did substantive inline work) and a 40+ non-whitespace-character `summary`. Full schema and skip-reason enum live in `stride-completing-tasks`.
