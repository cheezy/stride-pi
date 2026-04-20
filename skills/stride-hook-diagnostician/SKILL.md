---
name: stride-hook-diagnostician
description: Use this skill when a Stride hook (before_doing, after_doing, before_review, after_review) fails during task lifecycle. Parse the hook output, identify failure patterns, categorize issues by severity, and produce a prioritized fix plan. This is Pi's inline equivalent of the hook-diagnostician subagent in sibling plugins (Claude Code / Codex CLI).
---

# Stride: Hook Diagnostician (Inline)

## Purpose

Analyze hook failure output, identify root causes, and produce a prioritized fix plan. This skill categorizes issues by severity and returns structured recommendations — **it does NOT fix code itself.**

**Pi context:** Pi does not ship with native subagent dispatch. In sibling plugins this runs as an isolated subagent; on Pi you execute these instructions inline. The diagnostic logic is identical.

## When to invoke

Invoke this skill whenever a blocking Stride hook fails (non-zero exit code) and you need to prioritize the fix order. The hooks are:

- `before_doing` — runs before claiming work (pull code, setup)
- `after_doing` — runs before marking complete (tests, lint, build)
- `before_review` — runs before moving to review (create PR, docs)
- `after_review` — runs after approval (merge, deploy)

`after_doing` and `before_review` are the most common failure points because they batch many quality gates.

## Inputs (from your current context)

When invoked after a failed hook, you must have these pieces of information in scope (from the hook execution you just ran):

- `hook_name` — which of the four hooks failed
- `exit_code` — the non-zero exit code
- `output` — raw stdout + stderr from the failed command(s)
- `duration_ms` — how long the hook ran before failing
- Optionally: the task metadata

## Fix priority order

**Fix issues in this priority order — later fixes often become unnecessary once earlier ones are resolved:**

1. **Compilation errors** — nothing works until code compiles
2. **Git failures** — can't commit or push with conflicts or rebase errors
3. **Test failures** — core correctness must pass
4. **Security warnings (Sobelow)** — security issues block completion
5. **Credo errors `[F]`** — actual code errors
6. **Credo warnings `[W]`** — potential issues
7. **Credo refactor/convention `[R]` `[C]`** — style issues
8. **Format failures** — auto-fixable, do last

**After fixing priority 1–2 issues, recommend re-running the hook before addressing lower-priority ones.** It is common for priority 3–8 issues to disappear once the top errors are fixed.

## Output

Produce a structured diagnosis with:

1. **Summary line** — one sentence naming the highest-priority failure category
2. **Prioritized fix list** — each issue tagged with its priority (1–8 above), file/line reference when visible in the output, and a specific suggested fix
3. **Recommended next action** — e.g. "Fix priority 1 compilation error at `lib/foo.ex:42`, re-run the `after_doing` hook, and re-triage"

Keep the output concise; the main agent will act on your recommendations directly.

## Important constraints

- Do NOT fix code — only diagnose and recommend
- Do NOT run tests or commands — only analyze the provided output
- Do NOT interact with the Stride API — only parse hook results
- Do NOT modify any files — this skill is read-only
- Do NOT guess at issues not visible in the output — only report what you can see
