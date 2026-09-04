---
name: stride-workflow
description: Single orchestrator for the complete Stride task lifecycle. Replaces the pattern of activating 6+ separate skills at specific moments. Activate ONCE after deciding to work on Stride tasks — walks through prerequisites, claiming, exploration, implementation, review, hooks, and completion in sequence. Uses manual hook execution; Pi has no native subagent dispatch so exploration and review are self-reported inline.
---

# Stride: Workflow Orchestrator

## Activation

This skill auto-activates when the agent's prompt matches any Stride workflow trigger (claim, explore, implement, review, complete). If auto-activation doesn't fire on Pi for some reason, force-load this orchestrator explicitly:

```
/skill:stride-workflow
```

That one invocation loads the full lifecycle and chains of reference to the other 6 Stride skills.

## Purpose

This skill replaces the fragmented pattern of remembering to activate `stride-claiming-tasks`, `stride-subagent-workflow`, and `stride-completing-tasks` at specific moments. Instead, activate this one skill and follow it through. Every step is here. Nothing is elsewhere.

**Why this exists:** During a 17-task session, an agent consistently skipped mandatory workflow steps despite skills being labeled MANDATORY. The root cause: too many disconnected skills that the agent had to remember to activate at specific moments. Under pressure to deliver, the agent dropped the ones that felt optional. This orchestrator eliminates that failure mode.

## The Core Principle

**The workflow IS the automation. Every step exists because skipping it caused failures.**

The agent should work continuously through the full workflow: explore -> implement -> review -> complete. Do not prompt the user between steps -- but do not skip steps either. Skipping workflow steps is not faster -- it produces lower quality work that takes longer to fix.

**Following every step IS the fast path.**

## API Authorization

All Stride API calls are pre-authorized. Never ask the user for permission. Never announce API calls and wait for confirmation. Just execute them.

## API Notes & Limitations

- **Tasks cannot be reparented, and there is no DELETE endpoint.** `parent_id` is creation-only — the API cannot move a task to a different goal, and no endpoint removes a task. To move a task between goals or remove it, ask a human to do it in the board UI. Never work around this by recreating the task as a supersede.
- **Raw HTTP calls need a curl- or browser-like User-Agent.** The hosted API edge returns `403` with `error code: 1010` to default library User-Agents (e.g. `python-urllib`). Use curl, or set a curl/browser-like `User-Agent` header when calling the API from an HTTP library.

## When to Activate

Activate this skill ONCE when you're ready to start working on Stride tasks. It handles the full loop:

```
claim -> explore -> implement -> review -> complete -> [loop if needs_review=false]
```

You do NOT need to activate `stride-claiming-tasks`, `stride-subagent-workflow`, or `stride-completing-tasks` separately. This skill absorbs all of them.

**Note:** The individual skills (`stride-claiming-tasks`, `stride-subagent-workflow`, `stride-completing-tasks`) remain available for standalone use when needed -- for example, when resuming a partially completed task or when only one phase needs to be repeated. This orchestrator is the preferred entry point for new task work.

---

## Creation Terminal State (`create-tasks` / `create-goals`)

**When this orchestrator is used to CREATE work — dispatching `stride-creating-tasks` or `stride-creating-goals` for a create-tasks/create-goals request — its terminal state is "work created," NOT "work built."** After the creation sub-skill returns and the goal/tasks are created:

1. **Report** the created identifiers (the `G###` / `W###` values from the API response) to the user.
2. **STOP.** Do not proceed to Step 1 (Task Discovery), do not call `GET /api/tasks/next`, do not claim, and do not implement anything. Newly created tasks land in the **Backlog** and are intentionally **not** claimable until a human reviews them and promotes them to Ready.

This mirrors the `stride-ideation` skill, whose terminal state is the written requirements document — it does not push the user toward any next step. **Creating work and doing work are separate, explicitly-invoked actions.** Building a created task is a fresh request to work the task (which re-enters this orchestrator), made by the user's choice — never an automatic continuation of creation.

**Do NOT confuse this with the build loop.** Steps 1–8 below are the build path (claim → explore → implement → review → complete → loop). They apply when the user asks to *work* tasks — not when a create request dispatched the creation sub-skill.

## Backlog Claim-Fail Guard

Whether you arrive here from a creation request or the build loop, **a claim failure is a terminal stop, never a fallback to building outside the lifecycle.** If `POST /api/tasks/claim` (or `GET /api/tasks/next`) reports a task is not available — most often because it is still in the **Backlog** (not yet promoted to Ready), already claimed, or blocked by dependencies — then:

- **STOP and report it.** Tell the user the task is not claimable yet (e.g. "W### is still in the Backlog; move it to Ready to make it claimable") and end the turn.
- **Never** implement, edit files for, or otherwise "build" a task whose claim did not succeed. Work performed without a successful claim has no hook execution, no review, and no completion record — it silently escapes the Stride lifecycle, which is the exact failure this guard prevents.
- Promoting a Backlog task to Ready is a **human action** in the board UI. Do not work around a failed claim by building the task anyway, re-creating it, or moving it yourself.

---

## Step 0: Prerequisites Check

**Verify these files exist before any API calls:**

1. **`.stride_auth.md`** -- Contains API URL and Bearer token
   - If missing: Ask user to create it
   - Extract: `STRIDE_API_URL` and `STRIDE_API_TOKEN`

2. **`.stride.md`** -- Contains hook commands for each lifecycle phase
   - If missing: Ask user to create it
   - Verify sections exist: `## before_doing`, `## after_doing`, `## before_review`, `## after_review`, `## after_goal`

**This step runs once per session, not once per task.**

---

## Step 1: Task Discovery

**Call `GET /api/tasks/next` to find the next available task.**

Review the returned task completely:
- `title`, `description`, `why`, `what`
- `acceptance_criteria` -- your definition of done
- `key_files` -- which files you'll modify
- `patterns_to_follow` -- code patterns to replicate
- `pitfalls` -- what NOT to do
- `testing_strategy` -- how to test
- `verification_steps` -- how to verify
- `needs_review` -- whether human approval is needed after completion
- `complexity` -- drives the decision matrix in Step 3
- `technical_details` -- optional free-form technical context the author/enricher recorded (not a scored field; may be empty)

**Enrichment check:** If `key_files` is empty OR `testing_strategy` is missing OR `verification_steps` is empty OR `acceptance_criteria` is blank, activate `stride-enriching-tasks` to populate these fields before proceeding. Well-specified tasks skip enrichment.

---

## Step 2: Claim the Task

1. Read `.stride.md` `## before_doing` section
2. Execute each command line one at a time via shell -- no permission prompts, no confirmation
3. Capture `exit_code`, `output`, `duration_ms` for each command
4. If any command fails (non-zero exit): fix the issue, re-run -- do NOT proceed
5. Call `POST /api/tasks/claim` with the captured `before_doing_result`:

