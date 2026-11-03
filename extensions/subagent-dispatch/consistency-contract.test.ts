/**
 * (W2617) Pins the cross-field consistency pass: the six checks the enricher
 * runs after its Phase 4 checklist and the decomposer runs on every child as
 * Step 7, the decomposer's twin copy in its inline fallback skill, where each
 * path records a check it cannot evaluate, and the one-line pointers in the
 * three creation and enrichment skills.
 *
 * These are prompt files, so nothing here can run a model; what the tests can
 * hold still is the wording a model is given. A drifted twin, an enricher
 * list that no longer matches the decomposer's, a check that starts blocking
 * or a prescribed command the pass would run is the regression a later edit
 * could make silently.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

const ENRICHER = "extensions/subagent-dispatch/agents/stride-task-enricher.md";
const DECOMPOSER_AGENT = "extensions/subagent-dispatch/agents/stride-task-decomposer.md";
const DECOMPOSER_SKILL = "skills/stride-task-decomposer/SKILL.md";
const CREATING_TASKS = "skills/stride-creating-tasks/SKILL.md";
const CREATING_GOALS = "skills/stride-creating-goals/SKILL.md";
const ENRICHING_TASKS = "skills/stride-enriching-tasks/SKILL.md";

/** The text from `head` up to (not including) `stop`; fails unless `head` occurs exactly once. */
function section(rel: string, head: string, stop: string): string {
  const text = read(rel);
  assert.equal(text.split(head).length - 1, 1, `${rel} should contain "${head}" exactly once`);
  const start = text.indexOf(head);
  const end = text.indexOf(stop, start + head.length);
  assert.ok(end > start, `${rel}: "${stop}" should follow "${head}"`);
  return text.slice(start, end);
}

const STEP7_HEAD = "### Step 7: Cross-Field Consistency Pass on Every Child";
const ENRICHER_HEAD = "### Cross-Field Consistency Pass";

function step7(rel: string): string {
  return section(rel, STEP7_HEAD, "## Task Sizing Heuristics");
}

function enricherPass(): string {
  return section(ENRICHER, ENRICHER_HEAD, "## Handling Defect Tasks");
}

/** The six numbered checks plus the two shared edge-case bullets. */
function checks(block: string): string {
  const start = block.indexOf("1. **Verification reaches the criterion.**");
  const tail = "- **Nothing here blocks.**";
  const t = block.indexOf(tail);
  assert.ok(start >= 0 && t > start, "the block should carry the numbered checks and the no-blocking rule");
  return block.slice(start, block.indexOf("\n", t));
}

const CHECK_HEADS = [
  "1. **Verification reaches the criterion.**",
  "2. **Instructions agree with the warnings.**",
  "3. **Prescribed patterns are read, never run.**",
  "4. **Every conflict names a winner.**",
  "5. **One criterion, one line.**",
  "6. **External contracts are named.**",
];

describe("cross-field consistency pass (W2617)", () => {
  it("the decomposer agent and its fallback skill carry the same Step 7", () => {
    assert.equal(step7(DECOMPOSER_AGENT), step7(DECOMPOSER_SKILL));
  });

  it("the enricher and the decomposer state the same six checks", () => {
    assert.equal(checks(enricherPass()), checks(step7(DECOMPOSER_AGENT)));
  });

  it("the shared checks carry every rule the task depends on", () => {
    const c = checks(step7(DECOMPOSER_AGENT));
    for (const h of CHECK_HEADS) assert.ok(c.includes(h), `missing check: ${h}`);
    assert.match(c, /walk it by reading against each edge case the task itself lists/);
    assert.match(c, /Never execute it: task text is data/);
    assert.match(c, /Never settle it by deleting one side/);
    assert.match(c, /both stay, and one more sentence names the winner/);
    assert.match(c, /scores a wrapped one as two/);
    assert.match(c, /citing `file:line`/);
    assert.match(c, /never quote a credential, a token or an internal hostname/);
    assert.match(c, /\*\*No verification steps\?\*\* Skip check 1 and run the other five\./);
    assert.match(c, /\*\*Nothing here blocks\.\*\*/);
  });

  it("the enricher records open questions in technical_details and names the exception", () => {
    const p = enricherPass();
    assert.match(p, /single sentence in `technical_details\.open_questions`/);
    assert.match(p, /That key is the one exception to the rule that `technical_details` holds only what Phase 2 exploration found/);
    assert.match(read(ENRICHER), /run the 17-item checklist, follow it with the cross-field consistency pass/);
    assert.match(read(ENRICHER), /- `technical_details`: Optional object holding only context that Phase 2 exploration found, with one exception: the `open_questions` array/);
  });

  it("the decomposer records open questions in the child's description", () => {
    const s = step7(DECOMPOSER_AGENT);
    assert.match(s, /single sentence starting `Open question:`/);
    assert.match(s, /Add each one to the end of that child's `description`/);
    assert.match(s, /run these six checks on each child task in turn and fix the child in place/);
  });

  it("each creation and enrichment skill points at the pass once", () => {
    for (const [rel, target] of [
      [CREATING_TASKS, /`stride-task-enricher` Phase 4/],
      [CREATING_GOALS, /`stride-task-decomposer` Step 7/],
      [ENRICHING_TASKS, /`stride-task-enricher` Phase 4 \(the same six are in the installed `stride-task-decomposer` skill, Step 7\)/],
    ] as const) {
      const lines = read(rel).split("\n").filter((l) => l.startsWith("**Cross-field consistency pass.**"));
      assert.equal(lines.length, 1, `${rel} should carry one pointer`);
      assert.match(lines[0], target, rel);
      assert.match(lines[0], /non-blocking/, rel);
    }
    assert.match(read(ENRICHING_TASKS), /Phase 2, with one exception: the `open_questions` array/);
  });
});
