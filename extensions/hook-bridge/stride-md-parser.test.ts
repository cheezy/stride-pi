import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseHookSection } from "./stride-md-parser.ts";

const SAMPLE = `# Stride Configuration

## before_doing

\`\`\`bash
# git pull origin main
git fetch origin
mix deps.get
\`\`\`

## after_doing

\`\`\`bash
mix test --cover
mix credo --strict
\`\`\`

## before_review

\`\`\`bash
\`\`\`

## after_review

\`\`\`bash
# all commented
# git push origin main
\`\`\`
`;

describe("parseHookSection", () => {
  it("reads commands from the matching section, stripping comments and blanks", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "before_doing"), [
      "git fetch origin",
      "mix deps.get",
    ]);
  });

  it("isolates sections — does not bleed into the next section", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "after_doing"), [
      "mix test --cover",
      "mix credo --strict",
    ]);
  });

  it("returns empty when the fence is empty", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "before_review"), []);
  });

  it("returns empty when every command line is a comment", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "after_review"), []);
  });

  it("returns empty when the hook section is missing", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "nonexistent_hook"), []);
  });

  it("returns empty for empty content", () => {
    assert.deepEqual(parseHookSection("", "before_doing"), []);
  });

  it("matches exact section names — case-sensitive", () => {
    assert.deepEqual(parseHookSection(SAMPLE, "Before_Doing"), []);
  });
});

const CONT = `## two_line

\`\`\`bash
curl -sS -X POST \\
  https://example.com/api
\`\`\`

## three_line

\`\`\`bash
curl -sS \\
  -H "Content-Type: application/json" \\
  https://example.com/api
\`\`\`

## graceful_tail

\`\`\`bash
echo hi \\
\`\`\`

## mid_and_escaped

\`\`\`bash
echo foo\\bar
echo done\\\\
\`\`\`

## mixed_filter

\`\`\`bash
# a comment
echo first

echo part-a \\
  part-b
\`\`\`

## comment_backslash

\`\`\`bash
# TODO fix this \\
mix test
\`\`\`
`;

// Fence deliberately left unclosed, ending mid-continuation at EOF.
const UNTERMINATED = `## hook

\`\`\`bash
echo dangling \\`;

describe("parseHookSection — backslash line continuation", () => {
  it("joins a two-line continued command into one", () => {
    assert.deepEqual(parseHookSection(CONT, "two_line"), [
      "curl -sS -X POST https://example.com/api",
    ]);
  });

  it("joins a three-line continued command into one", () => {
    assert.deepEqual(parseHookSection(CONT, "three_line"), [
      'curl -sS -H "Content-Type: application/json" https://example.com/api',
    ]);
  });

  it("degrades gracefully when the fence's final line has a trailing backslash", () => {
    // No continuation line follows; the buffered command is emitted with the
    // backslash stripped — no crash, no dangling backslash artifact.
    assert.deepEqual(parseHookSection(CONT, "graceful_tail"), ["echo hi"]);
  });

  it("leaves a mid-line backslash intact and does not continue on an escaped trailing backslash", () => {
    assert.deepEqual(parseHookSection(CONT, "mid_and_escaped"), [
      "echo foo\\bar",
      "echo done\\\\",
    ]);
  });

  it("still filters comment and blank lines when a continuation is present", () => {
    assert.deepEqual(parseHookSection(CONT, "mixed_filter"), [
      "echo first",
      "echo part-a part-b",
    ]);
  });

  it("does not let a comment's trailing backslash swallow the next command", () => {
    // A '#' comment ending in a backslash is a literal comment in bash — the
    // following command must survive, not be folded into the comment.
    assert.deepEqual(parseHookSection(CONT, "comment_backslash"), ["mix test"]);
  });

  it("flushes a dangling continuation when the fence is never closed (EOF)", () => {
    assert.deepEqual(parseHookSection(UNTERMINATED, "hook"), ["echo dangling"]);
  });
});
