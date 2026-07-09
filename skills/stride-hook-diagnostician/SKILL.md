---
name: stride-hook-diagnostician
description: Use this skill when a Stride hook (before_doing, after_doing, before_review, after_review, after_goal) fails during task or goal lifecycle. Parse the hook output, identify failure patterns, categorize issues by severity, and produce a prioritized fix plan. This is Pi's inline equivalent of the hook-diagnostician subagent in sibling plugins (Claude Code / Codex CLI).
---

# Stride: Hook Diagnostician (Inline)

## Purpose

Analyze hook failure output, identify root causes, and produce a prioritized fix plan. This skill categorizes issues by severity and returns structured recommendations — **it does NOT fix code itself.**

**Pi context:** Pi does not ship with native subagent dispatch. In sibling plugins this runs as an isolated subagent; on Pi you execute these instructions inline. The diagnostic logic is identical.

## When to invoke

**MANDATORY** whenever a blocking Stride hook fails (non-zero exit code) — use this skill to prioritize the fix order before making blind attempts. The five hooks are:

- `before_doing` — runs before claiming work (pull code, setup)
- `after_doing` — runs before marking complete (tests, lint, build)
- `before_review` — runs before moving to review (create PR, docs)
- `after_review` — runs after approval (merge, deploy)
- `after_goal` — runs after the parent goal's final child task completes (project rollups, goal-completion notifications); its result is forwarded to `PATCH /api/tasks/:goal_id/after_goal`

`after_doing` and `before_review` are the most common failure points because they batch many quality gates.

## Inputs (from your current context)

When invoked after a failed hook, you must have these pieces of information in scope (from the hook execution you just ran), and you may receive them in one of three shapes — see "Input Detection and Parsing" below:

- `hook_name` — which of the five hooks failed
- `exit_code` — the non-zero exit code
- `output` (or `stdout`/`stderr`) — output from the failed command(s)
- `duration_ms` — how long the hook ran before failing
- Optionally: the task metadata

## Input Detection and Parsing

You may receive the failure in one of three shapes. Detect which, then parse accordingly.

### 1. Pi hook-bridge structured JSON (most common on Pi)

When the `stride-pi-hook-bridge` extension runs the hook, it emits this shape (see `formatHookResultJson` in `extensions/hook-bridge/index.ts`):

```json
{
  "hook": "after_doing",
  "status": "failed",
  "exit_code": 1,
  "output": "... merged stdout + stderr from the failed command ...",
  "failed_command": "mix test --cover",
  "duration_ms": 45678
}
```

**Pi specifics:** the hook-bridge merges stdout and stderr into a single `output` string and runs commands one at a time, stopping at the first failure — so it reports the `failed_command` but does NOT emit `commands_completed` / `commands_remaining` / `command_index`. Read `failed_command` to identify the failing tool, then apply the Failure Pattern Catalog to `output`.

### 2. Claude stride-hook.sh structured JSON (cross-plugin)

The canonical `stride-hook.sh` (and dispatched cross-plugin flows) provide a richer pre-parsed shape:

```json
{
  "hook": "after_doing",
  "status": "failed",
  "failed_command": "mix test --cover",
  "command_index": 1,
  "exit_code": 1,
  "stdout": "... test output ...",
  "stderr": "... warnings ...",
  "commands_completed": ["mix format --check-formatted"],
  "commands_remaining": ["mix credo --strict", "mix sobelow --config .sobelow_config.exs"]
}
```

**Extraction strategy (use whichever fields are present):**
1. Read `failed_command` to identify which tool failed (mix test, mix credo, git, etc.)
2. Apply the Failure Pattern Catalog (below) to `output` (Pi) or `stdout`/`stderr` (stride-hook.sh)
3. `commands_completed` — these passed; no action needed
4. `commands_remaining` — these did not run yet; after fixing the failure, the hook retries all commands including these
5. `command_index` — include it in the fix plan to indicate which step failed (e.g., "Command 2 of 4 failed")

### 3. Raw text (legacy / inline)

Plain text containing mixed tool output (test results, credo warnings, etc.). Fall through to the "Multi-Tool Output Parsing" section to find tool boundaries and parse each section.

