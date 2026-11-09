/**
 * (W2532) Task attachments — the Pi port of stride-hook.sh's W2522
 * download_task_attachments. The contract is stride's
 * docs/porting-attachments.md; stride's landed hook is the source of record,
 * and every name, cap, reason code and manifest field below comes from it.
 *
 * After a claim whose OWN tool_result proves the task identity, each file the
 * claim lists in `data.attachments` is downloaded into
 * `<cwd>/.stride/attachments/<STEM>/`, and `manifest.json` is written LAST
 * (staged, then renamed), so its presence means every entry is settled.
 *
 *   - The list comes from this call's own output (claimDataFromOutput), never
 *     from the env cache, the task file or a canonical response file. A
 *     truncated or failed claim downloads nothing.
 *   - STEM is task-file.ts's taskFileStem; no raw filename reaches a path. Each
 *     file is saved as `<id>-<sanitised basename>`.
 *   - Only a download_url matching `/api/tasks/<claimed id>/attachments/<n>`
 *     exactly is fetched, joined to the API URL from `.stride_auth.md` and
 *     nothing else. Redirects are NOT followed (`redirect: "manual"`): a 3xx is
 *     recorded as http_<code>, which is how the token is kept off every other
 *     host.
 *   - Caps are checked against the declared byte_size before any download, a
 *     body that grows past it is aborted, and a wall-clock budget bounds the
 *     whole run.
 *   - Never fatal and never on stdout: every failure is a manifest entry or one
 *     stderr line, and nothing here throws to its caller.
 *
 * SECURITY. The bearer token has one destination: the Authorization header of
 * a request to the configured API origin. It is never logged, never written to
 * a file and never placed in an Error message or a diagnostic. Attachment
 * contents and filenames are untrusted data; nothing here executes, opens or
 * unpacks a downloaded file.
 *
 * Its own module, like task-file.ts, because index.ts imports the Pi runtime
 * and so cannot be loaded under `node --test`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { claimDataFromOutput, taskFileStem } from "./task-file.ts";
import { readStrideAuth } from "./stride-auth.ts";
import type { StrideAuth } from "./stride-auth.ts";
import type { FetchFn } from "./after-goal-status.ts";

export const ATTACHMENT_FILE_BYTES = 26_214_400;
export const ATTACHMENT_MAX_FILES = 20;
export const ATTACHMENT_TOTAL_BYTES = 104_857_600;
export const ATTACHMENT_BUDGET_SECONDS = 120;

/**
 * The hosted API edge refuses Node's default User-Agent (403, error code
 * 1010), so a curl-like one is set explicitly, as stride-hook.ps1 does.
 */
export const ATTACHMENT_USER_AGENT = "curl/8.0 (stride-pi)";

export type AttachmentStatus = "downloaded" | "skipped" | "failed";

/** One manifest entry, in the contract's key order. */
export interface ManifestEntry {
  id: unknown;
  filename: unknown;
  local_file: string | null;
  content_type: unknown;
  byte_size: unknown;
  sha256: unknown;
  comment_id: unknown;
  uploaded_at: unknown;
  download_path: string | null;
  status: AttachmentStatus;
  reason: string | null;
}

export interface AttachmentSummary {
  stem: string;
  downloaded: number;
  skipped: number;
  failed: number;
}

export interface AttachmentDeps {
  /** Required: index.ts is the only place the real global fetch is supplied. */
  fetch: FetchFn;
  /** Defaults to readStrideAuth. */
  readAuth?: (cwd: string) => StrideAuth;
  /** May only SHORTEN the 120 s budget; anything else is ignored. */
  budgetSeconds?: number;
  /** Milliseconds clock, for tests. Defaults to Date.now. */
  now?: () => number;
  /** Diagnostic sink. Defaults to process.stderr. */
  stderr?: (line: string) => void;
}

