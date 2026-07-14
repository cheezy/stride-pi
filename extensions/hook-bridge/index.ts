/**
 * stride-pi hook-bridge extension
 *
 * Bridges Pi's tool_call / tool_result events onto Stride's five .stride.md
 * lifecycle hooks (before_doing, after_doing, before_review, after_review,
 * after_goal). Mirrors stride-gemini/hooks/stride-hook.sh in behavior.
 *
 * Implementation choices (see stride-pi/docs/ADR-002-hook-mechanism.md):
 *   - before_doing / before_review / after_review run in tool_result (post-call).
 *     Failures are logged but do not affect the call (it already succeeded).
 *   - after_doing runs in tool_call (pre-call). Failure returns
 *     { block: true, reason } to veto the /complete curl — handler return
 *     shape is ToolCallEventResult.
 *   - after_goal is not URL-routed; it fires when the /complete or
 *     /mark_reviewed response payload bundles an after_goal entry (see
 *     after-goal-detector.ts / after-goal-runner.ts).
 *   - Each hook has its own budget from HOOK_TIMEOUTS_MS (after_doing
 *     300 000 ms, the other four 60 000 ms), not a single shared deadline.
 *     runHookCommands runs the section's commands sequentially, giving each
 *     command the time still remaining in the hook budget; when the budget is
 *     exhausted the child is SIGTERM'd then SIGKILL'd after a 5 s grace.
 *   - After a successful claim, the API response is parsed to extract task
 *     metadata and written to `.stride-env-cache` so subsequent hook
 *     commands can reference $TASK_IDENTIFIER, $TASK_TITLE, etc.
 *   - The cache is deleted after after_review fires.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@mariozechner/pi-coding-agent";

import { parseHookSection } from "./stride-md-parser.js";
import { detectStrideHook, type StrideHookName } from "./curl-matcher.js";
import {
  finalizeAfterDoing,
  selfHealChangedFilesUpload,
  readFinalizerEnv,
  captureClaimDirtyBaseline,
  writeClaimDirtyBaseline,
  extractApiBase,
  extractToken,
  CHANGED_FILES_SNAPSHOT_FILE,
  DIFF_UPLOAD_STATE_FILE,
  CLAIM_DIRTY_BASELINE_FILE,
} from "./changed-files.js";
import {
  responseHasAfterGoal,
  extractGoalEnvFromResult,
  toolOutputCandidates,
} from "./after-goal-detector.js";
import {
  getAfterGoalStatus,
  readCanonicalResponse,
  writeCanonicalResponse,
} from "./after-goal-status.js";
import { runAfterGoalAndCleanup } from "./after-goal-runner.js";
import {
  type CommandOutput,
  type HookResult,
  COMMAND_OUTPUT_TAIL_LINES,
  formatHookResultJson,
  tailLines,
} from "./hook-result.js";
import {
  type TaskEnv,
  TASK_ENV_KEYS,
  resolveClaimEnvCache,
  resolveFinalizeBeforeDoingEnv,
} from "./env-cache.js";

// Per-hook timeout budgets. after_doing runs the full quality-gate suite
// (tests/lint/build) so it gets the largest window; the others are quick
// pre/post actions. The early changed-files snapshot is captured BEFORE the
// after_doing gate runs (and re-attempted by the before_review self-heal), so
// even if a long gate exhausts this budget the diff still survives. Matches the
// README timeout table and the canonical stride hooks.json 300s after_doing.
const HOOK_TIMEOUTS_MS: Record<StrideHookName, number> = {
  before_doing: 60_000,
  after_doing: 300_000,
  before_review: 60_000,
  after_review: 60_000,
  after_goal: 60_000,
};
const KILL_GRACE_MS = 5_000;

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    const hook = detectStrideHook("pre", command);
    if (hook !== "after_doing") return;

    // Capture and PUT the diff snapshot BEFORE the after_doing gate runs, so a
    // gate failure or timeout still leaves a usable snapshot on the server. The
    // post-gate finalize below refreshes it with the gate's own changes. This
    // pre-gate call is gated to after_doing by the early return above, so it
    // never fires for before_doing/before_review/after_review/after_goal.
    try {
      const { taskId, baseRef, trusted } = readFinalizerEnv(ctx.cwd);
      await finalizeAfterDoing({ cwd: ctx.cwd, command, taskId, baseRef, trusted });
    } catch {
      // intentional: never veto /complete on capture/upload failure
    }

    const result = await runHook(hook, ctx);
    if (result && !result.success) {
      return {
        block: true,
        reason: formatBlockReason(result),
      };
    }

    // Gate succeeded (or no hook configured). Refresh the snapshot so any
    // changes the gate itself produced (e.g. formatters) are captured. Fail-soft:
    // any error here must not block the agent's /complete curl.
    try {
      const { taskId, baseRef, trusted } = readFinalizerEnv(ctx.cwd);
      await finalizeAfterDoing({ cwd: ctx.cwd, command, taskId, baseRef, trusted });
    } catch {
      // intentional: never veto /complete on capture/upload failure
    }
    return;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!isBashToolResult(event)) return;
    const command = readBashCommand(event.input);
    if (!command) return;

    const hook = detectStrideHook("post", command);
    if (!hook) return;

    if (hook === "before_doing") {
      const taskEnv = extractTaskEnvFromResult(event.content, event.details);
      // (D142) Persist task IDENTITY only and strip any inherited
      // TASK_BASE_REF / TASK_BASE_REF_TRUSTED. The base is (re)captured and
      // (re)persisted AFTER runHook returns (finalizeBeforeDoing below), once
      // the ## before_doing section's `git pull` has moved HEAD to the
      // post-pull branch point — capturing it now would anchor the diff at the
      // PRE-pull commit and span another clone's pulled work (D132/W1678).
      const resolved = resolveClaimEnvCache(taskEnv, loadEnvCache(ctx.cwd));
      if (resolved) writeEnvCache(ctx.cwd, resolved);
      // Clear any leftover snapshot/upload-state/claim-dirty-baseline from a
      // prior task so a stale 2xx cannot suppress the new task's before_review
      // self-heal. Runs on the claim regardless of whether task env parsed. The
      // claim-time dirty baseline is likewise (re)recorded post-section, hashed
      // against the post-pull tree.
      deleteDiffArtifacts(ctx.cwd);
    }

    // before_review self-heal: if the after_doing finalize never landed the
    // diff (gate timeout, transport failure, non-2xx), re-upload it now on the
    // fresh tool_result budget. Gated to before_review; fail-soft.
    if (hook === "before_review") {
      try {
        const { taskId, baseRef, trusted } = readFinalizerEnv(ctx.cwd);
        await selfHealChangedFilesUpload({ cwd: ctx.cwd, command, taskId, baseRef, trusted });
      } catch {
        // intentional: never disturb the already-succeeded /complete call
      }
    }

    // D118 (write side): the after_goal entry rides in the /complete
    // (before_review) or /mark_reviewed (after_review) response, which the
    // harness can truncate — dropping the entry from event.content /
    // details.output. Capture the intercepted output to the canonical file
    // now so the detector below reads the untruncated payload. Only a
    // complete, valid-JSON candidate is written (writeCanonicalResponse
    // refuses anything else), so a truncated output is skipped and any good
    // file from the agent's `| tee` survives; a complete current output
    // overwrites a stale prior-call file.
    if (hook === "before_review" || hook === "after_review") {
      for (const raw of toolOutputCandidates(event.content, event.details)) {
        if (writeCanonicalResponse(ctx.cwd, raw)) break;
      }
    }

    const result = await runHook(hook, ctx);
    if (result && !result.success) {
      reportNonBlockingFailure(ctx, result);
    }

    // (D142) Capture TASK_BASE_REF only now — AFTER the ## before_doing section
    // ran its `git pull` / branch checkout — so the base is the post-pull branch
    // point, then re-record the claim-time dirty baseline against that same
    // post-pull tree. Runs even when the section failed (the claim already
    // succeeded — this tool_result cannot veto it — and a partially-run section
    // still leaves HEAD more accurate than the pre-pull value). No-op for every
    // other hook route.
    if (hook === "before_doing") {
      const baseRef = captureBaseRef(ctx.cwd);
      const finalized = resolveFinalizeBeforeDoingEnv(baseRef, loadEnvCache(ctx.cwd));
      if (finalized) writeEnvCache(ctx.cwd, finalized);
      writeClaimDirtyBaseline(ctx.cwd, captureClaimDirtyBaseline(ctx.cwd));
    }

    // Run `## after_goal` (when the server bundled one) and then clean up
    // the env cache. Ordering matters: cleanup must follow after_goal so
    // the hook runs with its env intact on the mark_reviewed route. The
    // forwarded goalEnv carries the GOAL_* / BOARD_* / COLUMN_* /
    // AGENT_NAME values the server supplied verbatim in `hook.env`. The
    // detector reads the canonical file FIRST (D118 read side) via the
    // injected reader, falling back to the tool-output candidates.
    const canonicalReader = () => readCanonicalResponse(ctx.cwd);
    await runAfterGoalAndCleanup(hook, !result || result.success, event.content, event.details, {
      hasAfterGoal: (content, details) => responseHasAfterGoal(content, details, canonicalReader),
      extractGoalEnv: (content, details) =>
        extractGoalEnvFromResult(content, details, canonicalReader),
      // D119: when the fast path (file/output) detects no after_goal — the
      // truncated-output case — ask the server directly. Keyed off the just-
      // completed task id (from the env cache written at claim time), with
      // apiBase/token lifted from the /complete|/mark_reviewed curl itself.
      // Returns null when we cannot form the request, so the runner no-ops.
      freshAfterGoalStatus: async () => {
        const { taskId } = readFinalizerEnv(ctx.cwd);
        const apiBase = extractApiBase(command);
        const token = extractToken(command);
        if (!taskId || !apiBase || !token) return null;
        return getAfterGoalStatus({ fetch, apiBase, token, taskId });
      },
      runAfterGoal: (goalEnv) => runHook("after_goal", ctx, goalEnv),
      emitResult: (agResult) => process.stdout.write(formatHookResultJson(agResult) + "\n"),
      deleteEnvCache: () => {
        deleteEnvCache(ctx.cwd);
        deleteDiffArtifacts(ctx.cwd);
      },
    });
  });
}

async function runHook(
  hook: StrideHookName,
  ctx: ExtensionContext,
  extraEnv?: Record<string, string>,
): Promise<HookResult | null> {
  const stridePath = path.join(ctx.cwd, ".stride.md");
  if (!fs.existsSync(stridePath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(stridePath, "utf-8");
  } catch {
    return null;
  }

  const commands = parseHookSection(content, hook);
  if (commands.length === 0) return null;

  const env = buildHookEnv(ctx.cwd, hook, extraEnv);
  return runHookCommands(hook, commands, ctx.cwd, env, ctx.signal, HOOK_TIMEOUTS_MS[hook]);
}

async function runHookCommands(
  hook: StrideHookName,
  commands: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  hookTimeoutMs: number,
): Promise<HookResult> {
  const start = Date.now();
  const outputParts: string[] = [];
  const commandsOutput: CommandOutput[] = [];

  for (const command of commands) {
    const remaining = hookTimeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      return {
        hook,
        success: false,
        exitCode: 124,
        output: outputParts.join("\n"),
        failedCommand: command,
        durationMs: Date.now() - start,
      };
    }

    const step = await runOneCommand(command, cwd, env, remaining, signal);
    if (step.output) outputParts.push(`$ ${command}\n${step.output}`);
    // Record this command's tail-truncated output for the success-path
    // commands_output array (D65). Built incrementally; only attached to the
    // success return below so the failure shape stays unchanged.
    commandsOutput.push({ command, output: tailLines(step.output, COMMAND_OUTPUT_TAIL_LINES) });
    if (step.exitCode !== 0) {
      return {
        hook,
        success: false,
        exitCode: step.exitCode,
        output: outputParts.join("\n"),
        failedCommand: command,
        durationMs: Date.now() - start,
      };
    }
  }

  return {
    hook,
    success: true,
    exitCode: 0,
    output: outputParts.join("\n"),
    durationMs: Date.now() - start,
    commandsOutput,
  };
}

interface StepResult {
  exitCode: number;
  output: string;
}

function runOneCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let timedOut = false;
    let exited = false;
    let killGrace: NodeJS.Timeout | undefined;

    // proc.killed flips to true the moment kill() is delivered, NOT when the
    // child actually exits — so we track exit ourselves to know whether
    // SIGTERM was honored before the grace window expired.
    const onAbort = () => {
      proc.kill("SIGTERM");
      killGrace = setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeoutMs);

    proc.stdout.on("data", (c: Buffer) => {
      buffer += c.toString("utf-8");
    });
    proc.stderr.on("data", (c: Buffer) => {
      buffer += c.toString("utf-8");
    });

    proc.on("error", (err) => {
      exited = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ exitCode: 127, output: `${buffer}\nfailed to spawn: ${err.message}` });
    });

    proc.on("close", (code, sig) => {
      exited = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (timedOut) {
        resolve({
          exitCode: 124,
          output: `${buffer}\nhook command timed out after ${timeoutMs} ms`,
        });
        return;
      }
      if (code !== null) {
        resolve({ exitCode: code, output: buffer });
      } else {
        resolve({
          exitCode: 128,
          output: `${buffer}\nhook command terminated by signal ${sig ?? "unknown"}`,
        });
      }
    });
  });
}

function buildHookEnv(
  cwd: string,
  hook: StrideHookName,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const cached = loadEnvCache(cwd);
  return {
    ...process.env,
    ...cached,
    ...(extraEnv ?? {}),
    HOOK_NAME: hook,
  };
}

function envCachePath(cwd: string): string {
  return path.join(cwd, ".stride-env-cache");
}

function loadEnvCache(cwd: string): TaskEnv {
  const file = envCachePath(cwd);
  if (!fs.existsSync(file)) return {};

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }

  const result: TaskEnv = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)='((?:[^'\\]|\\.)*)'$/);
    if (!match) continue;
    const key = match[1] as (typeof TASK_ENV_KEYS)[number];
    if (!TASK_ENV_KEYS.includes(key)) continue;
    result[key] = match[2].replace(/\\(.)/g, "$1");
  }
  return result;
}

function writeEnvCache(cwd: string, env: TaskEnv): void {
  const lines: string[] = [];
  for (const key of TASK_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === null || value === "") continue;
    const escaped = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    lines.push(`${key}='${escaped}'`);
  }
  if (lines.length === 0) return;
  try {
    fs.writeFileSync(envCachePath(cwd), `${lines.join("\n")}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // best effort — env cache is an optimization, not a correctness requirement
  }
}

function deleteEnvCache(cwd: string): void {
  try {
    fs.rmSync(envCachePath(cwd), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Remove the changed-files snapshot and diff-upload-state artifacts. Called on
 * claim (clear any prior task's leftovers) and after_review (final cleanup), so
 * a stale 2xx upload-state can never suppress a later task's self-heal. Mirrors
 * the rm cleanup in stride-hook.sh's claim and after_review paths. Best-effort.
 */
