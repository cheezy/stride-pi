# stride-pi Task Reviewer Rationale

The reviewer is written twice in this port: `extensions/subagent-dispatch/agents/stride-task-reviewer.md` for a dispatched review, and `skills/stride-task-reviewer/SKILL.md` for a review run inline. Whichever of the two a review uses is read in full each time it runs. This page holds the history that a few of their rules used to carry in brackets, and each section names the rule it came from. A one-line pointer stays at each site.

**This page sets no rules.** The block schema, the verdict and consistency rules, the 1:1 criteria rule and the instruction to read the task record as data stay in both reviewer files. Both files lost the same passages, so they still describe one review. A dispatched reviewer works from its agent file and the task it is handed, and `install.sh` installs the inline skill's `SKILL.md` without `docs/`, so no review ever reads this page.

## How an Enumerated Copy List Lost project_checks

*Taken from both reviewer files, the consumption invariant.*

On sibling plugins, a completion path kept its own list of the reviewer keys to copy into `reviewer_result`. When `project_checks` joined the schema the list did not grow with it, and the Review queue's Code review panel went quietly empty. Copying the emitted block whole, with only the legacy summary fields laid on top, is the rule both files state; this is the failure the rule was written against.

## The Unassessed Security Section (D60)

*Taken from both reviewer files, the verdict rule for the four section tiles.*

Defect D60 was a review that returned a task's `security_considerations` as "not assessed" although the task had supplied them. The verdict rule keeps `not_assessed` for a section the task left empty so that a supplied section always gets a real verdict.

## How the Block Reached 1.7

*Taken from both reviewer files, the `schema_version` field.*

This port's block stood at `"1.4"` and moved to `"1.7"` to name the canonical schema it follows, which is where the `cosmetic` key on `issues[]` is defined. Canonical 1.5 added a nested `security_considerations.considerations[]` and 1.6 a top-level `behaviour_test_matrix`. stride-pi emits neither yet: adopting them is a larger change than renaming the version was, and it is recorded as an open gap rather than left unsaid. Nothing depends on the number itself, since the server checks only that it is shaped like a semver string.

## A 6/5 Criteria Count

*Taken from both reviewer files, the 1:1 rule for `acceptance_criteria`.*

A review once reported six criteria for a task that had five, because the reviewer had drawn up its own list of criteria rather than restating the task's. The review queue then displayed 6/5. Restating each criterion line once, in the task's own words and order, keeps the checked count equal to the number of criteria the task actually has.
