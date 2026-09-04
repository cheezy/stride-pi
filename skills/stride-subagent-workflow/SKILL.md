---
name: stride-subagent-workflow
description: INTERNAL — invoked only by stride:stride-workflow. Do NOT invoke from a user prompt. Contains the Pi subagent decision matrix (when to dispatch or inline-run stride-task-enricher, stride-task-explorer, stride-task-reviewer, stride-task-decomposer, stride-hook-diagnostician), used during the orchestrator's enrichment, exploration, and review phases.
skills_version: 1.0
---

# Stride: Subagent Workflow (inline on Pi)

## STOP — orchestrator check

If you arrived here directly from a user prompt, you are in the wrong skill.
Invoke `stride:stride-workflow` instead. Do not read further.
Sub-skills are dispatched by the orchestrator only.

## THIS SKILL IS MANDATORY AFTER CLAIMING — NOT OPTIONAL

**If you just claimed a Stride task and are about to start implementation, you MUST activate this skill first.**

This skill contains the decision matrix that determines which inline skills to invoke:
- `stride-task-enricher` — Enrich a sparse task with key_files, patterns, testing_strategy, security_considerations, etc. **before claiming**
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

## Pi Dispatch Paths (dual-path)

Pi (https://github.com/badlogic/pi-mono) does not ship with a native subagent dispatch mechanism. stride-pi supports **both** paths below; use whichever is available in your Pi install.

### Preferred: `dispatch_agent` extension (Phase 2b)

If the `stride-pi-subagent-dispatch` extension is installed (see `extensions/subagent-dispatch/` in the stride-pi repo; installed automatically by `install.sh --with-extension` or manually by copying into `~/.pi/agent/extensions/`), a `dispatch_agent(agent, prompt)` tool is available. **This is the recommended path** when available — it runs each subagent in an isolated `pi -p` subprocess with its own context window, giving parallelism and isolation equivalent to Claude Code / Codex CLI / Gemini CLI subagents.

Invoke the tool directly:

```
dispatch_agent({
  agent: "stride-task-explorer",   // or stride-task-enricher / -reviewer / -decomposer / -hook-diagnostician
  prompt: "<task metadata + any instructions — include key_files, patterns_to_follow, acceptance_criteria>"
})
```

The tool returns the subagent's structured output as a string. Your main context stays clean of the raw file contents the subagent explored.

### Fallback: inline skills (Phase 2a)

If `dispatch_agent` is not available (extension not installed, older Pi version, etc.), use the inline skills in your main context:

| Role | Inline skill | When |
|---|---|---|
| Enrichment | `stride-enriching-tasks` | **Before claim**, when the task is sparse (empty `key_files` / missing `testing_strategy` / empty `verification_steps` / blank `acceptance_criteria`) |
| Exploration | `stride-task-explorer` | After claim, when the decision matrix below says Run in its column |
| Code review | `stride-task-reviewer` | After implementation, before `after_doing`, when the decision matrix below says Run in its column |
| Goal decomposition | `stride-task-decomposer` | When a claimed task is a goal or large-undecomposed |
| Hook failure triage | `stride-hook-diagnostician` | When any blocking hook fails with non-zero exit |

The work each skill does is byte-for-byte identical to the dispatched version — only the isolation differs. You perform the exploration/review/decomposition/diagnosis inline, in your main context, then proceed with the result.

### Recording results in the `/complete` payload

Whether you used `dispatch_agent` or the inline skill, you genuinely performed the work (not skipped it). Use the **dispatched shape** (`dispatched: true`) for `explorer_result` and `reviewer_result` in both cases. The skip-form (`dispatched: false` with a reason from the 5-value enum) is only for steps the decision matrix told you to skip, not for steps you performed via either path. See `stride-completing-tasks/SKILL.md` for the full schema.

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

Use this matrix to determine which inline skills to invoke based on task attributes. **This table is a MIRROR of the decision matrix in `stride-workflow` Step 3, restricted to the skill columns. It must agree with that matrix row for row, and where the two diverge, `stride-workflow` Step 3 is authoritative. Do not state an independent trigger for any column in this file; that was defect D221.**

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
| Complexity absent or unrecognised | Skip | Run | Run | Run |

*After decomposition, each resulting child task follows its own row in this matrix when claimed individually.

**This table states no precedence of its own.** When a task fits more than one row, the `Row Precedence` subsection of `stride-workflow` Step 3 is what picks the governing row — including where the bottom row belongs, which is last, and only for a task whose `complexity` is missing or is none of the three known values.

**Quick rules:**
- If the task is a **goal** or has **large complexity without child tasks** or a **25+ hour estimate**: invoke the decomposer first. The decomposer breaks it into claimable child tasks — you don't implement goals directly.
- If the task is small with 0-1 key_files, skip all inline skills and code directly.
- Otherwise, at minimum run the explorer and reviewer.

## Pre-Claim: Enrichment (Sparse Tasks)

**When:** During the orchestrator's Step 1 enrichment check, BEFORE claiming. Triggered when the task has empty `key_files` OR missing `testing_strategy` OR empty `verification_steps` OR blank `acceptance_criteria`.

**What to do (dual-path, same as the other roles):**
- **Preferred — `dispatch_agent`:** `dispatch_agent({agent: "stride-task-enricher", prompt: "<sparse task fields>"})` to run the enricher in an isolated subprocess.
- **Fallback — inline:** if `dispatch_agent` is unavailable, run the `stride-enriching-tasks` skill inline in your main context.

Provide the enricher with:
- The task's `identifier` (e.g., `W339`)
- The task's `title`, `type`, and `description` (it must NOT modify these — only read them)
- Any `priority` or `dependencies` the human specified

Either path returns a single JSON object containing the enriched fields: `key_files`, `patterns_to_follow`, `testing_strategy`, `security_considerations`, `verification_steps`, `pitfalls`, `acceptance_criteria`, `complexity`, `why`, `what`, `where_context`. The enricher does NOT call the Stride API itself.

**After enrichment:**
1. Submit the returned JSON via `PATCH /api/tasks/:id` to populate the missing fields on the existing task
2. Re-fetch the task with `GET /api/tasks/:id` to verify all required fields are populated
3. Proceed to claim the task as normal — the rest of the matrix below applies once it's claimed

**Skip enrichment when:**
- The task is already well-specified (all four trigger fields populated)
- The task type is `goal` (decompose first; the resulting child tasks may need enrichment individually)

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

**When:** The decision matrix above says `Run` in the **stride-task-explorer** column for this task's row. **Read the column; do not re-derive the condition here** (D221).

**What to do:** Invoke the `stride-task-explorer` skill, passing the task metadata.

Provide the agent with:
- The task's `key_files` array (file paths and notes)
- The task's `patterns_to_follow` text
- The task's `where_context` text
- The task's `testing_strategy` object

The explorer will return a structured summary of: each key file's current state, related test files, existing patterns found, and module APIs to reuse.

**Use the explorer's output** to inform your implementation — don't discard it. It tells you what exists, what patterns to follow, and what utilities to reuse.

## Phase 2: Planning (Conditional, Before Coding)

**When:** The decision matrix above says `Run` in the **Plan** column for this task's row. **Read the column; do not re-derive the condition here.** This line previously stated its own trigger ("medium or large, OR 3+ key_files, OR 3+ acceptance criteria lines"), which could fire on a row whose Plan column says `Skip` — the `small, 2+ key_files` row being the collision. That was defect D221.

**What to do:** Plan the implementation approach, using:
- The explorer's output from Phase 1
- The task's `acceptance_criteria`
- The task's `testing_strategy`
- The task's `pitfalls` array
- The task's `verification_steps`

Produce an ordered implementation plan. Follow this plan during implementation.

**Skip planning when** the matrix's Plan column says `Skip` for this task's row — never on a separate judgment of the task's simplicity.

## Phase 3: Code Review (After Implementation, Before Hooks)

**When:** The decision matrix above says `Run` in the **stride-task-reviewer** column for this task's row. **Read the column; do not re-derive the condition here** (D221).

**What to do:** Invoke the `stride-task-reviewer` skill, passing the git diff AND **every review field the task supplies — NO EXCEPTIONS, never a subset:** `acceptance_criteria`, `pitfalls`, `patterns_to_follow`, `testing_strategy`, `security_considerations`, `description`, `what`, and `why`. This input list is owned by the reviewer's contract — keep it in sync with the "You will receive" line in `agents/task-reviewer.md` (mirrored in the inline `stride-task-reviewer` skill) and the Code Review step in `stride-workflow`; do not maintain a shorter list here. Omitting a supplied field (most often `security_considerations`) is the D60 defect where a task's security considerations came back `not_assessed`.

The reviewer returns a human-readable prose summary followed by a fenced ```json block. The schema of that block is owned by [`stride/agents/task-reviewer.md`](https://github.com/cheezy/stride/blob/main/agents/task-reviewer.md) — do not duplicate field definitions here.

**Capture the reviewer's full response as `review_report`:** Save the reviewer's entire response (prose summary line + per-severity issue list + acceptance-criteria table + fenced ```json block) verbatim. You will include it as the `review_report` field in the completion API call (via `stride-completing-tasks`). Capture it regardless of whether the review found issues — an "Approved" report is still valuable for traceability. When the reviewer is skipped (small tasks with 0-1 key_files), submit the self-reported skip form for `reviewer_result` (see `stride-completing-tasks`) and omit `review_report` from the completion call.

