/**
 * Per-file diff capture and upload for the after_doing hook.
 *
 * Mirrors stride/hooks/stride-hook.sh:capture_changed_files and
 * :finalize_after_doing byte-identically for the on-the-wire encoding:
 *   - 500-line per-file cap with the contract truncation marker
 *   - binary placeholder for files git reports as binary
 *   - working-tree diff (committed + staged + unstaged) for tracked paths
 *   - synthesized new-file patches for untracked paths via
 *     `git diff --no-index --no-color /dev/null <path>`
 *
 * The PUT sends the D61 transport-encoded envelope
 * `{ "changed_files": { "encoding": "base64", "data": "<b64>" } }` per
 * docs/api/put_tasks_id_changed_files.md so an edge request filter (WAF) does
 * not misread a unified code diff as an attack and drop the upload; the server
 * decodes it back to the same list. Capture and encoding errors degrade to a
 * silent no-op, and a failed upload is surfaced to stderr (never the token)
 * rather than thrown — errors must never block the agent's completion request.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const TRUNC_MARKER = "[diff truncated at 500 lines]";
export const BIN_PLACEHOLDER = "[binary file — no diff captured]";
export const MAX_LINES = 500;

export interface ChangedFile {
  path: string;
  diff: string;
}

interface RunGitOk {
  ok: true;
  stdout: string;
}
interface RunGitErr {
  ok: false;
}
type RunGitResult = RunGitOk | RunGitErr;

function runGit(args: string[], cwd: string): RunGitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false };
  }
}

function runGitAllowFail(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: unknown) {
    // git diff --no-index exits 1 when files differ — still capture stdout.
    const e = err as { stdout?: string | Buffer };
    if (e && e.stdout !== undefined) {
      return typeof e.stdout === "string" ? e.stdout : e.stdout.toString("utf-8");
    }
    return "";
  }
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hash a working-tree file's current content (its git blob SHA). Returns
 * undefined on any failure (missing/deleted file, git error) so callers fail
 * OPEN — an un-hashable path is treated as "changed" and kept, never wrongly
 * dropped from the snapshot.
 */
function hashWorkingTreeFile(file: string, cwd: string): string | undefined {
  const res = runGit(["hash-object", "--", file], cwd);
  if (!res.ok) return undefined;
  const hash = res.stdout.trim();
  return hash.length > 0 ? hash : undefined;
}

function resolveBase(baseRef: string, cwd: string): string | null {
  if (baseRef) {
    if (runGit(["rev-parse", "--verify", baseRef], cwd).ok) return baseRef;
  }
  if (runGit(["rev-parse", "--verify", "HEAD~1"], cwd).ok) return "HEAD~1";
  return null;
}

function truncateDiff(diff: string): string {
  if (!diff) return diff;
  const lines = diff.split("\n");
  // Count newline-terminated lines the same way bash does (count of \n + 1).
  const lineCount = lines.length;
  if (lineCount <= MAX_LINES) return diff;
  const kept = lines.slice(0, MAX_LINES - 1).join("\n");
  return `${kept}\n${TRUNC_MARKER}`;
}

function parseNumstatBinaries(numstat: string): Set<string> {
  const binaries = new Set<string>();
  for (const line of numstat.split("\n")) {
    if (!line) continue;
    // Format: <added>\t<deleted>\t<path>
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[0] === "-" && parts[1] === "-") {
      // Path may itself contain tabs in pathological cases; join the rest.
      const filePath = parts.slice(2).join("\t");
      if (filePath) binaries.add(filePath);
    }
  }
  return binaries;
}

