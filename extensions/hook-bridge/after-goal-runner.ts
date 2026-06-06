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
}

/**
 * Given the just-completed primary hook and the response payload, run the
 * after_goal hook (when present and the primary succeeded) and then clean
 * up the env cache. Ordering is the whole point: cleanup never precedes
 * after_goal.
 *
 * Gated on: post-phase review hook (before_review from /complete,
 * after_review from /mark_reviewed), primary success, and an after_goal
 * entry in the response payload. A missing `## after_goal` section makes
 * runAfterGoal return null (clean no-op).
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
  if (
    (hook === "before_review" || hook === "after_review") &&
    primarySucceeded &&
    deps.hasAfterGoal(content, details)
  ) {
    const goalEnv = deps.extractGoalEnv(content, details);
    const result = await deps.runAfterGoal(goalEnv);
    if (result) deps.emitResult(result);
  }

  // Clean up the env cache AFTER after_goal runs — never before. after_goal
  // piggy-backs on after_review's lifecycle when present, so this gate
  // stays on after_review (mirrors stride-hook.sh:627-630).
  if (hook === "after_review") {
    deps.deleteEnvCache();
  }
}