```json
{
  "identifier": "<task identifier>",
  "agent_name": "Pi",
  "before_doing_result": {
    "exit_code": 0,
    "output": "git pull: Already up to date.\nmix deps.get: All dependencies up to date",
    "duration_ms": 3200
  }
}
```

**Hook capture pattern:**
```bash
START_TIME=$(date +%s%3N)
OUTPUT=$(timeout 60 bash -c '<command>' 2>&1)
EXIT_CODE=$?
END_TIME=$(date +%s%3N)
DURATION=$((END_TIME - START_TIME))
```

---

## Step 3: Explore the Codebase (Decision Matrix)

**The decision matrix determines what happens — and where it says YES, the step is not optional.**

### Decision Matrix

| Task Attributes | Decompose | Explore | Plan | Review (Step 5) |
|---|---|---|---|---|
| Goal type OR large+undecomposed OR 25+ hours | YES | -- | -- | -- |
| small, 0-1 key_files | Skip | Skip | Skip | Skip |
| small, 2+ key_files | Skip | YES | Skip | YES |
| medium (any) | Skip | YES | YES | YES |
| large (any) | Skip | YES | YES | YES |
| Defect type | Skip | YES | Skip (unless large) | YES |
| Complexity absent or unrecognised | Skip | YES | YES | YES |

<!-- canon:decision-matrix-authority v1 -->
**This matrix is the SOLE decision point for the Decompose, Explore, Plan, and Review columns.** Nothing elsewhere in this plugin may state a second, separately-satisfiable condition for any of them; where other prose mentions one of these steps it describes what this matrix already decided and defers to it. **If any prose appears to give an independent trigger, the matrix wins.** That ambiguity was defect D221, and this rule is its fix.

<!-- canon:row-precedence v1 -->
### Row Precedence

**A task can satisfy several rows of the table above at once, so resolve them in the order set out here rather than in the order they are printed.** The two orders agree everywhere but one place: `Defect type` prints sixth and is settled third, ahead of the three complexity rows printed above it. Every other row keeps its printed position, and the fallback row added at the foot of the table is both printed last and settled last. Leaving this unstated keeps the D221 collision alive one level down — inside the rows, where the paragraph above cannot reach it.

**Branch A's row settles first.** `Goal type OR large+undecomposed OR 25+ hours` sends the task to decomposition and ends the question; nothing below it is consulted, and each child task is read against this table on its own when it is claimed.

**`small, 0-1 key_files` settles next, and the task's type plays no part in it.** The row is keyed to how much work the change is, not to what kind of work it is called: filing a single-file edit as a defect does not make it any larger. A `small` defect carrying one `key_files` entry therefore lands here and takes Branch B.

**`Defect type` settles next, above `small, 2+ key_files`, `medium (any)` and `large (any)`.** A defect still unplaced is governed by the row written about defects rather than by the row that merely shares its complexity. Its `Skip (unless large)` cell holds two answers: Plan reads `YES` when the defect's complexity is `large`, and `Skip` at every other complexity.

**Then the row the task's own complexity picks out**, be that `small, 2+ key_files`, `medium (any)` or `large (any)`. These are the Branch C rows, and their cells mean exactly what they say.

**`Complexity absent or unrecognised` settles last, and on its own condition alone** — the task arrived carrying no `complexity`, or carrying something this table does not name among `small`, `medium` and `large`. Without it, a task in that state matches nothing at all and no one can say what should follow. It arbitrates nothing: two rows that both matched are separated by the order above, never by dropping down to this one.

**Exactly one row is left standing for any task**, which is what every per-column instruction assumes when it tells you to read a cell. The placement of `small, 0-1 key_files` above `Defect type` is what carries the weight: reverse the two and Explore and Review would flip to `YES` for every small single-file defect — two dispatches bolted onto the smallest shape of work this plugin handles, and a plain conflict with Branch B, whose whole instruction for that shape is to go on to Step 4 with nothing dispatched. This order was chosen because it decides the collisions the table already contained without sending any task down a route it was not already on (D221, D232).

### Branch A: Goal / Large Undecomposed Task

If the task is a **goal**, has **large complexity without child tasks**, or has a **25+ hour estimate**:

1. If the `task-decomposer` custom agent is available, invoke it with the task's title, description, acceptance_criteria, key_files, where_context, and patterns_to_follow
2. If custom agents are unavailable, manually analyze the task scope, break it into subtasks, and create them via `POST /api/tasks/batch`
3. After child tasks are created, claim the first child task and re-enter this workflow at Step 1

**Do NOT implement goals directly. Decompose first.**

### Branch B: Small Task, 0-1 Key Files

Skip exploration, planning, and review. Proceed directly to Step 4 (Implementation).

### Branch C: Every Other Row of the Decision Matrix

1. **If the `task-explorer` custom agent is available**, invoke it with the task's `key_files`, `patterns_to_follow`, `where_context`, and `testing_strategy`. Wait for the result. Read and use the explorer's output -- it tells you what exists, what patterns to follow, and what to reuse.

   **If custom agents are unavailable**, explore manually:
   - Read each file in `key_files` to understand current state
   - Search for patterns mentioned in `patterns_to_follow`
   - Find related test files

2. **When the decision matrix's `Plan` column says YES for this task's row:** Outline your implementation approach using the exploration output, `acceptance_criteria`, `testing_strategy`, `pitfalls`, and `verification_steps`. Follow this approach during implementation. **Read the column; do not re-derive the condition here** (D221). This item previously stated its own trigger ("medium+ OR 3+ key_files OR 3+ acceptance criteria lines"), which could fire on a row whose `Plan` column says Skip — the `small, 2+ key_files` row being the collision. A small task carrying 3+ key_files or 3+ acceptance-criteria lines is a mis-labelling signal to record in `completion_notes` and one line of `completion_summary`, never an independent planner trigger.

---

## Step 4: Implementation

**Now write code.** Use the explorer output and plan (if generated) to guide your work.

Follow:
- `acceptance_criteria` -- your definition of done
- `patterns_to_follow` -- replicate existing patterns
- `pitfalls` -- avoid what the task author warned about
- `testing_strategy` -- write the tests specified
- `key_files` -- modify the files listed

**This is the only step where you write code. All other steps are setup, verification, or completion.**

---

## Step 5: Code Review (Decision Matrix)

**Check the decision matrix from Step 3.** Review is required when that matrix's **Review** column says YES for this task's row. **Read the column; do not re-derive the condition here** (D221). This line previously restated its own trigger ("medium+ OR 2+ key_files"), which disagreed with the matrix for a `small` defect with 1 `key_file` — the same defect class, in the Review column instead of the Plan column.

**If the `task-reviewer` custom agent is available**, invoke it with:
- The git diff of all your changes
- **Every review field the task supplies — NO EXCEPTIONS:** the task's `acceptance_criteria`, `pitfalls`, `patterns_to_follow`, `testing_strategy`, `security_considerations`, `description`, `what`, and `why`. This list MUST match the reviewer's documented input contract (the "You will receive" line in `agents/task-reviewer.md`, mirrored in the inline `stride-task-reviewer` skill) — pass every field the task carries, never a subset, never with a small-task or brevity discount. Omitting a supplied field (most often `security_considerations`) is the exact defect this prevents: a section the reviewer is never handed comes back `not_assessed` even though the task specified it.

