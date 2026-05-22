/**
 * Detect an `after_goal` entry in a Pi tool_result event's response
 * payload. Mirrors stride-hook.sh:response_has_after_goal (W504) and
 * opencode's responseHasAfterGoal (W793).
 *
 * Extracted into its own module so the test file can import the
 * detector without pulling in the @mariozechner/pi-coding-agent
 * runtime dependency required by index.ts.
 */

/**
 * Reads the same two raw strings extractTaskEnvFromResult consumes:
 * event.details.output (preferred, structured) or event.content
 * (fallback raw stdout). For each candidate, JSON.parses, peels the
 * Bash-tool {stdout: "<inner-json>"} wrapper if present, then checks
 * the `hooks` array for an entry with name === "after_goal".
 *
 * Returns false on any parse failure — the after_goal routing is
 * additive, so any uncertainty falls back to "no after_goal detected"
 * which preserves the pre-W797 behavior for the four existing hooks.
 */
export function responseHasAfterGoal(content: string, details: unknown): boolean {
  const candidates: string[] = [];
  if (details && typeof details === "object") {
    const output = (details as { output?: unknown }).output;
    if (typeof output === "string" && output.length > 0) candidates.push(output);
  }
  if (typeof content === "string" && content.length > 0) candidates.push(content);

  for (const raw of candidates) {
    try {
      const parsed: unknown = JSON.parse(raw);

      // Peel the Bash-tool wrapper if present
      let payload: unknown = parsed;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { stdout?: unknown }).stdout === "string"
      ) {
        try {
          payload = JSON.parse((parsed as { stdout: string }).stdout);
        } catch {
          payload = parsed;
        }
      }

      if (!payload || typeof payload !== "object") continue;
      const hooks = (payload as { hooks?: unknown }).hooks;
      if (!Array.isArray(hooks)) continue;

      if (
        hooks.some(
          (h) =>
            h &&
            typeof h === "object" &&
            (h as { name?: unknown }).name === "after_goal",
        )
      ) {
        return true;
      }
    } catch {
      // Not JSON — try the next candidate
    }
  }

  return false;
}