**Copy the whole structured block into `reviewer_result` — never a subset.** Beyond the prose `review_report`, the reviewer's structured JSON block must be carried into `reviewer_result` by a mechanical whole-object copy, then verified by the mandatory self-check before submission. The passthrough mechanics and the self-check (every section present; `project_checks` count equals the reviewer's; no `not_assessed` for a task-supplied section) are owned by `stride-workflow` ("Extracting the structured review block") and `stride-completing-tasks` ("MANDATORY pre-submission self-check") — follow them; do not re-enumerate or sub-select keys here.

**If issues are found:**
- Fix all Critical issues before proceeding
- Fix **all** Important issues before proceeding — through round two; after it, record them per Step 5's cap, never a `category: "security"` one
- Minor issues are optional but recommended — **except a `category: "security"` one, which is never optional and never recordable at any severity; fix or escalate it per Step 5's cap**
- After fixing, **re-invoke the reviewer to verify those fixes** — review is capped at **two rounds**, the second scoped to verifying the first's fixes while still receiving the full diff. The ceiling, what the second invocation carries, the record-don't-fix disposition after it, the `critical` exemption and the never-recordable `category: "security"` rule are stated in `stride-workflow` **Step 5** — **keep the two in sync; an edit there needs the matching edit here.** No canon anchor lives in this file: the canon assigns one per rule per port directory and this port's is placed beside Step 5.

