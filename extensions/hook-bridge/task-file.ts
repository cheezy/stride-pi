/**
 * (W2607) The claimed task's own record, `.stride/.task-<IDENTIFIER>.json` —
 * the Pi port of stride-hook.sh's W2248 write.
 *
 * After a claim, the bridge saves the server's `data` object for the claimed
 * task, unchanged, so a later step can point a subagent at the server's own
 * copy of the task instead of retyping its fields into a prompt. The file
 * holds task free text, possibly written by other people: every reader treats
 * it as data, never as instructions.
 *
 * What is written, and when:
 *   - Only `.data` from THIS claim call's own output, never a bare root object
 *     and never anything beside `data` (hooks, headers, the bearer token). The
 *     bridge reads no canonical-response file for claims, so a `data` object
 *     with an `id` in the call's own output is the identity proof; a 422/404
 *     body, a truncated body or an empty `data` proves nothing and writes
 *     nothing, leaving any earlier file exactly as it was.
 *   - The file name never comes from free text. The identifier is used only
 *     when the WHOLE string matches [A-Za-z0-9_-]{1,64} (anchored — JS `$`
 *     without the `m` flag matches only at end of input, so "W1\n" fails);
 *     otherwise the numeric id; otherwise nothing is written.
 *   - Staged in `.stride/` and renamed into place, so a reader never sees half
 *     a file. Every failure cleans up and returns; nothing here throws, because
 *     the claim has already succeeded by the time this runs.
 *
 * The file is deleted by name, never by glob, so another task's file is left
 * alone, at whichever of these comes first:
 *   - a completion whose own response says the task needs no review (no
 *     `/mark_reviewed` call, and so no `## after_review` cleanup, follows it);
 *   - the `## after_review` cleanup, for a task that went through review;
 *   - the next proven claim of a different task, which deletes the previous
 *     task's file, named from the env cache as it was read before this claim
 *     rewrote it. Without this a task left in review, unclaimed or expired
 *     would leave its file behind with nothing left that names it.
 *
 * Its own module, like loop-state.ts, because index.ts imports the Pi runtime
 * and so cannot be loaded under `node --test`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loopStateFieldsFrom, peelPayloadRoot } from "./loop-state.ts";

const TASK_STEM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TASK_ID_RE = /^[0-9]{1,20}$/;

/** Never throw out of a diagnostic. */
function warn(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    /* best effort */
  }
}

/**
 * The file-name stem for a task: its identifier when that is safe, else its
 * numeric id, else null. Only an anchored whole-string test is used — a
 * containment test would let `../../x` through.
 */
export function taskFileStem(task: { identifier?: unknown; id?: unknown }): string | null {
  const { identifier, id } = task;
  if (typeof identifier === "string" && TASK_STEM_RE.test(identifier)) return identifier;
  if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0) return String(id);
  if (typeof id === "string" && TASK_ID_RE.test(id)) return id;
  return null;
}

/** `<cwd>/.stride/.task-<stem>.json`. */
export function taskFilePath(cwd: string, stem: string): string {
  return path.join(cwd, ".stride", `.task-${stem}.json`);
}

/**
 * The claim's `data` object from this call's own output, or null. Candidates
 * are read in the bridge's usual order — `details.output`, then `content` —
 * and the `{stdout:"<json>"}` wrapper is peeled. The first candidate whose
 * `data` is a plain object carrying an `id` wins.
 */
