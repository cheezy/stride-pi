# Phase 3 Validation — Hook Blocking on `after_doing` Failure

**Task:** W256
**Date:** 2026-05-17
**Pi version on test box:** `@mariozechner/pi-coding-agent@0.67.68`
**stride-pi version:** 0.3.0

## Scope and Method

This document records the programmatic validation of `hook-bridge`'s blocking semantics — specifically, that an `after_doing` hook failure causes the registered `pi.on("tool_call", ...)` handler to return `{ block: true, reason: <string> }`, which is the documented mechanism Pi uses to veto a tool call (per `pi-coding-agent@0.67.68` docs `extensions.md:583` and the `ToolCallEventResult` type in `dist/core/extensions/types.d.ts:652`).

W256's verification step #2 calls for a real interactive Pi session (`Hook fires without manual invocation`). That manual run is still expected for end-to-end sign-off and is captured under **Remaining manual verification** at the bottom of this document. The programmatic run below validates the contract at the code level: it loads the extension the same way Pi does (via the `@mariozechner/jiti` fork shipped with `pi-coding-agent`), fires synthetic `tool_call` events with the exact bash command shape Pi produces for a `/complete` curl, and asserts the handler return.

## Harness

`extensions/hook-bridge/validate-blocking.mjs` performs the following per scenario:

1. Create a temp directory and write a `.stride.md` whose `## after_doing` section contains a single configurable command.
2. Load `extensions/hook-bridge/index.ts` via `createJiti(import.meta.url, { fsCache: false, moduleCache: false, tryNative: false }).import(...)` — the same loader options Pi uses in `dist/core/extensions/loader.js`.
3. Call the loaded factory with a mock `pi` API that captures every `pi.on(...)` registration.
4. Synthesize a `tool_call` event for `bash` with `event.input.command` equal to a `/api/tasks/9999/complete` curl.
5. Invoke the captured `tool_call` handler with `(event, ctx)` where `ctx.cwd` is the temp dir.
6. Assert the return value matches the expected scenario contract.

`ctx.signal` is `undefined` (matching Pi's idle-context guarantee) and `ctx.ui.notify` prints to stderr so any non-blocking-failure logging is visible.

## Scenario A — failing `after_doing`

`.stride.md` `## after_doing` section runs the single command `false` (exits 1 immediately with no output).

**Expected:** `tool_call` handler returns `{ block: true, reason: <string> }` where the reason mentions the hook name, exit code, and failed command.

**Observed:**

```json
{
  "block": true,
  "reason_excerpt": "Stride after_doing hook failed (exit 1). Command: false\n\n(no output captured)"
}
```

**Pass.** The block flag is set, the reason names the hook (`after_doing`), the exit code (`1`), and the failing command (`false`). Pi's tool-call lifecycle treats this as a veto and the `/complete` curl never reaches the API — exactly the contract documented in ADR-002.

## Scenario B — passing `after_doing`

Same harness, with `.stride.md` `## after_doing` section running the single command `true` (exits 0 immediately with no output).

**Expected:** `tool_call` handler returns `undefined` (no block).

**Observed:** `undefined`

**Pass.** With a passing hook, no veto is raised and Pi proceeds to execute the curl.

## How to reproduce

```bash
cd stride-pi/extensions/hook-bridge
npm install --no-save --no-package-lock        # only @mariozechner/pi-coding-agent + jiti are needed
node validate-blocking.mjs
# Exits 0 on success. Output is structured JSON.
rm -rf node_modules                            # peer deps only — do not commit
```

The harness is reproducible offline (no Stride API or network needed). It is intended for CI / pre-release smoke testing — not as a substitute for end-to-end validation in a real Pi session.

## What this validates and what it does not

**Validates:**

- The `tool_call` handler returns the documented `ToolCallEventResult` shape on `after_doing` failure.
- The `reason` string includes enough context (hook name + exit code + failed command) to be actionable.
- A passing hook does not produce a spurious block.
- The extension loads through Pi's exact loader configuration (`@mariozechner/jiti` with `tryNative: false`).

**Does not validate (requires a real Pi run):**

- Pi's runtime actually honors `{ block: true, reason }` as a veto (this is documented contract behavior, not something we can re-prove without booting Pi).
- The full claim → before_doing → implement → after_doing flow when the user is operating Pi interactively.
- That `hook-bridge` is auto-discovered from the `pi.extensions` paths in `package.json` (covered indirectly by W255 wiring, plus the load test in this harness which uses the same loader).
- The `before_review` / `after_review` tool_result paths (out of W256 scope — W256 is specifically about `after_doing` blocking).

## Remaining manual verification

For end-to-end sign-off, do the following in an interactive Pi session:

1. Install / link `stride-pi@0.3.0` so `hook-bridge` is loaded (`pi /skills` should list `stride-claiming-tasks` etc., and Pi's extension-load log should mention `hook-bridge`).
2. In a project with `.stride.md` whose `## after_doing` section runs a guaranteed-failing command (e.g., `exit 1`), claim any throwaway Stride task.
3. Without fixing the failure, attempt `/complete` via the Stride curl. Pi should refuse to send the curl and surface the hook-bridge block reason in the tool result.
4. Fix the `## after_doing` section to a passing command, retry `/complete`, and confirm the curl reaches the API and the task transitions to Review/Done.
5. Capture a screenshot or log excerpt and append it to this document under a `## Manual session log` heading.

Until that section is populated, treat W256 as "validated programmatically; manual end-to-end pending".

## dispatch_agent event-contract verification (W1022)

**Date:** 2026-06-06 · **Pi version:** `@mariozechner/pi-coding-agent@0.67.68`

Separate from the W256 hook-blocking validation above, W1022 verified the `subagent-dispatch` extension's event contract against a live `pi -p` subprocess — the piece W277's reviewer flagged as inferred-but-never-run (see `docs/smoke-test-w277-dispatch-agent.md`).

**Method:** ran `pi --mode json -p --no-session "<trivial prompt>"` directly (throwaway temp dir, no Stride token in the prompt) and captured the raw streamed JSON.

**Verified (live):**
- Pi `--mode json -p` emits newline-delimited JSON in the sequence `session → agent_start → turn_start → message_start → message_end → turn_end → agent_end`.
- The final assistant turn is a **`message_end`** event with `message = { role: "assistant", content: [ { type: "text", text }, ... ] }`.
- This **confirms** `extractMessageText`'s `message_end` filter and `message.content[].text` extraction (gated on `role === "assistant"`) — so a successful dispatch captures the agent's text and does NOT silently return `isError: true` "no messages". The W277 inference was correct; no event-filter code change was required (only the doc comment was updated to record the verified contract).

**Not verified (requires a Pi with a working LLM provider):**
- A content-bearing happy-path dispatch and the `isError`-unset return. The test box's Pi has no usable model — the default Bedrock `anthropic.claude-opus-4-7` returns `AccessDeniedException`, and `--provider google` errors — so the assistant `message_end` came back empty with `stopReason: "error"`.
- The `tool_result_end` event name (no tool call occurred). It is retained in `extractMessageText` as an inert, documented defensive fallback.

See `docs/smoke-test-w277-dispatch-agent.md` → **Status** for the full record and the remaining happy-path sign-off step.