export function captureChangedFiles(baseRef: string, cwd: string): ChangedFile[] {
  if (!hasGit()) return [];

  const base = resolveBase(baseRef, cwd);
  if (!base) return [];

  const tracked = runGit(["diff", "--name-only", base], cwd);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"], cwd);

  const trackedFiles = tracked.ok
    ? tracked.stdout.split("\n").filter((line) => line.length > 0)
    : [];
  const untrackedFiles = untracked.ok
    ? untracked.stdout.split("\n").filter((line) => line.length > 0)
    : [];
  const untrackedSet = new Set(untrackedFiles);

  // Exclude the hook's OWN bookkeeping artifacts (D67): the upload-state file
  // and the on-disk snapshot live at the repo root and otherwise pass both
  // nets — .stride-diff-upload-state as an untracked entry, and either of them
  // as a tracked diff once a project's after_doing auto-commit has staged them.
  // git's name-only / ls-files output is repo-root-relative, so the exact
  // whole-string match anchors to the ROOT artifacts only; a same-named file in
  // a subdirectory (e.g. sub/.stride-changed-files.json) has a path prefix and
  // is still captured.
  const HOOK_STATE_ARTIFACTS = new Set([
    DIFF_UPLOAD_STATE_FILE,
    CHANGED_FILES_SNAPSHOT_FILE,
    CLAIM_DIRTY_BASELINE_FILE,
  ]);

  const seen = new Set<string>();
  const allFiles: string[] = [];
  for (const f of [...trackedFiles, ...untrackedFiles]) {
    if (HOOK_STATE_ARTIFACTS.has(f)) continue;
    // W1641: everything under the .stride/ runtime dir — most notably the
    // canonical response file .stride/.last-api-response.json (D118) — is a
    // hook artifact, never part of the task's diff. git paths are
    // repo-root-relative, so the leading ".stride/" anchors to the root
    // runtime dir only (mirrors stride-hook.sh's `$0 !~ /^\.stride\//`).
    if (f.startsWith(".stride/")) continue;
    if (!seen.has(f)) {
      seen.add(f);
      allFiles.push(f);
    }
  }

  if (allFiles.length === 0) return [];

  // W1529: subtract files that were already dirty at claim time and remain
  // byte-identical now — the task never touched them, so they are not part of
  // the claim->completion delta and must not pollute the reviewer's diff. A file
  // dirty at claim AND further edited during the task (its working-tree blob SHA
  // differs from the claim-time SHA) stays, with its full diff against the base.
  // Fail-open: an empty baseline (git missing, first run, or a read failure) or
  // an un-hashable path keeps the file, preserving the prior capture-everything
  // behavior.
  const claimDirtyBaseline = readClaimDirtyBaseline(cwd);
  const files =
    Object.keys(claimDirtyBaseline).length === 0
      ? allFiles
      : allFiles.filter((file) => {
          const claimHash = claimDirtyBaseline[file];
          if (claimHash === undefined) return true; // clean at claim → keep
          const currentHash = hashWorkingTreeFile(file, cwd);
          if (currentHash === undefined) return true; // un-hashable → fail-open keep
          return currentHash !== claimHash; // keep only if changed since claim
        });

  if (files.length === 0) return [];

  const numstatResult = runGit(["diff", "--numstat", base], cwd);
  const trackedBinaries = numstatResult.ok
    ? parseNumstatBinaries(numstatResult.stdout)
    : new Set<string>();

  const results: ChangedFile[] = [];
  for (const file of files) {
    let isBinary = false;
    let diffText = "";

    if (untrackedSet.has(file)) {
      diffText = runGitAllowFail(
        ["diff", "--no-index", "--no-color", "/dev/null", file],
        cwd,
      );
      if (/(^|\n)Binary files .* differ(\n|$)/.test(diffText)) {
        isBinary = true;
      }
    } else if (trackedBinaries.has(file)) {
      isBinary = true;
    } else {
      const tr = runGit(["diff", base, "--", file], cwd);
      diffText = tr.ok ? tr.stdout : "";
    }

    if (isBinary) {
      results.push({ path: file, diff: BIN_PLACEHOLDER });
    } else {
      results.push({ path: file, diff: truncateDiff(diffText) });
    }
  }

  return results;
}

const API_BASE_RE = /https?:\/\/[A-Za-z0-9._-]+(?::[0-9]+)?/;
const TOKEN_RE = /Bearer +([A-Za-z0-9._+/=-]+)/;

export function extractApiBase(command: string): string | null {
  if (!command) return null;
  const match = command.match(API_BASE_RE);
  return match ? match[0] : null;
}

export function extractToken(command: string): string | null {
  if (!command) return null;
  const match = command.match(TOKEN_RE);
  return match ? match[1] : null;
}

export async function putChangedFiles(
  apiBase: string,
  token: string,
  taskId: string,
  files: ChangedFile[],
): Promise<number> {
  if (!apiBase || !token || !taskId) return 0;
  const url = `${apiBase.replace(/\/+$/, "")}/api/tasks/${taskId}/changed_files`;
  // D61: send the transport-encoded envelope
  // {"changed_files":{"encoding":"base64","data":"<b64>"}} rather than the raw
  // array so an edge request filter does not misread a code diff as an attack
  // and drop the upload. The server decodes it back to the same list. Fall back
  // to the raw {"changed_files":[...]} object (never a bare array) if encoding
  // fails.
  let body: string;
  try {
    const b64 = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
    body = JSON.stringify({ changed_files: { encoding: "base64", data: b64 } });
  } catch {
    body = JSON.stringify({ changed_files: files });
  }

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (!resp.ok) {
      // Surface a failed upload instead of dropping it silently. The diff is
      // non-fatal to completion, so we warn rather than throw.
      console.error(
        `stride-hook: changed_files upload failed (HTTP ${resp.status}) for task ${taskId}`,
      );
    }
    return resp.status;
  } catch {
    // fire-and-forget — never block completion on upload failure
    console.error(`stride-hook: changed_files upload failed for task ${taskId}`);
    return 0;
  }
}

