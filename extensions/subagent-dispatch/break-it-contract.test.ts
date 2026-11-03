/**
 * (W2620) Pins the break-it rule: Step 4 of the workflow skill carries the
 * whole procedure inline (install.sh copies only SKILL.md), Step 5 hands the
 * entries to the reviewer as a labelled prompt section kept apart from the
 * round-two fixes list, both reviewer twins judge the record in step 4 and
 * raise an Important testing issue when it is missing or misses, and nothing
 * new reaches the reviewer's JSON block.
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

function slice(rel: string, head: string, next: string): string {
  const text = read(rel);
  assert.equal(text.split(head).length - 1, 1, `${rel}: ${head} should occur once`);
  const start = text.indexOf(head);
  const end = text.indexOf(next, start + head.length);
  assert.ok(end > start, `${rel}: ${next} should follow ${head}`);
  return text.slice(start, end);
}

const WORKFLOW = "skills/stride-workflow/SKILL.md";
const SUBAGENT = "skills/stride-subagent-workflow/SKILL.md";
const AGENT = "extensions/subagent-dispatch/agents/stride-task-reviewer.md";
const SKILL = "skills/stride-task-reviewer/SKILL.md";
const RATIONALE = "docs/orchestrator-rationale.md";

const step4 = () => slice(WORKFLOW, "## Step 4: Implementation", "## Step 5:");
const step5Inputs = () =>
  slice(WORKFLOW, "**If the `task-reviewer` custom agent is available**", "**Re-review and follow-up rounds");
const reviewStep4 = (rel: string) =>
  slice(rel, "4. **Testing Strategy Alignment**", "5. **Security Considerations Alignment**");
const breakBullet = (rel: string) => slice(rel, "   - **Break-it record.**", "\n");

describe("break-it procedure in Step 4 (W2620)", () => {
  it("covers every added or changed test, and nothing when there are none", () => {
    const s = step4();
    assert.match(s, /\*\*Break-it: watch every test you add or change go red once\.\*\*/);
    assert.match(s, /A test is new when the diff adds it, and changed when the diff touches its assertion, setup, fixture, or whatever file or slice it reads/);
    assert.match(s, /\*\*A diff that adds or changes no test has no entries, and Step 5 sends no `break_it`/);
    assert.match(s, /A test whose only edits are whitespace, wrapping or comments, with every assertion and setup line meaning what it meant before, needs no entry/);
    assert.match(s, /A test the diff deletes, or leaves alone inside a file it otherwise edits, needs none either/);
  });

  it("orders break, fail, restore, pass with observed booleans", () => {
    const s = step4();
    const order = [
      "1. **Take a content snapshot before the first break.**",
      "2. **Make one small edit where the guarded behaviour lives**",
      "3. **Run that test and watch it fail;** note what happened as `failed_when_broken`",
      "4. **Put the code back by reversing that one edit by hand.**",
      "5. **Run it again and watch it pass;** note `passes_when_restored`",
    ];
    let at = -1;
    for (const step of order) {
      const i = s.indexOf(step);
      assert.ok(i > at, `out of order or missing: ${step}`);
      at = i;
    }
    assert.match(s, /the booleans you observed rather than the ones you expected/);
    assert.match(s, /never change an observed `false` to `true`/);
  });

  it("hashes content, not just status, and must match before review", () => {
    const s = step4();
    assert.ok(
      s.includes(
        "`snap() { git status --porcelain --untracked-files=all; git diff HEAD --binary; git ls-files --others --exclude-standard -z | xargs -0 shasum; }; snap | shasum`",
      ),
    );
    assert.match(s, /status lines alone miss a break left in a file you had already modified/);
    assert.match(s, /\*\*After the last restore, snapshot again, and invoke the reviewer only when the two hashes are equal\*\*/);
    assert.match(s, /after `git rev-parse --show-toplevel` has printed that repository's path/);
    assert.match(s, /Any error printed while the snapshot runs voids it the same way/);
    assert.match(s, /\*\*Repairing a test is a deliberate edit, so snapshot again after each repair\*\*/);
  });

  it("restores by reversing the edit, never with a git command that drops work", () => {
    const s = step4();
    assert.match(s, /Never `git checkout`, `git restore`, `git stash` or `git reset`: each of them also discards your uncommitted work/);
    assert.match(s, /Deleting a file is never a break/);
    assert.match(s, /Never commit while a break is in place/);
  });

  it("records an unbreakable test with a one-line not_broken_reason", () => {
    const s = step4();
    assert.match(s, /\*\*A test you cannot break without a side effect outside the repository\*\* gets a one-line `not_broken_reason`, with `break` and both booleans `null`/);
    assert.match(s, /reach no network, remote, registry, API or Stride server/);
  });

  it("counts text-pin occurrences in the slice, not lines", () => {
    const s = step4();
    assert.match(s, /\*\*Text pins: count occurrences inside the slice the test reads, not lines\.\*\*/);
    assert.ok(s.includes("`sed -n '<range>p' '<file>' | grep -oF -- '<phrase>' | wc -l`"));
    assert.match(s, /Use that command only when the range is two line numbers or `1,\$`, the path does not start with `-`, and the phrase and the path hold nothing but letters, digits, spaces and `\.` `_` `-` `\/`/);
    assert.match(s, /is counted with the read and search tools, never typed into a shell command/);
    assert.match(s, /for a text pin, count the phrase first, as below/);
    assert.match(s, /`grep -c` counts lines, so a line holding the phrase twice/);
  });

  it("keeps the procedure inline with its why in docs, never a sibling file", () => {
    assert.ok(!fs.existsSync(path.join(ROOT, "skills/stride-workflow/test-non-vacuity.md")));
    assert.match(step4(), /Background: `docs\/orchestrator-rationale\.md` § Why the Break-it Evidence Comes From the Implementer\./);
    assert.match(read(RATIONALE), /\n## Why the Break-it Evidence Comes From the Implementer\n\n\*Taken from `skills\/stride-workflow\/SKILL\.md`, Step 4/);
  });
});

