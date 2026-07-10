import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectStrideHook, taskIdFromCommand } from "./curl-matcher.ts";

describe("detectStrideHook", () => {
  it("routes pre + /complete to after_doing", () => {
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/1640/complete" -d "{}"';
    assert.equal(detectStrideHook("pre", cmd), "after_doing");
  });

  it("routes post + /claim to before_doing", () => {
    const cmd = 'curl -s -X POST "https://www.stridelikeaboss.com/api/tasks/claim" -d "{}"';
    assert.equal(detectStrideHook("post", cmd), "before_doing");
  });

  it("routes post + /complete to before_review", () => {
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/1640/complete" -d "{}"';
    assert.equal(detectStrideHook("post", cmd), "before_review");
  });

  it("routes post + /mark_reviewed to after_review", () => {
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/1640/mark_reviewed"';
    assert.equal(detectStrideHook("post", cmd), "after_review");
  });

  it("returns null for unrelated curl calls", () => {
    assert.equal(detectStrideHook("pre", "curl https://example.com/api/tasks/something"), null);
    assert.equal(detectStrideHook("post", "curl https://api.github.com/repos/foo/bar"), null);
  });

  it("returns null for /complete on pre vs post mismatch with claim", () => {
    // claim only fires on post; pre+claim is not a thing
    assert.equal(
      detectStrideHook("pre", 'curl -X POST "https://example.com/api/tasks/claim"'),
      null,
    );
  });

  it("returns null for empty commands", () => {
    assert.equal(detectStrideHook("pre", ""), null);
    assert.equal(detectStrideHook("post", ""), null);
  });

  it("does not match substring lookalikes", () => {
    // /api/tasks/claim_audit should not match /api/tasks/claim
    assert.equal(
      detectStrideHook("post", "curl https://example.com/api/tasks/claim_audit"),
      null,
    );
    // /api/tasks/1640/completed (past-tense) should not match /complete
    assert.equal(
      detectStrideHook("pre", "curl https://example.com/api/tasks/1640/completed"),
      null,
    );
  });

  it("matches with query string after the path segment", () => {
    assert.equal(
      detectStrideHook("post", "curl https://example.com/api/tasks/claim?dryrun=1"),
      "before_doing",
    );
  });
});

describe("taskIdFromCommand (D127)", () => {
  it("extracts the numeric id from a /complete URL", () => {
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/1640/complete" -d "{}"';
    assert.equal(taskIdFromCommand(cmd), "1640");
  });

  it("extracts the numeric id from a /mark_reviewed URL", () => {
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/1640/mark_reviewed"';
    assert.equal(taskIdFromCommand(cmd), "1640");
  });

  it("matches with a query string after the completion segment", () => {
    const cmd = 'curl "https://example.com/api/tasks/12345/complete?dryrun=1"';
    assert.equal(taskIdFromCommand(cmd), "12345");
  });

  it("returns empty for the claim path (no id in the URL)", () => {
    assert.equal(taskIdFromCommand('curl -X POST "https://example.com/api/tasks/claim" -d "{}"'), "");
  });

  it("returns empty for the next path", () => {
    assert.equal(taskIdFromCommand("curl https://example.com/api/tasks/next"), "");
  });

  it("returns empty for a non-numeric id segment", () => {
    // Only a bare numeric id is accepted; a non-numeric segment must fall back
    // to the env-cache id, so the helper reports no match here.
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/W999/complete"'), "");
  });

  it("returns empty for a mixed alphanumeric id segment", () => {
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/12ab/complete"'), "");
  });

  it("does not match the past-tense /completed lookalike", () => {
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/1640/completed"'), "");
  });

  it("returns empty for an empty command", () => {
    assert.equal(taskIdFromCommand(""), "");
  });
});
