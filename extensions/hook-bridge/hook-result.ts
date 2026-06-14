/**
 * Pure HookResult shape + JSON serialization for the stride-pi hook bridge.
 *
 * Extracted from index.ts so it can be unit-tested without pulling in the
 * `@mariozechner/pi-coding-agent` runtime that index.ts imports (same pattern
 * as after-goal-detector.ts). index.ts re-uses these types and functions.
 */

import type { StrideHookName } from "./curl-matcher.js";

export interface CommandOutput {
  command: string;
  output: string;
}

export interface HookResult {
  hook: StrideHookName;
  success: boolean;
  exitCode: number;
  output: string;
  failedCommand?: string;
  durationMs: number;
  // D65: per-command tail-truncated output, populated on the SUCCESS path only
  // so passing-gate output is surfaced as structured data rather than an
  // error-shaped blob (schema parity with the after_goal JSON contract). pi
  // merges stdout+stderr into one buffer, so each entry carries a single
  // `output` string (vs. the canonical shell's separate stdout/stderr).
  commandsOutput?: CommandOutput[];
}

// D65: keep only the last N lines of each command's output in commands_output,
// matching the canonical shell hook's `tail -50` cap.
export const COMMAND_OUTPUT_TAIL_LINES = 50;

/**
 * Keep only the last `maxLines` lines of `text` (D65 tail truncation), mirroring
 * the canonical shell hook's `tail -50`. A leading marker is prepended when lines
 * are dropped so the truncation is visible.
 */
export function tailLines(text: string, maxLines: number): string {
  if (!text) return text;
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(lines.length - maxLines).join("\n");
  return `…(truncated, ${lines.length - maxLines} earlier lines)\n${kept}`;
}

/**
 * Serialize a HookResult into the cross-plugin JSON shape stride-hook.sh emits
 * on stdout for the after_goal lifecycle. The Pi agent reads this JSON and
 * forwards {exit_code, output, duration_ms} to PATCH /api/tasks/:goal_id/after_goal.
 * Field names are snake_case to match the Stride API contract; pi's internal
 * HookResult uses camelCase, so this function does the translation.
 */
export function formatHookResultJson(result: HookResult): string {
  if (result.success) {
    // D65: surface each passing command's tail-truncated output as a structured
    // `commands_output` array (schema parity with the after_goal contract). Every
    // value is encoded by JSON.stringify, so command output — even output that
    // contains JSON-like text — cannot inject sibling fields. Existing fields are
    // retained so downstream consumers (after_goal forwarding) are unaffected.
    return JSON.stringify({
      hook: result.hook,
      status: "success",
      exit_code: result.exitCode,
      output: result.output,
      commands_output: result.commandsOutput ?? [],
      duration_ms: result.durationMs,
    });
  }
  return JSON.stringify({
    hook: result.hook,
    status: "failed",
    exit_code: result.exitCode,
    output: result.output,
    failed_command: result.failedCommand ?? null,
    duration_ms: result.durationMs,
  });
}