export const CHANGED_FILES_SNAPSHOT_FILE = ".stride-changed-files.json";
export const DIFF_UPLOAD_STATE_FILE = ".stride-diff-upload-state";
export const CLAIM_DIRTY_BASELINE_FILE = ".stride-claim-dirty.json";

/**
 * Capture the set of files already dirty relative to HEAD at claim time, mapping
 * each repo-root-relative path to its current working-tree blob SHA. Enumerates
 * the same two nets captureChangedFiles uses (tracked diff vs HEAD + untracked,
 * excluding gitignored paths). captureChangedFiles later subtracts any of these
 * paths whose content is unchanged at completion, so pre-claim edits the task
 * never touched do not pollute the after_doing snapshot.
 *
 * Best-effort and FAIL-OPEN (W1529 pitfall): git missing, not a repo, or any
 * enumeration/hash failure yields an empty map, which makes captureChangedFiles
 * fall back to its prior capture-everything behavior. A path that cannot be
 * hashed is simply omitted from the baseline (its later changes are captured
 * rather than dropped).
 */
export function captureClaimDirtyBaseline(cwd: string): Record<string, string> {
  const baseline: Record<string, string> = {};
  if (!hasGit()) return baseline;

  const tracked = runGit(["diff", "--name-only", "HEAD"], cwd);
  const untracked = runGit(["ls-files", "--others", "--exclude-standard"], cwd);

  const paths = new Set<string>();
  if (tracked.ok) {
    for (const p of tracked.stdout.split("\n")) if (p.length > 0) paths.add(p);
  }
  if (untracked.ok) {
    for (const p of untracked.stdout.split("\n")) if (p.length > 0) paths.add(p);
  }

  for (const p of paths) {
    const hash = hashWorkingTreeFile(p, cwd);
    if (hash !== undefined) baseline[p] = hash;
  }
  return baseline;
}

/**
 * Persist the claim-time dirty baseline to `.stride-claim-dirty.json`.
 * Best-effort (never throws) and mode 0o600 like the other state artifacts — it
 * holds ONLY repo-root-relative paths and blob SHAs, never the API URL or bearer
 * token. Gitignore this file alongside the other `.stride-*` state artifacts.
 */