const SAFE_NAME_CHAR = /^[A-Za-z0-9._-]$/;
const NUMBER_ID_RE = /^[0-9]{1,64}$/;
const STRING_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const TASK_ID_RE = /^[0-9]{1,20}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HTTP_STATUS_RE = /^[1-9][0-9][0-9]$/;

function writeStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    /* best effort */
  }
}

function randomSuffix(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The saved-name part after `<id>-`: basename after the last `/` then the
 * last `\`; every code point outside A-Za-z0-9._- becomes `_` (an emoji is
 * one `_`); leading dots stripped; over 100 characters it is cut, keeping an
 * extension of at most 16 characters (dot included) whose dot is not the
 * first character; an empty result is `attachment`.
 */
export function sanitiseAttachmentName(filename: unknown): string {
  const raw = typeof filename === "string" ? filename : "";
  const afterSlash = raw.split("/").pop() ?? "";
  const base = afterSlash.split("\\").pop() ?? "";
  let name = Array.from(base, (ch) => (SAFE_NAME_CHAR.test(ch) ? ch : "_")).join("");
  name = truncateName(name.replace(/^\.+/, ""));
  return name === "" ? "attachment" : name;
}

/** Cut a name over 100 characters, keeping a short extension whose dot is not first. */
function truncateName(name: string): string {
  if (name.length <= 100) return name;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && name.length - dot <= 16) {
    return name.slice(0, 100 - (name.length - dot)) + name.slice(dot);
  }
  return name.slice(0, 100);
}

/**
 * The attachment id as the decimal string used in the saved name, or null
 * (reason unsafe_id). A number must render as plain digits — so a negative, a
 * fraction or an exponent form is refused, as in the shell half.
 */
export function attachmentIdString(id: unknown): string | null {
  if (typeof id === "number") {
    const text = String(id);
    return NUMBER_ID_RE.test(text) ? text : null;
  }
  if (typeof id === "string" && STRING_ID_RE.test(id)) return id;
  return null;
}

/** The claimed task's numeric id as a string of 1-20 digits, or null. */
export function claimedTaskIdString(id: unknown): string | null {
  if (typeof id === "number") {
    const text = String(id);
    return TASK_ID_RE.test(text) ? text : null;
  }
  if (typeof id === "string" && TASK_ID_RE.test(id)) return id;
  return null;
}

/**
 * The download path when it is exactly `/api/tasks/<taskId>/attachments/<n>`,
 * else null (reason unsafe_url). The anchored whole-string match excludes an
 * absolute or protocol-relative URL, `..`, `//`, a query, a fragment,
 * percent-encoding, a backslash, whitespace and any other task's files.
 */
export function safeDownloadPath(url: unknown, taskId: string | null): string | null {
  if (taskId === null || typeof url !== "string") return null;
  if (!TASK_ID_RE.test(taskId)) return null;
  const re = new RegExp(`^/api/tasks/${taskId}/attachments/[0-9]{1,20}$`);
  return re.test(url) ? url : null;
}

/** A declared byte_size usable for the caps, or null (reason too_large). */
function declaredSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

interface PlannedEntry {
  entry: ManifestEntry;
  /** Set only for an accepted entry, which the download loop settles. */
  pending: { path: string; size: number; sha: string | null; local: string } | null;
}

function asRecord(item: unknown): Record<string, unknown> {
  return (item && typeof item === "object" && !Array.isArray(item) ? item : {}) as Record<
    string,
    unknown
  >;
}

/** The first of the five pre-download checks an entry fails, or null. */
function skipReason(
  checked: { sid: string | null; dlPath: string | null; size: number | null },
  accepted: number,
  total: number,
): string | null {
  if (checked.sid === null) return "unsafe_id";
  if (checked.dlPath === null) return "unsafe_url";
  if (checked.size === null || checked.size > ATTACHMENT_FILE_BYTES) return "too_large";
  if (accepted >= ATTACHMENT_MAX_FILES) return "count_cap";
  if (total + checked.size > ATTACHMENT_TOTAL_BYTES) return "total_cap";
  return null;
}

/** A missing field reads as null in the manifest. */
const orNull = (value: unknown): unknown => value ?? null;

/** The manifest entry for one server entry, as skipped until it settles. */
function manifestEntry(
  o: Record<string, unknown>,
  dlPath: string | null,
  reason: string | null,
): ManifestEntry {
  return {
    id: orNull(o.id),
    filename: orNull(o.filename),
    local_file: null,
    content_type: orNull(o.content_type),
    byte_size: orNull(o.byte_size),
    sha256: orNull(o.sha256),
    comment_id: orNull(o.comment_id),
    uploaded_at: orNull(o.uploaded_at),
    download_path: dlPath,
    status: "skipped",
    reason,
  };
}

/** A declared sha256 of 64 lowercase hex digits, or null (which fails closed). */
function declaredSha(value: unknown): string | null {
  return typeof value === "string" && SHA256_RE.test(value) ? value : null;
}

/**
 * One entry per server entry, in server order, with the five pre-download
 * checks applied in the contract's order. count_cap and total_cap count
 * ACCEPTED entries only, so the outcome depends only on the list.
 */
export function planAttachments(list: unknown[], taskId: string | null): PlannedEntry[] {
  let accepted = 0;
  let total = 0;
  return list.map((item) => {
    const o = asRecord(item);
    const sid = attachmentIdString(o.id);
    const dlPath = safeDownloadPath(o.download_url, taskId);
    const size = declaredSize(o.byte_size);
    const reason = skipReason({ sid, dlPath, size }, accepted, total);
    const entry = manifestEntry(o, dlPath, reason);
    if (reason !== null || sid === null || dlPath === null || size === null) {
      return { entry, pending: null };
    }
    accepted += 1;
    total += size;
    return {
      entry,
      pending: {
        path: dlPath,
        size,
        sha: declaredSha(o.sha256),
        local: `${sid}-${sanitiseAttachmentName(o.filename)}`,
      },
    };
  });
}

/** Absent, or a real directory that is not a symlink. */
function dirOk(p: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
  return !st.isSymbolicLink() && st.isDirectory();
}

function isDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

/** Remove a task directory, manifest first, so no manifest outlives its files. */
function removeTaskDir(tdir: string): void {
  try {
    fs.rmSync(path.join(tdir, "manifest.json"), { force: true });
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(tdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Write `text` to `dest` via a staged file in `dir` and a rename. */
function stagedWrite(dir: string, prefix: string, dest: string, text: string): boolean {
  const tmp = path.join(dir, `${prefix}.${randomSuffix()}`);
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return false;
  }
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

/** Open the staging file for one entry, or null when it cannot be created. */
function openPart(part: string): number | null {
  try {
    return fs.openSync(part, "wx", 0o600);
  } catch {
    return null;
  }
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* best effort */
  }
}

/** The reason for a failed request: time_budget when its signal fired. */
function abortReason(signal: AbortSignal): string {
  return signal.aborted ? "time_budget" : "transport";
}

/**
 * The reason a non-200 response records: http_<code> for a three-digit
 * status, else transport (or time_budget). Its body is discarded unread.
 */
async function nonOkReason(response: Response, signal: AbortSignal): Promise<string> {
  try {
    await response.body?.cancel();
  } catch {
    /* best effort */
  }
  const status = String(response.status);
  return HTTP_STATUS_RE.test(status) ? `http_${status}` : abortReason(signal);
}

/**
 * Stream a body into `fd` and `hash` and return its length, or null as soon
 * as it passes `size` (the read is cancelled then, however it would have
 * ended). A missing body reads as empty.
 */
async function streamInto(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  fd: number,
  hash: ReturnType<typeof createHash>,
  size: number,
): Promise<number | null> {
  if (!reader) return 0;
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return got;
    got += value.length;
    if (got > size) {
      await reader.cancel().catch(() => {});
      return null;
    }
    hash.update(value);
    writeAll(fd, value);
  }
}

/**
 * Stream a 200 body into `fd` and return null when it is exactly `size` bytes
 * with the declared digest, else the failure reason. An absent or malformed
 * declared digest fails closed: an unverified file is never kept.
 */
async function readVerifiedBody(
  response: Response,
  fd: number,
  expected: { size: number; sha: string | null },
  signal: AbortSignal,
): Promise<string | null> {
  const hash = createHash("sha256");
  let got: number | null;
  try {
    got = await streamInto(response.body?.getReader(), fd, hash, expected.size);
  } catch {
    return abortReason(signal);
  }
  if (got !== expected.size) return "size_mismatch";
  return expected.sha !== null && hash.digest("hex") === expected.sha ? null : "sha256_mismatch";
}

/**
 * Fetch one accepted entry into `part`, verify it, and return null on success
 * or the failure reason. The status decides first, so a 500 whose body is
 * longer than the file is http_500 rather than size_mismatch. Redirects are
 * never followed, so the token reaches no host but the configured origin.
 */
async function fetchOne(opts: {
  fetch: FetchFn;
  url: string;
  token: string;
  size: number;
  sha: string | null;
  part: string;
  leftMs: number;
}): Promise<string | null> {
  const fd = openPart(opts.part);
  if (fd === null) return "transport";
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(opts.leftMs)));
  try {
    let response: Response;
    try {
      response = await opts.fetch(opts.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "User-Agent": ATTACHMENT_USER_AGENT,
          Accept: "*/*",
        },
        redirect: "manual",
        signal,
      });
    } catch {
      return abortReason(signal);
    }
    if (response.status !== 200) return await nonOkReason(response, signal);
    return await readVerifiedBody(response, fd, { size: opts.size, sha: opts.sha }, signal);
  } finally {
    closeQuietly(fd);
  }
}

function effectiveBudgetSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return Math.min(value, ATTACHMENT_BUDGET_SECONDS);
  }
  return ATTACHMENT_BUDGET_SECONDS;
}

type Log = (line: string) => void;

/**
 * Write `.stride/attachments/.gitignore` (`*`) before any file, so a download
 * can never be committed. A symlinked one is removed rather than written
 * through; anything else that is not a regular file refuses the run.
 */
function ensureGitignore(adir: string, stem: string, log: Log): boolean {
  const gitignore = path.join(adir, ".gitignore");
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(gitignore);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    fs.rmSync(gitignore, { force: true });
  } else if (st && !st.isFile()) {
    log(`stride: attachments ${stem}: .stride/attachments/.gitignore is not a regular file; nothing downloaded\n`);
    return false;
  }
  if (!stagedWrite(adir, ".gitignore", gitignore, "*\n")) {
    log(`stride: attachments ${stem}: could not write .stride/attachments/.gitignore; nothing downloaded\n`);
    return false;
  }
  return true;
}

/** A re-claim replaces the task directory, old manifest first. */
function replaceTaskDir(tdir: string, stem: string, log: Log): boolean {
  if (isDir(tdir)) removeTaskDir(tdir);
  try {
    fs.mkdirSync(tdir, { mode: 0o700 });
  } catch {
    /* checked below */
  }
  if (isDir(tdir)) return true;
  log(`stride: attachments ${stem}: could not create the task directory; nothing downloaded\n`);
  return false;
}

