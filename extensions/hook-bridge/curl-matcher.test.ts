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

  it("extracts an identifier-form id from a /complete URL (D309)", () => {
    // The server resolves /api/tasks/W2185/complete by identifier, so the upload
    // target must come from the URL rather than a possibly stale env cache.
    const cmd = 'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/W2185/complete" -d "{}"';
    assert.equal(taskIdFromCommand(cmd), "W2185");
  });

  it("extracts goal and defect identifiers from /mark_reviewed and /complete (D309)", () => {
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/G42/mark_reviewed"'), "G42");
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/D309/complete?response_view=slim"'), "D309");
  });

  it("extracts the identifier whatever the response concealment (D309)", () => {
    const url = '"https://example.com/api/tasks/W2185/complete"';
    for (const cmd of [
      `curl -X PATCH ${url}`,
      `curl -X PATCH ${url} -o /tmp/out.json`,
      `curl -X PATCH ${url} > /tmp/out.json`,
      `curl -X PATCH ${url} | jq .data`,
      `curl -X PATCH ${url} | tee .stride/.last-api-response.json`,
    ]) {
      assert.equal(taskIdFromCommand(cmd), "W2185", cmd);
    }
  });

  it("extracts the numeric id whatever the response concealment (D309)", () => {
    // The numeric path must behave exactly as before in every concealment form.
    const url = '"https://example.com/api/tasks/1640/complete"';
    for (const cmd of [
      `curl -X PATCH ${url}`,
      `curl -X PATCH ${url} -o /tmp/out.json`,
      `curl -X PATCH ${url} > /tmp/out.json`,
      `curl -X PATCH ${url} | jq .data`,
      `curl -X PATCH ${url} | tee .stride/.last-api-response.json`,
    ]) {
      assert.equal(taskIdFromCommand(cmd), "1640", cmd);
    }
  });

  it("captures only the id segment, never the surrounding command (D309)", () => {
    const cmd = 'curl -H "Authorization: Bearer tok_secret" "https://example.com/api/tasks/W7/complete"';
    assert.equal(taskIdFromCommand(cmd), "W7");
  });

  it("returns empty for a segment that is neither numeric nor an identifier", () => {
    for (const seg of ["abc", "w999", "X12", "W", "W12x", "W..", "..%2fW1", "W1%2f2"]) {
      assert.equal(taskIdFromCommand(`curl "https://example.com/api/tasks/${seg}/complete"`), "", seg);
    }
  });

  it("does not match the past-tense /completed lookalike for an identifier", () => {
    assert.equal(taskIdFromCommand('curl "https://example.com/api/tasks/W1640/completed"'), "");
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