function deleteDiffArtifacts(cwd: string): void {
  for (const name of [
    CHANGED_FILES_SNAPSHOT_FILE,
    DIFF_UPLOAD_STATE_FILE,
    CLAIM_DIRTY_BASELINE_FILE,
  ]) {
    try {
      fs.rmSync(path.join(cwd, name), { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Capture the commit HEAD points at when the task is claimed (before_doing).
 * changed-files anchors its per-file diff to this baseline (via TASK_BASE_REF in
 * the env cache) so a multi-commit task reports the full claim->completion delta
 * instead of only the last commit. Mirrors stride-hook.sh, which runs
 * `git rev-parse HEAD` at claim and writes TASK_BASE_REF. Best-effort: returns
 * "" on any git failure, which makes resolveBase fall back to HEAD~1.
 */
function captureBaseRef(cwd: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout.trim();
    }
  } catch {
    // best effort — absent a base ref, changed-files falls back to HEAD~1
  }
  return "";
}

function readBashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const cmd = (input as Record<string, unknown>).command;
  return typeof cmd === "string" ? cmd : null;
}

/**
 * Extract task metadata from a tool_result for a claim curl. The response may
 * surface in three shapes (mirroring stride-hook.sh:110-130):
 *
 *   1. event.details.output (BashToolDetails) — preferred, structured
 *   2. event.content (string) — fallback, raw stdout
 *
 * Inside either, the body may be a wrapper `{stdout: "<json>"}` (Claude Code
 * tooling), the raw `{data: {...}}` API envelope, or the unwrapped `{id, ...}`
 * task object.
 */
function extractTaskEnvFromResult(content: unknown, details: unknown): TaskEnv {
  const candidates: string[] = [];

  if (details && typeof details === "object") {
    const output = (details as Record<string, unknown>).output;
    if (typeof output === "string") candidates.push(output);
  }
  if (typeof content === "string") candidates.push(content);

  for (const candidate of candidates) {
    const task = parseTaskJson(candidate);
    if (task) return taskToEnv(task);
  }
  return {};
}

function parseTaskJson(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  // {stdout: "<inner-json>"} wrapper
  if (parsed && typeof parsed === "object" && "stdout" in (parsed as object)) {
    const inner = (parsed as Record<string, unknown>).stdout;
    if (typeof inner === "string") {
      const innerParsed = safeParse(inner);
      if (innerParsed) return extractTaskObject(innerParsed);
    }
  }

  return extractTaskObject(parsed);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractTaskObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object" && "id" in (obj.data as object)) {
    return obj.data as Record<string, unknown>;
  }
  if ("id" in obj) return obj;
  return null;
}

// Maps the env keys that derive from the claim API response. TASK_BASE_REF is
// NOT here — it is computed locally from git at claim time (see captureBaseRef),
// not read from the task object.
const TASK_FIELD_MAP = {
  TASK_ID: "id",
  TASK_IDENTIFIER: "identifier",
  TASK_TITLE: "title",
  TASK_STATUS: "status",
  TASK_COMPLEXITY: "complexity",
  TASK_PRIORITY: "priority",
} as const;

function taskToEnv(task: Record<string, unknown>): TaskEnv {
  const env: TaskEnv = {};
  for (const [key, field] of Object.entries(TASK_FIELD_MAP)) {
    const value = task[field];
    if (value === undefined || value === null) continue;
    env[key as keyof typeof TASK_FIELD_MAP] = String(value);
  }
  return env;
}

function formatBlockReason(result: HookResult): string {
  const failed = result.failedCommand ?? "<unknown>";
  const head = `Stride ${result.hook} hook failed (exit ${result.exitCode}). Command: ${failed}`;
  const tail = result.output ? truncate(result.output, 2000) : "(no output captured)";
  return `${head}\n\n${tail}`;
}

function reportNonBlockingFailure(ctx: ExtensionContext, result: HookResult): void {
  const failed = result.failedCommand ?? "<unknown>";
  const message = `Stride ${result.hook} hook failed (exit ${result.exitCode}). Command: ${failed}`;
  // stderr so the agent and operator both see it; tool_result is not modified.
  process.stderr.write(`${message}\n${truncate(result.output, 1000)}\n`);
  try {
    ctx.ui?.notify(message, "warning");
  } catch {
    // ctx.ui may be unavailable in -p / JSON mode
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more chars)`;
}