/**
 * Make `.stride/attachments/<STEM>/` ready for a non-empty list and return its
 * path, or null when nothing may be written. A symlink or non-directory at
 * `.stride`, `.stride/attachments` or the task directory refuses the run.
 */
function prepareAttachmentDirs(cwd: string, stem: string, log: Log): string | null {
  const root = path.join(cwd, ".stride");
  const adir = path.join(root, "attachments");
  const tdir = path.join(adir, stem);
  try {
    fs.mkdirSync(adir, { recursive: true });
  } catch {
    /* checked below */
  }
  if (!isDir(adir) || !dirOk(root)) {
    log(`stride: attachments ${stem}: could not create .stride/attachments; nothing written\n`);
    return null;
  }
  if (!ensureGitignore(adir, stem, log)) return null;
  return replaceTaskDir(tdir, stem, log) ? tdir : null;
}

/**
 * The API origin and token, from `.stride_auth.md` only, or null when either
 * is unusable. readStrideAuth admits https, or http to a loopback host, and
 * returns an origin.
 */
function resolveAttachmentAuth(
  cwd: string,
  readAuth: (cwd: string) => StrideAuth,
): { apiBase: string; token: string } | null {
  let auth: StrideAuth;
  try {
    auth = readAuth(cwd);
  } catch {
    return null;
  }
  const apiBase = typeof auth?.apiBase === "string" ? auth.apiBase.replace(/\/+$/, "") : "";
  const token = typeof auth?.token === "string" ? auth.token : "";
  return /^https?:\/\/[^/]+$/.test(apiBase) && token !== "" ? { apiBase, token } : null;
}