## Failure Pattern Catalog

### 1. Compilation Errors (Priority: CRITICAL — fix first)

**Detection:** Output contains `== Compilation error` or `** (CompileError)` or `could not compile`

**Output pattern:**
```
== Compilation error in file lib/kanban/tasks.ex ==
** (CompileError) lib/kanban/tasks.ex:45: undefined function foo/1
    (elixir) expanding macro
```

**Parsing strategy:**
1. Find lines matching `== Compilation error in file (.+) ==`
2. Extract the file path from the match
3. Find the next line matching `\*\* \(CompileError\) (.+):(\d+): (.+)` for file, line, message
4. If `undefined function` — the function doesn't exist or wasn't imported
5. If `undefined module` — the module doesn't exist or wasn't aliased
6. If `is undefined` after a variable — typo or wrong variable name

**Structured output:**
```
Category: Compilation Error
Severity: Critical
File: lib/kanban/tasks.ex
Line: 45
Description: undefined function foo/1
Suggested fix: Check if foo/1 exists in the module. If it's from another module, add an alias or import.
```

### 2. ExUnit Test Failures (Priority: HIGH — fix after compilation)

**Detection:** Output contains `tests, N failures` where N > 0, or `** (ExUnit.`

**Output patterns:**

**Single test failure:**
```
  1) test create_task/2 with valid data creates a task (Kanban.TasksTest)
     test/kanban/tasks_test.exs:45
     Assertion with == failed
     code:  assert task.title == "Expected"
     left:  "Actual"
     right: "Expected"
```

**Error in test:**
```
  1) test create_task/2 raises on invalid data (Kanban.TasksTest)
     test/kanban/tasks_test.exs:60
     ** (KeyError) key :name not found in: %{title: "foo"}
```

**Parsing strategy:**
1. Find lines matching `^\s+\d+\) test (.+) \((.+)\)` for test name and module
2. Next line gives `test/path/to/test.exs:LINE` for location
3. Look for `Assertion with (==|=~|match\?) failed` for assertion failures
4. Extract `left:` and `right:` values to understand the mismatch
5. Look for `** (ExceptionType)` for runtime errors in tests
6. Count total from `N tests, M failures` line

**Structured output:**
```
Category: Test Failure
Severity: High
File: test/kanban/tasks_test.exs
Line: 45
Test: create_task/2 with valid data creates a task
Module: Kanban.TasksTest
Description: Assertion failed — expected "Expected" but got "Actual"
Suggested fix: The function returns "Actual" instead of "Expected". Check the implementation in the corresponding source file.
```

### 3. Sobelow Security Warnings (Priority: HIGH — fix after tests)

**Detection:** Output contains `Running Sobelow` followed by warning lines

**Output patterns:**
```
[+] lib/kanban_web/controllers/task_controller.ex - SQL Injection
[+] lib/kanban_web/live/task_live/form.ex - XSS: Raw HTML
```

**Parsing strategy:**
1. Find lines matching `^\[\+\] (.+) - (.+)$` for file path and vulnerability type
2. Categorize by vulnerability type:
   - `SQL Injection` → Critical (data integrity risk)
   - `XSS` → Critical (user security risk)
   - `Traversal` → High (file system risk)
   - `Config` → Medium (misconfiguration)
   - `DOS` → Medium (availability risk)

**Structured output:**
```
Category: Security Warning
Severity: Critical
File: lib/kanban_web/controllers/task_controller.ex
Description: SQL Injection vulnerability detected
Suggested fix: Use parameterized queries with Ecto instead of string interpolation in SQL.
```

### 4. Credo Warnings (Priority: MEDIUM — fix after security)

**Detection:** Output contains `Checking N source files` and issues listed, or `found N issue(s)`

**Output patterns:**
```
┃ [F] → lib/kanban/tasks.ex:145:12       Modules should have a @moduledoc tag.
┃ [W] ↗ lib/kanban/tasks.ex:200          Function body is nested too deep.
┃ [R] ↗ lib/kanban/tasks.ex:250          Consider using a pipeline.
```