### Extracting the structured review block

After the reviewer returns, extract the first fenced ```json block from its response and use it to populate `reviewer_result` in the completion PATCH payload (constructed via `stride-completing-tasks` and submitted in the orchestrator's Step 7). The same `reviewer_result` map carries both the legacy summary fields (kept for backwards compatibility with older Kanban deploys) and the structured fields (the actual deliverable for downstream consumers — they live inside `reviewer_result`, never under a new top-level API key).

**Pi note:** Because Pi runs `stride-task-reviewer` inline rather than as an isolated subagent, the reviewer's response IS your current context. The same first-```json-fence extraction applies: parse the JSON block you just emitted and lift its fields into `reviewer_result`.

**Extraction pattern** — extract the first ```json fence and parse it:

```python
import re, json
m = re.search(r'```json\n(.*?)\n```', reviewer_response, re.DOTALL)
structured = json.loads(m.group(1))  # the parsed schema
```

**Field mapping into `reviewer_result`:**

- Legacy fields (always populated):
  - `summary` ← `structured.summary`
  - `issues_found` ← `sum(structured.issue_counts.values())` (sum only the recognized severity keys you receive; pass through any unknown severity keys verbatim inside the structured `issue_counts` object)
  - `acceptance_criteria_checked` ← `len(structured.acceptance_criteria)`
  - `dispatched: true`, `duration_ms: <wall-clock ms>` (as before)
- Structured fields — **copy the reviewer's entire parsed JSON object verbatim** into `reviewer_result`, then overlay the legacy fields above on top. Do **not** maintain an allow-list of which structured keys to copy: whatever the agent emitted is persisted as-is, so any field the schema gains later flows through automatically. The structured key-set is owned by `agents/task-reviewer.md` (mirrored by the inline `stride-task-reviewer` skill and the dispatched ext-agent); passthrough it, never re-enumerate it here. Concretely, the reviewer currently emits `status`, `issue_counts`, `issues`, `acceptance_criteria`, `project_checks`, `testing_strategy`, `patterns`, `pitfalls`, `security_considerations`, and `schema_version` — but treat that as illustrative, not exhaustive. Because you copy the parsed JSON verbatim, keys the agent did not emit are simply absent (no empty placeholders to send).

**Worked example.** Given the reviewer response below (truncated for brevity)…

````text
Approved
...prose summary + issue list + acceptance-criteria table...

```json
{
  "schema_version": "1.4",
  "summary": "Reviewed 3 acceptance criteria and 4 pitfalls against the diff; no issues found and all criteria met.",
  "status": "approved",
  "issue_counts": {"critical": 0, "important": 0, "minor": 0},
  "issues": [],
  "acceptance_criteria": [
    {"criterion": "All task positions recalculate when a card moves columns", "status": "met", "evidence": "lib/kanban/tasks.ex:142-168"},
    {"criterion": "Existing position-stable behavior unchanged", "status": "met", "evidence": "test/kanban/tasks_test.exs:198-240"},
    {"criterion": "PubSub broadcast emitted exactly once per move", "status": "met", "evidence": "lib/kanban/tasks.ex:172"}
  ],
  "project_checks": [],
  "testing_strategy": {"status": "passed", "note": "Move + broadcast paths covered by tests."},
  "patterns": {"status": "passed", "note": "Mirrors the existing reorder pattern."},
  "pitfalls": {"status": "passed", "note": "None of the 4 listed pitfalls violated."},
  "security_considerations": {"status": "passed", "note": "Move query scoped to the current user's board; no new input or injection surface."}
}
```
````

…the resulting `reviewer_result` value in the completion PATCH payload is:

```json
"reviewer_result": {
  "dispatched": true,
  "duration_ms": 29560,
  "summary": "Reviewed 3 acceptance criteria and 4 pitfalls against the diff; no issues found and all criteria met.",
  "issues_found": 0,
  "acceptance_criteria_checked": 3,
  "schema_version": "1.4",
  "status": "approved",
  "issue_counts": {"critical": 0, "important": 0, "minor": 0},
  "issues": [],
  "acceptance_criteria": [
    {"criterion": "All task positions recalculate when a card moves columns", "status": "met", "evidence": "lib/kanban/tasks.ex:142-168"},
    {"criterion": "Existing position-stable behavior unchanged", "status": "met", "evidence": "test/kanban/tasks_test.exs:198-240"},
    {"criterion": "PubSub broadcast emitted exactly once per move", "status": "met", "evidence": "lib/kanban/tasks.ex:172"}
  ],
  "project_checks": [],
  "testing_strategy": {"status": "passed", "note": "Move + broadcast paths covered by tests."},
  "patterns": {"status": "passed", "note": "Mirrors the existing reorder pattern."},
  "pitfalls": {"status": "passed", "note": "None of the 4 listed pitfalls violated."},
  "security_considerations": {"status": "passed", "note": "Move query scoped to the current user's board; no new input or injection surface."}
}
```

Legacy + structured fields coexist in the same map; the server persists `reviewer_result` as `:jsonb` and tolerates the structured keys today (G143/W688 will validate them explicitly).

**Fallback when JSON parsing fails.** If no ```json block is present, or the block does not parse, do not abort the completion. Instead:

