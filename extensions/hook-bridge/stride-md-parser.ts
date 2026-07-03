/**
 * Parses .stride.md and returns the executable command list for a given hook
 * section. Format mirrors stride-gemini/hooks/stride-hook.sh:
 *
 *   ## <hook_name>
 *
 *   ```bash
 *   command-1
 *   # a comment — stripped
 *   command-2
 *   ```
 *
 * Rules:
 *   - Section heading match is exact (case-sensitive). Anything between
 *     `## ` and end-of-line is the section name, trimmed of trailing whitespace.
 *   - The first ```bash fence under the matching heading wins. Content stops
 *     at the matching ``` close or the next `## ` heading, whichever first.
 *   - A physical line ending in an unescaped trailing backslash continues onto
 *     the next physical line, matching bash line-continuation. The joined result
 *     is one logical command: the trailing backslash and the newline are
 *     removed, and the trimmed segments are joined with a single space so
 *     idiomatic indented continuations produce a clean command. (Bash would
 *     concatenate byte-exact; for a continuation that splits *mid-token* — no
 *     space before the backslash and no indent after — the single space is a
 *     harmless divergence. Split between arguments, as real hooks do, and the
 *     result is identical.) Joining happens BEFORE the comment/blank filters, so
 *     the filters see whole logical lines.
 *   - A `#` comment line does NOT start a continuation even if it ends in a
 *     backslash — bash treats that backslash as literal comment text, so the
 *     next physical line remains its own command (never swallowed).
 *   - Comment lines (first non-whitespace char is `#`) are filtered out.
 *   - Blank lines (whitespace-only) are filtered out.
 *   - Section headings and the closing ``` fence are detected on PHYSICAL lines,
 *     so a stray trailing backslash can never swallow a section boundary. A
 *     trailing backslash on the fence's final line (or at end-of-content)
 *     degrades gracefully: the buffered command is flushed with the backslash
 *     stripped (no dangling artifact, no crash).
 *   - Missing section or empty fence → empty array (caller treats as no-op).
 */

export function parseHookSection(content: string, hookName: string): string[] {
  if (!content || !hookName) return [];

  const lines = content.split("\n");
  let inSection = false;
  let inFence = false;
  const commands: string[] = [];
  // Physical-line segments (trailing backslash already stripped) of a command
  // still being continued. `null` when no continuation is in progress.
  let continued: string[] | null = null;

  for (const raw of lines) {
    // Section headings and the closing fence are matched on PHYSICAL lines, so
    // a pending continuation can never consume a section boundary.
    if (raw.startsWith("## ")) {
      if (inSection) break;
      const heading = raw.slice(3).trimEnd();
      if (heading === hookName) inSection = true;
      continue;
    }

    if (!inSection) continue;

    if (!inFence) {
      if (raw.startsWith("```bash")) inFence = true;
      continue;
    }

    if (raw.startsWith("```")) break;

    const line = raw.replace(/\r$/, "");

    // A '#' comment's trailing backslash is literal in bash — never START a
    // continuation on a comment line, or it would swallow the next command.
    // Once a continuation is already in progress the line is a continued
    // segment (not a comment), so this guard only applies with nothing buffered.
    const startsComment = continued === null && line.trimStart().startsWith("#");

    if (!startsComment && endsWithLineContinuation(line)) {
      // Strip the single continuation backslash and buffer the segment; the
      // next physical line completes (or further continues) this command.
      (continued ??= []).push(line.slice(0, -1));
      continue;
    }

    if (continued === null) {
      emitLogicalLine(commands, [line]);
    } else {
      continued.push(line);
      emitLogicalLine(commands, continued);
      continued = null;
    }
  }

  // Flush a continuation left dangling by the fence's final line, a section
  // boundary, or end-of-content. The backslash is already stripped, so no
  // dangling artifact survives.
  emitLogicalLine(commands, continued);

  return commands;
}

/**
 * Joins buffered physical segments into one logical command and pushes it
 * unless the whole line is blank or a comment. Segments are trimmed and joined
 * with a single space (see the join rule in the module docstring). A null/empty
 * buffer is a no-op.
 */
function emitLogicalLine(commands: string[], segments: string[] | null): void {
  if (!segments || segments.length === 0) return;

  const logical = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(" ");

  if (!logical) return;
  if (logical.startsWith("#")) return;
  commands.push(logical);
}

/**
 * True when the line ends with an unescaped backslash — an odd number of
 * trailing backslashes. An even count means the final backslash is itself
 * escaped (a literal `\`), which bash does NOT treat as a line continuation.
 */
function endsWithLineContinuation(line: string): boolean {
  let backslashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}