**Parsing strategy:**
1. Find lines matching `^\s*┃\s+\[([FWRC])\]\s+[→↗]\s+(.+):(\d+)(?::(\d+))?\s+(.+)$`
2. Extract: severity letter, file, line, optional column, message
3. Map severity: `[F]` = Error, `[W]` = Warning, `[R]` = Refactor, `[C]` = Convention
4. With `--strict`, all categories cause non-zero exit

**Severity mapping:**
- `[F]` (Error) → High — actual code errors
- `[W]` (Warning) → Medium — potential issues
- `[R]` (Refactor) → Minor — style improvement
- `[C]` (Convention) → Minor — naming convention

**Structured output:**
```
Category: Credo Warning
Severity: Medium
File: lib/kanban/tasks.ex
Line: 145
Column: 12
Check: Credo.Check.Readability.ModuleDoc
Description: Modules should have a @moduledoc tag
Suggested fix: Add @moduledoc to the module describing its purpose.
```

### 5. Format Check Failures (Priority: LOW — fix last)

**Detection:** Output contains `mix format` and `would reformat` or `** (SyntaxError)`

**Output patterns:**

**Needs formatting:**
```
** (Mix) mix format failed due to --check-formatted.
The following files are not formatted:

  * lib/kanban/tasks.ex
  * lib/kanban_web/live/task_live/index.ex
```

**Syntax error during format:**
```
** (SyntaxError) lib/kanban/tasks.ex:45:1: unexpected token: end
```

**Parsing strategy:**
1. Find `The following files are not formatted:` marker
2. Extract file paths from `  \* (.+)` lines
3. If `SyntaxError` present — this is actually a compilation issue (escalate to Critical)

**Structured output:**
```
Category: Formatting
Severity: Minor
Files: lib/kanban/tasks.ex, lib/kanban_web/live/task_live/index.ex
Description: Files need formatting
Suggested fix: Run `mix format` to auto-fix formatting.
```

### 6. Git Operation Failures (Priority: CRITICAL — fix immediately)

**Detection:** Output contains `fatal:`, `CONFLICT`, `error: Your local changes`, or `Permission denied`

**Output patterns:**

**Merge conflicts:**
```
CONFLICT (content): Merge conflict in lib/kanban/tasks.ex
Automatic merge failed; fix conflicts and then commit the result.
```

**Permission denied:**
```
git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository.
```

**Dirty working tree:**
```
error: Your local changes to the following files would be overwritten by merge:
        lib/kanban/tasks.ex
Please commit your changes or stash them before you merge.
```

**Parsing strategy:**
1. Find `CONFLICT` lines — extract file paths from `Merge conflict in (.+)`
2. Find `Permission denied` — authentication issue
3. Find `local changes would be overwritten` — uncommitted changes blocking pull
4. Find `fatal: (.+)` — general git fatal errors

**Structured output:**
```
Category: Git Failure
Severity: Critical
Files: lib/kanban/tasks.ex
Description: Merge conflict during git pull
Suggested fix: Resolve conflicts in listed files. Open each file, find <<<< markers, choose correct version, then git add and continue.
```

### 7. after_goal Hook & Goal-Forwarding Failures (Priority: HIGH — unblocks the parent goal)

`after_goal` is the fifth blocking hook (60,000 ms budget, matching `HOOK_TIMEOUTS_MS`). It fires once, after the parent goal's final child task completes, when the server bundles an `after_goal` entry in the `/complete` or `/mark_reviewed` response. It has two distinct failure modes.

**Detection is reliable, so a missed `after_goal` is rarely a truncation problem.** The hook-bridge reads the untruncated canonical response file (`<cwd>/.stride/.last-api-response.json`, which it writes itself on `before_review`/`after_review`) in preference to the truncatable `tool_result` payload, and when neither carries the entry it issues an independent hook-initiated `GET /api/tasks/:id/after_goal_status` as the guarantee. The two sources are de-duped so `after_goal` runs at most once. So an `after_goal` that "never fired" points at the hook itself (Mode A) or the PATCH forwarding / push (Mode B) — not at a truncated payload.