interface DownloadContext {
  tdir: string;
  fetch: FetchFn;
  auth: { apiBase: string; token: string } | null;
  deadline: number;
  now: () => number;
}

/** Settle one planned entry: skip it on a spent budget, else fetch and keep or remove it. */
async function settleEntry(planned: PlannedEntry, ctx: DownloadContext): Promise<void> {
  const { entry, pending } = planned;
  if (!pending) return;
  const leftMs = ctx.deadline - ctx.now();
  if (leftMs <= 0) {
    entry.status = "skipped";
    entry.reason = "time_budget";
    return;
  }
  const part = path.join(ctx.tdir, `.part.${randomSuffix()}`);
  let reason: string | null = "transport";
  if (ctx.auth) {
    reason = await fetchOne({
      fetch: ctx.fetch,
      url: `${ctx.auth.apiBase}${pending.path}`,
      token: ctx.auth.token,
      size: pending.size,
      sha: pending.sha,
      part,
      leftMs,
    }).catch(() => "transport");
  }
  if (reason === null) {
    try {
      fs.renameSync(part, path.join(ctx.tdir, pending.local));
      entry.status = "downloaded";
      entry.reason = null;
      entry.local_file = pending.local;
      return;
    } catch {
      reason = "transport";
    }
  }
  fs.rmSync(part, { force: true });
  entry.status = "failed";
  entry.reason = reason;
  entry.local_file = null;
}

/**
 * The manifest, LAST: compact, key order fixed by the contract, one trailing
 * LF, no timestamp of its own, no URL, no token.
 */
function writeManifest(
  tdir: string,
  data: Record<string, unknown>,
  budgetSeconds: number,
  plan: PlannedEntry[],
): boolean {
  const manifest = {
    manifest_version: 1,
    task: {
      id: typeof data.id === "number" ? data.id : null,
      identifier: typeof data.identifier === "string" ? data.identifier : null,
    },
    caps: {
      file_bytes: ATTACHMENT_FILE_BYTES,
      files: ATTACHMENT_MAX_FILES,
      total_bytes: ATTACHMENT_TOTAL_BYTES,
      budget_seconds: budgetSeconds,
    },
    attachments: plan.map((p) => p.entry),
  };
  return stagedWrite(tdir, ".manifest", path.join(tdir, "manifest.json"), JSON.stringify(manifest) + "\n");
}

/** The claim's `data` object and its stem, or null when there is no safe stem. */
function taskAndStem(task: unknown): { data: Record<string, unknown>; stem: string } | null {
  if (!task || typeof task !== "object" || Array.isArray(task)) return null;
  const data = task as Record<string, unknown>;
  const stem = taskFileStem(data);
  return stem ? { data, stem } : null;
}

/**
 * Whether a download may go ahead. A symlink or non-directory at `.stride`,
 * `.stride/attachments` or the task directory stops it (logged only when the
 * list is non-empty). An empty list creates nothing, and removes a directory
 * an EARLIER claim of this task left, so its manifest can never describe
 * this one.
 */
