# Hook and dispatch research for stride-pi

This file keeps the runtime evidence behind decisions about fixes that depend on how Pi behaves at run time, so a later port of a stride change can tell what was checked, how, and when. Each finding carries a date, the Pi version it was checked against, and one of three labels:

- **measured** — a command was run here and its output observed;
- **documented** — Pi's own shipped documentation says so;
- **read from code** — the installed Pi package, or this repository, was read at the cited line.

Paths into Pi are relative to its package roots: `pi-coding-agent/` is the CLI package and `pi-agent-core/` is the agent-loop package it depends on (`pi-coding-agent/node_modules/@mariozechner/pi-agent-core/`). Paths without either prefix are in this repository.

## W2254 and W2255: what Pi does while a subagent runs (W2611, 2026-11-03)

Two fixes released in stride 1.81.0 depend on a runtime property:

- **W2254** lets the main agent look through `key_files` and draft its plan during the explorer subagent's run, so that run is not idle time. That needs an explorer invocation that gives the turn back before the explorer finishes.
- **W2255** lets stride's blocking Stop gate allow a stop while one of its own subagents is still running. That needs a Stop gate at all, and an input that says a subagent is running.

### Setup

- **Pi version: 0.67.68** — *measured* with `pi --version` on 2026-11-03; the `package.json` of `pi-coding-agent` and of `pi-agent-core` both say `0.67.68`.
- **No model call was made.** This environment cannot run `pi -p` against a model, so nothing below about how a model behaves is measured. The loop's behaviour is read from code and from Pi's documentation.
- **Code and documentation agree** wherever both speak (findings 3 and 4), and with no observation there is nothing yet for either to disagree with. If a later measurement contradicts the documentation, record the measured result here, labelled *measured*, and let it decide over the documentation.

### Findings

1. **A `dispatch_agent` call stays open until the subagent exits** — *read from code*, 2026-11-03, Pi 0.67.68.
   - `extensions/subagent-dispatch/index.ts:68-70`: the tool's `execute` returns `dispatchAgent(...)`.
   - `extensions/subagent-dispatch/index.ts:109`: `dispatchAgent` does `await runSubprocess(...)`.
   - `extensions/subagent-dispatch/index.ts:152-256`: `runSubprocess` returns a promise that settles only on the child's `close` (`:223`) or `error` (`:215`) event.
   - The tool sets no `executionMode` of its own.

2. **Pi starts the next model turn only after every tool call of the current message has returned** — *read from code*, 2026-11-03, Pi 0.67.68.
   - `pi-agent-core/dist/agent-loop.js:115` awaits `executeToolCalls(...)` for the whole assistant message; `turn_end` is emitted at `:121`, and the next model request (`streamAssistantResponse`, `:103`) is made only on the next pass of the loop.
   - So while a `dispatch_agent` call is running, the model is not asked for anything, and it cannot choose a new tool call.

3. **Tool calls from one assistant message run concurrently by default** — *read from code* and *documented*, 2026-11-03, Pi 0.67.68.
   - `pi-agent-core/dist/agent.js:126` defaults `toolExecution` to `"parallel"`, and `pi-coding-agent` does not override it.
   - `pi-agent-core/dist/agent-loop.js:222-229` takes the sequential path only when `toolExecution` is `"sequential"` or a called tool declares `executionMode: "sequential"`.
   - `pi-agent-core/dist/agent-loop.js:250-277` (the parallel path) prepares each call in turn, starts every runnable call, and only then awaits them, in order.
   - `pi-coding-agent/docs/extensions.md:587` states it: sibling calls from the same assistant message are preflighted one by one and then executed concurrently.
   - Consequence: a read the model emits alongside the `dispatch_agent` call, in one assistant message, runs while the explorer works, but its result reaches the model together with the explorer's summary, at the start of the next turn. Nothing the model plans can use it sooner. Whether a model would batch reads that way was not measured.

4. **Messages typed during a run wait for the turn's tool calls** — *documented* and *read from code*, 2026-11-03, Pi 0.67.68.
   - `pi-coding-agent/README.md:204-205`: a steering message is delivered after the current turn finishes its tool calls, and a follow-up message after all work.
   - `pi-agent-core/dist/agent-loop.js:122` polls steering only after the tool calls return.
   - Neither interleaves with a running `dispatch_agent` call, and this port sends neither kind of message itself.

5. **The inline explorer is sequential by construction** — *read from code*, 2026-11-03, Pi 0.67.68 (the finding rests on this repository's skill text, not on Pi's code).
   - `skills/stride-task-explorer/SKILL.md:12` has the main agent carry out the explorer's instructions itself, in its own context, so there is no second worker to overlap with.

6. **This port has no blocking Stop gate** — *read from code*, 2026-11-03, Pi 0.67.68.
   - `extensions/hook-bridge/index.ts` registers `tool_call` (`:105`), `tool_result` (`:143`) and `before_agent_start` (`:321`) and nothing else. Its one refusal is the `tool_call` veto of a `/complete` curl (`:125-128`), which stops a tool call, not a turn from ending.
   - `pi-coding-agent/dist/core/extensions/types.d.ts:732` (`agent_end`) and `:734` (`turn_end`) register handlers with no result type (`ExtensionHandler<E, R = undefined>`, `:713`), so nothing an extension returns from them can hold the end of a turn. `docs/ADR-002-hook-mechanism.md` section (d) records the same reading for an earlier Pi; the line numbers still match on 0.67.68.
   - `extensions/hook-bridge/advisory-continuation.ts:1-23` describes what happens instead: after a no-review completion, a message is injected at the start of the user's **next** turn (`before_agent_start`). It advises; it never holds a stop open.
   - Since a `dispatch_agent` call holds the turn (findings 1 and 2), no turn ends while a dispatched subagent is running, so there is no moment at which a "subagent still running" signal would matter.

### Decisions

- **W2254: not applicable.** The model gets no turn while `dispatch_agent` runs (findings 1 and 2), and the inline explorer runs in the main context (finding 5), so there is no window in which to read and plan. Batching reads into the dispatch message (finding 3) would only overlap their latency, since they come back alongside the explorer's summary; it is not adopted, and it is unmeasured. Phase 1 of the subagent-workflow skill now states that the port waits for the explorer.
- **W2255: not applicable.** There is no blocking Stop gate here to relax (finding 6), and no event input that lists running subagents. No pending-subagent marker is added to stand in for one.

### Re-measure when

- Pi gives extensions a way to return from a tool call before its work is done (a background or detached tool), or `dispatch_agent` is changed to start the subprocess without awaiting it: W2254 then needs a fresh look.
- Pi gives `turn_end` or `agent_end` a result type, or adds any event that can refuse or delay the end of a turn: W2255, and `docs/ADR-002-hook-mechanism.md`, need a fresh look.
- A model call becomes possible here: findings 2 and 3 can then be **measured** with a throwaway session that dispatches the explorer together with a read, checking when each result arrives.