**Mode A — the `## after_goal` command failed.** The hook-bridge runs the section and emits the same structured result shape on stdout as the other hooks:

```json
{
  "hook": "after_goal",
  "status": "failed",
  "exit_code": 1,
  "output": "... merged stdout + stderr ...",
  "failed_command": "./scripts/notify-team.sh",
  "duration_ms": 1234
}
```

Diagnose `output` with the Failure Pattern Catalog above exactly as for any other hook (git, script, network, etc.); the failing command's own category sets the fix priority. The parent goal stays In Progress until the fix lands and the result is re-forwarded.

**Mode B — the PATCH forwarding failed, or the push never landed.** After the command runs, the agent PATCHes the captured result to `PATCH /api/tasks/:goal_id/after_goal` to flip the goal to Done. If that PATCH never lands (transport failure, non-2xx, missing `GOAL_ID`), the goal does NOT transition immediately — it falls back to the server's grace-window worker, which promotes it to Done automatically after the configured wait. Detection: an `after_goal` that succeeded locally (`exit_code: 0`) yet whose goal is still In Progress, or a PATCH error in the agent's log. **Note the grace-window worker only flips the goal to Done — it does NOT push.** So if the `## after_goal` section performs a `git push`, a Done goal is not proof the work reached the remote: verify separately with `git log origin/main..main --oneline` (a non-empty result means the push did not land, even though the goal transitioned).

**Structured output:**
```
Category: after_goal Failure
Severity: High
Hook: after_goal
Description: <Mode A: the after_goal command failed | Mode B: the /api/tasks/:goal_id/after_goal forwarding did not land>
Suggested fix:
  - Mode A: fix the failing command per its catalog category, then re-run so the result re-forwards.
  - Mode B: usually no code fix — the grace-window worker promotes the goal after its wait; investigate only if the goal stays In Progress past that window (check GOAL_ID and connectivity to the API). If `## after_goal` pushes, also confirm the push landed with `git log origin/main..main --oneline` — the grace worker does not push, so re-run the push manually if commits remain.
```

## Hook Timeout Handling

**Detection:** Duration ≥ timeout threshold AND output may be empty or truncated (the Pi hook-bridge reports timeouts with `exit_code: 124` and an output suffix `hook command timed out after <ms> ms`).

**Timeout thresholds:**
- The Pi hook-bridge (`extensions/hook-bridge/index.ts`) wraps each hook in a per-hook deadline from the `HOOK_TIMEOUTS_MS` map and kills the child with SIGTERM (then SIGKILL after a 5,000 ms grace).
- Per-hook deadlines: before_doing 60,000 ms · after_doing 300,000 ms · before_review 60,000 ms · after_review 60,000 ms · after_goal 60,000 ms. (after_doing gets the largest window because it runs the full quality-gate suite.)

**When timeout detected:**
```
Category: Hook Timeout
Severity: Critical
Description: Hook exceeded timeout (duration_ms >= threshold, or exit_code 124)
Suggested fix: Check which command is slow. Common causes:
  - Large test suite: Run specific test files instead of full suite
  - Network issues: Check connectivity for git/hex operations
  - Compilation: Full recompile needed — check for changed dependencies
  - Infinite loop: Check recent code changes for loops without termination