function readyToDownload(cwd: string, stem: string, list: unknown[], log: Log): boolean {
  const root = path.join(cwd, ".stride");
  const adir = path.join(root, "attachments");
  const existing = path.join(adir, stem);
  if (!dirOk(root) || !dirOk(adir) || !dirOk(existing)) {
    if (list.length > 0) {
      log(
        `stride: attachments ${stem}: a .stride, .stride/attachments or task directory is a symlink or not a directory; nothing written\n`,
      );
    }
    return false;
  }
  if (list.length === 0) {
    if (isDir(existing)) removeTaskDir(existing);
    return false;
  }
  return true;
}

/** Settle every planned entry in order against one shared wall-clock budget. */
async function settleAll(
  cwd: string,
  tdir: string,
  plan: PlannedEntry[],
  deps: AttachmentDeps,
  budgetSeconds: number,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const ctx: DownloadContext = {
    tdir,
    fetch: deps.fetch,
    auth: resolveAttachmentAuth(cwd, deps.readAuth ?? readStrideAuth),
    deadline: now() + budgetSeconds * 1000,
    now,
  };
  for (const planned of plan) await settleEntry(planned, ctx);
}

function summarise(stem: string, plan: PlannedEntry[], log: Log): AttachmentSummary {
  const summary: AttachmentSummary = { stem, downloaded: 0, skipped: 0, failed: 0 };
  for (const { entry } of plan) summary[entry.status] += 1;
  log(
    `stride: attachments ${stem}: ${summary.downloaded} downloaded, ${summary.skipped} skipped, ${summary.failed} failed\n`,
  );
  return summary;
}

async function runDownload(
  cwd: string,
  data: Record<string, unknown>,
  stem: string,
  deps: AttachmentDeps,
  log: Log,
): Promise<AttachmentSummary | null> {
  const list = Array.isArray(data.attachments) ? (data.attachments as unknown[]) : [];
  if (!readyToDownload(cwd, stem, list, log)) return null;
  const plan = planAttachments(list, claimedTaskIdString(data.id));
  const tdir = prepareAttachmentDirs(cwd, stem, log);
  if (!tdir) return null;
  const budgetSeconds = effectiveBudgetSeconds(deps.budgetSeconds);
  await settleAll(cwd, tdir, plan, deps, budgetSeconds);
  if (!writeManifest(tdir, data, budgetSeconds, plan)) {
    log(`stride: attachments ${stem}: could not write manifest.json\n`);
    return null;
  }
  return summarise(stem, plan, log);
}

/**
 * Download the attachments `task` (a proven claim's `data` object) lists.
 * Returns the counts, or null when nothing was written. Never throws.
 */
export async function downloadAttachments(
  cwd: string,
  task: unknown,
  deps: AttachmentDeps,
): Promise<AttachmentSummary | null> {
  const log = deps.stderr ?? writeStderr;
  let stem = "?";
  try {
    const found = taskAndStem(task);
    if (!found) return null;
    stem = found.stem;
    return await runDownload(cwd, found.data, stem, deps, log);
  } catch {
    log(`stride: attachments ${stem}: the download stopped early; continuing\n`);
    return null;
  }
}

/**
 * The claim branch's one call: take `data` from THIS tool_result's own output
 * and download its attachments only when that output proves the task
 * identity — a `data` object whose numeric `id` and `identifier` are both
 * present and safe. Anything else (a truncated body, a 4xx, an id-less
 * object) downloads nothing and touches nothing. Never throws.
 */
export async function downloadClaimAttachments(
  cwd: string,
  content: unknown,
  details: unknown,
  deps: AttachmentDeps,
): Promise<AttachmentSummary | null> {
  try {
    const data = claimDataFromOutput(content, details);
    if (!data) return null;
    if (claimedTaskIdString(data.id) === null) return null;
    if (typeof data.identifier !== "string" || taskFileStem(data) !== data.identifier) return null;
    return await downloadAttachments(cwd, data, deps);
  } catch {
    return null;
  }
}
