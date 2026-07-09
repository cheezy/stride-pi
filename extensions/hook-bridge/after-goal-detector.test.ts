import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type CanonicalReader,
  extractGoalEnvFromResult,
  responseHasAfterGoal,
  toolOutputCandidates,
} from "./after-goal-detector.ts";
import {
  readCanonicalResponse,
  writeCanonicalResponse,
} from "./after-goal-status.ts";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-agd-"));
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mktemp();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A complete /complete-style response whose hooks[] carries an after_goal entry. */
function afterGoalResponse(env: Record<string, string>): string {
  return JSON.stringify({
    data: { id: 4977, status: "completed" },
    hooks: [
      { name: "after_doing", env: {} },
      { name: "before_review", env: {} },
      { name: "after_goal", env },
    ],
  });
}

const FULL = afterGoalResponse({
  GOAL_ID: "4975",
  GOAL_IDENTIFIER: "G17",
  GOAL_TITLE: "Ship it",
});

// A harness-truncated candidate: cut before the after_goal entry appears, so it
// is invalid JSON AND carries no after_goal — exactly the payload D118 rescues.
const TRUNCATED = FULL.slice(0, FULL.indexOf("after_goal"));

describe("toolOutputCandidates", () => {
  it("prefers details.output, then content", () => {
    assert.deepEqual(toolOutputCandidates("C", { output: "O" }), ["O", "C"]);
  });

  it("falls back to content when details has no output", () => {
    assert.deepEqual(toolOutputCandidates("C", {}), ["C"]);
    assert.deepEqual(toolOutputCandidates("C", null), ["C"]);
  });

  it("drops empty strings and yields [] when both are empty", () => {
    assert.deepEqual(toolOutputCandidates("", { output: "O" }), ["O"]);
    assert.deepEqual(toolOutputCandidates("", {}), []);
  });
});

describe("canonical-file preference (read side)", () => {
  it("detects after_goal from the file when the candidates are truncated", () => {
    const reader: CanonicalReader = () => FULL;
    // Truncated candidates alone: not detected (proves the file is decisive).
    assert.equal(responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }), false);
    // File consulted first: detected.
    assert.equal(
      responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader),
      true,
    );
  });

  it("reads GOAL_* env from the file under truncated candidates", () => {
    const reader: CanonicalReader = () => FULL;
    const env = extractGoalEnvFromResult(TRUNCATED, { output: TRUNCATED }, reader);
    assert.equal(env.GOAL_ID, "4975");
    assert.equal(env.GOAL_IDENTIFIER, "G17");
    assert.equal(env.GOAL_TITLE, "Ship it");
    // Canonical keys the server omitted default to "" (defined-but-empty).
    assert.equal(env.BOARD_ID, "");
  });

  it("back-compat: detects from candidates alone when no reader is supplied", () => {
    assert.equal(responseHasAfterGoal(FULL, { output: FULL }), true);
    assert.equal(
      extractGoalEnvFromResult(FULL, { output: FULL }).GOAL_ID,
      "4975",
    );
  });

  it("back-compat: a reader returning null (absent/invalid file) falls back to candidates", () => {
    const reader: CanonicalReader = () => null;
    assert.equal(responseHasAfterGoal(FULL, { output: FULL }, reader), true);
    assert.equal(
      responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader),
      false,
    );
  });

  it("still finds a real entry in the candidates when the file lacks after_goal", () => {
    // File is a valid response WITHOUT an after_goal entry; the current
    // candidates carry the real one. File-first must not mask the fallback.
    const noGoalFile = JSON.stringify({ data: {}, hooks: [{ name: "before_review" }] });
    const reader: CanonicalReader = () => noGoalFile;
    assert.equal(responseHasAfterGoal(FULL, { output: FULL }, reader), true);
  });
});

