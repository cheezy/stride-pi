import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BIN_PLACEHOLDER,
  MAX_LINES,
  TRUNC_MARKER,
  captureChangedFiles,
  extractApiBase,
  extractToken,
  finalizeAfterDoing,
  putChangedFiles,
  readFinalizerEnv,
} from "./changed-files.ts";

function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

function gitCommit(cwd: string, msg: string): string {
  execFileSync("git", ["add", "-A"], { cwd });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf-8" }).trim();
}

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-cf-"));
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FetchStub {
  calls: FetchCall[];
  restore: () => void;
}

/**
 * Replaces globalThis.fetch with a stub that records every call and returns a
 * canned Response. Pitfall W742 demands "mock the fetch/curl layer" — no real
 * network calls, not even to localhost.
 */
function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): FetchStub {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  const stub = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  // @ts-expect-error — overriding the global for test isolation
  globalThis.fetch = stub;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("captureChangedFiles", () => {
  it("returns [] when the directory is not a git repo", () => {
    const dir = mktemp();
    try {
      assert.deepEqual(captureChangedFiles("HEAD", dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the base ref is unresolvable and there is no HEAD~1", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
      gitCommit(dir, "first");
      assert.deepEqual(captureChangedFiles("nonexistent-ref", dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces an entry for a tracked modified file", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "tracked.txt"), "v1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "tracked.txt"), "v2\n");

      const result = captureChangedFiles(base, dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].path, "tracked.txt");
      assert.match(result[0].diff, /-v1/);
      assert.match(result[0].diff, /\+v2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces an entry for a staged-uncommitted change", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      const base = gitCommit(dir, "base");

      fs.writeFileSync(path.join(dir, "f.txt"), "v2-staged\n");
      execFileSync("git", ["add", "f.txt"], { cwd: dir });

      const result = captureChangedFiles(base, dir);
      const entry = result.find((r) => r.path === "f.txt");
      assert.ok(entry, "staged change should surface in capture");
      assert.match(entry!.diff, /\+v2-staged/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("synthesizes an untracked new text file as a /dev/null patch", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "anchor.txt"), "anchor\n");
      const base = gitCommit(dir, "base");

      fs.writeFileSync(path.join(dir, "new.txt"), "hello untracked\n");

      const result = captureChangedFiles(base, dir);
      const entry = result.find((r) => r.path === "new.txt");
      assert.ok(entry);
      assert.match(entry!.diff, /--- \/dev\/null/);
      assert.match(entry!.diff, /\+hello untracked/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits the binary placeholder for tracked binary files", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      const bin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00, 0xfe]);
      fs.writeFileSync(path.join(dir, "img.bin"), bin);
      const base = gitCommit(dir, "base with binary");

      const bin2 = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]);
      fs.writeFileSync(path.join(dir, "img.bin"), bin2);

      const result = captureChangedFiles(base, dir);
      assert.equal(result.length, 1);
      assert.equal(result[0].path, "img.bin");
      assert.equal(result[0].diff, BIN_PLACEHOLDER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits the binary placeholder for untracked binary files", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "anchor.txt"), "anchor\n");
      const base = gitCommit(dir, "base");

      const bin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00, 0xfe]);
      fs.writeFileSync(path.join(dir, "logo.png"), bin);

      const result = captureChangedFiles(base, dir);
      const entry = result.find((r) => r.path === "logo.png");
      assert.ok(entry);
      assert.equal(entry!.diff, BIN_PLACEHOLDER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncates diffs over MAX_LINES with the exact contract marker text", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "big.txt"), "");
      const base = gitCommit(dir, "base");

      const lines: string[] = [];
      for (let i = 0; i < MAX_LINES + 200; i++) {
        lines.push(`line ${i}`);
      }
      fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n");

      const result = captureChangedFiles(base, dir);
      const big = result.find((r) => r.path === "big.txt");
      assert.ok(big);
      const out = big!.diff;
      const newlineCount = (out.match(/\n/g) || []).length;
      assert.ok(
        newlineCount <= MAX_LINES,
        `expected <= ${MAX_LINES} newlines, got ${newlineCount}`,
      );
      assert.ok(
        out.endsWith(TRUNC_MARKER) || out.endsWith(TRUNC_MARKER + "\n"),
        `expected diff to end with the truncation marker, got tail: ${out.slice(-200)}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a file that is both committed-since-base AND further modified exactly once, with the final working-tree diff", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      const base = gitCommit(dir, "base");

      fs.writeFileSync(path.join(dir, "f.txt"), "v2-committed\n");
      gitCommit(dir, "modify");

      // Further modify in working tree on top of the new commit.
      fs.writeFileSync(path.join(dir, "f.txt"), "v3-working\n");

      const result = captureChangedFiles(base, dir);
      const matches = result.filter((r) => r.path === "f.txt");
      assert.equal(matches.length, 1, "file should appear exactly once");
      assert.match(matches[0].diff, /\+v3-working/, "final working-tree state should win");
      assert.doesNotMatch(matches[0].diff, /\+v2-committed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to HEAD~1 when base ref is empty but history exists", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      gitCommit(dir, "first");
      fs.writeFileSync(path.join(dir, "f.txt"), "v2\n");
      gitCommit(dir, "second");

      const result = captureChangedFiles("", dir);
      const entry = result.find((r) => r.path === "f.txt");
      assert.ok(entry, "f.txt should be captured via HEAD~1 fallback");
      assert.match(entry!.diff, /-v1/);
      assert.match(entry!.diff, /\+v2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when there are no changes between base and the working tree", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "stable.txt"), "stable\n");
      const base = gitCommit(dir, "base");
      assert.deepEqual(captureChangedFiles(base, dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureChangedFiles when git binary is unavailable", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
    // PATH that points nowhere — execFileSync('git', ...) raises ENOENT,
    // exercising the hasGit() and runGitAllowFail() fallback branches that
    // would otherwise require uninstalling git on the runner.
    process.env.PATH = "/nonexistent-stride-pi-test-path";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns [] without throwing when git is missing from PATH", () => {
    const dir = mktemp();
    try {
      assert.deepEqual(captureChangedFiles("HEAD", dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractApiBase / extractToken", () => {
  it("extracts the base URL from a curl command", () => {
    const cmd =
      'curl -X PATCH "https://www.stridelikeaboss.com/api/tasks/W741/complete" -H "Authorization: Bearer abc"';
    assert.equal(extractApiBase(cmd), "https://www.stridelikeaboss.com");
  });

  it("extracts a base URL with a port", () => {
    const cmd = 'curl http://localhost:4000/api/tasks/claim -d "{}"';
    assert.equal(extractApiBase(cmd), "http://localhost:4000");
  });

  it("extracts the Bearer token, stripping the scheme prefix", () => {
    const cmd =
      'curl -H "Authorization: Bearer stride_dev_abc.123-XYZ/+_=" https://example.com/api/tasks/next';
    assert.equal(extractToken(cmd), "stride_dev_abc.123-XYZ/+_=");
  });

  it("returns null when there is no URL or token", () => {
    assert.equal(extractApiBase("echo hello"), null);
    assert.equal(extractToken("echo hello"), null);
  });

  it("returns null on empty input", () => {
    assert.equal(extractApiBase(""), null);
    assert.equal(extractToken(""), null);
  });
});

describe("putChangedFiles (fetch mocked)", () => {
  let stub: FetchStub | null = null;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  it("PUTs the base64-encoded changed_files envelope (D61)", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    const files = [{ path: "lib/foo.ex", diff: "@@ -1 +1 @@\n-a\n+b\n" }];
    await putChangedFiles("https://api.example.com", "tok-abc", "W741", files);
    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0];
    assert.equal(call.url, "https://api.example.com/api/tasks/W741/changed_files");
    assert.equal(call.init?.method, "PUT");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer tok-abc");
    assert.equal(headers["Content-Type"], "application/json");
    const rawBody = call.init?.body as string;
    const body = JSON.parse(rawBody);
    // D61: transport-encoded envelope, NOT a bare array and NOT raw diff text.
    assert.equal(body.changed_files.encoding, "base64");
    assert.equal(typeof body.changed_files.data, "string");
    assert.ok(!rawBody.includes("lib/foo.ex"), "raw path must be absent from the wire body");
    // Round-trip: data is base64 of the snapshot array JSON and decodes back.
    const expectedData = Buffer.from(JSON.stringify(files), "utf8").toString("base64");
    assert.equal(body.changed_files.data, expectedData);
    assert.deepEqual(
      JSON.parse(Buffer.from(body.changed_files.data, "base64").toString("utf8")),
      files,
    );
  });

  it("trims a trailing slash from the API base before composing the URL", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    await putChangedFiles("https://api.example.com/", "tok", "W741", []);
    assert.equal(stub.calls[0].url, "https://api.example.com/api/tasks/W741/changed_files");
  });

  it("resolves silently when the server returns 404", async () => {
    stub = stubFetch(() => new Response("not found", { status: 404 }));
    await putChangedFiles("https://api.example.com", "tok", "W741", []);
    assert.equal(stub.calls.length, 1);
  });

  it("warns to stderr on a non-2xx response without throwing (D61)", async () => {
    stub = stubFetch(() => new Response("server error", { status: 500 }));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      await putChangedFiles("https://api.example.com", "tok", "W741", []);
    } finally {
      console.error = originalError;
    }
    assert.equal(stub.calls.length, 1);
    assert.ok(
      errors.some((e) => e.includes("changed_files upload failed (HTTP 500) for task W741")),
      "expected a non-2xx stderr warning",
    );
    assert.ok(!errors.join(" ").includes("tok"), "token must not appear in the warning");
  });

  it("resolves silently when fetch itself rejects (network failure)", async () => {
    stub = stubFetch(() => {
      throw new Error("network unreachable");
    });
    await putChangedFiles("https://api.example.com", "tok", "W741", []);
    assert.equal(stub.calls.length, 1);
  });

  it("skips the request entirely when the token is empty", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    await putChangedFiles("https://api.example.com", "", "W741", []);
    assert.equal(stub.calls.length, 0);
  });

  it("skips the request entirely when the task id is empty", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    await putChangedFiles("https://api.example.com", "tok", "", []);
    assert.equal(stub.calls.length, 0);
  });

  it("skips the request entirely when the api base is empty", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    await putChangedFiles("", "tok", "W741", []);
    assert.equal(stub.calls.length, 0);
  });
});

describe("finalizeAfterDoing (fetch mocked)", () => {
  let stub: FetchStub | null = null;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  it("captures, writes the snapshot, and PUTs it when everything is available", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const command = `curl -X PATCH "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer secret-tok"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: "W999",
        baseRef: base,
      });

      const snapPath = path.join(dir, ".stride-changed-files.json");
      assert.ok(fs.existsSync(snapPath));
      const parsed = JSON.parse(fs.readFileSync(snapPath, "utf-8"));
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].path, "a.txt");

      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, "https://api.example.com/api/tasks/W999/changed_files");
      const body = JSON.parse(stub.calls[0].init?.body as string);
      // D61: the wire body is the base64 envelope; decode it to verify the list.
      assert.equal(body.changed_files.encoding, "base64");
      const decoded = JSON.parse(
        Buffer.from(body.changed_files.data, "base64").toString("utf8"),
      );
      assert.equal(decoded.length, 1);
      assert.equal(decoded[0].path, "a.txt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still writes the snapshot but skips PUT when the command has no Bearer token", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const command = `curl -X PATCH "https://api.example.com/api/tasks/W999/complete"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: "W999",
        baseRef: base,
      });

      assert.ok(fs.existsSync(path.join(dir, ".stride-changed-files.json")));
      assert.equal(stub.calls.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips PUT when taskId is undefined", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const command = `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: undefined,
        baseRef: base,
      });

      assert.equal(stub.calls.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when the directory is not a git repo (empty snapshot)", async () => {
    const dir = mktemp();
    try {
      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const command = `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: "W999",
        baseRef: undefined,
      });
      const snapPath = path.join(dir, ".stride-changed-files.json");
      assert.ok(fs.existsSync(snapPath));
      assert.equal(fs.readFileSync(snapPath, "utf-8"), "[]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw when the snapshot file cannot be written (cwd does not exist)", async () => {
    // cwd points at a non-existent directory — captureChangedFiles returns [],
    // then fs.writeFileSync raises ENOENT which the catch swallows.
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    const fakeDir = path.join(os.tmpdir(), `stride-pi-doesnotexist-${Date.now()}`);
    await finalizeAfterDoing({
      cwd: fakeDir,
      command: `curl "https://api.example.com/api/tasks/W1/complete" -H "Authorization: Bearer t"`,
      taskId: "W1",
      baseRef: undefined,
    });
    // PUT still fires because taskId + url + token are present even though
    // the snapshot file was un-writable.
    assert.equal(stub.calls.length, 1);
  });

  it("swallows a PUT 404 without throwing", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("not found", { status: 404 }));
      await finalizeAfterDoing({
        cwd: dir,
        command: `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`,
        taskId: "W999",
        baseRef: base,
      });
      assert.equal(stub.calls.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readFinalizerEnv", () => {
  it("returns undefined values when the env cache file does not exist", () => {
    const dir = mktemp();
    try {
      const env = readFinalizerEnv(dir);
      assert.equal(env.taskId, undefined);
      assert.equal(env.baseRef, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads TASK_ID and TASK_BASE_REF from the env cache file", () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(
        path.join(dir, ".stride-env-cache"),
        "TASK_ID='2758'\nTASK_IDENTIFIER='W741'\nTASK_BASE_REF='abc123def456'\n",
      );
      const env = readFinalizerEnv(dir);
      assert.equal(env.taskId, "2758");
      assert.equal(env.baseRef, "abc123def456");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing keys without throwing", () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(
        path.join(dir, ".stride-env-cache"),
        "TASK_IDENTIFIER='W741'\n",
      );
      const env = readFinalizerEnv(dir);
      assert.equal(env.taskId, undefined);
      assert.equal(env.baseRef, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the env cache file cannot be read (path is a directory)", () => {
    // existsSync sees the directory and returns true, but readFileSync raises
    // EISDIR — exercised by the readFinalizerEnv catch branch.
    const dir = mktemp();
    try {
      fs.mkdirSync(path.join(dir, ".stride-env-cache"));
      const env = readFinalizerEnv(dir);
      assert.equal(env.taskId, undefined);
      assert.equal(env.baseRef, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("changed-files anchors to the claim-time TASK_BASE_REF", () => {
  it("with the claim-time base ref, reports the full claim->completion delta (more than one commit)", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed"); // HEAD at claim time
      // Two commits since the claim, each adding a different file.
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      gitCommit(dir, "add a");
      fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
      gitCommit(dir, "add b");

      // Anchored to the claim baseline → the FULL delta (both files).
      const anchored = captureChangedFiles(base, dir).map((r) => r.path).sort();
      assert.deepEqual(anchored, ["a.txt", "b.txt"]);

      // Without a base ref, resolveBase falls back to HEAD~1 and sees only the
      // last commit — under-reporting the true claim->completion delta. This is
      // exactly the bug TASK_BASE_REF persistence fixes.
      const fallback = captureChangedFiles("", dir).map((r) => r.path).sort();
      assert.deepEqual(fallback, ["b.txt"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips TASK_BASE_REF through the env cache and anchors the diff to it", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      // .stride-env-cache is gitignored in real repos, so it never shows up in
      // the changed-files diff; mirror that here.
      fs.writeFileSync(path.join(dir, ".gitignore"), ".stride-env-cache\n");
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      gitCommit(dir, "add a");
      fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
      gitCommit(dir, "add b");

      // Persist the claim-time base ref exactly as writeEnvCache would.
      fs.writeFileSync(
        path.join(dir, ".stride-env-cache"),
        `TASK_ID='3431'\nTASK_BASE_REF='${base}'\n`,
      );
      const { baseRef } = readFinalizerEnv(dir);
      assert.equal(baseRef, base); // round-trip through the cache

      const files = captureChangedFiles(baseRef ?? "", dir).map((r) => r.path).sort();
      assert.deepEqual(files, ["a.txt", "b.txt"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
