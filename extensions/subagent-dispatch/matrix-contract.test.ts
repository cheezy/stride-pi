/**
 * (W2616) Pins the behaviour_test_matrix authoring rule in the four places
 * that create tasks: stride-creating-tasks (which owns the row contract),
 * stride-creating-goals, and the task-decomposer agent and its inline
 * fallback skill.
 *
 * These are prompt files, so nothing here can run a model; what the tests can
 * hold still is the wording a model is given. A drifted decomposer twin, a
 * lost manual-only rule, a dropped credential rule or a pointer to a section
 * that no longer exists is the regression a later edit could make silently.
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

const CREATING_TASKS = "skills/stride-creating-tasks/SKILL.md";
const CREATING_GOALS = "skills/stride-creating-goals/SKILL.md";
const DECOMPOSER_AGENT = "extensions/subagent-dispatch/agents/stride-task-decomposer.md";
const DECOMPOSER_SKILL = "skills/stride-task-decomposer/SKILL.md";

const CATEGORIES = [
  "Happy path",
  "Boundary",
  "Error / exception",
  "Null / empty",
  "Concurrency",
  "Lifecycle / wiring",
  "Contract / serialization",
];

const DEC_HEAD = "**Give every child with testable behaviour a `behaviour_test_matrix`.**";
const DEC_TAIL = "which wins if it and this section ever disagree.";

/** The decomposer's matrix block; fails when absent or repeated. */
function decomposerBlock(rel: string): string {
  const text = read(rel);
  assert.equal(text.split(DEC_HEAD).length - 1, 1, `${rel} should carry exactly one matrix block`);
  const start = text.indexOf(DEC_HEAD);
  const end = text.indexOf(DEC_TAIL, start);
  assert.ok(end > start, `${rel}: the matrix block should end with the ownership sentence`);
  return text.slice(start, end + DEC_TAIL.length);
}

function matrixRow(rel: string): string {
  const rows = read(rel).split("\n").filter((l) => l.startsWith("| `behaviour_test_matrix` |"));
  assert.equal(rows.length, 1, `${rel} should carry exactly one behaviour_test_matrix table row`);
  return rows[0];
}

/** The creating-tasks section, from its heading to the next heading or rule. */
function creatingTasksSection(): string {
  const text = read(CREATING_TASKS);
  const head = "\n### behaviour_test_matrix\n";
  assert.equal(text.split(head).length - 1, 1, "creating-tasks should have one behaviour_test_matrix section");
  const start = text.indexOf(head) + 1;
  const rest = text.slice(start + head.length);
  const next = rest.search(/\n(#{2,3} |---\n)/);
  return next === -1 ? text.slice(start) : text.slice(start, start + head.length + next);
}

describe("behaviour_test_matrix authoring rule (W2616)", () => {
  it("the decomposer agent and its fallback skill carry the same block and table row", () => {
    assert.equal(decomposerBlock(DECOMPOSER_AGENT), decomposerBlock(DECOMPOSER_SKILL));
    assert.equal(matrixRow(DECOMPOSER_AGENT), matrixRow(DECOMPOSER_SKILL));
  });

  it("the decomposer block states every rule a child is written under", () => {
    const b = decomposerBlock(DECOMPOSER_AGENT);
    assert.match(b, /lists a unit or integration test/);
    assert.match(b, /all seven categories/);
    assert.match(b, /waived with an `na_reason`/);
    assert.match(b, /\*\*Manual-only children\.\*\* When the child's strategy lists only `manual_tests`/);
    assert.match(b, /`type: "manual"` rows whose `test_name` is one of the `manual_tests` entries/);
    assert.match(b, /\*\*Leaving it off\.\*\* Only a child with nothing testable/);
    assert.match(b, /`description` says so in one sentence/);
    assert.match(b, /\*\*Names match\.\*\* Every row's `test_name` is a test from the child's own `testing_strategy`/);
    assert.match(b, /refused with a `422`/);
    assert.match(b, /A missing or empty matrix passes/);
    assert.match(b, /A credential-shaped string you met there/);
    assert.match(b, /must never end up in `behaviour`, `test_name` or `na_reason`/);
    assert.match(b, /`stride-creating-tasks` § behaviour_test_matrix/);
  });

  it("creating-tasks owns the row contract and the by-default rules", () => {
    const s = creatingTasksSection();
    assert.match(s, /lists a unit or integration test, send a complete matrix covering all seven categories/);
    assert.match(s, /\*\*A manual-only strategy\*\*/);
    assert.match(s, /its `type` is `"manual"`/);
    assert.match(s, /\*\*Leave it off only for a task with no testable behaviour\*\*/);
    assert.match(s, /\*\*Every `test_name` is a test taken from `testing_strategy`\.\*\*/);
    assert.match(s, /The API accepts a matrix that is missing or empty/);
    assert.match(s, /refused with a `422`/);
    assert.match(s, /\*\*No secrets in row text\.\*\*/);
    for (const c of CATEGORIES) assert.ok(s.includes(`\`"${c}"\``), `category "${c}" should be listed`);
    assert.match(s, /the server stores it as `"planned"`/);
  });

  it("creating-goals applies the rule to every nested task and points at creating-tasks", () => {
    const text = read(CREATING_GOALS);
    const paras = text.split("\n").filter((l) => l.startsWith("**Nested tasks carry a `behaviour_test_matrix` by default"));
    assert.equal(paras.length, 1, "creating-goals should carry exactly one nested-task matrix paragraph");
    const p = paras[0];
    assert.match(p, /complete seven-category matrix of its own/);
    assert.match(p, /waived by `na_reason` rather than dropped/);
    assert.match(p, /A manual-only strategy gets `"manual"` rows/);
    assert.match(p, /left off only for a nested task with no testable behaviour/);
    assert.match(p, /names a test in that task's own `testing_strategy`/);
    assert.match(p, /refuses one with categories missing with a `422`/);
    assert.match(p, /`stride-creating-tasks` § behaviour_test_matrix/);
  });

  it("the creation skills keep their summary lines pointing at the section", () => {
    assert.match(read(CREATING_TASKS), /\| `behaviour_test_matrix` \| array \|.*\| No — but sent by default \|/);
    assert.match(read(CREATING_TASKS), /- \[ \] `behaviour_test_matrix` - Sent by default/);
  });
});