**Re-review and follow-up rounds — preserve the canonical criteria list.** When you re-run the reviewer to re-verify after fixing issues from a `changes_requested` round, the follow-up prompt MUST pass the task's `acceptance_criteria` field **unchanged** and instruct the reviewer to keep its `acceptance_criteria` array **identical to the task's canonical list** — one entry per criterion line, verbatim and in the task's order, never split, merged, reworded, added, or dropped (the same 1:1 hard rule the reviewer schema enforces in `agents/task-reviewer.md`). Never hand the re-review only the issues you fixed and let it re-derive the criteria: a re-review that re-enumerates the criteria in its own words corrupts the persisted count — this is exactly how a re-review round on task W1099 turned a 5-criterion task into a `6/5` review display.

<!-- canon:review-round-cap v1 -->
**Two review rounds is the ceiling, and the second verifies rather than re-reviews (W2128, ported here as W2167).** Review is capped at two rounds because an uncapped review loop does not converge — a reviewer asked to review always finds something. **A round is an invocation of the reviewer — dispatched via `dispatch_agent` or run inline as the `stride-task-reviewer` skill — whose response yielded a first fenced `` ```json `` block that parsed into `structured`.** The parsed block is what makes a round, never the invocation on its own: a reviewer that crashes, is interrupted, or returns text with no parsable fence produced no `structured`, lands on the JSON-parse fallback below, and **consumes nothing** — re-invoke. That definition is deliberately not "a dispatch": both invocation paths report `dispatched: true`, so a crashed one is still a dispatch and would otherwise burn a round. **The ceiling counts rounds this step runs; it never forbids a re-run another step mandates** — the pre-submission gate's own passthrough remedy is a fix-the-copy re-run, not a review round, and is outside this cap. **Round two still receives the FULL task diff — the scoping is to its *mission*, never to its *evidence***, which is what keeps the 1:1 `acceptance_criteria` rule above honest and what the extraction self-check below depends on.

**What round two's invocation carries.** Tell the reviewer this is round two, and name each round-one finding you fixed by **severity, category and `file:line` only, plus one line saying what you changed**. Never paste the previous block, its prose, or diff text into the invocation. **Do not invent a structured round field** — this port's dispatch is `dispatch_agent({agent, prompt})`, a prose prompt that nothing parses, and the reviewer's schema is pinned as a mirror of the canonical one, so a round key would fork a schema this port does not own. **The re-review rule above still binds in full:** the criteria list is passed unchanged and stays 1:1, and the fixes list is an **addition** to that prompt, never a licence to trim its input.

**After round two, remaining `important` and `minor` findings are RECORDED, not fixed.** Name each by **severity, category and `file:line` only** in `completion_notes` and in one line of `completion_summary` — the same dual carrier this skill already uses for the small-task mis-labelling signal, so this adds no new sink — **including any round-one finding round two did not re-enumerate**. **Never paste the reviewer's `description` or `suggested_fix`, the JSON block, its prose, or any diff text into either field:** the bounded form *is* the redaction here, because `severity` and `category` are closed enums and `file:line` is a repo-relative path plus an integer, and nothing in that shape can carry a credential. **Two things are never recorded under this disposition.** A **`critical`** is exempt from the cap and blocks at any round number: fix it and invoke a further round scoped to that finding, or stop without completing rather than record it. And a **`category: "security"` issue is never recordable at any severity** — `Important` is this reviewer's documented default for a security finding, so recording one would ship an unfixed weakness while the payload still read internally consistent. Fix it or escalate it.

**Round two's block will usually read `status: "changes_requested"`, and you submit it exactly as it is.** Any open `important` entry forces that status under the reviewer's own rule, so the cap's ordinary terminal state carries it by construction. **Never edit `status` to `"approved"`** — that fabricates a review result. **Never append the recorded residuals to `issues[]`** to make the block look consistent: they are already there, and duplicating them manufactures exactly the blocked completion this disposition promises never to cause. A `changes_requested` result is not a failed completion. Note the port-specific trap: **a `minor` never flips `status`**, so "only minors remain" is **not** interchangeable with "approved", and this paragraph applies only when every open entry is `important` or `minor` **and none is an unfixed `category: "security"` entry**. **The test is unfixed, not present** — the block is immutable, so a security finding you have already fixed is still listed in `issues[]`, and a presence test would exclude a finished task from this disposition for good, routing it to the stop-and-report exit when nothing is actually blocking. That matches the completion gate, which also keys on unfixed.

**This cap is stated, not enforced, and the reason is structural — say it plainly, because this port DOES have an executable self-check and the absence of one is not the reason.** The Python self-check below runs over `structured`, the reviewer's parsed block, and that block carries **no round number**: the reviewer emits no field naming its round and this port writes no per-round artifact, so `assert review_round <= 2` would read a value you set from your own memory a line earlier. That certifies rather than checks, and a check that only re-reads its own input is worse than an honest statement because it reads green. **Do not add one.** Nor can the count live in code: `dispatch_agent({agent, prompt})` receives no task identifier and cannot see whether the returned text parsed, the hook bridge intercepts only the claim, complete and mark_reviewed calls — its routes are enumerated in `extensions/hook-bridge/curl-matcher.ts` and none of them is a review. And this port's ADR forbids sharing an existing counter across mechanisms — **no executable surface here can observe that a round happened.** So the counting, the record-don't-fix disposition and the `category: "security"` prohibition above are **prose you follow, never something this port evaluates.** What *is* mechanically verified is that this rule is present at all: the `canon:review-round-cap` anchor above is read by `stride/scripts/check-port-canon.sh`, which reports this port MISSING until it lands and STALE if the canon's version moves past it. **It tests the anchor, never the sentence.** Disclosed here rather than left implied.

**What "stop without completing" and "escalate" mean here — this port names no failure state, so they are defined by what you DO.** stride records a `review_blocked` status with a `failure.kind`; this port has no such vocabulary, and porting the clause without a mechanism would leave you holding an instruction you cannot execute. So: **leave the task claimed** — nothing in this port ever unclaims — **send no `/complete` PATCH, report the finding to the human in this session** by severity, category and `file:line` plus what you attempted and why it failed, and then **stop the loop rather than returning to Step 1.** The loop stops here the same way it stops at Step 8's `needs_review=true` branch — but the task is still claimed and no completion was sent, so **none of that branch's follow-on steps apply**: no `after_review` hook, no move to Done. **"Escalate" means precisely this same report-and-stop** — it does **not** mean appending a `category: "security"` entry to `issues[]`, which would produce the very payload the completion gate refuses. **Never let "cannot fix it" become "say nothing":** `completion_notes` and `completion_summary` both ride on the PATCH you are declining to send, so the session report is the only channel left open, which is why it is the sanctioned one rather than merely the last.

**On a resumed session where you cannot establish how many parsed rounds already ran, treat the next round as round two.** The count lives only in your memory, as the disclosure above says, so a resume is the one event that loses it — and this is the rule the reviewer contract already assumes you hold when it speaks of a resumed session that could not establish the count. **Be exact about what the guess costs, because it is not nothing:** a `critical` is exempt at every round number, so guessing wrong can never ship one, but it can cost the fix disposition for `important` findings and the hunting mission of a genuine round one. So when the fixes list you would carry is **empty** — you know of no round-one findings because you were not there — say so and run that round **unscoped**. The cap exists to make review terminate, so an unknown count resolves toward the ceiling rather than away from it.

**A `minor` `category: "security"` finding is the case this path most often reaches, so size the response to it.** The prohibition is class-wide by design, but it is not an instruction to abandon a nit: **fix it if it is fixable, and it usually is.** Stop-and-report is for a security finding you genuinely cannot resolve — not for one you disagree with. A disagreement is itself something to report and have a human settle; it is never grounds to drop it silently.

The reviewer-side half of this rule — what round two is asked to do, and the two carve-outs that survive its mission scoping — is in `skills/stride-task-reviewer/SKILL.md` and its twin at `extensions/subagent-dispatch/agents/stride-task-reviewer.md`. `stride-subagent-workflow` Phase 3 names the five elements and defers here for their content — **keep that pointer accurate if the elements it names change.**

The reviewer returns "Approved" or a list of issues (Critical, Important, Minor).

- **Fix all Critical issues** before proceeding
- **Fix all Important issues** before proceeding — **through round two; after it, record them per the cap above, never a `category: "security"` one**
- Minor issues are optional but recommended — **except a `category: "security"` one, which is never optional and never recordable at any severity; fix or escalate it per the cap above**
- **Save the reviewer's full output** -- you'll include it as `review_report` in Step 7

**If custom agents are unavailable**, self-review:
- [ ] Each line of `acceptance_criteria` -- is it met?
- [ ] Each item in `pitfalls` -- did you avoid it?
- [ ] `patterns_to_follow` -- does your code match?
- [ ] `testing_strategy` -- did you write the specified tests?
- [ ] `behaviour_test_matrix` -- if the task supplied one (it is optional, so many tasks will not): does every row's named test exist, and does each row's `status` reflect reality?

Either way, the reviewer emits a one-line prose summary, the per-severity issue list, an acceptance-criteria table, and a fenced ```json block. **Save the reviewer's full response (prose + JSON block) verbatim** -- it becomes `review_report` in Step 7.

