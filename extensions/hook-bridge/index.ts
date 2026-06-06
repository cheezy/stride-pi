/**
 * stride-pi hook-bridge extension
 *
 * Bridges Pi's tool_call / tool_result events onto Stride's four .stride.md
 * lifecycle hooks. Mirrors stride-gemini/hooks/stride-hook.sh in behavior.
 *
 * Implementation choices (see stride-pi/docs/ADR-002-hook-mechanism.md):
 *   - before_doing / before_review / after_review run in tool_result (post-call).
 *     Failures are logged but do not affect the call (it already succeeded).
 *   - after_doing runs in tool_call (pre-call). Failure returns
 *     { block: true, reason } to veto the /complete curl per the docs at
 *     extensions.md:583 — handler return shape is ToolCallEventResult.
 *   - Pi imposes no handler-level timeout (verified in runner.js:598). Each
 *     hook is wrapped in Promise.race against a 120 000 ms deadline that
 *     matches stride-copilot/hooks/hooks.json. On timeout the child is
 *     SIGTERM'd then SIGKILL'd after a 5 s grace.
 *   - After a successful claim, the API response is parsed to extract task
 *     metadata and written to `.stride-env-cache` so subsequent hook
 *     commands can reference $TASK_IDENTIFIER, $TASK_TITLE, etc.
 *   - The cache is deleted after after_review fires.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType, isBashToolResult } from "@mariozechner/pi-coding-agent";

import { parseHookSection } from "./stride-md-parser.js";
import { detectStrideHook, type StrideHookName } from "./curl-matcher.js";
import { finalizeAfterDoing, readFinalizerEnv } from "./changed-files.js";
import {
  responseHasAfterGoal,
  extractGoalEnvFromResult,
} from "./after-goal-detector.js";
import { runAfterGoalAndCleanup } from "./after-goal-runner.js";

const HOOK_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 5_000;
const TASK_ENV_KEYS = [
  "TASK_ID",
  "TASK_IDENTIFIER",
  "TASK_TITLE",
  "TASK_STATUS",
  "TASK_COMPLEXITY",
  "TASK_PRIORITY",
] as const;

type TaskEnv = Partial<Record<(typeof TASK_ENV_KEYS)[number], string>>;

interface HookResult {
  hook: StrideHookName;
  success: boolean;
  exitCode: number;
  output: string;
  failedCommand?: string;
  durationMs: number;
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    const hook = detectStrideHook("pre", command);
    if (hook !== "after_doing") return;

    const result = await runHook(hook, ctx);
    if (result && !result.success) {
      return {
        block: true,
        reason: formatBlockReason(result),
      };
    }

    // Hook succeeded (or no hook configured). Capture per-file diffs and
    // fire-and-forget PUT them to /api/tasks/:id/changed_files. Fail-soft:
    // any error here must not block the agent's /complete curl.
    try {
      const { taskId, baseRef } = readFinalizerEnv(ctx.cwd);
      await finalizeAfterDoing({ cwd: ctx.cwd, command, taskId, baseRef });
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
      if (Object.keys(taskEnv).length > 0) {
        writeEnvCache(ctx.cwd, taskEnv);
      }
    }

    const result = await runHook(hook, ctx);
    if (result && !result.success) {
      reportNonBlockingFailure(ctx, result);
    }

    // Run `## after_goal` (when the server bundled one) and then clean up
    // the env cache. Ordering matters: cleanup must follow after_goal so
    // the hook runs with its env intact on the mark_reviewed route. The
    // forwarded goalEnv carries the GOAL_* / BOARD_* / COLUMN_* /
    // AGENT_NAME values the server supplied verbatim in `hook.env`.
    await runAfterGoalAndCleanup(hook, !result || result.success, event.content, event.details, {
      hasAfterGoal: responseHasAfterGoal,
      extractGoalEnv: extractGoalEnvFromResult,
      runAfterGoal: (goalEnv) => runHook("after_goal", ctx, goalEnv),
      emitResult: (agResult) => process.stdout.write(formatHookResultJson(agResult) + "\n"),
      deleteEnvCache: () => deleteEnvCache(ctx.cwd),
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
  return runHookCommands(hook, commands, ctx.cwd, env, ctx.signal);
}

async function runHookCommands(
  hook: StrideHookName,
  commands: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<HookResult> {
  const start = Date.now();
  const outputParts: string[] = [];

  for (const command of commands) {
    const remaining = HOOK_TIMEOUT_MS - (Date.now() - start);
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

function taskToEnv(task: Record<string, unknown>): TaskEnv {
  const env: TaskEnv = {};
  const mapping: Record<(typeof TASK_ENV_KEYS)[number], string> = {
    TASK_ID: "id",
    TASK_IDENTIFIER: "identifier",
    TASK_TITLE: "title",
    TASK_STATUS: "status",
    TASK_COMPLEXITY: "complexity",
    TASK_PRIORITY: "priority",
  };
  for (const key of TASK_ENV_KEYS) {
    const value = task[mapping[key]];
    if (value === undefined || value === null) continue;
    env[key] = String(value);
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

/**
 * Serialize a HookResult into the cross-plugin JSON shape stride-hook.sh
 * emits on stdout for the after_goal lifecycle. The Pi agent reads this
 * JSON and forwards {exit_code, output, duration_ms} to
 * PATCH /api/tasks/:goal_id/after_goal. Field names are snake_case to
 * match the Stride API contract; pi's internal HookResult uses camelCase,
 * so this function does the translation.
 */
function formatHookResultJson(result: HookResult): string {
  if (result.success) {
    return JSON.stringify({
      hook: result.hook,
      status: "success",
      exit_code: result.exitCode,
      output: result.output,
      duration_ms: result.durationMs,
    });
  }
  return JSON.stringify({
    hook: result.hook,
    status: "failed",
    exit_code: result.exitCode,
    output: result.output,
    failed_command: result.failedCommand ?? null,
    duration_ms: result.durationMs,
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more chars)`;
}
