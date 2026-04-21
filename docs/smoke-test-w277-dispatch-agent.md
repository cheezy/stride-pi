# Smoke test — dispatch_agent extension (W277)

**Date filed:** 2026-04-21
**Scope:** One manual verification step that was deferred during W277. The `dispatch_agent` extension is structurally correct and parses cleanly, but has never been run against a live `pi -p` subprocess. This doc walks you through that verification.

## Why this test exists

W277's reviewer approved the extension with one Important caveat: the JSON event-type names that `extractMessageText` filters on (`message_end`, `tool_result_end`) and the tool's return-value shape (`{ content, isError? }`) were inferred from Pi's type definitions and the built-in subagent example — they weren't verified against an actual Pi run. If Pi emits different event names or expects a different return shape, `dispatch_agent` will silently return `isError: true` with "subprocess produced no messages" even though the subprocess ran fine.

Five minutes of live testing confirms the contract in both directions or tells you exactly what needs to change.

## Install with the extension

```bash
curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash -s -- --with-extension
```

Expected output ends with:

```
Installed:
  Skills:     11 skills
  Extensions: 1 extension(s)
```

Restart Pi. At startup, the `[Extensions]` line (or similar) should mention `subagent-dispatch`. The `[Skills]` line still lists the 11 skills (7 core + 4 inline subagent skills).

## Run the smoke test

In any Pi session:

```
dispatch_agent({agent: "stride-task-explorer", prompt: "List the files in stride-pi/skills/ and describe what each one does in one sentence."})
```

### Expected outcomes

| Result | Diagnosis | What to do |
|---|---|---|
| Returns a multi-paragraph description of the 7+4 skills | **Works.** Event names and return shape are both correct. Flip this doc's status to "verified." | Done. Update ADR-001 or add a one-line note in this file's Status section. |
| Returns `isError: true` with "subprocess produced no messages" | **Event-type names are wrong.** The subprocess ran but `extractMessageText` didn't recognize any events. | See [Fix A](#fix-a-event-type-names) below. |
| Returns `isError: true` with "failed to spawn subprocess" | **Pi isn't on PATH** in the subprocess env, or `getPiInvocation` resolved to the wrong command. | See [Fix B](#fix-b-spawn-fails) below. |
| Returns `isError: true` with "subprocess exited with code X" and non-empty stderr | **Pi rejected our flags.** Likely `--mode json`, `-p`, `--no-session`, or `--append-system-prompt` is wrong for this Pi version. | See [Fix C](#fix-c-pi-flags) below. |
| Pi refuses to register the tool at startup | **Tool registration shape is wrong** — Pi's `ToolDefinition` type rejected our object. | See [Fix D](#fix-d-tool-registration) below. |
| Pi tool invocation works but Pi complains about the return shape | **Return type is wrong** — Pi expects `{ output }` or similar, not `{ content, isError }`. | See [Fix E](#fix-e-return-shape) below. |

## Fixes

All code references are in `/Users/cheezy/dev/elixir/kanban/stride-pi/extensions/subagent-dispatch/index.ts`.

### Fix A — Event type names

The filter lives in `extractMessageText`, around line 260:

```ts
if (rec.type !== "message_end" && rec.type !== "tool_result_end") {
  return null;
}
```

To find the real names, run `pi --mode json -p --no-session "say hi"` directly in a shell and capture the raw JSON output (one object per line). Look at the `type` field on the assistant-message event. Update the filter to match.

### Fix B — Spawn fails

Debug by logging `invocation.command` and `invocation.args` before spawn. The `getPiInvocation` helper is around line 150. If the fallback to `command: "pi"` is reached but your `pi` is at a non-standard path, either prepend Pi's install dir to PATH or hard-code the `command` in a local config.

### Fix C — Pi flags

Run `pi --help` and `pi -p --help` on the installed Pi version and check whether `--mode json`, `--append-system-prompt`, and `--no-session` still exist with the same names and semantics. If flag names changed, update the `getPiInvocation` call site (around line 100) in the `dispatchAgent` function.

### Fix D — Tool registration

Inspect the exact error Pi prints at tool-registration time. Compare the `pi.registerTool({...})` call (around line 63) against Pi's current `ToolDefinition` TypeScript interface in its installed `types.d.ts`. Likely missing or renamed fields.

### Fix E — Return shape

Look at the built-in subagent example at `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/examples/extensions/subagent/index.ts` and confirm what shape its `execute` returns. Adjust `dispatchAgent`'s return type and its callers accordingly.

## If everything works

Commit a small update to this file adding:

```markdown
## Status

Verified 2026-MM-DD against Pi <version>. No changes required.
```

And optionally update `docs/ADR-001-subagent-model.md`'s Status line from "Shipped via W277 on 2026-04-20" to "Shipped and verified via W277 on 2026-MM-DD."

## If a fix is needed

Open a new Stride defect referencing this smoke test as the discovery context. Link the defect here and in the ADR. Apply the fix to `index.ts`, reinstall with `--with-extension`, and re-run the smoke test until the happy path above succeeds.