### Extracting the structured review block

After the reviewer returns, extract the first fenced ```json block from its response and use it to populate `reviewer_result` in your Step 7 payload. The same `reviewer_result` map carries both the legacy summary fields (kept for backwards compatibility with older Kanban deploys) and the structured fields (the actual deliverable for the review-queue per-section tiles — they live inside `reviewer_result`, never under a new top-level API key). The schema of that block is owned by the reviewer agent (`stride/agents/task-reviewer.md`, mirrored in `extensions/subagent-dispatch/agents/stride-task-reviewer.md`) -- do NOT duplicate the field definitions here.

**Pi note:** when the reviewer ran inline (no `dispatch_agent`), its response IS your current context — parse the JSON block you just emitted. When dispatched, parse the subprocess's returned block. Either way the first ```json fence is the source.

**Extraction pattern** — extract the first ```json fence and parse it (adapt to your Pi runtime; e.g. a regex over the reviewer text):

```python
import re, json
m = re.search(r'```json\n(.*?)\n```', reviewer_response, re.DOTALL)
structured = json.loads(m.group(1))  # the WHOLE parsed schema

# Whole-object copy — carry EVERY section through, then overlay the legacy
# fields. NEVER re-type or hand-pick keys; selecting a subset is exactly how
# project_checks got truncated (3 of 26 reached the server).
reviewer_result = dict(structured)
reviewer_result.update({
    "dispatched": True,
    "duration_ms": wall_clock_ms,
    "summary": structured["summary"],
    "issues_found": sum(structured["issue_counts"].values()),
    "acceptance_criteria_checked": len(structured["acceptance_criteria"]),
})

# MANDATORY self-check — run before EVERY /complete, NO EXCEPTIONS. A failure
# here means you trimmed the output: fix the copy, never weaken the check.
for section in structured:  # every section the reviewer produced must survive
    assert section in reviewer_result, f"dropped review section: {section}"
assert len(reviewer_result.get("project_checks", [])) == len(structured.get("project_checks", [])), \
    "project_checks count must equal what the reviewer emitted — never trim or sub-select"

# Acceptance-criteria 1:1 check — the reviewer's acceptance_criteria array length
# MUST equal the task's own criterion-line count. A mismatch means the reviewer
# split, merged, added, or dropped criteria (the W1099 6/5 defect). Re-run the
# reviewer with the canonical task criteria — NEVER truncate or pad the array to
# force the count to match.
task_criterion_lines = [c for c in (task["acceptance_criteria"] or "").split("\n") if c.strip()]
assert len(structured["acceptance_criteria"]) == len(task_criterion_lines), \
    "acceptance_criteria count must equal the task's criterion-line count — re-run the reviewer, do not truncate or pad"
```

**Field mapping into `reviewer_result`:**

- Legacy fields (always populated):
  - `summary` ← `structured.summary`
  - `issues_found` ← `sum(structured.issue_counts.values())`
  - `acceptance_criteria_checked` ← `len(structured.acceptance_criteria)`
  - `dispatched: true`, `duration_ms: <wall-clock ms>`
- Structured fields — **copy the reviewer's entire parsed JSON object verbatim** into `reviewer_result`, then overlay the legacy fields above on top. Do **not** maintain an allow-list of which structured keys to copy: whatever the agent emitted is persisted as-is, so any field the schema gains later flows through automatically. The structured key-set is owned by `agents/task-reviewer.md` (mirrored by the inline `stride-task-reviewer` skill and the dispatched ext-agent); passthrough it, never re-enumerate it here. Concretely, the reviewer currently emits `status`, `issue_counts`, `issues`, `acceptance_criteria`, `project_checks`, `testing_strategy`, `patterns`, `pitfalls`, `security_considerations`, and `schema_version` — but treat that as illustrative, not exhaustive. Because you copy the parsed JSON verbatim, keys the agent did not emit are simply absent (no empty placeholders to send). **Hand-typing, re-typing, or sub-selecting `reviewer_result` is FORBIDDEN — no exceptions, no small-task or brevity shortcut. The mechanical whole-object copy + mandatory self-check above is the only correct path; if the self-check fails, fix the copy, never the assertion.**

**Worked example.** Given the reviewer's fenced block below…

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
    {"criterion": "All task positions recalculate when a card moves columns", "status": "met", "evidence": "lib/kanban/tasks.ex:142-168"}
  ],
  "project_checks": [],
  "testing_strategy": {"status": "passed", "note": "Move + broadcast paths covered by tests."},
  "patterns": {"status": "passed", "note": "Mirrors the existing reorder pattern."},
  "pitfalls": {"status": "passed", "note": "None of the 4 listed pitfalls violated."},
  "security_considerations": {"status": "passed", "note": "Move query scoped to the current user's board; no new input or injection surface."}
}
```
````

