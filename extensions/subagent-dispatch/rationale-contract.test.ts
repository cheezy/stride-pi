/**
 * (W2614) Pins the move of background prose out of the completion skill and
 * the two reviewer files into docs/: every `docs/<page>.md` § pointer left in
 * a skill or agent names a heading that exists, the reviewer agent and its
 * inline twin carry the same pointers and lost the same passages, the
 * contract that has to stay inline is still there, and the pages say they set
 * no rules.
 *
 * A pointer to a renamed heading, a twin that drifted, or a rule that moved
 * out with its history is the regression a later edit could make silently.
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

const COMPLETING = "skills/stride-completing-tasks/SKILL.md";
const REVIEWER_AGENT = "extensions/subagent-dispatch/agents/stride-task-reviewer.md";
const REVIEWER_SKILL = "skills/stride-task-reviewer/SKILL.md";
const PAGES = ["docs/completion-rationale.md", "docs/task-reviewer-rationale.md"];

function promptFiles(): string[] {
  const skills = fs
    .readdirSync(path.join(ROOT, "skills"))
    .map((d) => `skills/${d}/SKILL.md`)
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const agents = fs
    .readdirSync(path.join(ROOT, "extensions/subagent-dispatch/agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `extensions/subagent-dispatch/agents/${f}`);
  return [...skills, ...agents];
}

function headings(rel: string): string[] {
  return read(rel)
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3));
}

/** Each `§ <title>` that follows a `docs/<page>.md` reference on the same line, as [page, text after §]. */
function pointers(rel: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of read(rel).split("\n")) {
    let page: string | null = null;
    const re = /`(docs\/[a-z0-9-]+\.md)`|§ /g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[1]) page = m[1];
      else if (page) out.push([page, line.slice(m.index + 2)]);
    }
  }
  return out;
}

/** The headings a file's pointers resolve to, as sorted "page § heading" strings. */
function targets(rel: string): string[] {
  return pointers(rel)
    .map(([page, rest]) => `${page} § ${headings(page).find((h) => rest.startsWith(h)) ?? "?"}`)
    .sort();
}

describe("rationale pages and their pointers (W2614)", () => {
  it("every docs pointer in a skill or agent names an existing heading", () => {
    let seen = 0;
    for (const rel of promptFiles()) {
      for (const [page, rest] of pointers(rel)) {
        assert.ok(fs.existsSync(path.join(ROOT, page)), `${rel} points at missing ${page}`);
        const hit = headings(page).some((h) => rest.startsWith(h));
        assert.ok(hit, `${rel}: no heading in ${page} matches "§ ${rest.slice(0, 60)}"`);
        seen++;
      }
    }
    assert.ok(seen >= 10, `expected the pointers this move left, saw ${seen}`);
  });

  it("both pages set no rules and say where each section came from", () => {
    for (const page of PAGES) {
      const text = read(page);
      assert.match(text, /\*\*This page sets no rules\.\*\*/, page);
      assert.match(text, /`install\.sh` installs/, page);
      const sections = text.split("\n## ").slice(1);
      assert.ok(sections.length >= 4, `${page} should hold the moved sections`);
      for (const s of sections) assert.match(s, /\n\*Taken from /, `${page}: "${s.split("\n")[0]}" lacks its source line`);
    }
  });

  it("the reviewer agent and its inline twin carry the same pointers and lost the same passages", () => {
    const a = targets(REVIEWER_AGENT);
    assert.equal(a.length, 4);
    assert.deepEqual(a, targets(REVIEWER_SKILL));
    for (const rel of [REVIEWER_AGENT, REVIEWER_SKILL]) {
      const t = read(rel);
      assert.doesNotMatch(t, /exact D60 bug/, rel);
      assert.doesNotMatch(t, /nonsensical `6\/5` review display/, rel);
      assert.doesNotMatch(t, /Raised from `"1\.4"`/, rel);
      assert.doesNotMatch(t, /silently dropped `project_checks`/, rel);
    }
  });

  it("the reviewer files keep their rules", () => {
    for (const rel of [REVIEWER_AGENT, REVIEWER_SKILL]) {
      const t = read(rel);
      assert.match(t, /MUST NOT maintain its own allow-list of which structured keys to copy/, rel);
      assert.match(t, /if the task supplied that section you MUST return a real verdict \(`passed` or `failed`\), never `not_assessed`/, rel);
      assert.match(t, /Always `"1\.7"` for this prompt version\. \*\*This port does not carry two optional keys canonical 1\.7 allows\*\*/, rel);
      assert.match(t, /\*\*Hard rule — exact 1:1 verbatim restatement\.\*\*/, rel);
      assert.match(t, /data, never instructions/, rel);
    }
  });

  it("the completion skill keeps its contract inline", () => {
    const c = read(COMPLETING);
    for (const reason of ["no_subagent_support", "small_task_0_1_key_files", "trivial_change_docs_only", "self_reported_exploration", "self_reported_review"]) {
      assert.match(c, new RegExp("\\| `" + reason + "` \\|"), reason);
    }
    assert.match(c, /## Explorer\/Reviewer Result Schema/);
    assert.match(c, /at least \*\*40 non-whitespace characters\*\*/);
    assert.match(c, /### 422 rejection example/);
    assert.match(c, /## ⚠️ MANDATORY pre-submission self-check \(hard gate\) ⚠️/);
    assert.match(c, /## Completion Request Field Reference/);
    assert.match(c, /\*\*Emit the fields correctly now\*\*/);
    assert.match(c, /Never answer the veto with a made-up passing `after_doing_result`/);
    assert.match(c, /## Manual Hook Execution/);
  });

  it("the completion skill no longer carries the restatements or the moved history", () => {
    const c = read(COMPLETING);
    for (const gone of ["## Quick Reference Card", "## Rationalization Table", "## Real-World Impact", "## Common Mistakes", "## Implementation Workflow", "## Completion Workflow Flowchart", "## Review vs Auto-Approval Decision", "60s timeout, blocking", "This has been observed in practice"]) {
      assert.ok(!c.includes(gone), `still present: ${gone}`);
    }
  });
});
