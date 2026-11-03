# stride-pi Completion Rationale

The completion skill loads on every task that reaches Step 7, so background prose in `skills/stride-completing-tasks/SKILL.md` is paid for each time a task closes. This page keeps that background: the failures a part of the skill answers, and the figures it once quoted. Each section names the part of the skill it came from. Where that passage still has a place in the skill, a one-line pointer there leads back here; the last section records text that was deleted outright and has no pointer.

**This page sets no rules.** The field reference, both result shapes, the skip-reason enum, the checklist, the self-check and its exit all stay in the skill, and where the two read differently the skill is the one to follow. The page lives only in the repository: `install.sh` installs each skill's `SKILL.md` and leaves `docs/` behind, so an agent completing a task never has it to read.

## Fields Found One Rejection at a Time

*Taken from `skills/stride-completing-tasks/SKILL.md`, THIS SKILL IS MANDATORY.*

An agent that tried to complete a task from memory, without this skill open, typically spent three or more calls before one went through. Each refusal named one more missing field, the agent supplied that field alone, and the next call failed on the field after it. Listing every required field at the top of the skill is meant to get the body right on the first call.

## What Completing Before the Hooks Breaks

*Taken from `skills/stride-completing-tasks/SKILL.md`, The Critical Mistake.*

A task completed before both hooks have run looks done while nothing has checked it. A failing test that `after_doing` would have caught stays hidden, the preparation `before_review` performs never happens, and broken code can reach `main` with the board saying the work is finished. The server also refuses a request that is missing either hook result.

## Why the Checklist Exists

*Taken from `skills/stride-completing-tasks/SKILL.md`, the Verification Checklist.*

Under pressure to finish, agents dropped exploration and review more often than any other step. Leaving them out never made a task quicker in the end: the work came back weaker and took longer to put right than the skipped steps would have taken.

## The Server Contract Behind the Self-Check

*Taken from `skills/stride-completing-tasks/SKILL.md`, the Verification Checklist's `reviewer_result` item and the closing paragraph of the pre-submission self-check.*

A `reviewer_result` whose `project_checks` had been dropped or shortened left the Review queue's Code review panel blank, with nothing to show that anything had gone missing. The Kanban server now refuses that report, and refuses one that fails any of the other self-check items, so a self-check that would fail is a completion that would fail. Running the self-check before the request finds the problem while it costs nothing.

## The Excuses Table

*Taken from `skills/stride-completing-tasks/SKILL.md`, Rationalization Table.*

The skill once answered five reasons for skipping or postponing the hooks:

- "Tests probably pass": the table credited `after_doing` with catching 40% of issues, at the cost of a task marked done with failing tests.
- "I can fix later": by then the task is complete, so a fix means reopening it and another review cycle.
- "Just this once": the answer given was that it turns into a habit and the standard wears away.
- "before_review can wait": the API needs both hook results and turns the request away without them.
- "Hooks take too long": two or three minutes of hooks set against two or more hours of rework.

The percentages and hours came with the table. Nothing in this repository measured them, and they are kept here as they were written.

## Before and After Figures

*Taken from `skills/stride-completing-tasks/SKILL.md`, Real-World Impact.*

The skill also quoted a comparison. Completing without the hooks: 40% of completions with failing tests, 2.3 hours on average to fix them afterwards, and 65% reopened for rework. Running the hooks first: 2% with issues, 15 minutes to fix before completion, and 5% reworked, summed up as more than two hours saved per task. Like the table above, these numbers are recorded as written, not as measurements made here.

## Restatements Removed

*Taken from `skills/stride-completing-tasks/SKILL.md`, Overview, When to Use, Completion Workflow Flowchart, Review vs Auto-Approval Decision, Common Mistakes, Implementation Workflow and Quick Reference Card, and the AUTOMATION NOTICE's closing "Following every step" line.*

These sections said again what the Iron Law, The Complete Completion Process and the field reference already say, so they were dropped rather than moved. Two had drifted from the rest of the skill. The auto-approval steps called `after_review` blocking, which it never is under `hook-bridge`. The Quick Reference Card showed hook results with real output and durations, where the skill asks for the placeholder shape. Common Mistakes also carried one point said nowhere else, that an `after_doing` veto is never answered with a made-up passing result, and step 4 of the completion process now says it.