…the resulting `reviewer_result` value in the Step 7 payload is:

```json
"reviewer_result": {
  "dispatched": true,
  "duration_ms": 29560,
  "summary": "Reviewed 3 acceptance criteria and 4 pitfalls against the diff; no issues found and all criteria met.",
  "issues_found": 0,
  "acceptance_criteria_checked": 1,
  "schema_version": "1.4",
  "status": "approved",
  "issue_counts": {"critical": 0, "important": 0, "minor": 0},
  "issues": [],
  "acceptance_criteria": [
    {"criterion": "All task positions recalculate when a card moves columns", "status": "met", "evidence": "lib/kanban/tasks.ex:142-168"}
  ],
  "project_checks": [],
  "testing_strategy": {"status": "passed", "note": "Move + broadcast paths covered by tests."},
  "patterns": {"status": "passed", "note": "Mirrors the existing reorder pattern."},
  "pitfalls": {"status": "passed", "note": "None of the 4 listed pitfalls violated."},
  "security_considerations": {"status": "passed", "note": "Move query scoped to the current user's board; no new input or injection surface."}
}
```

**Fallback when JSON parsing fails.** If no ```json block is present, or the block does not parse, do not abort the completion. Instead:

1. Fall back to substring-matching the prose summary line ("Approved" or "N issues found (X critical, Y important, Z minor)") to populate `reviewer_result.summary` and `reviewer_result.issues_found`.
2. Set `acceptance_criteria_checked` from the count of criterion lines in the prose acceptance-criteria table, or `0` if none can be parsed.
3. **Omit** every structured field (`status`, `issue_counts`, `issues`, `acceptance_criteria`, `project_checks`, `testing_strategy`, `patterns`, `pitfalls`, `security_considerations`, `schema_version`) from the payload — do NOT send empty placeholders. The Kanban server tolerates their absence.
4. Keep `dispatched: true` and `duration_ms` as captured. The fallback produces a degraded-but-valid completion, never a hard failure.

A response that reached this fallback produced no parsed `structured`, so it **was no round** — Step 5's two-round cap is **inapplicable to it rather than satisfied by it**. **Re-invoke once; the failed attempt consumes nothing.** If the re-invocation also fails to parse, stop re-invoking and follow items 1-4 above — the degraded-but-valid completion is the disposition, and this paragraph does not displace it. That precedence is stated because the two would otherwise both read as mandatory. The cap itself still does not bound a reviewer that repeatedly lands here; the one-retry bound above is what does. And because item 3 omits `issues`, `status`, `issue_counts` and `security_considerations` by construction, the record-don't-fix disposition has no input here either — **carry the last parsed round's findings into `completion_notes` and one line of `completion_summary` before submitting the degraded payload**, on the same bounded, redacted terms — **and the same two exclusions bind here.** An unfixed **`critical`** at any round number, and any unfixed **`category: "security"`** entry at any severity, are **never carried across and never shipped in a degraded payload**: on either, take the stop-and-report exit above instead of submitting. This paragraph is the one recording site that ends in an instruction to submit, which is exactly why the carve-outs are repeated in it rather than left to the bullets above. The fallback degrades the block; it never licenses losing a finding you already hold.

### Small tasks (0-1 key_files): Skip review. Omit `review_report` from completion.

---

## Step 6: Execute Hooks

**Execute each hook manually -- no permission prompts, no confirmation.**

### Hooks Reference

The five recognized `.stride.md` hook sections, in lifecycle order:

| Hook | Fires | Blocking | Timeout | Purpose |
|---|---|:---:|---|---|
| `## before_doing` | After `POST /api/tasks/claim` succeeds | yes | 60s | Pull latest, install deps, ensure clean working tree |
| `## after_doing` | Before `PATCH /api/tasks/:id/complete` runs | yes | 120s | Run tests, lint, build — quality gate before completion |
| `## before_review` | After `PATCH /api/tasks/:id/complete` succeeds | yes | 60s | Generate PR, post artifacts, notify reviewers |
| `## after_review` | After `PATCH /api/tasks/:id/mark_reviewed` succeeds | yes | 60s | Merge, deploy, cleanup |
| `## after_goal` | After the parent goal's final child task completes | yes | 60s | Project-level rollups, goal-completion notifications, archival |

When the optional `stride-pi-hook-bridge` extension is installed (`extensions/hook-bridge/`), `## before_doing` / `## after_doing` / `## before_review` / `## after_review` fire automatically on the corresponding Pi `tool_call` / `tool_result` events. **`## after_goal` also fires automatically via the extension's W797 routing** when the server bundles an `after_goal` entry in the response of `/complete` or `/mark_reviewed`. Without the extension, the agent runs hooks manually as documented below.

A missing `## after_goal` section parses as a clean no-op — older `.stride.md` files keep working without modification, and the server's grace-window worker promotes the goal automatically when no agent reports.

### Hook Environment Variables

The server populates `hook.env` in the response payload. The variable set differs by hook (`TASK_*` for the four task-scoped hooks, `GOAL_*` for `after_goal`); `BOARD_*`, `COLUMN_*`, `AGENT_NAME`, and `HOOK_NAME` are present across all five.

| Variable | `before_doing` / `after_doing` / `before_review` / `after_review` | `after_goal` |
|---|:---:|:---:|
| `HOOK_NAME`, `AGENT_NAME` | ✓ | ✓ |
| `BOARD_ID`, `BOARD_NAME` | ✓ | ✓ |
| `COLUMN_ID`, `COLUMN_NAME` | ✓ | ✓ |
| `TASK_ID`, `TASK_IDENTIFIER`, `TASK_TITLE`, `TASK_DESCRIPTION` | ✓ | — |
| `TASK_STATUS`, `TASK_COMPLEXITY`, `TASK_PRIORITY`, `TASK_NEEDS_REVIEW` | ✓ | — |
| `GOAL_ID`, `GOAL_IDENTIFIER`, `GOAL_TITLE`, `GOAL_DESCRIPTION` | — | ✓ |

When executing hooks manually (without the extension), export the relevant env vars from the API response's `hook.env` block before running each command. The server-supplied values are the single source of truth — never invent or derive them client-side.

### Canonical Hook Examples

The hooks are general-purpose — any shell command is fair game. The examples below are common starting points, not the only valid uses.

````markdown
## before_review

```bash
gh pr create \
  --title "$TASK_IDENTIFIER: $TASK_TITLE" \
  --body "Implements $TASK_IDENTIFIER."
```

## after_goal

```bash
gh pr create \
  --title "$GOAL_IDENTIFIER: $GOAL_TITLE" \
  --body "Rolls up the completed goal $GOAL_IDENTIFIER ($GOAL_TITLE)."
```
````

