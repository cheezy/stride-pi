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

// Captures the task id from a /complete or /mark_reviewed URL. Reuses the
// COMPLETE/MARK_REVIEWED path shape but restricts the id segment to the two
// forms the server resolves: a numeric database id ([0-9]+) or a task
// identifier ([GWD][0-9]+, e.g. W2185). Any other segment must NOT match, so
// the caller falls back to the env-cache id (see taskIdFromCommand). The
// closed character class is what keeps the captured value safe to interpolate
// into the changed_files PUT path: no slash, dot, percent, query or fragment
// can reach it (D309).
const TASK_ID_FROM_COMMAND =
  /\/api\/tasks\/([0-9]+|[GWD][0-9]+)\/(?:complete|mark_reviewed)(\b|$|[?#])/;

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
 * Extracts the authoritative task id from a /complete or /mark_reviewed command
 * URL (…/api/tasks/<id>/complete). Returns the numeric id or the identifier
 * (G/W/D plus digits) exactly as written, or "" when the command is not a
 * completion call or the id segment is neither form. The identifier form
 * matters because the server accepts it: without it, /api/tasks/W2185/complete
 * fell through to the env-cache id, which is stale when the claim response was
 * concealed, and the diff was PUT against the previous task (D309).
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
