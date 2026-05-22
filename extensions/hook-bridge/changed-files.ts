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
 * The PUT is wrapped in `{ "changed_files": [...] }` per
 * docs/api/put_tasks_id_changed_files.md. Every failure path degrades to a
 * silent no-op — capture and upload errors must never block the agent's
 * completion request.
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

  const seen = new Set<string>();
  const allFiles: string[] = [];
  for (const f of [...trackedFiles, ...untrackedFiles]) {
    if (!seen.has(f)) {
      seen.add(f);
      allFiles.push(f);
    }
  }

  if (allFiles.length === 0) return [];

  const numstatResult = runGit(["diff", "--numstat", base], cwd);
  const trackedBinaries = numstatResult.ok
    ? parseNumstatBinaries(numstatResult.stdout)
    : new Set<string>();

  const results: ChangedFile[] = [];
  for (const file of allFiles) {
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
): Promise<void> {
  if (!apiBase || !token || !taskId) return;
  const url = `${apiBase.replace(/\/+$/, "")}/api/tasks/${taskId}/changed_files`;
  try {
    await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ changed_files: files }),
    });
  } catch {
    // fire-and-forget — never block completion on upload failure
  }
}

export interface FinalizeOptions {
  cwd: string;
  command: string;
  taskId: string | undefined;
  baseRef: string | undefined;
}

/**
 * After-doing finalizer: capture diffs, persist the snapshot to
 * `.stride-changed-files.json`, and fire-and-forget PUT it to the server.
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

  try {
    fs.writeFileSync(
      path.join(cwd, ".stride-changed-files.json"),
      JSON.stringify(snapshot),
      { encoding: "utf-8" },
    );
  } catch {
    // best-effort; not fatal
  }

  if (!opts.taskId) return;
  const apiBase = extractApiBase(command);
  const token = extractToken(command);
  if (!apiBase || !token) return;

  await putChangedFiles(apiBase, token, opts.taskId, snapshot);
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
