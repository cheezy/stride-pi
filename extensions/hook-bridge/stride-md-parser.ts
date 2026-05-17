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
 *   - Comment lines (first non-whitespace char is `#`) are filtered out.
 *   - Blank lines (whitespace-only) are filtered out.
 *   - Missing section or empty fence → empty array (caller treats as no-op).
 */

export function parseHookSection(content: string, hookName: string): string[] {
  if (!content || !hookName) return [];

  const lines = content.split("\n");
  let inSection = false;
  let inFence = false;
  const commands: string[] = [];

  for (const raw of lines) {
    if (raw.startsWith("## ")) {
      if (inSection) break;
      const heading = raw.slice(3).trimEnd();
      if (heading === hookName) inSection = true;
      continue;
    }

    if (!inSection) continue;

    if (!inFence) {
      if (raw.startsWith("```bash")) {
        inFence = true;
      }
      continue;
    }

    if (raw.startsWith("```")) break;

    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    commands.push(trimmed);
  }

  return commands;
}
