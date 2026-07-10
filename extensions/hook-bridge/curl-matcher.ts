/**
 * Detects Stride API calls inside a bash command string and maps them to
 * the .stride.md hook section that should fire.
 *
 * Routing mirrors stride-gemini/hooks/stride-hook.sh:
 *
 *   pre  + /api/tasks/:id/complete       -> after_doing   (blocking — vetoes /complete)
 *   post + /api/tasks/claim              -> before_doing  (non-blocking)
 *   post + /api/tasks/:id/complete       -> before_review (non-blocking)
 *   post + /api/tasks/:id/mark_reviewed  -> after_review  (non-blocking)
 *
 * The fifth hook, after_goal, is NOT routed from a URL here — detectStrideHook
 * never returns it. It is response-payload-driven: after-goal-detector.ts fires
 * it when the /complete or /mark_reviewed response bundles an after_goal entry.
 * StrideHookName still includes after_goal because HOOK_TIMEOUTS_MS and the
 * runner key on the full five-hook set.
 */

export type StrideHookPhase = "pre" | "post";

export type StrideHookName =
  | "before_doing"
  | "after_doing"
  | "before_review"
  | "after_review"
  | "after_goal";

const CLAIM = /\/api\/tasks\/claim(\b|$|[?#])/;
const COMPLETE = /\/api\/tasks\/[^/\s]+\/complete(\b|$|[?#])/;
const MARK_REVIEWED = /\/api\/tasks\/[^/\s]+\/mark_reviewed(\b|$|[?#])/;

// Captures the bare numeric task id from a /complete or /mark_reviewed URL.
// Reuses the COMPLETE/MARK_REVIEWED path shape but restricts the id segment to
// digits ([0-9]+): a non-numeric segment must NOT match, so the caller falls
// back to the env-cache id (see taskIdFromCommand).
const TASK_ID_FROM_COMMAND =
  /\/api\/tasks\/([0-9]+)\/(?:complete|mark_reviewed)(\b|$|[?#])/;

export function detectStrideHook(
  phase: StrideHookPhase,
  command: string,
): StrideHookName | null {
  if (!command) return null;

  if (phase === "pre") {
    return COMPLETE.test(command) ? "after_doing" : null;
  }

  // post
  if (CLAIM.test(command)) return "before_doing";
  if (MARK_REVIEWED.test(command)) return "after_review";
  if (COMPLETE.test(command)) return "before_review";
  return null;
}

/**
 * Extracts the authoritative numeric task id from a /complete or /mark_reviewed
 * command URL (…/api/tasks/<id>/complete). Returns the bare numeric id, or ""
 * when the command is not a completion call or the id segment is non-numeric.
 *
 * Mirrors task_id_from_command in stride/hooks/stride-hook.sh (D127): the id is
 * a pure parse of the command already in hand — no network call. It targets the
 * changed_files PUT so a stale env-cache TASK_ID cannot misroute the diff. The
 * claim/next paths carry no id and return "", so the caller falls back to the
 * env-cache id only on the claim path.
 */
export function taskIdFromCommand(command: string): string {
  if (!command) return "";
  const match = command.match(TASK_ID_FROM_COMMAND);
  return match ? match[1] : "";
}