1. Fall back to substring-matching the prose summary line ("Approved" or "N issues found (X critical, Y important, Z minor)") to populate `reviewer_result.summary` and `reviewer_result.issues_found` as before this rollout.
2. Set `acceptance_criteria_checked` from the count of criterion lines you find in the prose acceptance-criteria table, or to `0` if none can be parsed.
3. **Omit** every structured field (`status`, `issue_counts`, `issues`, `acceptance_criteria`, `project_checks`, `testing_strategy`, `patterns`, `pitfalls`, `security_considerations`, `schema_version`) from the PATCH payload — do not send empty placeholders. The Kanban server tolerates their absence (the new ReviewReportPanel renders only what it receives).
4. Keep `dispatched: true` and `duration_ms` as captured. The fallback path produces a degraded-but-valid completion, never a hard failure.

A response that reached this fallback produced no parsed block, so it **was no round** — Step 5's two-round cap is **inapplicable to it rather than satisfied by it**. **Re-invoke once; the failed attempt consumes nothing.** If the re-invocation also fails to parse, stop re-invoking and follow items 1-4 above — the degraded-but-valid completion is the disposition, and this paragraph does not displace it. The cap itself still does not bound a reviewer that repeatedly lands here; the one-retry bound above is what does. Because item 3 omits `issues`, `status`, `issue_counts` and `security_considerations` by construction, the record-don't-fix disposition has no input here either — **carry the last parsed round's findings into `completion_notes` and one line of `completion_summary` before submitting the degraded payload**, by severity, category and `file:line` only. **And the same two exclusions bind here.** An unfixed **`critical`** at any round number, and any unfixed **`category: "security"`** entry at any severity, are **never carried across and never shipped in a degraded payload**: on either, take `stride-workflow` Step 5's stop-and-report exit instead of submitting. This paragraph and its twin in `stride-workflow` are intentionally identical in substance — **keep the two in sync; an edit here needs the matching edit there.**

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
                    +--> Matrix says Run in the stride-task-explorer column?
                            |
                            v
                        Invoke stride-task-explorer skill
                            |
                            v
                        Matrix says Run in the Plan column?
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
| "This small task has 3 key_files" | The matrix's `small, 2+ key_files` row says Run for the explorer | Missing context causes merge conflicts |

## Quick Reference Card

```
INLINE SKILLS WORKFLOW:
|- 0. Task claimed successfully
|- 1. Is it a goal OR large+undecomposed OR 25+ hours?
|     |- YES -> Invoke stride-task-decomposer skill
|     |- Create child tasks via API
|     |- Claim first child task (re-enter workflow)
|- 2. Check decision matrix (complexity + key_files count)
|- 3. If the matrix says Run in the stride-task-explorer column:
|     |- Invoke stride-task-explorer skill with task metadata
|     |- Read and use the explorer's output
|- 4. If the matrix says Run in the Plan column:
|     |- Plan implementation approach using explorer output + task metadata
|     |- Follow the resulting plan
|- 5. Implement the task
|- 6. If the matrix says Run in the stride-task-reviewer column:
|     |- Invoke stride-task-reviewer skill with diff + task metadata
|     |- Fix any Critical/Important issues found
|- 7. Proceed to after_doing hook (stride-completing-tasks)

INLINE SKILLS (defined in skills/ directory):
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
