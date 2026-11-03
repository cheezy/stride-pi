/**
 * (W2619) Pins the reviewer's step 4 mapping of listed test items: every
 * unit_tests, integration_tests and edge_cases item is mapped to a covering
 * test by file:line, a name match is not coverage, an unmapped item is an
 * Important testing issue, manual_tests are left out with a note, the review
 * stays read-only, and nothing new goes into the JSON block. The dispatched
 * reviewer and its inline twin carry the same step.
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

const AGENT = "extensions/subagent-dispatch/agents/stride-task-reviewer.md";
const SKILL = "skills/stride-task-reviewer/SKILL.md";
const HEAD = "4. **Testing Strategy Alignment**";
const NEXT = "5. **Security Considerations Alignment**";

function step4(rel: string): string {
  const text = read(rel);
  assert.equal(text.split(HEAD).length - 1, 1, `${rel} should carry step 4 once`);
  const start = text.indexOf(HEAD);
  const end = text.indexOf(NEXT, start);
  assert.ok(end > start, `${rel}: step 5 should follow step 4`);
  return text.slice(start, end);
}

describe("reviewer test-item mapping (W2619)", () => {
  it("the agent and its inline twin carry the same step 4", () => {
    assert.equal(step4(AGENT), step4(SKILL));
  });

  it("every listed item is mapped to a covering test by file:line", () => {
    const s = step4(AGENT);
    assert.match(s, /Take every entry of `unit_tests`, `integration_tests` and `edge_cases` in turn and name the one test that covers it by `file:line`/);
    assert.match(s, /whether that test is in the diff or was already in the suite/);
  });

  it("a name match is not coverage, and coverage is judged by reading", () => {
    const s = step4(AGENT);
    assert.match(s, /only when its assertions check the behaviour the item describes/);
    assert.match(s, /A test whose name echoes the item but asserts something else leaves the item unmapped/);
    assert.match(s, /Judge this by reading the test and never by running it/);
    for (const rel of [AGENT, SKILL]) assert.match(read(rel), /Do not run tests or execute code/, rel);
  });

  it("an unmapped item is an Important testing issue that fails the verdict, raised once", () => {
    const s = step4(AGENT);
    assert.match(s, /\*\*An item with no covering test\*\* goes into `issues\[\]` as an \*\*Important\*\* finding in the `testing` category, naming the item/);
    assert.match(s, /turns the `testing_strategy` verdict to `"failed"` under the Consistency rule/);
    assert.match(s, /One item raises one testing issue at most/);
    assert.match(s, /This port's reviewer judges no `behaviour_test_matrix` rows, so no row stands in for a mapping/);
  });

  it("manual_tests and empty lists give no mapping and no issue", () => {
    const s = step4(AGENT);
    assert.match(s, /`manual_tests` entries are left out of the mapping: write one line saying how many were left out/);
    assert.match(s, /An empty `edge_cases` array, or a strategy that holds only `manual_tests`, gives no mapping lines and no issue/);
  });

  it("the mapping stays in prose, cites locations, and the block is unchanged", () => {
    const s = step4(AGENT);
    assert.match(s, /Write one line per item in the prose below the summary line, never in the JSON block/);
    assert.match(s, /Cite a test by `file:line`, never by quoting its body/);
    for (const rel of [AGENT, SKILL]) {
      const t = read(rel);
      assert.match(t, /then the step 4 test-item mapping, then a short acceptance-criteria table/, rel);
      assert.match(t, /the per-severity issue list, the step 4 test-item mapping, the acceptance-criteria table/, rel);
      assert.match(t, /two reads go beyond it: `CODE-REVIEW\.md` for step 7, and an existing test that step 4 maps a listed item to/, rel);
      assert.match(t, /Always `"1\.7"` for this prompt version/, rel);
      assert.doesNotMatch(t, /test_item_mapping|"mapping":/, rel);
    }
  });
});