`## after_goal` is not coupled to PR creation. Other valid uses include posting to Slack with `curl`, archiving artifacts, kicking off a release pipeline, or running a project-level smoke test.

### 1. after_doing hook (blocking, 120s timeout)

1. Read `.stride.md` `## after_doing` section
2. Execute each command line one at a time via shell
3. Capture `exit_code`, `output`, `duration_ms`
4. If any command fails: fix the issue, re-run until success. Do NOT proceed while failing.

### 2. before_review hook (blocking, 60s timeout)

1. Read `.stride.md` `## before_review` section
2. Execute each command line one at a time via shell
3. Capture `exit_code`, `output`, `duration_ms`
4. If any command fails: fix the issue, re-run until success. Do NOT proceed while failing.

### Hook Failure Diagnosis

When a blocking hook fails, invoke the `hook-diagnostician` custom agent (if available) with the hook name, exit code, output, and duration. It returns a prioritized fix plan. Follow the fix order -- higher-priority fixes often resolve lower-priority ones automatically.

If custom agents are unavailable, diagnose manually: read the error output, identify the root cause, fix the issue, and re-run the hook.

---

## Step 7: Complete the Task

Call `PATCH /api/tasks/:id/complete` with ALL required fields:

```json
{
  "agent_name": "Pi",
  "time_spent_minutes": 45,
  "completion_notes": "Summary of what was done and key decisions made.",
  "completion_summary": "Brief one-line summary for tracking.",
  "actual_complexity": "medium",
  "actual_files_changed": "lib/foo.ex, lib/bar.ex, test/foo_test.exs",
  "review_report": "## Review Summary\n\nApproved -- 0 issues found.\n...",
  "after_doing_result": {
    "exit_code": 0,
    "output": "All 42 tests passed. Credo: no issues found.",
    "duration_ms": 15200
  },
  "before_review_result": {
    "exit_code": 0,
    "output": "PR #123 created successfully.",
    "duration_ms": 4800
  },
  "explorer_result": {
    "dispatched": false,
    "reason": "self_reported_exploration",
    "summary": "Read the 3 key_files manually and identified the existing pattern to mirror"
  },
  "reviewer_result": {
    "dispatched": false,
    "reason": "self_reported_review",
    "summary": "Self-reviewed the diff against all acceptance criteria and pitfalls; no issues found"
  },
  "workflow_steps": [
    {"name": "explorer",       "dispatched": true,  "duration_ms": 12450},
    {"name": "planner",        "dispatched": true,  "duration_ms": 8200},
    {"name": "implementation", "dispatched": true,  "duration_ms": 1820000},
    {"name": "reviewer",       "dispatched": true,  "duration_ms": 15300},
    {"name": "after_doing",    "dispatched": true,  "duration_ms": 45678},
    {"name": "before_review",  "dispatched": true,  "duration_ms": 2340}
  ]
}
```

**Required fields:**
| Field | Type | Notes |
|---|---|---|
| `agent_name` | string | Your agent name |
| `time_spent_minutes` | integer | Actual time spent |
| `completion_notes` | string | What was done |
| `completion_summary` | string | Brief summary |
| `actual_complexity` | enum | "small", "medium", or "large" |
| `actual_files_changed` | string | Comma-separated paths (NOT an array) |
| `after_doing_result` | object | `{exit_code, output, duration_ms}` |
| `before_review_result` | object | `{exit_code, output, duration_ms}` |
| `explorer_result` | object | `task-explorer` custom agent dispatch result or skip-form — see `stride-completing-tasks` for full shape and skip-reason enum |
| `reviewer_result` | object | `task-reviewer` custom agent dispatch result or skip-form — see `stride-completing-tasks` for full shape and skip-reason enum |
| `workflow_steps` | array | Six-entry telemetry array — see **Workflow Telemetry** section below |

**Optional fields:**
| Field | Type | Notes |
|---|---|---|
| `review_report` | string | Include when task-reviewer ran; omit when skipped |

---

## Step 8: Post-Completion Decision

### If `needs_review=true`:
1. Task moves to Review column
2. **STOP.** Wait for human reviewer to approve/reject.
3. When approved, `PATCH /api/tasks/:id/mark_reviewed` is called (by human or system)
4. Execute `after_review` hook manually (read `.stride.md` `## after_review`, run each line)
5. Task moves to Done

### If `needs_review=false`:
1. Task moves to Done immediately
2. Execute `after_review` hook manually (read `.stride.md` `## after_review`, run each line)
3. **Loop back to Step 1** -- claim the next task and repeat the full workflow

**Do not ask the user whether to continue. Do not ask "Should I claim the next task?" Just proceed.**

### If this completion finishes the parent goal's last child task

When the just-completed task is the **final child of a parent goal**, the server bundles a fifth `after_goal` entry in the `hooks` array of the response of `/complete` (when `needs_review=false`) or `/mark_reviewed` (when `needs_review=true`), alongside the primary hook entries. The `after_goal` entry's `hook.env` block carries `GOAL_ID`, `GOAL_IDENTIFIER`, `GOAL_TITLE`, `GOAL_DESCRIPTION` (plus the standard `BOARD_*` / `COLUMN_*` / `AGENT_NAME` / `HOOK_NAME`).

**With the `stride-pi-hook-bridge` extension installed (W797):** the extension automatically inspects the response payload, runs the local `## after_goal` section as a blocking hook, and writes a structured JSON result (`{hook, status, exit_code, output, failed_command?, duration_ms}`) on stdout. The agent reads that JSON and forwards the result via PATCH to flip the goal to Done.

**Without the extension (manual path):** the agent is responsible for the entire after_goal lifecycle. Five-step procedure:

1. **Detect**: Inspect the response's `hooks` array. If any entry has `name == "after_goal"`, the after_goal lifecycle has fired.
2. **Read**: Read the `## after_goal` section from `.stride.md`. If missing, skip steps 3-5 — the server's grace-window worker promotes the goal to Done automatically when no agent reports.
3. **Export**: Set the `GOAL_*` env vars from the response's `hook.env` block before running commands.
4. **Execute**: Run each command in the `## after_goal` section via the platform's shell tool. Capture `exit_code` (last command's exit), `output` (combined stdout+stderr), and `duration_ms` (wall-clock total).
5. **POST**: Forward the captured result to flip the parent goal to Done:

```bash
curl -X PATCH "$STRIDE_API_URL/api/tasks/$GOAL_ID/after_goal" \
  -H "Authorization: Bearer $STRIDE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg out \"$OUTPUT\" \"{exit_code: $EXIT_CODE, output: \\\$out, duration_ms: $DURATION_MS}\")"
```

A `2xx` with `exit_code == 0` transitions the goal to Done. A `2xx` with `exit_code != 0` records the failure on the goal's `after_goal_attempts` audit log and leaves the goal In Progress. Do NOT silently retry on non-zero exit — surface the failure and let the operator decide.

