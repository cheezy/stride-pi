/**
 * The Stride subagent registry: the set of agent names `dispatch_agent` can
 * resolve, each backed by an `agents/<name>.md` definition file.
 *
 * Kept in its own pi-free module — no `@mariozechner/pi-coding-agent` or
 * `@sinclair/typebox` imports — so it can be unit-tested under `node --test`
 * without the peer deps that index.ts requires. This mirrors how the
 * hook-bridge extension extracts its pi-free helpers (after-goal-detector.ts,
 * curl-matcher.ts, stride-md-parser.ts) so the tests import real shipped code
 * rather than re-deriving it. index.ts imports `AGENT_NAMES` from here to
 * build the `dispatch_agent` parameter union and to resolve `agents/<name>.md`.
 */

export const AGENT_NAMES = [
  "stride-task-explorer",
  "stride-task-reviewer",
  "stride-task-decomposer",
  "stride-hook-diagnostician",
  "stride-task-enricher",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

/** Case-sensitive membership check against the registry. */
export function isRegisteredAgent(name: string): name is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(name);
}