```

## Multi-Tool Output Parsing

Hooks often chain multiple commands (e.g., `mix test` then `mix credo --strict`). When parsing combined raw output:

1. **Identify tool boundaries** using known markers:
   - ExUnit: starts with `Running ExUnit` or `Compiling N files`, ends with `N tests, M failures`
   - Credo: starts with `Checking N source files`, ends with `found N issue(s)` or `N mods/funs`
   - Sobelow: starts with `Running Sobelow`, ends with `SCAN COMPLETE`
   - Format: contains `mix format` or `would reformat`
   - Git: starts with `From` (pull) or `CONFLICT` or `Already up to date`
2. **Split the output** at these boundaries
3. **Parse each section** using the appropriate pattern from the catalog above
4. **Merge results** into a single prioritized list

**When commands run sequentially:** the Pi hook-bridge stops at the first failure, so `output` typically contains only the failing tool's output. The Claude `&&`-chained flow behaves the same — if an early tool fails, later tools don't run.

## Fix Prioritization Scheme

Issues must be fixed in this order — later fixes often become unnecessary once earlier ones are resolved:

| Priority | Category | Rationale |
|----------|----------|-----------|
| 1 | Compilation errors | Nothing else works until code compiles |
| 2 | Git failures | Can't commit or push with conflicts |
| 3 | Test failures | Core correctness must pass |
| 4 | Security warnings (Sobelow) | Security issues block completion |
| 5 | Credo errors `[F]` | Actual code errors |
| 6 | Credo warnings `[W]` | Potential issues |
| 7 | Credo refactor/convention `[R][C]` | Style issues |
| 8 | Format failures | Auto-fixable, do last |

**Important:** After fixing Priority 1-2 issues, re-run the hook. Many Priority 3+ issues may resolve automatically (e.g., fixing a compilation error often fixes test failures).

## Structured Output Format

Produce a single structured analysis. When the input carried a command sequence (stride-hook.sh shape), include the command-sequence context.

### When input is structured JSON with a command sequence:

```
## Hook Failure Analysis

**Hook:** after_doing
**Failed command:** mix test --cover (command 2 of 4)
**Exit code:** 1

### Command Sequence
- [PASSED] mix format --check-formatted
- [FAILED] mix test --cover
- [SKIPPED] mix credo --strict
- [SKIPPED] mix sobelow --config .sobelow_config.exs

### Summary
2 issues found (1 High, 1 Minor)

### Issues (ordered by fix priority)

**1. [High] Test Failure**
- File: test/kanban/tasks_test.exs:120
- Test: create_comment/2 with valid data
- Description: Expected {:ok, %TaskComment{}} but got {:error, %Changeset{}}
- Fix: Check changeset validations — required fields may be missing from test attrs

**2. [Minor] Formatting**
- Files: lib/kanban/tasks.ex
- Fix: Run `mix format` (note: this was in a PASSED command — may have been auto-fixed)

### Fix Order
1. Fix test failure in test/kanban/tasks_test.exs:120
2. Re-run hook — all 4 commands will re-execute
```

### When input is the Pi hook-bridge shape or raw text (no command sequence):

```
## Hook Failure Analysis

**Hook:** after_doing
**Failed command:** mix test
**Exit code:** 1
**Duration:** 45,678 ms

### Summary
4 issues found (1 Critical, 2 High, 1 Minor)

### Issues (ordered by fix priority)

**1. [Critical] Compilation Error**
- File: lib/kanban/tasks.ex:45
- Description: undefined function create_task_comment/2
- Fix: Add create_task_comment/2 to the Tasks module or import it

**2. [High] Test Failure**
- File: test/kanban/tasks_test.exs:120
- Test: create_comment/2 with valid data
- Description: Expected {:ok, %TaskComment{}} but got {:error, %Changeset{}}
- Fix: Check changeset validations — required fields may be missing from test attrs

**3. [High] Test Failure**
- File: test/kanban_web/live/task_live/view_component_test.exs:85
- Test: renders comment section
- Description: Element ".comments" not found in rendered HTML
- Fix: Add comments section to the view_component template

**4. [Minor] Formatting**
- Files: lib/kanban/tasks.ex
- Fix: Run `mix format`

### Fix Order
1. Fix compilation error in lib/kanban/tasks.ex:45 (add missing function)
2. Re-run hook — test failures may resolve with compilation fix
3. If tests still fail, fix test attrs and template
4. Run `mix format` last
```

## Important constraints

- **Do NOT fix code** — only diagnose and recommend
- **Do NOT run tests or commands** — only analyze the provided output
- **Do NOT interact with the Stride API** — only parse hook results
- **Do NOT modify any files** — this skill is read-only
- **Do NOT guess at issues not visible in the output** — only report what you can see
- Be proportional: a single formatting issue needs a one-line response, not a full analysis
- Always recommend re-running the hook after fixing critical issues before addressing lower-priority ones
