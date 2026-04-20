# ADR-001: Subagent Model for stride-pi

**Status:** Superseded 2026-04-20 — see **Addendum** at bottom. 2a ships as the baseline; 2b is the recommended path (W252 reopened).
**Date:** 2026-04-20
**Context:** stride-pi Phase 2 (G69)
**Decision task:** W251 (original), reversal recorded same day

## Context

Pi (https://github.com/badlogic/pi-mono) does not ship with a native subagent dispatch mechanism. The Stride plugin family (Claude Code, Codex CLI, Gemini CLI) relies on 4 specialized subagents — `task-explorer`, `task-reviewer`, `task-decomposer`, `hook-diagnostician` — that run in isolated contexts to keep exploration, review, and decomposition cleanly separated from the main agent's working memory. stride-pi needs an equivalent mechanism.

Two options were considered during planning (G69 W250/W251/W252):

- **Option 2a — Inline Skills.** Port the 4 sibling-plugin subagents as additional SKILLs that the main agent executes in its own context. Zero extension code. Lose parallelism and isolation. Fast to ship.
- **Option 2b — TypeScript Extension.** Build a Pi extension that registers a `dispatch_agent(name, prompt)` tool. The tool shells out to `pi -p` with `PI_CODING_AGENT_DIR` pointed at an ephemeral config directory containing a per-agent `SYSTEM.md`. Each dispatch runs in its own Pi subprocess with its own context window. Preserves isolation and parallelism. Requires ~1 day of TypeScript work per the original planning estimate.

## Evidence gathered (Phase 2a pilot)

W250 landed Phase 2a: four inline skills (`stride-task-explorer`, `stride-task-reviewer`, `stride-task-decomposer`, `stride-hook-diagnostician`) plus an updated `stride-subagent-workflow` that references them. Observations from the implementation and review cycle:

| Observation | 2a outcome |
|---|---|
| Do the inline skills produce valid G65 payloads? | **Yes.** Both `stride-task-explorer` and `stride-task-reviewer` document the `dispatched: true` shape with the required fields (`summary` ≥ 40 non-whitespace chars, `duration_ms`, and for reviewer: `acceptance_criteria_checked`, `issues_found`). These are byte-compatible with the server-side `Kanban.Tasks.CompletionValidation` module — the same enum and rules the sibling plugins use. |
| Does the Agent Skills standard make the inline skills discoverable? | **Yes, verified in W249.** Pi lists all 7+4=11 skills at startup under `[Skills]`. Auto-activation on description-match is the documented mechanism; `/skill:name` is the explicit fallback. |
| What is lost vs 2b? | **Parallelism** (Pi runs one execution path at a time in the inline model) and **context isolation** (exploration findings occupy the main agent's context window; no fresh slate for review). For the target task sizes documented in Stride (1–3 hour work tasks), the main agent's context window comfortably holds exploration + implementation + review findings without spilling. Parallel exploration across multiple key_files is something the main agent can do sequentially in one pass. |
| What does 2a cost? | Zero extension code, zero new dependencies, zero new test surface. The 4 skills are markdown files in `skills/*/SKILL.md`. They work on any Pi install that already supports the Agent Skills standard. |
| What would justify 2b? | (a) Inline exploration regularly consumes >30% of the main agent's context budget on medium tasks; or (b) a concrete scenario where parallel subagent dispatch would complete work that inline cannot. Neither has materialized in the 2a pilot. |

## Decision

**Accept Option 2a (Inline Skills) as the supported subagent model for stride-pi. Defer Option 2b indefinitely.**

Phase 2b (tracked as **W252** under G69) is marked out-of-scope as a result of this ADR. W252's spec remains on file as reference material should future evidence ever justify reopening the decision.

### Rationale

1. **The pilot works.** The 4 inline skills landed cleanly in W250, produce G65-compliant output payloads, and follow the established Agent Skills standard Pi already implements.
2. **The cost of 2a is near zero** — no TypeScript build system to maintain, no Node subprocess orchestration, no ephemeral config directories. This matters for a plugin whose value proposition is "Stride on Pi, simply."
3. **The gains from 2b are not currently needed.** Stride tasks are scoped for 1–3 hour work items. Parallelism and isolation become interesting optimizations when task complexity or agent-context pressure justifies them; for the current target task sizes they do not.
4. **The decision is reversible.** If future Pi users report that inline exploration is too context-heavy or that multi-file tasks benefit from parallel agent dispatch, W252 can be promoted to Ready and the TypeScript extension built without changing anything in the 4 inline skills — they would simply become unused fallbacks once `dispatch_agent` is available.

## Consequences

### Positive

- stride-pi ships G69 Phase 2 with one task completed (W250) and one (W251) closed as a decision doc. W252 is marked out-of-scope; G69 closes at 2 of 3 tasks shipped and 1 correctly deferred.
- The plugin is distribution-ready from Phase 1 alone. Phase 2a adds nuance but no install burden.
- No TypeScript build system introduced. `install.sh` continues to work as a plain bash + `git clone`.

### Negative

- No parallel exploration. A task with 10 unrelated key_files cannot have 10 explorers run simultaneously — the main agent reads them in sequence.
- Exploration and review both consume the main agent's context window during the task. A pathological case with very large `key_files` + deeply referenced `patterns_to_follow` could cause context pressure; the main agent would need to summarize aggressively.

### Neutral

- Consumers accustomed to sibling plugins' subagent behavior will find stride-pi similar in outputs but different in execution model. The `stride-subagent-workflow` skill explicitly documents this difference (line 31 onward, "Pi Inline Skills (Phase 2a)").

## References

- W250 commit `48847d6` (scaffold) + `8982b4d` (review fixes) — Phase 2a implementation
- `skills/stride-subagent-workflow/SKILL.md` — decision matrix + Phase 2a section
- `skills/stride-task-explorer/SKILL.md`, `stride-task-reviewer/SKILL.md`, `stride-task-decomposer/SKILL.md`, `stride-hook-diagnostician/SKILL.md` — the 4 inline skills
- Stride task W252 — Phase 2b TS extension spec, deferred by this ADR

## Reversal conditions

Reopen this decision if any of the following are observed in production Pi usage:

- Inline exploration regularly consumes >30% of the main agent's context window on medium-complexity tasks
- A concrete task scenario emerges that parallel subagent dispatch could complete but inline cannot
- Pi's own roadmap adds native subagent support — at which point 2b becomes "implement the native path" rather than "build a workaround"

Document the evidence, then claim W252 to build the 2b extension. The 4 inline skills remain in place as fallbacks for older Pi versions.

---

## Addendum — 2026-04-20 (same day): decision reversed

The original decision above deferred Phase 2b based on four points: the 2a pilot "worked," 2a cost near zero, the gains from 2b were "not currently needed," and the decision was reversible.

On reconsideration later the same day, those points don't hold up:

1. **"The pilot works" was overstated.** W250 verified that the 4 inline skill *files* are structurally correct and produce G65-compatible output shapes on paper. Nobody has actually run an end-to-end Pi session using them and measured context usage, exploration quality, or whether a main agent's context budget survives inline exploration + implementation + review on a real medium-complexity task.
2. **"Cost to build" was over-weighted.** W252's TypeScript extension was already planned work with a scoped estimate. The right question was "which architecture should stride-pi ship," not "which is cheapest to build."
3. **"Stride tasks are 1–3 hours" is hand-waving.** I did not measure Pi's context budget or the compounding effect of inline exploration on top of implementation context. The "should be fine" reasoning was unsupported.
4. **The parallelism loss matters.** Exploring N unrelated `key_files` serially is a real context burn that 2b's `pi -p` subprocesses avoid.
5. **The isolation loss matters for review.** A dispatched reviewer returns a summary; the main agent never sees the full diff or raw file contents. Inline review keeps everything in the main context, which can bias subsequent decisions.

### Revised decision

**Ship 2a as the baseline (it's real and already in the repo).** **Reopen W252 as the recommended path.** When 2b ships, the 4 inline skills remain in place as fallbacks for Pi installs that lack the extension (e.g., older Pi versions, container environments where the extension can't run, or users who opt out for simplicity). Users who install the extension opt into isolation and parallelism.

### What changes in the repo

- The 4 inline skills stay. No regression for anyone currently using them.
- `stride-subagent-workflow` will gain a dual-path section: "if the extension is installed, use `dispatch_agent()`; otherwise run the inline skill." (A follow-up task, not this ADR.)
- W252 moves from "deferred" back to Ready in Stride; the decision's reversal conditions (above) are no longer the primary trigger — shipping 2b is now planned work.
- When W252 ships, flip this ADR's Status line to "Accepted — 2a + 2b both supported; 2b recommended."

### What this ADR did right

The reversal conditions section was the right idea in form — ADRs should be reversible — but the specific triggers were too high a bar (nobody would instrument Pi context usage just to reopen a decision). Architectural decisions should not wait for production failures when the better design is already known.