**How the extension detects `after_goal` reliably (canonical file + fresh GET).** The `/complete` (and `/mark_reviewed`) response can be large — the echoed `reviewer_result` alone runs to tens of KB — and Pi can truncate the `tool_result` payload the extension inspects, dropping the `after_goal` entry. The hook-bridge therefore does **not** depend on that payload being intact:

1. **Canonical file (fast path).** On `before_review` / `after_review` the extension captures the intercepted output to `<cwd>/.stride/.last-api-response.json` when it is complete valid JSON, and the `after_goal` detector reads that untruncated file **first**, falling back to the tool-output candidates. Unlike the sibling Claude Code plugin, the agent does **not** pipe the curl through `| tee` — the extension writes the canonical file itself.
2. **Fresh GET (guarantee).** When neither the file nor the intercepted output carries the entry, the extension issues an independent, hook-initiated `GET /api/tasks/:id/after_goal_status` — keyed off the just-completed task id, immune to truncation, needing no agent cooperation — and runs `## after_goal` from that server-truth result.

The sources are de-duplicated: `after_goal` runs **at most once**. A disarmed or unreachable status is a clean no-op, so a flaky check never blocks completion.

**Verify the push landed (last-child completions).** The `## after_goal` section is what performs any project push (e.g. `git push`); the server-side grace-window worker only flips the goal to Done — it does **not** push. So after a `needs_review=false` completion that finishes a goal's last child, confirm the push actually happened:

```bash
git log origin/main..main --oneline
```

An empty result means local `main` is level with the remote — the push landed. If it lists commits, the `## after_goal` section did not run (or performed no push) — run the `## after_goal` steps from `.stride.md` manually (push, then PATCH the after_goal result as above) so the goal's work reaches the remote.

**Back-compat:**