export function writeClaimDirtyBaseline(
  cwd: string,
  baseline: Record<string, string>,
): void {
  try {
    fs.writeFileSync(
      path.join(cwd, CLAIM_DIRTY_BASELINE_FILE),
      JSON.stringify(baseline),
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // best-effort; not fatal
  }
}

/**
 * Read `.stride-claim-dirty.json`, returning the path→blob-SHA baseline map. A
 * missing, unreadable, or malformed file (or any non-object JSON) degrades to an
 * empty map — which makes captureChangedFiles capture everything. Never throws.
 */
export function readClaimDirtyBaseline(cwd: string): Record<string, string> {
  const file = path.join(cwd, CLAIM_DIRTY_BASELINE_FILE);
  if (!fs.existsSync(file)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Persist the captured snapshot to `.stride-changed-files.json`. Best-effort:
 * a write failure (e.g. cwd does not exist) is swallowed, never thrown. Shared
 * by finalizeAfterDoing and selfHealChangedFilesUpload so both produce the
 * identical on-disk artifact.
 */
function writeSnapshot(cwd: string, snapshot: ChangedFile[]): void {
  try {
    fs.writeFileSync(
      path.join(cwd, CHANGED_FILES_SNAPSHOT_FILE),
      JSON.stringify(snapshot),
      { encoding: "utf-8" },
    );
  } catch {
    // best-effort; not fatal
  }
}

/**
 * Record the outcome of a changed_files upload to `.stride-diff-upload-state`.
 *
 * The file holds ONLY the task id and the HTTP status code — never the API URL
 * or bearer token (W1094 security contract). Mirrors stride-hook.sh's
 * record_diff_upload_state byte-for-byte:
 *
 *   task_id=<id>
 *   http_code=<code>
 *
 * Best-effort: a write failure is swallowed. A missing state file means "no
 * healthy upload on record", which makes the before_review self-heal re-upload.
 */
export function recordDiffUploadState(
  cwd: string,
  taskId: string,
  httpCode: number,
): void {
  try {
    fs.writeFileSync(
      path.join(cwd, DIFF_UPLOAD_STATE_FILE),
      `task_id=${taskId}\nhttp_code=${httpCode}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // best-effort; not fatal
  }
}

/**
 * Read `.stride-diff-upload-state`, returning the recorded task id and HTTP
 * code. httpCode is returned as a string so callers can mirror the shell's
 * `case "$_state_code" in 2*)` prefix test. A missing file or missing keys
 * degrades to undefined; never throws.
 */
export function readDiffUploadState(cwd: string): {
  taskId: string | undefined;
  httpCode: string | undefined;
} {
  const file = path.join(cwd, DIFF_UPLOAD_STATE_FILE);
  if (!fs.existsSync(file)) return { taskId: undefined, httpCode: undefined };

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { taskId: undefined, httpCode: undefined };
  }

  let taskId: string | undefined;
  let httpCode: string | undefined;
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "task_id") taskId = value;
    else if (key === "http_code") httpCode = value;
  }
  return { taskId, httpCode };
}

export interface FinalizeOptions {
  cwd: string;
  command: string;
  taskId: string | undefined;
  baseRef: string | undefined;
}

/**
 * After-doing finalizer: capture diffs, persist the snapshot to
 * `.stride-changed-files.json`, fire-and-forget PUT it to the server, and
 * record the upload outcome (task id + HTTP code) to
 * `.stride-diff-upload-state` so the before_review self-heal can tell whether
 * the diff already landed.
 *
 * Every error path degrades to a no-op. Returns once the PUT settles (or
 * fails); callers may either await the promise or drop it on the floor —
 * either way the agent's completion request is unaffected.
 */
export async function finalizeAfterDoing(opts: FinalizeOptions): Promise<void> {
  const { cwd, command } = opts;
  let snapshot: ChangedFile[] = [];
  try {
    snapshot = captureChangedFiles(opts.baseRef ?? "", cwd);
  } catch {
    snapshot = [];
  }

  writeSnapshot(cwd, snapshot);

  if (!opts.taskId) return;
  const apiBase = extractApiBase(command);
  const token = extractToken(command);
  if (!apiBase || !token) return;

  const code = await putChangedFiles(apiBase, token, opts.taskId, snapshot);
  recordDiffUploadState(cwd, opts.taskId, code);
}

/**
 * Before-review self-heal: re-upload the changed-files snapshot when the
 * after_doing finalize never landed it. Ports stride-hook.sh's
 * self_heal_changed_files_upload (the HOOK_NAME gate lives in the caller, which
 * only invokes this on the before_review event).
 *
 * Re-uploads when the recorded state is missing, was written for a different
 * task, or carries a non-2xx HTTP code. When the state already shows a 2xx for
 * this task, it is a no-op (the diff is already on the server) and the existing
 * snapshot is left untouched. Credentials are resolved BEFORE re-capturing so a
 * missing token leaves the prior snapshot intact rather than clobbering it.
 *
 * Best-effort: every error path degrades to a no-op; never throws.
 */
export async function selfHealChangedFilesUpload(
  opts: FinalizeOptions,
): Promise<void> {
  const { cwd, command } = opts;
  if (!opts.taskId) return;

  // Already healthy? A recorded 2xx for this exact task means the after_doing
  // upload landed — nothing to heal, and we must not overwrite the snapshot.
  const state = readDiffUploadState(cwd);
  if (state.taskId === opts.taskId && (state.httpCode ?? "").startsWith("2")) {
    return;
  }

  // Resolve credentials before touching the snapshot so a missing token leaves
  // the prior (possibly stale) snapshot intact rather than clobbering it.
  const apiBase = extractApiBase(command);
  const token = extractToken(command);
  if (!apiBase || !token) return;

  let snapshot: ChangedFile[] = [];
  try {
    snapshot = captureChangedFiles(opts.baseRef ?? "", cwd);
  } catch {
    snapshot = [];
  }

  writeSnapshot(cwd, snapshot);

  const code = await putChangedFiles(apiBase, token, opts.taskId, snapshot);
  recordDiffUploadState(cwd, opts.taskId, code);
}

const ENV_CACHE_FILE = ".stride-env-cache";

/**
 * Reads the env cache file directly and returns TASK_ID and TASK_BASE_REF.
 * Mirrors loadEnvCache in index.ts but is intentionally independent — the
 * caller does not need TASK_BASE_REF to be in TASK_ENV_KEYS, and a missing
 * file or missing keys degrades to undefined rather than throwing.
 */
export function readFinalizerEnv(cwd: string): {
  taskId: string | undefined;
  baseRef: string | undefined;
} {
  const file = path.join(cwd, ENV_CACHE_FILE);
  if (!fs.existsSync(file)) return { taskId: undefined, baseRef: undefined };

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { taskId: undefined, baseRef: undefined };
  }

  let taskId: string | undefined;
  let baseRef: string | undefined;
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)='((?:[^'\\]|\\.)*)'$/);
    if (!match) continue;
    const value = match[2].replace(/\\(.)/g, "$1");
    if (match[1] === "TASK_ID") taskId = value;
    else if (match[1] === "TASK_BASE_REF") baseRef = value;
  }
  return { taskId, baseRef };
}
