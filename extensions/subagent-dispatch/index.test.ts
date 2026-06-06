/**
 * Tests for the subagent-dispatch agent registry (W1014).
 *
 * The registry (AGENT_NAMES) lives in the pi-free agents-registry.ts module
 * — extracted there precisely so this test can import the REAL value index.ts
 * builds its dispatch parameter union from, rather than re-deriving it.
 * index.ts itself cannot be imported here: it pulls the
 * @mariozechner/pi-coding-agent and @sinclair/typebox peer deps, which are
 * not installed in the test environment (the same constraint that keeps the
 * hook-bridge tests off index.ts). agents-registry.ts has no such deps.
 *
 * Resolution mirrors index.ts dispatchAgent: an agent resolves iff it is a
 * registered name AND agents/<name>.md exists on disk.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_NAMES, isRegisteredAgent } from "./agents-registry.ts";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(DIR, "agents");

// Resolution mirrors index.ts dispatchAgent: registered name + existing file.
function resolves(agent: string): boolean {
  return isRegisteredAgent(agent) && fs.existsSync(path.join(AGENTS_DIR, `${agent}.md`));
}

const EXPECTED_AGENTS = [
  "stride-task-explorer",
  "stride-task-reviewer",
  "stride-task-decomposer",
  "stride-hook-diagnostician",
  "stride-task-enricher",
];

const PRE_EXISTING_AGENTS = [
  "stride-task-explorer",
  "stride-task-reviewer",
  "stride-task-decomposer",
  "stride-hook-diagnostician",
];

describe("subagent-dispatch agent registry", () => {
  it("registers exactly the 5 expected agents, including task-enricher", () => {
    assert.equal(AGENT_NAMES.length, 5);
    assert.deepEqual([...AGENT_NAMES].sort(), [...EXPECTED_AGENTS].sort());
  });

  it("resolves all 5 registered agents to an existing agent definition file", () => {
    for (const agent of EXPECTED_AGENTS) {
      assert.equal(resolves(agent), true, `${agent} should resolve to agents/${agent}.md`);
    }
  });

  it("resolves task-enricher to stride-task-enricher.md", () => {
    assert.equal(isRegisteredAgent("stride-task-enricher"), true);
    assert.equal(
      fs.existsSync(path.join(AGENTS_DIR, "stride-task-enricher.md")),
      true,
    );
  });

  it("does not break the 4 pre-existing agent mappings", () => {
    for (const agent of PRE_EXISTING_AGENTS) {
      assert.equal(resolves(agent), true, `${agent} mapping must still resolve`);
    }
  });

  it("rejects an unknown agent name", () => {
    assert.equal(isRegisteredAgent("stride-task-nonexistent"), false);
    assert.equal(resolves("stride-task-nonexistent"), false);
  });

  it("treats agent keys as case-sensitive (rejects an upper-cased name)", () => {
    assert.equal(isRegisteredAgent("STRIDE-TASK-ENRICHER"), false);
    assert.equal(resolves("STRIDE-TASK-ENRICHER"), false);
  });
});