describe("break_it in the Step 5 invocation (W2620)", () => {
  it("is a labelled prompt section with the four keys, apart from the fixes list", () => {
    const s = step5Inputs();
    assert.match(s, /- \*\*A `break_it` section, whenever the diff adds or changes a test\*\* — a labelled part of the `dispatch_agent` prompt/);
    assert.match(s, /listing your Step 4 entries with `test`, `break`, `failed_when_broken` and `passes_when_restored`/);
    assert.match(s, /not a field the task supplies, and never a key of the reviewer's JSON block/);
    assert.match(s, /\*\*It stays apart from the round-two fixes list below:\*\*/);
    assert.match(s, /on round two it carries a fresh entry for every test a fix touched/);
  });

  it("self-review without a reviewer checks the entries too", () => {
    assert.match(read(WORKFLOW), /- \[ \] `break_it` -- did every test you added or changed fail when broken and pass when restored/);
  });

  it("the subagent workflow hands over the same section", () => {
    assert.match(read(SUBAGENT), /\*\*Hand over `break_it` as well when the diff has new or changed tests:\*\*/);
    assert.match(read(SUBAGENT), /`stride-workflow` Step 4 owns the procedure and the entry shape/);
  });
});

describe("reviewer enforcement of break_it (W2620)", () => {
  it("both twins judge the record with the same step 4 bullet", () => {
    assert.equal(breakBullet(AGENT), breakBullet(SKILL));
    assert.ok(reviewStep4(AGENT).includes(breakBullet(AGENT)));
  });

  it("a missing entry or a missed break is an Important testing issue", () => {
    const b = breakBullet(AGENT);
    assert.match(b, /Raise an \*\*Important\*\* `testing` issue for a new or changed test with no entry/);
    assert.match(b, /for an entry whose two booleans are not both `true` or whose break leaves the asserted behaviour alone/);
    assert.match(b, /a `not_broken_reason` that names no side effect outside the repository/);
    assert.match(b, /A pinned phrase found more than once in the text its test reads still matches after a break at one site/);
  });

  it("round two needs fresh entries, and the reviewer never runs a break", () => {
    const b = breakBullet(AGENT);
    assert.match(b, /On round two, each test a listed fix touched needs a fresh entry/);
    assert.match(b, /You read the record; you never perform a break/);
    assert.match(b, /When the files you read contradict a recorded `true`, the files win and the entry counts as a missed break/);
    for (const rel of [AGENT, SKILL]) assert.match(read(rel), /step 4's break-it check may also read the file a new or changed test reads, to count a pinned phrase there/, rel);
    for (const rel of [AGENT, SKILL]) assert.match(read(rel), /provided that file sits inside the repository under review; cite it by `file:line` and never quote what it holds/, rel);
    for (const rel of [AGENT, SKILL]) assert.match(read(rel), /Do not run tests or execute code/, rel);
  });

  it("break_it is an input, not a block key, and schema_version is unchanged", () => {
    for (const rel of [AGENT, SKILL]) {
      const t = read(rel);
      assert.match(t, /- A `break_it` section if the diff has new or changed tests: the implementer's Step 4 break-it entries, asserted by the orchestrator/, rel);
      assert.match(t, /It is orchestrator-asserted input, not a field the task supplies, and it adds nothing to your JSON block/, rel);
      assert.match(t, /\*\*Absent means no entries\.\*\*/, rel);
      assert.match(t, /Always `"1\.7"` for this prompt version/, rel);
      assert.doesNotMatch(t, /"break_it"\s*:/, rel);
    }
  });
});
