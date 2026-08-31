/**
 * (W2150) Loop-state record — the Pi port of stride-hook.sh's W2123 helpers
 * (loop_state_safe / loop_state_payload_ok / write_loop_state /
 * record_loop_state_for_completion) and of the clear in its before_doing branch.
 *
 * This file is a FLEET contract, not a port-local artifact: stride's
 * stride-stop-gate.sh (and its PowerShell twin) reads exactly these four keys
 * out of a shared checkout, so the shape here matches the shell writer key for
 * key and type for type. `needs_review` is the literal JSON boolean — the gate
 * tests `(.needs_review | type) == "boolean"`, so a stringified "false"
 * silently defeats terminal-state-2 detection rather than erroring.
 *
 * Lives in its own module rather than in index.ts for the same reason
 * after-goal-status.ts does: index.ts imports the Pi runtime, so it cannot be
 * loaded under `node --test`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Fleet-contract path, relative to the project root. In sync with
 * stride-hook.sh's LOOP_STATE_FILE and stride-stop-gate.sh.
 */
export const LOOP_STATE_FILE = ".stride/.loop-state.json";

/** The record, in the shell writer's key order. */
export interface LoopStateRecord {
  identifier: string;
  needs_review: boolean;
  completed_at: string;
  session_id: string;
}

/** Never throw out of a diagnostic. */
function warn(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    /* best effort */
  }
}

/** Mirror of stride-hook.sh:loop_state_safe (non-empty, <=64, [A-Za-z0-9_.:-]). */
export function loopStateSafe(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
  );
}

/**
 * `date -u +%Y-%m-%dT%H:%M:%SZ`.
 *
 * toISOString() yields milliseconds; strip them with a regex rather than
 * slice(0, 19), which would silently corrupt an ISO extended-year timestamp
 * into garbage that still looks like a date.
 */
export function completedAtNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parse a raw tool-output string and peel the Bash-tool `{stdout:"<json>"}`
 * wrapper, landing at the payload ROOT where `hook`/`hooks` sit as siblings of
 * `data`. A truncated body fails JSON.parse and returns null.
 */
