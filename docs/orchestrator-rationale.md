# stride-pi Orchestrator Rationale

Each time the orchestrator runs, Pi reads all of `skills/stride-workflow/SKILL.md`, so every paragraph of background in it costs tokens on every task. This page holds that background instead: reasons behind parts of the workflow, and history the skill once carried inline. Every section says which part of the skill it was lifted from, and a short pointer left there leads back here.

**This page sets no rules.** If it and the skill ever disagree, follow the skill; no step asks you to open this page. It exists only in the repository: `install.sh` copies each skill's `SKILL.md` and nothing under `docs/`, so an installed agent never sees it, which is why every instruction an agent must follow stays in the skill.

## The Session Behind a Single Orchestrator

*Taken from `skills/stride-workflow/SKILL.md`, Purpose.*

Over one 17-task session, an agent kept skipping steps that every skill labelled MANDATORY. The cause was how many separate skills it had to remember to activate, each at its own moment; under pressure to deliver, it dropped whichever felt optional. One orchestrator that holds every step in sequence takes that choice away.

## Branch C's Former Plan Trigger

*Taken from `skills/stride-workflow/SKILL.md`, Step 3, Branch C, item 2.*

This item previously stated its own trigger ("medium+ OR 3+ key_files OR 3+ acceptance criteria lines"), which could fire on a row whose `Plan` column says Skip — the `small, 2+ key_files` row being the collision.

## Step 5's Former Review Trigger

*Taken from `skills/stride-workflow/SKILL.md`, Step 5.*

This line previously restated its own trigger ("medium+ OR 2+ key_files"), which disagreed with the matrix for a `small` defect with 1 `key_file` — the same defect class, in the Review column instead of the Plan column.

## What a Trimmed Review Prompt Loses

*Taken from `skills/stride-workflow/SKILL.md`, Step 5, the reviewer invocation.*

Omitting a supplied field (most often `security_considerations`) is the exact defect this prevents: a section the reviewer is never handed comes back `not_assessed` even though the task specified it.

## How This Port Sorts Its Own Markdown

*Taken from `skills/stride-workflow/SKILL.md`, Step 5, the code-path buckets.*

A `SKILL.md` or agent-definition edit changes how this port behaves, yet it sorts as documentation. That limit is disclosed rather than patched, because a rule keyed on paths is one you can apply without judgement — and triggers two and three still fire on a skill fix.

`.stride.md` goes the other way. stride's own path list files it as documentation; being stricter here can only cost a round two, never a third.

## Why Stopping Here Records No Status

*Taken from `skills/stride-workflow/SKILL.md`, Step 5, what "stop without completing" and "escalate" mean here.*

stride records a `review_blocked` status with a `failure.kind`; this port has no such vocabulary, and porting the clause without a mechanism would leave you holding an instruction you cannot execute.

## What the Cosmetic Rule Spells Out

*Taken from `skills/stride-workflow/SKILL.md`, Step 5, the all-cosmetic rule.*

A conforming reviewer cannot produce that pair (an unmet criterion or check owes a paired `issues[]` entry, which defaults to `important` and so cannot be cosmetic), but the wording invites the mistake, so it is stated rather than left to inference.

`cosmetic` is a key of the **canonical** reviewer schema mirrored here, not one this port invented, so the prohibition on inventing a structured round field above is untouched by it.

## Why the Parse Fallback Repeats Its Carve-outs

*Taken from `skills/stride-workflow/SKILL.md`, Extracting the structured review block, the JSON-parse fallback.*

That precedence is stated because the two would otherwise both read as mandatory. This paragraph is the one recording site that ends in an instruction to submit, which is exactly why the carve-outs are repeated in it rather than left to the bullets above.

## How the Hook Bridge Finds after_goal

*Taken from `skills/stride-workflow/SKILL.md`, Step 8, after_goal.*

**How the extension detects `after_goal` reliably (canonical file + fresh GET).** The `/complete` (and `/mark_reviewed`) response can be large — the echoed `reviewer_result` alone runs to tens of KB — and Pi can truncate the `tool_result` payload the extension inspects, dropping the `after_goal` entry. The hook-bridge therefore does **not** depend on that payload being intact:

1. **Canonical file (fast path).** On `before_review` / `after_review` the extension captures the intercepted output to `<cwd>/.stride/.last-api-response.json` when it is complete valid JSON, and the `after_goal` detector reads that untruncated file **first**, falling back to the tool-output candidates. Unlike the sibling Claude Code plugin, the agent does **not** pipe the curl through `| tee` — the extension writes the canonical file itself.
2. **Fresh GET (guarantee).** When neither the file nor the intercepted output carries the entry, the extension issues an independent, hook-initiated `GET /api/tasks/:id/after_goal_status` — keyed off the just-completed task id, immune to truncation, needing no agent cooperation — and runs `## after_goal` from that server-truth result.

