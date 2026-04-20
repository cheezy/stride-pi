/**
 * stride-pi subagent-dispatch extension
 *
 * Registers a `dispatch_agent(agent, prompt)` tool that runs Stride's four
 * specialized agents (task-explorer, task-reviewer, task-decomposer,
 * hook-diagnostician) in isolated `pi -p` subprocesses — providing
 * parallelism and context isolation equivalent to sibling-plugin subagents
 * (Claude Code, Codex CLI, Gemini CLI).
 *
 * Each invocation:
 *   1. Resolves the agent's SYSTEM prompt from agents/<name>.md
 *   2. Writes the prompt to a temp file
 *   3. Creates an ephemeral PI_CODING_AGENT_DIR to isolate session state
 *   4. Spawns `pi --mode json -p --no-session --append-system-prompt <tmpfile>`
 *      with the task prompt as the final positional argument
 *   5. Parses newline-delimited JSON from stdout
 *   6. Returns the final assistant message as the tool result
 *   7. Cleans up temp dir + ephemeral agent dir
 *
 * The 4 inline skills in stride-pi/skills/stride-task-* remain as fallbacks
 * for Pi installs that don't load this extension. Behavior is dual-path:
 * stride-subagent-workflow prefers dispatch_agent when available, otherwise
 * falls back to the inline skill path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const AGENT_NAMES = [
  "stride-task-explorer",
  "stride-task-reviewer",
  "stride-task-decomposer",
  "stride-hook-diagnostician",
] as const;

type AgentName = (typeof AGENT_NAMES)[number];

const DispatchParams = Type.Object({
  agent: Type.Union(AGENT_NAMES.map((n) => Type.Literal(n))),
  prompt: Type.String({
    description: "The task prompt for the subagent, including any relevant Stride task metadata.",
  }),
});

const EXTENSION_DIR = (() => {
  // Resolve this file's directory (ESM-safe)
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS / jiti fallback
    return __dirname;
  }
})();

const AGENTS_DIR = path.join(EXTENSION_DIR, "agents");

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Stride Subagent",
    description:
      "Run one of the four Stride subagents (task-explorer, task-reviewer, task-decomposer, hook-diagnostician) in an isolated `pi -p` subprocess with its own context window. Returns the subagent's structured output as a string.",
    promptSnippet:
      "dispatch_agent({agent, prompt}) — isolated run of a Stride subagent in a subprocess",
    promptGuidelines: [
      "Use dispatch_agent for exploration (agent: 'stride-task-explorer'), code review (agent: 'stride-task-reviewer'), goal decomposition (agent: 'stride-task-decomposer'), and hook failure diagnosis (agent: 'stride-hook-diagnostician') — per the decision matrix in the stride-subagent-workflow skill.",
      "Each dispatch runs in an isolated subprocess and does not affect your main context window beyond the returned result string.",
      "Pass the full task metadata (key_files, patterns_to_follow, acceptance_criteria, etc.) as part of the prompt — the subprocess has no other way to see it.",
    ],
    parameters: DispatchParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return dispatchAgent(params, signal, ctx);
    },
  });
}

async function dispatchAgent(
  params: Static<typeof DispatchParams>,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: string; isError?: boolean }> {
  const { agent, prompt } = params;
  const agentPath = path.join(AGENTS_DIR, `${agent}.md`);

  if (!fs.existsSync(agentPath)) {
    return {
      content: `stride-pi subagent-dispatch error: agent definition not found at ${agentPath}. Expected one of: ${AGENT_NAMES.join(", ")}.`,
      isError: true,
    };
  }

  const agentBody = fs.readFileSync(agentPath, "utf-8");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-dispatch-"));
  const agentDir = path.join(tmpDir, "agent");
  const promptPath = path.join(tmpDir, "system.md");

  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(promptPath, agentBody, { encoding: "utf-8", mode: 0o600 });

    const invocation = getPiInvocation([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--append-system-prompt",
      promptPath,
      prompt,
    ]);

    const result = await runSubprocess(invocation, agentDir, signal, ctx);
    return result;
  } finally {
    // Best-effort cleanup — don't throw from finally
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // swallow
    }
  }
}

interface Invocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to invoke `pi` correctly across install methods:
 *   - npm global install → the current process is `pi` itself, re-exec with argv[0]
 *   - bun binary → fall through to plain `pi` command
 *   - local script → re-exec with node + the script path
 *
 * Mirrors the approach used by the built-in subagent example extension.
 */
function getPiInvocation(args: string[]): Invocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

async function runSubprocess(
  invocation: Invocation,
  agentDir: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: string; isError?: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
      },
    });

    let killTimer: NodeJS.Timeout | undefined;
    let wasAborted = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    const messages: string[] = [];

    const killProc = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    };

    if (signal) {
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }

    const ingestLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        const text = extractMessageText(event);
        if (text) messages.push(text);
      } catch {
        // Not JSON — ignore (pi should emit only JSON in --mode json mode)
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      // Parse complete lines as they arrive; retain any trailing partial line.
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) ingestLine(line);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    proc.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({
        content: `stride-pi subagent-dispatch: failed to spawn subprocess (${err.message}). Check that \`pi\` is installed and in PATH.`,
        isError: true,
      });
    });

    proc.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (wasAborted) {
        resolve({
          content: "stride-pi subagent-dispatch: subprocess aborted.",
          isError: true,
        });
        return;
      }

      // Flush any trailing partial line
      if (stdoutBuffer) ingestLine(stdoutBuffer);

      if (code !== 0) {
        resolve({
          content: `stride-pi subagent-dispatch: subprocess exited with code ${code}.\nstderr:\n${stderrBuffer || "(empty)"}\n\npartial stdout messages:\n${messages.join("\n\n") || "(none)"}`,
          isError: true,
        });
        return;
      }

      if (messages.length === 0) {
        resolve({
          content: "stride-pi subagent-dispatch: subprocess produced no messages. Check that the agent prompt is well-formed and that `pi --mode json` is supported by your Pi install.",
          isError: true,
        });
        return;
      }

      // The subagent's final assistant message is the last one in the stream.
      resolve({ content: messages[messages.length - 1] });
    });
  });
}

/**
 * Pull text content out of a pi `--mode json` event.
 *
 * The event shape from Pi looks like:
 *   { type: "message_end", message: { role: "assistant", content: [...] } }
 *
 * where `content` is an array of blocks. We concatenate all text blocks.
 * Unknown event types are ignored.
 */
function extractMessageText(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const rec = event as Record<string, unknown>;

  if (rec.type !== "message_end" && rec.type !== "tool_result_end") {
    return null;
  }

  const message = rec.message as Record<string, unknown> | undefined;
  if (!message) return null;
  if (message.role !== "assistant") return null;

  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }

  return parts.length ? parts.join("\n") : null;
}
