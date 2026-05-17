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
 */

export type StrideHookPhase = "pre" | "post";

export type StrideHookName =
  | "before_doing"
  | "after_doing"
  | "before_review"
  | "after_review";

const CLAIM = /\/api\/tasks\/claim(\b|$|[?#])/;
const COMPLETE = /\/api\/tasks\/[^/\s]+\/complete(\b|$|[?#])/;
const MARK_REVIEWED = /\/api\/tasks\/[^/\s]+\/mark_reviewed(\b|$|[?#])/;

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