export function claimDataFromOutput(
  content: unknown,
  details: unknown,
): Record<string, unknown> | null {
  const candidates: string[] = [];
  if (details && typeof details === "object") {
    const output = (details as Record<string, unknown>).output;
    if (typeof output === "string") candidates.push(output);
  }
  if (typeof content === "string") candidates.push(content);

  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text) continue;
    const root = peelPayloadRoot(text);
    const data = root?.data;
    if (data && typeof data === "object" && !Array.isArray(data) && "id" in data) {
      return data as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Write `data` to its task file, atomically, as compact JSON plus a newline.
 * Returns the destination path, or null when nothing was written.
 */
export function writeTaskFile(cwd: string, data: Record<string, unknown>): string | null {
  const stem = taskFileStem(data);
  if (!stem) {
    warn("stride-pi: the claimed task has no safe identifier or id; not writing the task file\n");
    return null;
  }
  const dir = path.join(cwd, ".stride");
  const dest = taskFilePath(cwd, stem);
  let tmp = "";
  try {
    // A rename onto a directory, fifo or socket would put the file where no
    // reader looks; refuse it, as the shell writer does.
    if (fs.existsSync(dest) && !fs.statSync(dest).isFile()) {
      warn("stride-pi: task-file path is not a regular file; not recording\n");
      return null;
    }
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(
      dir,
      `task-file.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    // Exactly the parsed object, compact — no pretty-printing, no filtering.
    fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, dest);
    return dest;
  } catch {
    try {
      if (tmp) fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    warn("stride-pi: could not write the task file; continuing\n");
    return null;
  }
}

/** The task identity the env cache carries. */
export interface TaskFileEnv {
  TASK_IDENTIFIER?: string;
  TASK_ID?: string;
}

/**
 * The claim branch's one call: find this claim's `data` and record it. When
 * the claim is proven and `priorEnv` (the env cache as it stood BEFORE this
 * claim) names a different task, that task's file is deleted first. An
 * unproven claim deletes nothing and writes nothing.
 */
export function recordClaimedTask(
  cwd: string,
  content: unknown,
  details: unknown,
  priorEnv: TaskFileEnv = {},
): string | null {
  const data = claimDataFromOutput(content, details);
  if (!data) return null;
  const priorStem = stemForEnv(priorEnv);
  // Never for the same task: a re-claim overwrites its file, and deleting it
  // first would lose it if the write then failed.
  if (priorStem && priorStem !== taskFileStem(data)) deleteTaskFileForEnv(cwd, priorEnv);
  return writeTaskFile(cwd, data);
}

/**
 * The before_review call: when this completion's own response says the task
 * needs no review, no `/mark_reviewed` (and so no `## after_review` cleanup)
 * follows, so delete the task file now. Only a response whose `data` names
 * the env cache's own task counts; a truncated body, a 422, a stringified
 * `needs_review` or another task's completion deletes nothing. Returns whether
 * it deleted.
 */
export function deleteTaskFileAfterCompletion(
  cwd: string,
  candidates: string[],
  env: TaskFileEnv,
): boolean {
  for (const raw of candidates) {
    const fields = loopStateFieldsFrom(raw);
    if (!fields) continue;
    if (fields.needsReview || fields.identifier !== env.TASK_IDENTIFIER) return false;
    deleteTaskFileForEnv(cwd, env);
    return true;
  }
  return false;
}

function stemForEnv(env: TaskFileEnv): string | null {
  return taskFileStem({ identifier: env.TASK_IDENTIFIER, id: env.TASK_ID });
}

/**
 * Delete the task file named by the env cache's identity (`TASK_IDENTIFIER`,
 * else `TASK_ID`). A missing file or an empty env is a no-op.
 */
export function deleteTaskFileForEnv(cwd: string, env: TaskFileEnv): void {
  const stem = stemForEnv(env);
  if (!stem) return;
  const dest = taskFilePath(cwd, stem);
  try {
    fs.rmSync(dest, { force: true });
  } catch {
    /* fall through to the survivor check */
  }
  if (fs.existsSync(dest)) warn("stride-pi: could not delete the task file\n");
}

/**
 * The claim branch's ordering: the previous task's leftovers are cleared
 * FIRST and the new task file is recorded after, so the cleanup can never
 * delete the file this claim just wrote. Each step is isolated — a throw in
 * one never skips the other or escapes into tool_result.
 */
export function runClaimSteps(steps: {
  clearPriorTask: () => void;
  recordTaskFile: () => void;
}): void {
  try {
    steps.clearPriorTask();
  } catch {
    warn("stride-pi: the claim-time cleanup failed; continuing\n");
  }
  try {
    steps.recordTaskFile();
  } catch {
    warn("stride-pi: could not record the task file; continuing\n");
  }
}