The sources are de-duplicated: `after_goal` runs **at most once**. A disarmed or unreachable status is a clean no-op, so a flaky check never blocks completion.

## Goals Closed by the Grace-Window Worker

*Taken from `skills/stride-workflow/SKILL.md`, Step 8, Back-compat.*

Step 8 used to close with a back-compat list. It said that when `.stride.md` has no `## after_goal` section, the server's grace-window worker moves the goal to Done with a synthetic attempt tagged `source: "after_goal_grace_worker"`, and that an older agent runtime that does not speak the after_goal protocol is covered the same way. Step 8 keeps the instruction an agent acts on: with the section missing, skip the manual steps.

## The W2130 Wall-Clock Measurements

*Taken from `skills/stride-workflow/SKILL.md`, Workflow Telemetry, dispatch_count limit (1).*

Across the eight real dispatches measured when the key was introduced (W2130), tokens per second varied about **2.1×** by dispatch kind — reviewer rounds around 300–375 tok/s, the sample's other dispatch kind around 455–625 tok/s. The figure tracks a task's review *mix*, not its size. On the two real records available then, the pair ranked one task 20.3% more expensive when its token cost was in fact 1.4% *cheaper*: the order inverted, and the recorded gap was some fifteen times the real one.

## Where stride's Reviewer Figure Differs

*Taken from `skills/stride-workflow/SKILL.md`, Workflow Telemetry, dispatch_count limit (2).*

In stride the `reviewer` entry's `duration_ms` is an aggregate: other review-phase steps fold their wall-clock into it, so dividing by the count mixes populations. Nothing folds in on this port, which removes that hazard and leaves the smaller one limit (2) still states.

## How the Server Treats dispatch_count

*Taken from `skills/stride-workflow/SKILL.md`, Workflow Telemetry, dispatch_count limit (6).*

This port *does* have an executable self-check, so the absence is not for want of a mechanism. Server-side, `valid_step?/1` checks `name`, `dispatched`, `duration_ms` and `reason`, with the `reason_code` enum validated separately, and does not check this key. Unlike `reason_code`, which is refused when unrecognised, `dispatch_count` is accepted whatever its type, stored in the array and returned verbatim. Nothing reads it yet, so today's cost is a corrupt record rather than anything worse.

## Why No Token Count Is Recorded

*Taken from `skills/stride-workflow/SKILL.md`, Workflow Telemetry, after the dispatch_count limits.*

**Why not simply record tokens.** The obvious answer to (1) is a token count, the one figure observed to rank correctly. The task that introduced these keys declined it — record what is actually measurable — and that stands. Be exact about the reason, though, because the usual one is wrong: some runtimes **do** measure a per-dispatch token cost, so recording it would not be inventing it. The unsettled question is **portability**, whether every runtime this schema serves can produce one. Until that is answered, this pair is what exists, read within the limits above.

## The Completion-Validation Rollout

*Taken from `skills/stride-workflow/SKILL.md`, Explorer and Reviewer Result Rollout.*

The server is rolling out hard enforcement behind a feature flag `:strict_completion_validation`:

| Phase | Server behavior | Agent impact |
|---|---|---|
| **Grace (current)** | Missing or invalid results log a structured warning and the request succeeds | Emit the fields correctly now; the warning volume is a preview of the strict-mode rejection volume |
| **Strict (after all 5 plugins release)** | Missing or invalid results return `422` with a `failures` list | Any agent not emitting valid fields is locked out of completion |

## The Failure Modes Behind This Skill

*Taken from `skills/stride-workflow/SKILL.md`, Failure Modes This Skill Prevents.*

| Failure Mode | Old Pattern | This Skill |
|---|---|---|
| Forgot to explore | Agent skipped stride-subagent-workflow | Step 3 is inline -- can't be missed |
| Forgot to review | Agent jumped to completion | Step 5 is inline -- can't be missed |
| Wrong API fields | Agent guessed from memory | Step 7 has the exact format |
| Skipped hooks | Agent called complete directly | Step 6 blocks Step 7 |
| Asked user permission | Agent prompted between steps | Automation notice says don't |
| Speed over process | Agent optimized for throughput | Every step is framed as mandatory |