export function peelPayloadRoot(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/**
 * Mirror of loop_state_payload_ok: a payload describes a SUCCESSFUL completion
 * only when `.data.identifier` is a non-empty string AND `.data.needs_review`
 * is a real boolean. Every failure body the API emits (422, 404, validation
 * errors) lacks `.data` entirely and falls through to null, so a failed
 * completion records nothing — this one predicate is the whole of AC4. Reads
 * ONLY `.data`, never a bare root object, so an unwrapped claim payload cannot
 * be mistaken for a completion. Never throws.
 */
export function loopStateFieldsFrom(
  raw: string | null | undefined,
): { identifier: string; needsReview: boolean } | null {
  if (!raw) return null;
  const root = peelPayloadRoot(raw);
  if (!root) return null; // truncated body -> no write
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null; // 422 -> no write
  const rec = data as Record<string, unknown>;
  const identifier = rec.identifier;
  const needsReview = rec.needs_review;
  if (typeof identifier !== "string" || identifier.length === 0) return null;
  if (typeof needsReview !== "boolean") return null; // stringified "false" -> no write
  return { identifier, needsReview };
}

/**
 * (D226) Is this canonical-file payload demonstrably THIS completion's? The
 * file survives across calls, so an unguarded fallback records the previous
 * claim as a completion that never happened. Two guards, both required:
 * `.hooks` is an array (a completion bundles plural `hooks`; a claim carries
 * singular `hook`), AND `.data.id` equals the id the intercepted command routed
 * on. This is the only path that records anything when the harness truncates a
 * large SUCCESS.
 */
export function canonicalBelongsToCompletion(
  raw: string | null | undefined,
  taskId: string | null | undefined,
): boolean {
  if (!raw || !taskId) return false;
  const root = peelPayloadRoot(raw);
  if (!root || !Array.isArray(root.hooks)) return false;
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const id = (data as Record<string, unknown>).id;
  if (id === undefined || id === null) return false;
  return String(id) === taskId;
}

/**
 * Atomic and never fatal — the mechanics of stride-hook.sh:write_loop_state.
 * The temp file is created IN the destination directory so the rename is
 * same-filesystem and therefore atomic; a reader never sees a half-file. Every
 * failure path cleans up and returns false; nothing throws. A completion must
 * never fail because the loop state could not be recorded.
 */
export function writeLoopState(cwd: string, record: LoopStateRecord): boolean {
  const dir = path.join(cwd, ".stride");
  const dest = path.join(cwd, LOOP_STATE_FILE);
  let tmp = "";
  try {
    // A rename onto a fifo/socket/directory would "succeed" and put the record
    // where no reader looks. Refuse a non-regular destination, as the shell
    // does; statSync follows symlinks exactly like `[ -f ]`.
    if (fs.existsSync(dest) && !fs.statSync(dest).isFile()) {
      warn("stride-pi: loop-state path is not a regular file; not recording\n");
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(
      dir,
      `loop-state.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    // Key order and the trailing newline match the shell writer's jq object
    // literal and its `printf '%s\n'`. needs_review is written as the boolean
    // it already is — never String()'d.
    const json =
      JSON.stringify({
        identifier: record.identifier,
        needs_review: record.needs_review,
        completed_at: record.completed_at,
        session_id: record.session_id,
      }) + "\n";
    fs.writeFileSync(tmp, json, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    try {
      if (tmp) fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    warn("stride-pi: could not record the loop state; continuing\n");
    return false;
  }
}

/**
 * Remove the record. Unlink, NOT an empty write: the gate treats absence as
 * "undetermined", but a `{}` file parses and would read as a record with no
 * usable needs_review. Best-effort but NOT silent — a stale record is the one
 * direction this design calls dangerous.
 */
export function clearLoopState(cwd: string): void {
  const dest = path.join(cwd, LOOP_STATE_FILE);
  try {
    fs.rmSync(dest, { force: true });
  } catch {
    /* fall through to the survivor check */
  }
  try {
    if (fs.existsSync(dest)) {
      warn(
        `stride-pi: could not clear the loop state at ${dest}; a stale completion record remains\n`,
      );
    }
  } catch {
    /* best effort */
  }
}

/**
 * Is this raw body a GENUINE parse failure, as opposed to absent or merely
 * uninteresting? The shell distinguishes two silent-no-write cases on purpose:
 * a 422 legitimately records nothing and is not announced, but an UNPARSABLE
 * body means the completion may well have succeeded server-side with the
 * evidence simply lost. The non-empty guard keeps "no body at all" out of a
 * channel that claims a body failed to parse, and a well-formed `false` or
 * `null` body is parsable and so is never announced.
 */
function isUnparsableBody(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

/**
 * Record the loop state for a completion, if the payload proves one succeeded.
 *
 * Tier 1 is THIS call's own output. Tier 2 is the canonical response file,
 * admitted only under the D226 guard — it survives across calls, so on a
 * truncated or 422 completion it still holds the previous CLAIM payload, which
 * carries both fields and would record a completion that never happened.
 *
 * Lives here rather than in index.ts so it is testable without the Pi runtime.
 */
export function recordLoopStateForCompletion(args: {
  cwd: string;
  ownCandidates: string[];
  canonicalText?: string | null;
  taskId?: string;
  sessionId?: string;
  now?: Date;
}): boolean {
  try {
    let fields: { identifier: string; needsReview: boolean } | null = null;
    for (const raw of args.ownCandidates) {
      fields = loopStateFieldsFrom(raw);
      if (fields) break;
    }
    if (!fields && canonicalBelongsToCompletion(args.canonicalText, args.taskId)) {
      fields = loopStateFieldsFrom(args.canonicalText);
    }
    if (!fields) {
      // Mirrors stride-hook.sh: announce only a genuine parse failure, never a
      // 422 and never an absent body.
      if (args.ownCandidates.some((raw) => isUnparsableBody(raw))) {
        warn("stride-pi: completion response was unparsable; no loop state recorded\n");
      }
      return false;
    }
    if (!loopStateSafe(fields.identifier)) return false;
    const sessionId = loopStateSafe(args.sessionId) ? args.sessionId : "unknown";
    return writeLoopState(args.cwd, {
      identifier: fields.identifier,
      needs_review: fields.needsReview,
      completed_at: completedAtNow(args.now),
      session_id: sessionId,
    });
  } catch {
    return false; // AC2: never fatal to the completion
  }
}
