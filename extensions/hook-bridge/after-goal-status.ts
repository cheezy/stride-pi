/**
 * Pure modules for the after_goal reliability path, ported from
 * stride-hook.sh's D118 (canonical response file) and D119 (fresh
 * `GET /api/tasks/:id/after_goal_status` fallback).
 *
 * index.ts is un-importable under `node --test` (it pulls the
 * @mariozechner/pi-coding-agent runtime), so the transport + file-IO half
 * lives here as pure, dependency-injected functions — mirroring the
 * extracted-module style of after-goal-runner.ts / after-goal-detector.ts —
 * and is covered directly by after-goal-status.test.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Canonical API-response file, relative to the project cwd (D118). index.ts
 * writes the full `/complete` (or `/claim`) response here so the after_goal
 * detector reads an untruncated payload rather than the harness-truncated
 * tool_response stdout. Kept in sync with stride-hook.sh:RESPONSE_FILE.
 */
export const CANONICAL_RESPONSE_FILE = ".stride/.last-api-response.json";

/**
 * Keys that must never be copied out of a server-supplied JSON object into
 * an env map — copying them risks prototype pollution when the map is later
 * spread into another object. Mirrors after-goal-detector.ts.
 */
const PROTO_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** The after_goal_armed status the server reports for a task's parent goal. */
export interface AfterGoalStatus {
  /** True when this completion armed the parent goal's after_goal hook. */
  armed: boolean;
  /** The parent goal's numeric id, or null when not armed / absent. */
  goalId: number | null;
  /** The GOAL_* / board-context env the server bundled, string values only. */
  env: Record<string, string>;
}

/** Minimal shape of an injected fetch — the DOM/Node `fetch` satisfies it. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The disarmed default returned on any missing-arg / failure path. */
function disarmed(): AfterGoalStatus {
  return { armed: false, goalId: null, env: {} };
}

/** Absolute path to the canonical response file under `cwd`. */
function canonicalPath(cwd: string): string {
  return path.join(cwd, ".stride", ".last-api-response.json");
}

/**
 * Copy a server-supplied env object into a flat string map, dropping
 * prototype-pollution keys and non-string values. Mirrors
 * extractGoalEnvFromResult's defensive copy in after-goal-detector.ts.
 */
function sanitizeEnv(env: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return result;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    if (typeof value !== "string") continue;
    result[key] = value;
  }
  return result;
}

/**
 * D119 fresh-call fallback: ask the server whether this task's completion
 * armed its parent goal's after_goal hook, via
 * `GET /api/tasks/:id/after_goal_status`. Immune to harness stdout
 * truncation because it is a fresh request, not a re-parse of the primary
 * response.
 *
 * `fetch` is dependency-injected (mirrors after-goal-runner.ts's DI style)
 * so tests stub it with no real network calls (pitfall W742). Never throws:
 * every failure path — missing credentials, network error, non-2xx, or an
 * unparseable body — degrades to the disarmed default `{armed: false,
 * goalId: null, env: {}}`, so a flaky status check never blocks completion.
 */
export async function getAfterGoalStatus(opts: {
  fetch: FetchFn;
  apiBase: string;
  token: string;
  taskId: string;
}): Promise<AfterGoalStatus> {
  const { fetch, apiBase, token, taskId } = opts;
  if (!apiBase || !token || !taskId) return disarmed();

  const url = `${apiBase.replace(/\/+$/, "")}/api/tasks/${taskId}/after_goal_status`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return disarmed(); // network error → no-op
  }

  if (!resp.ok) return disarmed();

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return disarmed(); // unparseable body → no-op
  }
  if (!body || typeof body !== "object") return disarmed();

  const armed = (body as { after_goal_armed?: unknown }).after_goal_armed === true;
  if (!armed) return disarmed();

  const rawGoalId = (body as { goal_id?: unknown }).goal_id;
  const goalId = typeof rawGoalId === "number" ? rawGoalId : null;
  const env = sanitizeEnv((body as { env?: unknown }).env);

  return { armed: true, goalId, env };
}

/**
 * D118 fast path: read the canonical API-response file under `cwd` and
 * return its raw text, or null when the file is absent, empty, unreadable,
 * or not valid JSON. Never throws — a missing or corrupt file simply falls
 * through to the D119 fresh-call fallback. Returns the raw text (not a
 * parsed object) so the caller can hand it to the existing string-based
 * after_goal detector unchanged.
 */
export function readCanonicalResponse(cwd: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(canonicalPath(cwd), "utf8");
  } catch {
    return null; // absent or unreadable
  }
  if (text.trim().length === 0) return null; // empty
  try {
    JSON.parse(text);
  } catch {
    return null; // invalid JSON — never trust a corrupt file
  }
  return text;
}

/**
 * Persist the full API-response `text` to the canonical file under `cwd`,
 * creating the `.stride/` directory as needed. Refuses to write anything
 * that is not valid JSON, so a truncated or garbage payload never
 * overwrites a good file (mirrors capture_canonical_response in
 * stride-hook.sh). Best-effort: returns true when the file was written,
 * false on invalid input or any IO failure — never throws.
 */
export function writeCanonicalResponse(cwd: string, text: string): boolean {
  try {
    JSON.parse(text);
  } catch {
    return false; // never overwrite a good file with non-JSON garbage
  }
  try {
    fs.mkdirSync(path.join(cwd, ".stride"), { recursive: true });
    fs.writeFileSync(canonicalPath(cwd), text);
    return true;
  } catch {
    return false; // best-effort — never block on a write failure
  }
}
