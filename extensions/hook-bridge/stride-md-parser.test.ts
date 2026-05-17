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
