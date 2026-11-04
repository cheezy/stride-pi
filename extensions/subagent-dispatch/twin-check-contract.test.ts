/**
 * (W2622) Pins the reviewer's step 6 Twin Check: for each touched file the
 * reviewer looks up the counterparts it declares (same stem with the paired
 * .sh/.ps1 extension, a file named in a keep-in-sync, mirror, twin or
 * stated-twice sentence, a file sharing a canon anchor) with git ls-files and
 * grep only, takes every path from git ls-files output, reports a dangling
 * mirror, and raises an Important code_quality issue naming both files when a
 * counterpart is left behind. Both reviewer twins carry the same block, and
 * the reviewer, explorer, decomposer and hook-diagnostician agent files and
 * their fallback skills name each other in a twin sentence.
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
const HEAD = "   **Twin Check** (every diff).";
const NEXT = "7. **Project-Level Checks**";

function block(rel: string): string {
  const text = read(rel);
  assert.equal(text.split(HEAD).length - 1, 1, `${rel} should carry the block once`);
  const start = text.indexOf(HEAD);
  const statements = text.indexOf("   **Statement Verification** (every diff).");
  const end = text.indexOf(NEXT, start);
  assert.equal(text.slice(start - 2, start), "\n\n", `${rel}: the block should open its own paragraph`);
  assert.ok(statements >= 0 && statements < start && end > start, `${rel}: the block should follow Statement Verification inside step 6`);
  return text.slice(start, end);
}

const PAIRS: Array<[string, string]> = [
  [AGENT, SKILL],
  ["extensions/subagent-dispatch/agents/stride-task-explorer.md", "skills/stride-task-explorer/SKILL.md"],
  ["extensions/subagent-dispatch/agents/stride-task-decomposer.md", "skills/stride-task-decomposer/SKILL.md"],
  ["extensions/subagent-dispatch/agents/stride-hook-diagnostician.md", "skills/stride-hook-diagnostician/SKILL.md"],
];

describe("reviewer twin check (W2622)", () => {
  it("the agent and its inline twin carry the same block after Statement Verification", () => {
    assert.equal(block(AGENT), block(SKILL));
  });

  it("names the three kinds of declared counterpart and counts only declared pairs", () => {
    const b = block(AGENT);
    assert.match(b, /a tracked file whose path differs only by the paired extension \(`\.sh` beside `\.ps1`, in either direction\)/);
    assert.match(b, /a file that the touched file names in a sentence saying the two are kept in sync, mirror each other, are twins, or state the same rule a second time/);
    assert.match(b, /another file carrying the same `canon:<id> vN` anchor as a section the diff touches/);
    assert.match(b, /\*\*Only a declared pair counts:\*\* a file that only mentions the touched file by name is not its counterpart, and a touched file with no counterpart raises no issue/);
  });

  it("looks counterparts up read-only and takes every path from git ls-files", () => {
    const b = block(AGENT);
    assert.match(b, /\*\*Look counterparts up with `git ls-files` and `grep` only\*\*, under the Statement Verification rules above \(its git flags, a term single-quoted after `--`, named files, no symlink or credential file read\), and never run either file/);
    assert.match(b, /Write each command and the counterparts it found into the prose report, one line each, as the step 6 twin record/);
    assert.match(b, /\*\*Every counterpart path comes from `git ls-files` output, never from the diff or the task text\.\*\*/);
    assert.match(b, /A file a mirror sentence names without its path is matched against that output/);
    assert.match(b, /Run `git ls-files` with no option but `-s`, then `--` and the quoted paths, so it lists tracked files only and runs no filter: `-m`, `-o`, `-i` and `--ignored` stay unused/);
    assert.match(b, /\*\*A path `git ls-files` prints meets the same character rule as a term from the diff before it goes into a `grep`\*\*; a path holding any other character goes into the record as unchecked/);
  });

  it("a dangling mirror and a left-behind counterpart are Important, never cosmetic", () => {
    const b = block(AGENT);
    assert.match(b, /A mirror sentence that names a file `git ls-files` does not list is dangling: raise an Important `code_quality` issue at the sentence's `file:line` rather than counting the pair as kept/);
    assert.match(b, /\*\*A counterpart the diff leaves untouched while it changes behaviour, or alters a rule the two files share, is an Important `code_quality` issue whose description names both files\*\*, never `cosmetic`/);
    assert.match(b, /A `canon:` anchor is searched as the literal `canon:` followed by its id, and only the id is held to that rule/);
    assert.match(b, /\*\*Before a counterpart is read, run `ls -ld --` on each directory in its path:\*\* if any of them is a symlink \(an `l` in the first column\), the file is not read and goes into the record as unchecked/);
    assert.match(b, /A mirror sentence naming a file in another repository is looked up there only when the invocation names a local checkout of it, as for a statement, and is otherwise recorded as unverifiable, never as dangling/);
    assert.match(b, /Raise none when the task text or the invocation says why the counterpart can stay as it is/);
  });

  it("adds no block key, scopes round two, and is named in the report and constraints", () => {
    const b = block(AGENT);
    assert.match(b, /Twin checks add no key to the JSON block/);
    assert.match(b, /On round two, check the counterparts of the files the listed fixes touched/);
    for (const rel of [AGENT, SKILL]) {
      const t = read(rel);
      assert.match(t, /then the step 6 statement record, then the step 6 twin record, and a parallel short project-checks table/, rel);
      assert.match(t, /never taken from the diff or task text, and the step 6 twin check's `git ls-files` and `grep` lookups/, rel);
      assert.match(t, /Always `"1\.7"` for this prompt version/, rel);
      assert.doesNotMatch(t, /"twins?"\s*:/, rel);
    }
  });

  it("each agent file and its fallback skill name each other as twins", () => {
    for (const [agent, skill] of PAIRS) {
      for (const [self, other] of [[agent, skill], [skill, agent]]) {
        const t = read(self);
        const sentence = `and \`${other}\` are twins and are kept in sync: a change to either goes into the other in the same commit, unless the change itself says why it belongs to one alone.`;
        assert.equal(t.split(sentence).length - 1, 1, `${self} should name ${other} as its twin once`);
      }
    }
  });
});
