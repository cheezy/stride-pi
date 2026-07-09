import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type AfterGoalDeps,
  runAfterGoalAndCleanup,
} from "./after-goal-runner.ts";
import {
  type AfterGoalStatus,
  readCanonicalResponse,
  writeCanonicalResponse,
} from "./after-goal-status.ts";
import {
  extractGoalEnvFromResult,
  responseHasAfterGoal,
} from "./after-goal-detector.ts";

type Res = { hook: string; success: boolean };

/**
 * Deps that record side effects in call order. The fast path detector
 * defaults to "found nothing" (hasAfterGoal → false), i.e. the truncated-
 * output + no-file case D119 rescues; individual tests override as needed.
 */
function makeDeps(overrides: Partial<AfterGoalDeps<Res>> = {}) {
  const calls: string[] = [];
  const goalEnvs: Record<string, string>[] = [];
  const deps: AfterGoalDeps<Res> = {
    hasAfterGoal: () => false,
    extractGoalEnv: () => ({}),
    runAfterGoal: async (goalEnv) => {
      calls.push("after_goal");
      goalEnvs.push(goalEnv);
      return { hook: "after_goal", success: true };
    },
    emitResult: () => calls.push("emit"),
    deleteEnvCache: () => calls.push("delete_cache"),
    ...overrides,
  };
  return { calls, goalEnvs, deps };
}

function status(partial: Partial<AfterGoalStatus>): AfterGoalStatus {
  return { armed: false, goalId: null, env: {}, ...partial };
}

describe("runAfterGoalAndCleanup — D119 fresh-GET fallback", () => {
  it("runs after_goal from a stubbed armed GET when the fast path finds nothing", async () => {
    const h = makeDeps({
      freshAfterGoalStatus: async () =>
        status({ armed: true, goalId: 4975, env: { GOAL_ID: "4975", GOAL_TITLE: "Ship it" } }),
    });
    // content/details empty = fully truncated output, and hasAfterGoal → false
    // = no canonical file. Only the fresh GET can arm after_goal here.
    await runAfterGoalAndCleanup("before_review", true, "", undefined, h.deps);
    assert.deepEqual(h.calls, ["after_goal", "emit"]);
    assert.equal(h.goalEnvs[0].GOAL_ID, "4975");
    assert.equal(h.goalEnvs[0].GOAL_TITLE, "Ship it");
  });

  it("does not run after_goal when the fresh status is disarmed (armed=false)", async () => {
    const h = makeDeps({ freshAfterGoalStatus: async () => status({ armed: false }) });
    await runAfterGoalAndCleanup("before_review", true, "", undefined, h.deps);
    assert.deepEqual(h.calls, []);
  });

  it("no-ops when the endpoint is unreachable (freshAfterGoalStatus → null)", async () => {
    const h = makeDeps({ freshAfterGoalStatus: async () => null });
    await runAfterGoalAndCleanup("after_review", true, "", undefined, h.deps);
    // No after_goal, but the after_review cache cleanup still runs.
    assert.deepEqual(h.calls, ["delete_cache"]);
  });

  it("de-dups: the fast path and the fresh GET never both run", async () => {
    let freshCalled = false;
    const h = makeDeps({
      hasAfterGoal: () => true,
      extractGoalEnv: () => ({ GOAL_ID: "from-fast-path" }),
      freshAfterGoalStatus: async () => {
        freshCalled = true;
        return status({ armed: true, env: { GOAL_ID: "from-fresh" } });
      },
    });
    await runAfterGoalAndCleanup("before_review", true, "x", undefined, h.deps);
    assert.equal(freshCalled, false, "fresh GET must not be called once the fast path fires");
    assert.deepEqual(h.calls, ["after_goal", "emit"]);
    assert.equal(h.goalEnvs[0].GOAL_ID, "from-fast-path");
  });

  it("GOAL_ID omitted from the server env falls back to the status goalId", async () => {
    const h = makeDeps({
      freshAfterGoalStatus: async () =>
        status({ armed: true, goalId: 4975, env: { GOAL_TITLE: "No id in env" } }),
    });
    await runAfterGoalAndCleanup("before_review", true, "", undefined, h.deps);
    assert.equal(h.goalEnvs[0].GOAL_ID, "4975");
    assert.equal(h.goalEnvs[0].GOAL_TITLE, "No id in env");
  });

  it("does not consult the fresh GET when the primary hook failed", async () => {
    let freshCalled = false;
    const h = makeDeps({
      freshAfterGoalStatus: async () => {
        freshCalled = true;
        return status({ armed: true });
      },
    });
    await runAfterGoalAndCleanup("after_review", false, "", undefined, h.deps);
    assert.equal(freshCalled, false);
    assert.deepEqual(h.calls, ["delete_cache"]);
  });

  it("does not consult the fresh GET on a non-review hook", async () => {
    let freshCalled = false;
    const h = makeDeps({
      freshAfterGoalStatus: async () => {
        freshCalled = true;
        return status({ armed: true });
      },
    });
    await runAfterGoalAndCleanup("before_doing", true, "", undefined, h.deps);
    assert.equal(freshCalled, false);
    assert.deepEqual(h.calls, []);
  });

  it("back-compat: with no freshAfterGoalStatus dep, an undetected fast path is a no-op", async () => {
    const h = makeDeps(); // no fresh dep at all → pre-D119 behavior
    await runAfterGoalAndCleanup("before_review", true, "", undefined, h.deps);
    assert.deepEqual(h.calls, []);
  });

  it("skips emitResult when the fresh-armed after_goal is a no-op (null result)", async () => {
    const calls: string[] = [];
    await runAfterGoalAndCleanup("before_review", true, "", undefined, {
      hasAfterGoal: () => false,
      extractGoalEnv: () => ({}),
      runAfterGoal: async () => {
        calls.push("after_goal");
        return null; // missing ## after_goal section
      },
      emitResult: () => calls.push("emit"),
      deleteEnvCache: () => calls.push("delete_cache"),
      freshAfterGoalStatus: async () => status({ armed: true, env: { GOAL_ID: "1" } }),
    });
    assert.deepEqual(calls, ["after_goal"]);
  });
});

