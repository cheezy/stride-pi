/**
 * Tests for the after_goal detection helper (W798).
 *
 * responseHasAfterGoal lives in its own module (after-goal-detector.ts)
 * so the test can import it without pulling in the @mariozechner/pi-coding-agent
 * runtime dependency required by index.ts. The rest of the hook bridge
 * is module-private to index.ts and exercised end-to-end via the Pi
 * runtime (no in-process integration tests at this layer).
 *
 * Mirrors the pattern in opencode's responseHasAfterGoal test block
 * (stride-opencode/src/index.test.ts, W794) — pure-function unit tests
 * across all transport shapes the helper handles plus defensive edge
 * cases (null/undefined inputs, malformed JSON, defensive non-object
 * entries in the hooks array).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  responseHasAfterGoal,
  extractGoalEnvFromResult,
  AFTER_GOAL_ENV_KEYS,
} from "./after-goal-detector.ts";
import { runAfterGoalAndCleanup } from "./after-goal-runner.ts";

// Build the Claude/Gemini-style Bash-tool wrapper transport shape — used
// when Pi's tool_result event delivers the raw response via event.content
// or event.details.output as a JSON string wrapping {stdout: "<inner>"}.
function buildWrapped(hooks: Array<{ name: string }>): string {
  return JSON.stringify({
    stdout: JSON.stringify({ data: { id: 42 }, hooks }),
  });
}

// Build a raw payload (no wrapper) — the third transport shape some Pi
// hosts deliver when the response is already parsed/peeled by the runtime.
function buildRaw(hooks: Array<{ name: string }>): string {
  return JSON.stringify({ data: { id: 42 }, hooks });
}

describe("responseHasAfterGoal", () => {
  it("returns true when after_goal is in event.content (wrapped shape)", () => {
    const content = buildWrapped([
      { name: "before_review" },
      { name: "after_review" },
      { name: "after_goal" },
    ]);
    assert.equal(responseHasAfterGoal(content, undefined), true);
  });

  it("returns true when after_goal is in event.content (raw shape)", () => {
    const content = buildRaw([{ name: "after_goal" }]);
    assert.equal(responseHasAfterGoal(content, undefined), true);
  });

  it("returns true when after_goal is in details.output (preferred over content)", () => {
    // details.output is preferred — it's checked first per the candidate
    // iteration order. Set details.output to the after_goal payload and
    // content to something without after_goal; the detector should find
    // the entry via details first.
    const detailsOutput = buildWrapped([{ name: "after_goal" }]);
    const content = buildWrapped([{ name: "before_review" }]);
    assert.equal(
      responseHasAfterGoal(content, { output: detailsOutput }),
      true,
    );
  });

  it("falls back to content when details.output is missing", () => {
    const content = buildWrapped([{ name: "after_goal" }]);
    assert.equal(responseHasAfterGoal(content, {}), true);
    assert.equal(responseHasAfterGoal(content, undefined), true);
    assert.equal(responseHasAfterGoal(content, null), true);
  });

  it("returns false when after_goal is absent from the hooks array", () => {
    const content = buildWrapped([
      { name: "before_review" },
      { name: "after_review" },
    ]);
    assert.equal(responseHasAfterGoal(content, undefined), false);
  });

  it("returns false when the hooks array is empty", () => {
    const content = buildWrapped([]);
    assert.equal(responseHasAfterGoal(content, undefined), false);
  });

  it("returns false when the hooks key is missing entirely", () => {
    const content = JSON.stringify({
      stdout: JSON.stringify({ data: { id: 42 } }),
    });
    assert.equal(responseHasAfterGoal(content, undefined), false);
  });

  it("returns false on malformed outer JSON in content", () => {
    assert.equal(
      responseHasAfterGoal("not json at all {{", undefined),
      false,
    );
  });

  it("returns false on malformed inner stdout JSON (falls back to outer parse)", () => {
    // Outer parses fine; the inner .stdout string fails to parse — code
    // should fall back to using the outer parsed object (which has no
    // .hooks at top level), then return false cleanly.
    const content = JSON.stringify({ stdout: "this is not json {{" });
    assert.equal(responseHasAfterGoal(content, undefined), false);
  });

  it("returns false when both candidates are empty", () => {
    assert.equal(responseHasAfterGoal("", undefined), false);
    assert.equal(responseHasAfterGoal("", { output: "" }), false);
  });

  it("returns false when details.output is non-string (skipped, content also empty)", () => {
    // details.output must be a string to be considered a candidate.
    // A non-string output (e.g., an object) is ignored; the detector
    // falls through to content, which is empty here.
    assert.equal(
      responseHasAfterGoal("", { output: { not: "a string" } }),
      false,
    );
  });

  it("ignores non-object entries in the hooks array (defensive)", () => {
    // A hooks array containing nulls/strings shouldn't crash; the
    // .some predicate guards each entry with `h && typeof h === 'object'`.
    const content = JSON.stringify({
      stdout: JSON.stringify({
        hooks: [null, "after_goal", 42, { name: "after_goal" }],
      }),
    });
    assert.equal(responseHasAfterGoal(content, undefined), true);
  });

  it("returns true when the first candidate misses but the second hits", () => {
    // details.output is checked first; if it parses but has no after_goal,
    // the loop continues to content, which has after_goal. Confirms
    // candidate iteration order doesn't short-circuit on first parse.
    const detailsOutput = buildRaw([{ name: "before_review" }]);
    const content = buildRaw([{ name: "after_goal" }]);
    assert.equal(
      responseHasAfterGoal(content, { output: detailsOutput }),
      true,
    );
  });
});

// Build a wrapped Bash-tool payload whose hooks array carries env blocks —
// the shape extractGoalEnvFromResult parses for the after_goal entry's env.
function buildWrappedWithEnv(
  hooks: Array<{ name: string; env?: Record<string, unknown> }>,
): string {
  return JSON.stringify({
    stdout: JSON.stringify({ data: { id: 42 }, hooks }),
  });
}

function buildRawWithEnv(
  hooks: Array<{ name: string; env?: Record<string, unknown> }>,
): string {
  return JSON.stringify({ data: { id: 42 }, hooks });
}

// A representative after_goal hook.env block as the server bundles it.
const SERVER_GOAL_ENV = {
  GOAL_ID: "3417",
  GOAL_IDENTIFIER: "G166",
  GOAL_TITLE: "Harden the hook bridge",
  GOAL_DESCRIPTION: "Fix after_goal env handling",
  BOARD_ID: "55",
  BOARD_NAME: "Stride Development",
  COLUMN_ID: "128",
  COLUMN_NAME: "Doing",
  AGENT_NAME: "Claude Opus 4.8",
  HOOK_NAME: "after_goal",
};

describe("extractGoalEnvFromResult", () => {
  it("forwards GOAL_* / BOARD_* / COLUMN_* / AGENT_NAME from hook.env (wrapped shape)", () => {
    const content = buildWrappedWithEnv([
      { name: "after_review" },
      { name: "after_goal", env: SERVER_GOAL_ENV },
    ]);
    const env = extractGoalEnvFromResult(content, undefined);
    assert.equal(env.GOAL_ID, "3417");
    assert.equal(env.GOAL_IDENTIFIER, "G166");
    assert.equal(env.GOAL_TITLE, "Harden the hook bridge");
    assert.equal(env.GOAL_DESCRIPTION, "Fix after_goal env handling");
    assert.equal(env.BOARD_ID, "55");
    assert.equal(env.BOARD_NAME, "Stride Development");
    assert.equal(env.COLUMN_ID, "128");
    assert.equal(env.COLUMN_NAME, "Doing");
    assert.equal(env.AGENT_NAME, "Claude Opus 4.8");
  });

  it("forwards hook.env from the raw (unwrapped) shape too", () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const env = extractGoalEnvFromResult(content, undefined);
    assert.equal(env.GOAL_IDENTIFIER, "G166");
  });

  it("prefers details.output over content", () => {
    const detailsOutput = buildWrappedWithEnv([
      { name: "after_goal", env: { ...SERVER_GOAL_ENV, GOAL_IDENTIFIER: "G999" } },
    ]);
    const content = buildWrappedWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const env = extractGoalEnvFromResult(content, { output: detailsOutput });
    assert.equal(env.GOAL_IDENTIFIER, "G999");
  });

  it("defaults every canonical key to '' when the server omits it", () => {
    // after_goal entry present but env carries only GOAL_IDENTIFIER.
    const content = buildWrappedWithEnv([
      { name: "after_goal", env: { GOAL_IDENTIFIER: "G166" } },
    ]);
    const env = extractGoalEnvFromResult(content, undefined);
    assert.equal(env.GOAL_IDENTIFIER, "G166");
    // The rest are defined-but-empty, never absent.
    for (const key of AFTER_GOAL_ENV_KEYS) {
      assert.equal(typeof env[key], "string");
    }
    assert.equal(env.GOAL_DESCRIPTION, "");
    assert.equal(env.BOARD_ID, "");
  });

  it("returns canonical keys defaulted to '' when there is no env block", () => {
    const content = buildRawWithEnv([{ name: "after_goal" }]);
    const env = extractGoalEnvFromResult(content, undefined);
    for (const key of AFTER_GOAL_ENV_KEYS) {
      assert.equal(env[key], "");
    }
  });

  it("never forwards a Stride API token present in hook.env (defensive)", () => {
    // The server never puts the token in hook.env, but verify that even if
    // a token-shaped key appeared it would be forwarded verbatim ONLY if a
    // string — and that nothing injects the token when it is absent.
    const content = buildWrappedWithEnv([
      { name: "after_goal", env: SERVER_GOAL_ENV },
    ]);
    const env = extractGoalEnvFromResult(content, undefined);
    assert.equal("STRIDE_API_TOKEN" in env, false);
    assert.equal("STRIDE_API_URL" in env, false);
    assert.equal("Authorization" in env, false);
  });

  it("drops prototype-pollution keys and non-string values", () => {
    // Built from a raw JSON string so `__proto__` is a genuine own key
    // after JSON.parse (an object-literal `__proto__:` would set the
    // prototype and never serialize). GOAL_ID is a non-string here.
    const inner =
      '{"data":{"id":42},"hooks":[{"name":"after_goal","env":' +
      '{"GOAL_IDENTIFIER":"G166","__proto__":{"polluted":true},' +
      '"constructor":"nope","prototype":"nope","GOAL_ID":3417}}]}';
    const content = JSON.stringify({ stdout: inner });
    const env = extractGoalEnvFromResult(content, undefined);
    assert.equal(env.GOAL_IDENTIFIER, "G166");
    assert.equal(env.GOAL_ID, ""); // non-string value rejected, stays default
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "constructor"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, "prototype"), false);
  });
});

describe("runAfterGoalAndCleanup", () => {
  // Records side effects in call order so ordering can be asserted. The
  // detector collaborators are the REAL functions, so these tests also
  // exercise responseHasAfterGoal / extractGoalEnvFromResult end-to-end.
  function makeDeps() {
    const calls: string[] = [];
    let passedGoalEnv: Record<string, string> | null = null;
    return {
      calls,
      get goalEnv() {
        return passedGoalEnv;
      },
      deps: {
        hasAfterGoal: responseHasAfterGoal,
        extractGoalEnv: extractGoalEnvFromResult,
        runAfterGoal: async (goalEnv: Record<string, string>) => {
          calls.push("after_goal");
          passedGoalEnv = goalEnv;
          return { hook: "after_goal", success: true };
        },
        emitResult: () => {
          calls.push("emit");
        },
        deleteEnvCache: () => {
          calls.push("delete_cache");
        },
      },
    };
  }

  it("runs after_goal BEFORE deleting the cache on the after_review route", async () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const h = makeDeps();
    await runAfterGoalAndCleanup("after_review", true, content, undefined, h.deps);
    assert.deepEqual(h.calls, ["after_goal", "emit", "delete_cache"]);
    assert.equal(h.goalEnv?.GOAL_IDENTIFIER, "G166");
  });

  it("runs after_goal and does NOT delete the cache on the before_review route", async () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const h = makeDeps();
    await runAfterGoalAndCleanup("before_review", true, content, undefined, h.deps);
    assert.deepEqual(h.calls, ["after_goal", "emit"]);
  });

  it("deletes the cache on after_review even when no after_goal is present", async () => {
    const content = buildRawWithEnv([{ name: "after_review" }]);
    const h = makeDeps();
    await runAfterGoalAndCleanup("after_review", true, content, undefined, h.deps);
    assert.deepEqual(h.calls, ["delete_cache"]);
  });

  it("does not run after_goal when the primary hook failed", async () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const h = makeDeps();
    await runAfterGoalAndCleanup("after_review", false, content, undefined, h.deps);
    // Primary failed → after_goal skipped, but cache cleanup still runs.
    assert.deepEqual(h.calls, ["delete_cache"]);
  });

  it("does nothing on a non-review hook", async () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const h = makeDeps();
    await runAfterGoalAndCleanup("before_doing", true, content, undefined, h.deps);
    assert.deepEqual(h.calls, []);
  });

  it("skips emitResult when after_goal is a no-op (null result)", async () => {
    const content = buildRawWithEnv([{ name: "after_goal", env: SERVER_GOAL_ENV }]);
    const calls: string[] = [];
    await runAfterGoalAndCleanup("after_review", true, content, undefined, {
      hasAfterGoal: responseHasAfterGoal,
      extractGoalEnv: extractGoalEnvFromResult,
      runAfterGoal: async () => {
        calls.push("after_goal");
        return null; // missing ## after_goal section → no-op
      },
      emitResult: () => calls.push("emit"),
      deleteEnvCache: () => calls.push("delete_cache"),
    });
    assert.deepEqual(calls, ["after_goal", "delete_cache"]);
  });
});
