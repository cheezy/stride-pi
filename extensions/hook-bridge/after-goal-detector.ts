/**
 * Detect an `after_goal` entry in a Pi tool_result event's response
 * payload, and extract the GOAL_* / board-context env that entry carries.
 * Mirrors stride-hook.sh:response_has_after_goal (W504) and opencode's
 * responseHasAfterGoal (W793).
 *
 * Extracted into its own module so the test file can import the
 * detector and the env extractor without pulling in the
 * @mariozechner/pi-coding-agent runtime dependency required by index.ts.
 */

/**
 * Canonical env keys the server's `hook.env` carries for an `after_goal`
 * hook (see stride/skills/stride-workflow/hook-execution.md). Each is
 * exported defined-but-empty when the server omits it — never absent —
 * so `set -u` user commands referencing $GOAL_DESCRIPTION etc. do not
 * abort. HOOK_NAME is set by index.ts's buildHookEnv, not here.
 */
export const AFTER_GOAL_ENV_KEYS = [
  "GOAL_ID",
  "GOAL_IDENTIFIER",
  "GOAL_TITLE",
  "GOAL_DESCRIPTION",
  "BOARD_ID",
  "BOARD_NAME",
  "COLUMN_ID",
  "COLUMN_NAME",
  "AGENT_NAME",
] as const;

// Keys that must never be copied out of a parsed JSON object into an env
// map — copying them risks prototype pollution when the map is later
// spread into another object.
const PROTO_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Build the candidate raw strings to inspect, in priority order:
 * event.details.output (preferred, structured) then event.content
 * (fallback raw stdout). Mirrors extractTaskEnvFromResult in index.ts.
 */
function collectCandidates(content: string, details: unknown): string[] {
  const candidates: string[] = [];
  if (details && typeof details === "object") {
    const output = (details as { output?: unknown }).output;
    if (typeof output === "string" && output.length > 0) candidates.push(output);
  }
  if (typeof content === "string" && content.length > 0) candidates.push(content);
  return candidates;
}

/**
 * JSON-parse a candidate string, peeling the Bash-tool
 * `{stdout: "<inner-json>"}` wrapper if present. Returns the parsed
 * payload, or null when the outer string is not JSON. When the inner
 * stdout string fails to parse, falls back to the outer parsed object.
 */
function parsePayload(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { stdout?: unknown }).stdout === "string"
  ) {
    try {
      return JSON.parse((parsed as { stdout: string }).stdout);
    } catch {
      return parsed;
    }
  }

  return parsed;
}

/**
 * Find the first `after_goal` entry in the response's `hooks` array,
 * scanning candidates in priority order. Returns the entry object (which
 * may carry an `env` block) or null when no after_goal entry is present.
 */
function findAfterGoalEntry(
  content: string,
  details: unknown,
): Record<string, unknown> | null {
  for (const raw of collectCandidates(content, details)) {
    const payload = parsePayload(raw);
    if (!payload || typeof payload !== "object") continue;

    const hooks = (payload as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;

    const entry = hooks.find(
      (h) =>
        h &&
        typeof h === "object" &&
        (h as { name?: unknown }).name === "after_goal",
    );
    if (entry) return entry as Record<string, unknown>;
  }

  return null;
}

/**
 * True when the response payload contains an `after_goal` entry in its
 * `hooks` array. Returns false on any parse failure — the after_goal
 * routing is additive, so any uncertainty falls back to "no after_goal
 * detected", preserving pre-W797 behavior for the four existing hooks.
 */
export function responseHasAfterGoal(content: string, details: unknown): boolean {
  return findAfterGoalEntry(content, details) !== null;
}

/**
 * Extract the env the server bundled with the `after_goal` hook entry,
 * to be forwarded verbatim into the `## after_goal` child process.
 *
 * Contract (stride/skills/stride-workflow/hook-execution.md "GOAL_*
 * Forwarding Rule"): the server's `hook.env` is the single source of
 * truth. We copy its keys verbatim — never inventing, deriving, or
 * looking up GOAL_* client-side — and default every canonical key the
 * server omits to the empty string (defined-but-empty). Prototype-
 * pollution keys and non-string values are dropped defensively; the
 * Stride API bearer token is never injected here because it is not part
 * of `hook.env`.
 *
 * Returns a flat string map. When no after_goal entry (or no env block)
 * is present, returns the canonical keys all defaulted to "".
 */
export function extractGoalEnvFromResult(
  content: string,
  details: unknown,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of AFTER_GOAL_ENV_KEYS) result[key] = "";

  const entry = findAfterGoalEntry(content, details);
  const env = entry?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return result;

  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    result[key] = value;
  }

  return result;
}
