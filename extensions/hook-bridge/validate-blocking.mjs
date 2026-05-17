/**
 * Programmatic validation harness for hook-bridge blocking semantics.
 *
 * Loads the extension via Pi's jiti loader (the same path Pi uses at
 * startup), then constructs synthetic tool_call / tool_result events for
 * a /complete curl and observes whether the registered handlers return
 * { block: true, reason } when after_doing fails.
 *
 * Two scenarios are run in isolated temp directories:
 *
 *   A) Failing after_doing — `.stride.md` after_doing section runs `false`.
 *      Expected: tool_call handler returns { block: true, reason: "..." }
 *      and the reason mentions the failed command and non-zero exit code.
 *
 *   B) Passing after_doing — same .stride.md but after_doing runs `true`.
 *      Expected: tool_call handler returns undefined (no block).
 *
 * Designed to be self-contained — no Stride API, no network, no real Pi
 * subprocess. The harness exits 0 on success, non-zero on validation
 * failure, and prints a structured summary that the surrounding task can
 * paste into docs/validation-phase3.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPLETE_CURL =
  'curl -s -X PATCH "https://www.stridelikeaboss.com/api/tasks/9999/complete" -d "{}"';

async function loadExtension() {
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    moduleCache: false,
    tryNative: false,
  });
  const factory = await jiti.import(path.join(HERE, "index.ts"), { default: true });
  if (typeof factory !== "function") {
    throw new Error(`extension default export is not a function: ${typeof factory}`);
  }
  return factory;
}

function createMockPi() {
  const handlers = new Map();
  const pi = {
    on(eventName, handler) {
      if (!handlers.has(eventName)) handlers.set(eventName, []);
      handlers.get(eventName).push(handler);
    },
    registerTool() {
      // not used by hook-bridge
    },
  };
  return { pi, handlers };
}

function createContext(cwd) {
  return {
    cwd,
    signal: undefined,
    ui: {
      notify: (msg) => {
        process.stderr.write(`[ctx.ui.notify] ${msg}\n`);
      },
    },
  };
}

function writeStrideMd(dir, afterDoingCommand) {
  const content = `# Stride Configuration

## before_doing

\`\`\`bash
echo "before_doing ran"
\`\`\`

## after_doing

\`\`\`bash
${afterDoingCommand}
\`\`\`

## before_review

\`\`\`bash
echo "before_review ran"
\`\`\`

## after_review

\`\`\`bash
echo "after_review ran"
\`\`\`
`;
  fs.writeFileSync(path.join(dir, ".stride.md"), content, "utf-8");
}

async function runScenario(name, afterDoingCommand) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `stride-hookbridge-${name}-`));
  try {
    writeStrideMd(tmp, afterDoingCommand);

    const factory = await loadExtension();
    const { pi, handlers } = createMockPi();
    factory(pi);

    const toolCallHandlers = handlers.get("tool_call") || [];
    if (toolCallHandlers.length !== 1) {
      throw new Error(`expected exactly 1 tool_call handler, got ${toolCallHandlers.length}`);
    }

    const event = {
      type: "tool_call",
      toolCallId: "test-1",
      toolName: "bash",
      input: { command: COMPLETE_CURL },
    };

    const ctx = createContext(tmp);
    const result = await toolCallHandlers[0](event, ctx);

    return { tmp, result };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function assertBlocked(label, result) {
  if (!result || typeof result !== "object") {
    throw new Error(`${label}: expected block result, got ${JSON.stringify(result)}`);
  }
  if (result.block !== true) {
    throw new Error(`${label}: expected block=true, got ${JSON.stringify(result)}`);
  }
  if (typeof result.reason !== "string" || result.reason.length === 0) {
    throw new Error(`${label}: expected non-empty reason string`);
  }
  return result.reason;
}

function assertNotBlocked(label, result) {
  if (result !== undefined && result !== null) {
    if (result.block === true) {
      throw new Error(`${label}: expected no block, got block=true with reason=${result.reason}`);
    }
  }
}

async function main() {
  const summary = {
    scenario_a_failing: null,
    scenario_b_passing: null,
    verdict: "PENDING",
  };

  // Scenario A — after_doing fails (runs `false`)
  const a = await runScenario("fail", "false");
  const aReason = assertBlocked("Scenario A", a.result);
  summary.scenario_a_failing = {
    expected: "{ block: true, reason: '...' } from tool_call handler",
    got: { block: a.result.block, reason_excerpt: aReason.slice(0, 200) },
    pass: true,
  };

  // Scenario B — after_doing passes (runs `true`)
  const b = await runScenario("pass", "true");
  assertNotBlocked("Scenario B", b.result);
  summary.scenario_b_passing = {
    expected: "undefined / no block from tool_call handler",
    got: b.result === undefined ? "undefined" : JSON.stringify(b.result),
    pass: true,
  };

  summary.verdict = "PASS";
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("VALIDATION FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