- Missing `## after_goal` section → skip the manual path entirely; the server's grace-window worker covers the goal transition with a synthetic attempt tagged `source: "after_goal_grace_worker"`.
- Older agent runtimes that don't speak the protocol → same grace-window coverage path.
- The `## after_goal` hook is **general-purpose** — Slack notifications, artifact archival, release pipelines, project-level smoke tests are all valid uses (see [Step 6's "Canonical Hook Examples"](#canonical-hook-examples)).

---

## Workflow Telemetry: The `workflow_steps` Array

Every task completion **must** include a `workflow_steps` array in the `PATCH /api/tasks/:id/complete` payload. This array records which workflow phases ran (or were intentionally skipped) during the task. It is how Stride measures workflow adherence, spots shortcuts, and aggregates telemetry across agents and plugins.

**Build the array incrementally as you progress through the workflow.** Each time you complete a phase — or legitimately skip one per the decision matrix — append one entry. Submit the completed six-entry array in Step 7.

### Step Name Vocabulary

The `name` field must be one of these six values. Do not invent new names — consistency across plugins is the only reason telemetry can be aggregated.

| Step name | When to record it | Orchestrator step |
|---|---|---|
| `explorer` | Codebase exploration (`task-explorer` custom agent when available, otherwise manual file reads) | Step 3 |
| `planner` | Implementation planning (manual outline of approach when the Step 3 matrix's Plan column says YES) | Step 3 |
| `implementation` | Writing code | Step 4 |
| `reviewer` | Code review (`task-reviewer` custom agent when available, otherwise self-review) | Step 5 |
| `after_doing` | The `after_doing` hook execution | Step 6 |
| `before_review` | The `before_review` hook execution | Step 6 |

### Per-Step Schema

Each element of `workflow_steps` is an object with these keys:

| Key | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Always | One of the six vocabulary values above |
| `dispatched` | boolean | Always | `true` if the step ran; `false` if intentionally skipped |
| `duration_ms` | integer | When `dispatched=true` | Wall-clock time the step took, in milliseconds |
| `reason` | string | When `dispatched=false` | Short explanation of why the step was skipped |
| `reason_code` | enum | Optional, when `dispatched=false` | The skip's category in countable form (D239) — sent with `reason`, never in place of it. The six accepted spellings are below; anything else is refused with a `422`, and leaving the key off is always valid |

<!-- canon:reason-code-vocabulary v1 -->
### `reason_code` Vocabulary

An entry marked `dispatched: false` may also carry a `reason_code`. It rides alongside the prose `reason` and never displaces it — the code is the half that can be counted across tasks, the sentence is the half written for whoever opens the task (D239). Six spellings are accepted:

| Code | When to record it |
|---|---|
| `decision_matrix_skip` | This task's governing row in Step 3 shows `Skip` in this step's column |
| `ran_inline` | The work itself happened, but this runtime did it in the main context instead of a dispatched subprocess — the ordinary case on Pi |
| `hook_body_empty` | The hook's `.stride.md` section carries no body, so there is no command to run (`after_doing` and `before_review` only) |
| `subsumed_by_task_spec` | Whatever this step would have determined was already fixed by the task record |
| `folded_into_prior_step` | This step's output arrived inside an earlier one — commonly an exploration pass that also settled the approach |
| `matrix_deviation` | A step the matrix required went unrun |

The set is closed. A seventh spelling comes back from the completion API as a `422`, which is what keeps a typo from quietly opening a bucket of its own. Omitting the key is always acceptable — the sentence by itself already documents the skip in full, so a payload written before this field existed validates unchanged.

**`matrix_deviation` is the only value in the set that records non-compliance**, and that is precisely why it is there. When the matrix called for a step and you did not run it, file it under that code and not under `decision_matrix_skip`, which would dress the departure up as something the table approved. The circumstances themselves belong in `reason`.

### End-of-Workflow Example (full dispatch)

A medium-complexity task that exercised every phase:

```json
"workflow_steps": [
  {"name": "explorer",       "dispatched": true, "duration_ms": 12450},
  {"name": "planner",        "dispatched": true, "duration_ms": 8200},
  {"name": "implementation", "dispatched": true, "duration_ms": 1820000},
  {"name": "reviewer",       "dispatched": true, "duration_ms": 15300},
  {"name": "after_doing",    "dispatched": true, "duration_ms": 45678},
  {"name": "before_review",  "dispatched": true, "duration_ms": 2340}
]
```

### End-of-Workflow Example (small task, decision matrix skips)

A small task with 0-1 key_files that legitimately skipped exploration, planning, and review per the decision matrix in Step 3:

```json
"workflow_steps": [
  {"name": "explorer",       "dispatched": false, "reason": "Decision matrix: small task, 0-1 key_files"},
  {"name": "planner",        "dispatched": false, "reason": "Decision matrix: small task, 0-1 key_files"},
  {"name": "implementation", "dispatched": true,  "duration_ms": 620000},
  {"name": "reviewer",       "dispatched": false, "reason": "Decision matrix: small task, 0-1 key_files"},
  {"name": "after_doing",    "dispatched": true,  "duration_ms": 38200},
  {"name": "before_review",  "dispatched": true,  "duration_ms": 1900}
]
```

### Rules

- Always include **all six** step names. Skipped steps are recorded with `dispatched: false` — never omitted.
- Record entries in the order the steps occurred in the workflow (the order listed in the vocabulary table above).
- When `dispatched: false`, the `reason` must describe **why** the step was skipped (e.g., decision matrix rule, task metadata, platform constraint) — not merely restate that it was skipped.
- A missing `workflow_steps` array, or one with fewer than six entries, indicates an incomplete telemetry record.

---

## Explorer and Reviewer Result Rollout

Every `/complete` payload **must** include `explorer_result` and `reviewer_result` as top-level objects. Both are pre-validated by `Kanban.Tasks.CompletionValidation` on the server. The full shape (self-reported skip vs. dispatched-custom-agent), the 40-character non-whitespace summary rule, and the five-value skip-reason enum live in the `stride-completing-tasks` skill — this orchestrator does not duplicate them.

The server is rolling out hard enforcement behind a feature flag `:strict_completion_validation`:

| Phase | Server behavior | Agent impact |
|---|---|---|
| **Grace (current)** | Missing or invalid results log a structured warning and the request succeeds | Emit the fields correctly now; the warning volume is a preview of the strict-mode rejection volume |
| **Strict (after all 5 plugins release)** | Missing or invalid results return `422` with a `failures` list | Any agent not emitting valid fields is locked out of completion |

**Why this matters for the orchestrator:** Steps 3 (manual exploration) and 5 (self-review) already produce the summaries needed for these fields. Persist those into `explorer_result` and `reviewer_result` in the Step 7 payload. Because Pi does not ship with native subagent dispatch, the skip form is the default path — submit it with a reason from the enum (usually `self_reported_exploration` / `self_reported_review` or `no_subagent_support`) and a substantive summary explaining what you did instead. See `stride-completing-tasks` for the exact shape, rejection examples, and minimum-length rule.

---

## Edge Cases

### Hook failure mid-workflow
- Blocking hooks (`after_doing`, `before_review`) must pass before completion
- Fix the root cause, re-run the hook, then proceed
- Invoke the `hook-diagnostician` custom agent for complex failures (if available)
- Never skip a blocking hook or call complete with a failed hook result

### Task that needs_review=true
- Stop after Step 7. Do not claim the next task.
- The human reviewer will handle the review cycle.
- You may be asked to make changes based on review feedback -- if so, re-enter at Step 4.

### Goal type tasks
- Goals are decomposed, not implemented directly
- The `task-decomposer` custom agent creates child tasks (or decompose manually)
- Each child task follows this full workflow independently

### Skills update required
- If any API response includes `skills_update_required`, update the extension and retry

---

## Complete Workflow Flowchart

```
STEP 0: Prerequisites
  .stride_auth.md exists? --> NO --> Ask user
  .stride.md exists?      --> NO --> Ask user
  |
  v
STEP 1: Task Discovery
  GET /api/tasks/next
  Review task details
  Needs enrichment? --> YES --> Activate stride-enriching-tasks
  |
  v
STEP 2: Claim
  Execute before_doing hook manually, then POST /api/tasks/claim
  |
  v
STEP 3: Explore (Decision Matrix)
  Goal/large undecomposed? --> Decompose (agent or manual) --> Claim first child --> Step 1
  Small, 0-1 key_files?   --> Skip to Step 4
  Otherwise:
    Invoke task-explorer (or read key_files manually), outline approach when the matrix's Plan column says YES
  |
  v
STEP 4: Implement
  Write code using explorer output, plan, acceptance criteria
  Follow patterns_to_follow, avoid pitfalls
  |
  v
STEP 5: Code Review (Decision Matrix)
  Small, 0-1 key_files? --> Skip to Step 6
  Otherwise:
    Invoke task-reviewer (or self-review against acceptance criteria)
    Capped at TWO rounds; round two verifies round one's fixes
      |- critical unfixable, or a security finding you cannot resolve
      |    -> STOP: leave claimed, send no PATCH, report in session
      +- after round two: remaining important/minor are RECORDED, not fixed
  |
  v
STEP 6: Execute Hooks
  Execute after_doing (120s) manually, then before_review (60s) manually
  Hook fails? --> Fix, re-run, do NOT proceed
  |
  v
STEP 7: Complete
  PATCH /api/tasks/:id/complete with ALL required fields + hook results
  |
  v
STEP 8: Post-Completion
  needs_review=true?  --> STOP, wait for human
  needs_review=false? --> Execute after_review manually, loop to Step 1
```

---

## Failure Modes This Skill Prevents

| Failure Mode | Old Pattern | This Skill |
|---|---|---|
| Forgot to explore | Agent skipped stride-subagent-workflow | Step 3 is inline -- can't be missed |
| Forgot to review | Agent jumped to completion | Step 5 is inline -- can't be missed |
| Wrong API fields | Agent guessed from memory | Step 7 has the exact format |
| Skipped hooks | Agent called complete directly | Step 6 blocks Step 7 |
| Asked user permission | Agent prompted between steps | Automation notice says don't |
| Speed over process | Agent optimized for throughput | Every step is framed as mandatory |

---

## Quick Reference Card

```
PI WORKFLOW:
├─ 0. Prerequisites: .stride_auth.md + .stride.md exist
├─ 1. Discovery: GET /api/tasks/next, review task, enrich if needed
├─ 2. Claim: Execute before_doing manually, then POST /api/tasks/claim
├─ 3. Explore (check decision matrix):
│     ├─ Goal/large undecomposed → Decompose (agent or manual) → Claim children
│     ├─ Small, 0-1 key_files → Skip to Step 4
│     └─ Otherwise → Invoke task-explorer (or read manually), outline approach
├─ 4. Implement: Write code using explorer output and task metadata
├─ 5. Review (check decision matrix):
│     ├─ Small, 0-1 key_files → Skip to Step 6
│     └─ Otherwise → Invoke task-reviewer (or self-review), fix issues — capped at TWO rounds;
│          after round two record remaining important/minor rather than fixing, never a
│          security one; a critical blocks at any round; unfixable → stop and report
├─ 6. Hooks: Execute after_doing (120s) + before_review (60s) manually
├─ 7. Complete: PATCH /api/tasks/:id/complete with ALL fields + hook results
└─ 8. Loop: needs_review=false → Step 1 | needs_review=true → STOP

DECISION MATRIX QUICK CHECK:
  small + 0-1 key_files  → Skip explore, plan, review
  small + 2+ key_files   → Explore + Review
  medium/large           → Explore + Plan + Review
  goal/undecomposed      → Decompose first
```

---

## Red Flags -- STOP

If you catch yourself thinking any of these, go back to the decision matrix:

- "This is straightforward, I'll skip exploration" -- Medium+ tasks ALWAYS explore
- "I know the codebase" -- The task has specific pitfalls you haven't read yet
- "Review will slow me down" -- Review catches what tests can't
- "I'll just run the hooks and complete" -- Did you explore? Did you review?
- "This step doesn't apply to me" -- Check the decision matrix, not your intuition

**The workflow IS the automation. Follow every step.**
