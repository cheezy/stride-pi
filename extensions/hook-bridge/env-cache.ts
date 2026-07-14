/**
 * Task env-cache key set, type, and the pure claim-time merge policy.
 *
 * Extracted from index.ts so the claim-merge logic can be unit-tested without
 * pulling in the `@mariozechner/pi-coding-agent` runtime that index.ts imports
 * (same pattern as after-goal-detector.ts / hook-result.ts). The fs-backed
 * read/write helpers stay in index.ts; this module owns only the key set, the
 * type, and the pure decision of what to persist on a claim.
 */

export const TASK_ENV_KEYS = [
  "TASK_ID",
  "TASK_IDENTIFIER",
  "TASK_TITLE",
  "TASK_STATUS",
  "TASK_COMPLEXITY",
  "TASK_PRIORITY",
  "TASK_BASE_REF",
  // (D142) Marks a TASK_BASE_REF written by the post-before_doing capture (the
  // task branch point by construction). resolveSnapshotBase's branch-point rule
  // skips a marked base so a workflow that pushes its own task commits before
  // completing stays safe.
  "TASK_BASE_REF_TRUSTED",
] as const;

export type TaskEnv = Partial<Record<(typeof TASK_ENV_KEYS)[number], string>>;

/**
 * Decide what to persist to the env cache when a claim curl is detected (G224 /
 * D142).
 *
 * (D142) This writes task IDENTITY only. `TASK_BASE_REF` is deliberately NOT
 * written at claim: the `## before_doing` section has not run yet, and its
 * `git pull` moves HEAD — a base captured now would anchor the after_doing diff
 * at the PRE-pull commit and span another clone's pulled work (D132/W1678).
 * {@link resolveFinalizeBeforeDoingEnv} writes the base (and the trust marker)
 * after the section finishes. Any inherited `TASK_BASE_REF` /
 * `TASK_BASE_REF_TRUSTED` is stripped so a stale value from a prior task or
 * session can never survive a claim. Returns the `TaskEnv` to write, or `null`
 * for a no-op (empty parse with nothing left to strip).
 *
 * Pure: never mutates its arguments and performs no IO.
 */
export function resolveClaimEnvCache(
  parsedTaskEnv: TaskEnv,
  existing: TaskEnv,
): TaskEnv | null {
  if (Object.keys(parsedTaskEnv).length > 0) {
    // Identity from the parsed claim response; strip any base/trust the parse
    // may have carried (writeEnvCache overwrites the whole file, so this also
    // drops any inherited base already on disk).
    const {
      TASK_BASE_REF: _b,
      TASK_BASE_REF_TRUSTED: _t,
      ...identity
    } = parsedTaskEnv;
    return identity;
  }
  // Empty parse: keep the existing TASK_ identity lines (a later completion can
  // still recover TASK_ID) but strip the inherited base + trust marker.
  const {
    TASK_BASE_REF: _existingBase,
    TASK_BASE_REF_TRUSTED: _existingTrust,
    ...identity
  } = existing;
  return Object.keys(identity).length > 0 ? identity : null;
}

/**
 * (D142) Decide what to persist AFTER the `## before_doing` section runs. The
 * section's `git pull` has moved HEAD to the post-pull branch point, so
 * `baseRef` (the current HEAD) is the correct diff anchor. Preserves the
 * existing identity lines, replaces the base with `baseRef`, and stamps the
 * `TASK_BASE_REF_TRUSTED` marker. Returns `null` when there is no base to write
 * (e.g. a non-git directory) so the caller leaves the identity-only cache
 * intact. Pure: never mutates its arguments and performs no IO.
 */
export function resolveFinalizeBeforeDoingEnv(
  baseRef: string,
  existing: TaskEnv,
): TaskEnv | null {
  if (!baseRef) return null;
  const {
    TASK_BASE_REF: _b,
    TASK_BASE_REF_TRUSTED: _t,
    ...identity
  } = existing;
  return { ...identity, TASK_BASE_REF: baseRef, TASK_BASE_REF_TRUSTED: "1" };
}
