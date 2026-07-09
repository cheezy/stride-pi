import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type AfterGoalDeps,
  runAfterGoalAndCleanup,
} from "./after-goal-runner.ts";
import type { AfterGoalStatus } from "./after-goal-status.ts";

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
