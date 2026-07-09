/**
 * Orchestrates the post-primary-hook sequence for the after_goal
 * lifecycle: run `## after_goal` (when the server bundled one) FIRST,
 * then clean up the env cache. Mirrors stride-hook.sh ordering
 * (lines 603-630): the cache cleanup gate on after_review fires only
 * AFTER the after_goal block, so after_goal always runs with its env
 * intact on the mark_reviewed route.
 *
 * Pure orchestration with no module imports — every collaborator (the
 * after_goal detector, the env extractor, the hook runner, the cache
 * delete) is injected. This keeps the ordering unit-testable with stubs
 * under plain `node --test` without pulling in the
 * @mariozechner/pi-coding-agent runtime dependency or any sibling module.
 */

// Type-only import (erased at runtime, so it never triggers the .js→.ts
// resolution that a value import of the fs-backed module would under
// `node --test`). Gives the fresh-GET dep its server-truth status shape.
import type { AfterGoalStatus } from "./after-goal-status.js";

export interface AfterGoalDeps<R> {
  /** True when the response payload carries an `after_goal` entry. */
  hasAfterGoal: (content: string, details: unknown) => boolean;
  /** Extract the GOAL_* / board-context env the server bundled, verbatim. */
  extractGoalEnv: (content: string, details: unknown) => Record<string, string>;
  /** Run the `## after_goal` section with the forwarded goal env. */
  runAfterGoal: (goalEnv: Record<string, string>) => Promise<R | null>;
  /** Emit the structured JSON result on stdout (cross-plugin shape). */
  emitResult: (result: R) => void;
  /** Delete the `.stride-env-cache` file. */
  deleteEnvCache: () => void;
  /**
   * D119 reliability guarantee: an independent, server-truth after_goal
   * status GET (getAfterGoalStatus, wired in index.ts). Consulted ONLY when
   * the fast path (canonical file / intercepted output) detected nothing, so
   * the two sources never both fire. Optional — omitting it preserves the
   * pre-D119 fast-path-only behavior. Returns the status, or null when the
   * caller cannot form the request (missing task id / creds).
   */
  freshAfterGoalStatus?: () => Promise<AfterGoalStatus | null>;
}

/**
 * Given the just-completed primary hook and the response payload, run the
 * after_goal hook (when present and the primary succeeded) and then clean
 * up the env cache. Ordering is the whole point: cleanup never precedes
 * after_goal.
 *
 * Gated on: post-phase review hook (before_review from /complete,
 * after_review from /mark_reviewed) and primary success. after_goal is
 * detected from the fast path (canonical file / intercepted output) first;
 * when the fast path finds nothing, an optional independent server-truth GET
 * (`freshAfterGoalStatus`, D119) is consulted, de-duped so after_goal runs at
 * most once. A missing `## after_goal` section makes runAfterGoal return null
 * (clean no-op); a disarmed/unreachable fresh status is likewise a no-op.
 *
 * @param hook            the primary hook that just ran (post-phase)
 * @param primarySucceeded whether the primary hook succeeded (or was a no-op)
 * @param content         event.content (raw stdout candidate)
 * @param details         event.details (structured candidate)
 * @param deps            injected side-effecting collaborators
 */
export async function runAfterGoalAndCleanup<R>(
  hook: string,
  primarySucceeded: boolean,
  content: string,
  details: unknown,
  deps: AfterGoalDeps<R>,
): Promise<void> {
  if ((hook === "before_review" || hook === "after_review") && primarySucceeded) {
    // Fast path: an after_goal entry is present in the canonical file or the
    // intercepted output. `ran` is the run-once guard — once the fast path
    // fires after_goal, the fresh GET below is skipped entirely, so after_goal
    // runs at most once per completion.
    let ran = false;
    if (deps.hasAfterGoal(content, details)) {
      const goalEnv = deps.extractGoalEnv(content, details);
      const result = await deps.runAfterGoal(goalEnv);
      if (result) deps.emitResult(result);
      ran = true;
    }

    // D119 reliability guarantee: the intercepted output/file is the
    // truncatable value, so when the fast path found nothing, fall back to an
    // independent server-truth GET. De-duped against the fast path by the
    // `!ran` guard. Best-effort: a disarmed or unreachable status (armed=false
    // or null) is a clean no-op — never a hard failure.
    if (!ran && deps.freshAfterGoalStatus) {
      const status = await deps.freshAfterGoalStatus();
      if (status && status.armed) {
        const goalEnv = { ...status.env };
        // GOAL_ID fallback: when the server env omits GOAL_ID, derive it from
        // the status goalId so the after_goal hook and its downstream PATCH
        // still carry the goal identity.
        if (!goalEnv.GOAL_ID && status.goalId != null) {
          goalEnv.GOAL_ID = String(status.goalId);
        }
        const result = await deps.runAfterGoal(goalEnv);
        if (result) deps.emitResult(result);
      }
    }
  }

  // Clean up the env cache AFTER after_goal runs — never before. after_goal
  // piggy-backs on after_review's lifecycle when present, so this gate
  // stays on after_review (mirrors stride-hook.sh:627-630).
  if (hook === "after_review") {
    deps.deleteEnvCache();
  }
}
