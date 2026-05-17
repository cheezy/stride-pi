# ADR-002: Hook Mechanism for stride-pi

**Status:** Accepted — use `pi.on("tool_call", ...)` with `{ block: true, reason }` veto
**Date:** 2026-05-17
**Context:** stride-pi Phase 3 (G69) — Stride lifecycle hook bridge
**Decision task:** W253
**Pi version verified against:** `@mariozechner/pi-coding-agent@0.67.68`

## Context

stride-pi Phase 3 needs to bridge Stride's four client-side lifecycle hooks (`before_doing`, `after_doing`, `before_review`, `after_review`) onto Pi's extension event surface so that a Pi user working a Stride task gets the same automatic, blocking-where-required hook execution that Claude Code provides via `hooks.json`.

W253 was scoped as a fork in the road: implement the bridge against Pi's documented `pi.on("tool_call", ...)` event if blocking is supported, or fall back to wrapping the entire `bash` tool with a custom shim if it is not. The wrong choice would burn Phase 3's remaining time budget. The directive in W253 was explicit: do not guess — verify in code.

## Evidence

Read directly from the installed Pi runtime at `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/` (npm-global install, version `0.67.68`).

### (a) Does `pi.on("tool_call", ...)` support a veto?

**Yes.** The handler return type is `ToolCallEventResult`, defined in `dist/core/extensions/types.d.ts:652`:

```typescript
export interface ToolCallEventResult {
    /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
    block?: boolean;
    reason?: string;
}
```

`docs/extensions.md:583` ("Tool Events / tool_call") confirms the event is "**Can block.**" and the canonical sample shows the working pattern:

```typescript
if (event.input.command.includes("rm -rf")) {
  return { block: true, reason: "Dangerous command" };
}
```

Returning `{ block: true, reason }` aborts the tool call; the `reason` is surfaced as the tool result so the model sees why. The handler may additionally mutate `event.input` in place to patch tool arguments before execution (`extensions.md:589`). Handlers are awaited (`runner.js:598` — `await handler(event, ctx)`), so an async hook completes before the tool runs.

### (b) Pre-tool, post-tool, or both?

**Pre-tool only** for `tool_call`. Per the lifecycle diagram (`extensions.md:240-260`):

```
tool_execution_start
  └─ tool_call (can block)        ← pre-tool, blocking veto
  └─ tool_execution_update
  └─ tool_result (can modify)     ← post-tool, modify return value
tool_execution_end
```

A separate `tool_result` event fires after execution and can rewrite the result; it is the right surface for `after_doing`-style follow-ups but not for blocking the tool itself.

### (c) Timeout?

**There is no built-in handler-level timeout.** Every handler invocation in `runner.js` is a plain `await handler(event, ctx)` — no `Promise.race`, no `setTimeout` wrapper. Cancellation is cooperative via `ctx.signal` (`docs/extensions.md:653,791-798`): a long-running hook should pass `ctx.signal` to its own async work so that Esc / agent abort can cancel `fetch`, child processes, etc. The Stride hook contract's per-hook timeouts (60s / 120s) must therefore be enforced inside the handler — `Promise.race` against a `setTimeout`, killing any spawned child on timeout — not relied upon from Pi.

## Decision

**Use `pi.on("tool_call", ...)` with `{ block: true, reason }` for `before_doing` and `before_review`.** Use `pi.on("tool_result", ...)` for `after_doing` and `after_review` where post-execution follow-up is needed. Do **not** wrap the `bash` tool; the documented event surface is sufficient.

The hook bridge extension will:

1. Register a single `pi.on("tool_call", ...)` handler that intercepts tool calls during Stride lifecycle windows (when a task is claimed / about to complete) and runs the corresponding `.stride.md` hook commands. On non-zero exit it returns `{ block: true, reason: "<hook_name> failed: <stderr>" }`.
2. Register a parallel `pi.on("tool_result", ...)` handler for `after_doing` / `after_review` follow-ups.
3. Enforce per-hook timeouts (60s / 120s) inside the handler via `Promise.race` + `child.kill`, since Pi imposes none. Wire `ctx.signal` through to spawned children so Esc cancels cleanly.

## Rationale

1. **The documented API works for our case.** Blocking is a first-class capability, typed, and exercised in Pi's own example. No wrapping needed.
2. **`tool_call` veto is strictly more powerful than wrapping `bash`.** The veto path covers every tool (Edit, Write, custom tools) — not just bash — which matches how Stride hooks gate the workflow, not just shell calls.
3. **Wrapping `bash` would be a maintenance liability.** It would mean shadowing a built-in tool, replicating its argument schema, and tracking upstream changes in Pi between releases.
4. **No timeout from Pi is acceptable for our needs.** Stride's hook contract already specifies per-hook timeouts; enforcing them in our handler is straightforward and gives us correct child-process cleanup on timeout — something we'd have to write either way.

## Consequences

### Positive

- Phase 3 builds on documented API rather than a wrapper. Minimal surface area, single registration call.
- Same handler shape covers every tool, not just bash.
- The `event.input` mutation capability is available for free if a future hook needs to *transform* a command (e.g., prepend env setup) rather than block it.

### Negative

- We must implement timeout enforcement ourselves. ~15 lines of `Promise.race` + child-kill code per hook; mitigated by sharing a single helper.
- Parallel-tool-execution mode (Pi's default) does *not* guarantee that sibling tool calls from the same assistant message see each other's results in `ctx.sessionManager` (`extensions.md:587`). For Stride's per-task lifecycle this is irrelevant — hooks gate the task transition, not individual sibling tool calls — but it is worth noting in the extension code so future modifications don't depend on cross-sibling visibility.

### Neutral

- The fallback "wrap `bash` entirely" path documented in W253 is not needed and is now formally out of scope. If a future Pi release removes the `block` capability from `tool_call`, this ADR should be reopened.

## References

- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md` lines 240–260 (lifecycle diagram), 581–620 (`tool_call` docs), 644–673 (`tool_result` docs), 791–798 (`ctx.signal`)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:524-557` (`ToolCallEvent*` types), `:652-656` (`ToolCallEventResult`)
- `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js:598` (handler invocation pattern — no timeout wrapper)
- Existing precedent: `stride-pi/extensions/subagent-dispatch/index.ts` already uses `pi.registerTool` with `ctx.signal` for cooperative abort
- W251 (predecessor — Phase 3 hook bridge planning)
- W12 (consumer — depends on this decision to start)

## Reversal conditions

Reopen this ADR if any of the following are observed:

- A future Pi release deprecates or removes `block`/`reason` from `ToolCallEventResult`
- The bridge needs to intercept calls Pi does not emit a `tool_call` event for (none known today)
- Timeout enforcement inside the handler proves unreliable in practice (e.g., child processes that ignore SIGTERM and we cannot reliably kill from the handler)