// ---------------------------------------------------------------------------
// W1644: end-to-end after_goal reliability across the three pure modules.
// These drive runAfterGoalAndCleanup with the REAL detector functions
// (responseHasAfterGoal / extractGoalEnvFromResult) wired to a REAL canonical
// file (readCanonicalResponse over a tmp cwd), plus a stubbed fresh GET —
// exactly index.ts's production wiring, minus index.ts (un-importable). This
// locks the full decision path under truncation, testable only via the
// extracted pure modules.
// ---------------------------------------------------------------------------

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-e2e-"));
}

function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mktemp();
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function afterGoalResponse(env: Record<string, string>): string {
  return JSON.stringify({
    data: { id: 4979, status: "completed" },
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
// A harness-truncated candidate: cut before the after_goal entry — invalid
// JSON, carrying no after_goal. This is the payload the file/GET must rescue.
const TRUNCATED = FULL.slice(0, FULL.indexOf("after_goal"));

/**
 * Deps wired exactly like index.ts: the real detector functions read the
 * canonical file FIRST (via readCanonicalResponse over `cwd`), and an optional
 * stubbed fresh GET provides the D119 fallback. Records side effects in order.
 */
function e2eDeps(cwd: string, freshAfterGoalStatus?: () => Promise<AfterGoalStatus | null>) {
  const calls: string[] = [];
  const goalEnvs: Record<string, string>[] = [];
  const canonicalReader = () => readCanonicalResponse(cwd);
  const deps: AfterGoalDeps<Res> = {
    hasAfterGoal: (content, details) => responseHasAfterGoal(content, details, canonicalReader),
    extractGoalEnv: (content, details) =>
      extractGoalEnvFromResult(content, details, canonicalReader),
    runAfterGoal: async (goalEnv) => {
      calls.push("after_goal");
      goalEnvs.push(goalEnv);
      return { hook: "after_goal", success: true };
    },
    emitResult: () => calls.push("emit"),
    deleteEnvCache: () => calls.push("delete_cache"),
    freshAfterGoalStatus,
  };
  return { calls, goalEnvs, deps };
}

describe("end-to-end after_goal reliability (detector + runner + canonical file)", () => {
  it("truncated output + present file => detected, GOAL_* extracted, run decision fires", async () => {
    await withTmp(async (dir) => {
      assert.equal(writeCanonicalResponse(dir, FULL), true);
      const h = e2eDeps(dir);
      // Fully truncated output; only the canonical file carries after_goal.
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, h.deps);
      assert.deepEqual(h.calls, ["after_goal", "emit"]);
      assert.equal(h.goalEnvs[0].GOAL_ID, "4975");
      assert.equal(h.goalEnvs[0].GOAL_IDENTIFIER, "G17");
      assert.equal(h.goalEnvs[0].GOAL_TITLE, "Ship it");
    });
  });

  it("no file + truncated output => stubbed GET path fires (no false positive from the empty file)", async () => {
    await withTmp(async (dir) => {
      // No canonical file written; the fast path must find nothing and the
      // fresh GET must supply the armed decision.
      const h = e2eDeps(dir, async () => ({
        armed: true,
        goalId: 4975,
        env: { GOAL_ID: "4975", GOAL_TITLE: "Ship it" },
      }));
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, h.deps);
      assert.deepEqual(h.calls, ["after_goal", "emit"]);
      assert.equal(h.goalEnvs[0].GOAL_ID, "4975");
    });
  });

  it("no-false-positive control: no file + truncated output + disarmed GET => no run", async () => {
    await withTmp(async (dir) => {
      const h = e2eDeps(dir, async () => ({ armed: false, goalId: null, env: {} }));
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, h.deps);
      assert.deepEqual(h.calls, []);
    });
  });

  it("no-false-positive control: no file + truncated output + no fresh dep => no run", async () => {
    await withTmp(async (dir) => {
      const h = e2eDeps(dir); // no fresh GET at all
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, h.deps);
      assert.deepEqual(h.calls, []);
    });
  });

  it("de-dup: with a present file the fresh GET is never consulted", async () => {
    await withTmp(async (dir) => {
      assert.equal(writeCanonicalResponse(dir, FULL), true);
      let freshCalled = false;
      const h = e2eDeps(dir, async () => {
        freshCalled = true;
        return { armed: true, goalId: 9, env: { GOAL_ID: "9" } };
      });
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, h.deps);
      assert.equal(freshCalled, false);
      assert.equal(h.goalEnvs[0].GOAL_ID, "4975"); // from the file, not the fresh GET
    });
  });

  it("missing ## after_goal section => clean no-op (runs, null result, no emit)", async () => {
    await withTmp(async (dir) => {
      assert.equal(writeCanonicalResponse(dir, FULL), true);
      const calls: string[] = [];
      const canonicalReader = () => readCanonicalResponse(dir);
      await runAfterGoalAndCleanup("before_review", true, TRUNCATED, { output: TRUNCATED }, {
        hasAfterGoal: (c, d) => responseHasAfterGoal(c, d, canonicalReader),
        extractGoalEnv: (c, d) => extractGoalEnvFromResult(c, d, canonicalReader),
        runAfterGoal: async () => {
          calls.push("after_goal");
          return null; // no ## after_goal section configured
        },
        emitResult: () => calls.push("emit"),
        deleteEnvCache: () => calls.push("delete_cache"),
      });
      // Detected from the file and runAfterGoal was invoked, but the null
      // result means no emit; the before_review route leaves the cache alone.
      assert.deepEqual(calls, ["after_goal"]);
    });
  });
});
