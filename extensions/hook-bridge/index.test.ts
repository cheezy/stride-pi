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

import { responseHasAfterGoal } from "./after-goal-detector.ts";

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
