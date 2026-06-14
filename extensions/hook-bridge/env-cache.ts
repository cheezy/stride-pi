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
] as const;

export type TaskEnv = Partial<Record<(typeof TASK_ENV_KEYS)[number], string>>;

/**
 * Decide what to persist to the env cache when a claim curl is detected (G224).
 *
 * A claim always opens a new task window, so `TASK_BASE_REF` must be refreshed
 * to the claim-time HEAD on EVERY detected claim — never gated on a successful
 * task-field parse. Returns the `TaskEnv` to write, or `null` for a no-op.
 *
 * - Parsed task fields present → persist them, stamping `TASK_BASE_REF` when a
 *   base ref is resolvable (matching the prior behavior).
 * - Empty parse but a resolvable base ref → preserve the existing `TASK_`
 *   identity lines from the cache and refresh only `TASK_BASE_REF`, so a stale
 *   base ref from a PRIOR claim cannot survive (which would make the after_doing
 *   diff span every commit since that older claim).
 * - Empty parse AND no resolvable base ref (e.g. a non-git directory) → `null`,
 *   leaving the cache untouched.
 *
 * Pure: never mutates its arguments and performs no IO. (The persisted-output
 * jq fallback from the canonical shell hook is N/A here — pi derives the base
 * ref from local git, not from the claim response JSON.)
 */
export function resolveClaimEnvCache(
  parsedTaskEnv: TaskEnv,
  baseRef: string,
  existing: TaskEnv,
): TaskEnv | null {
  if (Object.keys(parsedTaskEnv).length > 0) {
    const env: TaskEnv = { ...parsedTaskEnv };
    if (baseRef) env.TASK_BASE_REF = baseRef;
    return env;
  }
  if (!baseRef) return null;
  return { ...existing, TASK_BASE_REF: baseRef };
}
