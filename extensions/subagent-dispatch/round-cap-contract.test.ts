/**
 * (W2610) Pins the review-round-cap rule's wording in stride-workflow Step 5
 * and its completing-tasks mirror: round two runs only when earned, by
 * three triggers, and nothing here opens a third round.
 *
 * The rule is prose this port follows rather than code it runs (Step 5 says
 * so), so these tests cannot check a review; they hold still the sentences a
 * model is given. The canon checker reads only the anchor; this file covers
 * the parts of the rule the anchor cannot see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const WORKFLOW = read("skills/stride-workflow/SKILL.md");
const COMPLETING = read("skills/stride-completing-tasks/SKILL.md");

describe("review-round-cap v2 wording (W2610)", () => {
  it("carries the v2 anchor exactly once and no v1 anchor", () => {
    assert.equal(WORKFLOW.split("<!-- canon:review-round-cap").length - 1, 1);
    assert.ok(WORKFLOW.includes("<!-- canon:review-round-cap v2 -->"));
  });

  it("names the three triggers, a security finding at any severity included", () => {
    assert.match(WORKFLOW, /\*\*\(1\)\*\* a fix you made changed a code path/);
    assert.match(WORKFLOW, /\*\*\(2\)\*\* round one reported a `critical`/);
    assert.match(WORKFLOW, /\*\*\(3\)\*\* round one reported a `category: "security"` finding at any severity/);
  });

  it("never lets a trigger open a third round", () => {
    assert.match(WORKFLOW, /\*\*None of the three opens a third round\.\*\*/);
  });

  it("lets an all-cosmetic round outrank a code-path fix, and records its fixes", () => {
    assert.match(WORKFLOW, /all cosmetic buys nothing even when its fix touched a `\.ts` file — record those fixes/);
    assert.match(WORKFLOW, /the round is not all-cosmetic, and the three triggers above decide whether another round runs/);
    assert.ok(!WORKFLOW.includes("invoke the next round regardless"));
  });

  it("defines a code path, leaning to code when in doubt", () => {
    assert.match(WORKFLOW, /\*\*`#` is never a comment in C-family sources\*\*/);
    assert.match(WORKFLOW, /a `\.txt` file is code/);
    assert.match(WORKFLOW, /\*\*A path that matches none of the three, or whose bucket you are unsure of, is code;\*\*/);
    assert.match(WORKFLOW, /\*\*`\.stride\.md` is the exception, and counts as code\*\*/);
  });

  it("records fixes without a trigger, with the free-text line redacted", () => {
    assert.match(WORKFLOW, /\*\*With no trigger, skip round two: record each fix/);
    assert.match(WORKFLOW, /\*\*it never names a credential, token or secret value, or where one is kept\*\*/);
    assert.match(WORKFLOW, /\*\*Nothing in this record is ever a `critical` or a `category: "security"` entry:\*\*/);
  });

  it("says the triggers are followed, not enforced, and forbids a predicate", () => {
    assert.match(WORKFLOW, /\*\*Do not add one\.\*\* \*\*Nor a predicate for the triggers:\*\*/);
    assert.match(WORKFLOW, /the triggers are followed, not enforced, like the rest of the cap/);
  });

  it("keeps the completing-tasks gate in step with Step 5", () => {
    assert.match(COMPLETING, /\*\*Fixes recorded when round two was not earned \(W2610\)\.\*\*/);
    assert.match(COMPLETING, /that line never names a credential, token or secret value, or where one is kept/);
    assert.match(COMPLETING, /a `minor` left unfixed is named the same way, marked as still standing/);
    assert.match(COMPLETING, /\*\*A critical or a security entry cannot be on this path:\*\*/);
  });
});