describe("canonical-file preference with the real fs functions", () => {
  it("detects + reads env under a truncated output with a present file", () => {
    withTmp((dir) => {
      assert.equal(writeCanonicalResponse(dir, FULL), true);
      const reader: CanonicalReader = () => readCanonicalResponse(dir);
      assert.equal(
        responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader),
        true,
      );
      const env = extractGoalEnvFromResult(TRUNCATED, { output: TRUNCATED }, reader);
      assert.equal(env.GOAL_ID, "4975");
      assert.equal(env.GOAL_TITLE, "Ship it");
    });
  });

  it("an invalid-JSON file is ignored and detection falls back to candidates", () => {
    withTmp((dir) => {
      fs.mkdirSync(path.join(dir, ".stride"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".stride", ".last-api-response.json"),
        "{truncated-garbage",
      );
      const reader: CanonicalReader = () => readCanonicalResponse(dir);
      // Unusable file + full candidates → detected via fallback.
      assert.equal(responseHasAfterGoal(FULL, { output: FULL }, reader), true);
      // Unusable file + truncated candidates → not detected.
      assert.equal(
        responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader),
        false,
      );
    });
  });
});

// Mirrors index.ts's capture loop: write the first complete-valid-JSON
// tool-output candidate to the canonical file.
function capture(dir: string, content: string, details: unknown): void {
  for (const raw of toolOutputCandidates(content, details)) {
    if (writeCanonicalResponse(dir, raw)) break;
  }
}

describe("capture semantics (write side, mirroring index.ts)", () => {
  it("a valid current output overwrites a stale prior-call file", () => {
    withTmp((dir) => {
      assert.equal(writeCanonicalResponse(dir, afterGoalResponse({ GOAL_ID: "1" })), true);
      const current = afterGoalResponse({ GOAL_ID: "4975" });
      capture(dir, current, { output: current });
      const env = extractGoalEnvFromResult("", {}, () => readCanonicalResponse(dir));
      assert.equal(env.GOAL_ID, "4975");
    });
  });

  it("a truncated current output does not clobber a good file", () => {
    withTmp((dir) => {
      const good = afterGoalResponse({ GOAL_ID: "4975" });
      assert.equal(writeCanonicalResponse(dir, good), true);
      capture(dir, TRUNCATED, { output: TRUNCATED });
      const env = extractGoalEnvFromResult("", {}, () => readCanonicalResponse(dir));
      assert.equal(env.GOAL_ID, "4975");
    });
  });
});

// W1644: detection/env edge cases pinning the fast-path decision.
describe("detection edge cases (W1644)", () => {
  it("GOAL_ID omitted from the after_goal env defaults to '' (defined-but-empty)", () => {
    // The detector forwards the server env verbatim and defaults every
    // canonical key the server omitted to "" — never absent — so a `set -u`
    // ## after_goal referencing $GOAL_ID does not abort. (The goalId-based
    // fallback is the fresh-GET path's job, exercised in after-goal-runner.)
    const fileNoId = afterGoalResponse({ GOAL_TITLE: "No id here" });
    const env = extractGoalEnvFromResult(TRUNCATED, { output: TRUNCATED }, () => fileNoId);
    assert.equal(env.GOAL_TITLE, "No id here");
    assert.equal(env.GOAL_ID, "");
    assert.equal(env.GOAL_IDENTIFIER, "");
  });

  it("a present file WITHOUT an after_goal entry is not a false positive", () => {
    // File-first must not manufacture an after_goal from an unrelated response.
    const noGoal = JSON.stringify({ data: { id: 1 }, hooks: [{ name: "before_review" }] });
    const reader: CanonicalReader = () => noGoal;
    assert.equal(responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader), false);
    const env = extractGoalEnvFromResult(TRUNCATED, { output: TRUNCATED }, reader);
    assert.equal(env.GOAL_ID, "");
  });

  it("a completely absent hooks array is not a false positive", () => {
    const reader: CanonicalReader = () => JSON.stringify({ data: {}, ok: true });
    assert.equal(responseHasAfterGoal(TRUNCATED, { output: TRUNCATED }, reader), false);
  });
});
