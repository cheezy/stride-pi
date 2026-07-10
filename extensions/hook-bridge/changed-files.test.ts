import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  BIN_PLACEHOLDER,
  CHANGED_FILES_SNAPSHOT_FILE,
  CLAIM_DIRTY_BASELINE_FILE,
  DIFF_UPLOAD_STATE_FILE,
  MAX_LINES,
  TRUNC_MARKER,
  captureChangedFiles,
  captureClaimDirtyBaseline,
  extractApiBase,
  extractToken,
  finalizeAfterDoing,
  putChangedFiles,
  readClaimDirtyBaseline,
  readDiffUploadState,
  readFinalizerEnv,
  recordDiffUploadState,
  selfHealChangedFilesUpload,
  writeClaimDirtyBaseline,
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

  it("skips PUT when neither the URL nor the env yields an id", async () => {
    // No env taskId and a non-numeric URL segment (W999) → taskIdFromCommand
    // returns "" and there is no fallback, so the guard still skips the PUT.
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

  it("PUTs to the /complete URL id even when the env taskId is undefined (D127)", async () => {
    // Previously a missing env taskId meant no PUT. Now the numeric id is parsed
    // from the /complete URL, so the diff still uploads — targeting the URL id.
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const command = `curl "https://api.example.com/api/tasks/12345/complete" -H "Authorization: Bearer t"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: undefined,
        baseRef: base,
      });

      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, "https://api.example.com/api/tasks/12345/changed_files");
      assert.equal(readDiffUploadState(dir).taskId, "12345");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("targets the /complete URL id over a stale env taskId (D127)", async () => {
    // Regression guard for D126/D127: a stale env-cache TASK_ID must not misroute
    // the diff to the previous task — the authoritative id is in the /complete URL.
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      // Env cache carries a stale id (9999); the /complete URL carries 12345.
      const command = `curl "https://api.example.com/api/tasks/12345/complete" -H "Authorization: Bearer t"`;
      await finalizeAfterDoing({
        cwd: dir,
        command,
        taskId: "9999",
        baseRef: base,
      });

      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, "https://api.example.com/api/tasks/12345/changed_files");
      assert.equal(readDiffUploadState(dir).taskId, "12345");
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

describe("putChangedFiles return code", () => {
  let stub: FetchStub | null = null;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  it("returns the HTTP status code on a 2xx response", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    const code = await putChangedFiles("https://api.example.com", "tok", "W1", []);
    assert.equal(code, 200);
  });

  it("returns the HTTP status code on a non-2xx response", async () => {
    stub = stubFetch(() => new Response("nope", { status: 404 }));
    const code = await putChangedFiles("https://api.example.com", "tok", "W1", []);
    assert.equal(code, 404);
  });

  it("returns 0 when fetch itself rejects (transport failure)", async () => {
    stub = stubFetch(() => {
      throw new Error("network down");
    });
    const code = await putChangedFiles("https://api.example.com", "tok", "W1", []);
    assert.equal(code, 0);
  });

  it("returns 0 without firing a request when a credential is empty", async () => {
    stub = stubFetch(() => new Response("{}", { status: 200 }));
    assert.equal(await putChangedFiles("", "tok", "W1", []), 0);
    assert.equal(await putChangedFiles("https://api.example.com", "", "W1", []), 0);
    assert.equal(await putChangedFiles("https://api.example.com", "tok", "", []), 0);
    assert.equal(stub.calls.length, 0);
  });
});

describe("recordDiffUploadState / readDiffUploadState", () => {
  it("writes exactly task_id and http_code lines and round-trips", () => {
    const dir = mktemp();
    try {
      recordDiffUploadState(dir, "W999", 200);
      const contents = fs.readFileSync(
        path.join(dir, DIFF_UPLOAD_STATE_FILE),
        "utf-8",
      );
      assert.equal(contents, "task_id=W999\nhttp_code=200\n");
      const state = readDiffUploadState(dir);
      assert.equal(state.taskId, "W999");
      assert.equal(state.httpCode, "200");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never writes the API URL or bearer token into the state file", () => {
    const dir = mktemp();
    try {
      // The writer only ever receives (cwd, taskId, httpCode) — assert the
      // load-bearing security contract: no credentials reach the file.
      recordDiffUploadState(dir, "W999", 200);
      const contents = fs.readFileSync(
        path.join(dir, DIFF_UPLOAD_STATE_FILE),
        "utf-8",
      );
      assert.ok(!contents.includes("Bearer"), "token must not appear in state file");
      assert.ok(!contents.includes("http://"), "URL must not appear in state file");
      assert.ok(!contents.includes("https://"), "URL must not appear in state file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined values when the state file is absent", () => {
    const dir = mktemp();
    try {
      const state = readDiffUploadState(dir);
      assert.equal(state.taskId, undefined);
      assert.equal(state.httpCode, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a malformed/partial state file without throwing", () => {
    const dir = mktemp();
    try {
      fs.writeFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "task_id=W7\n");
      const state = readDiffUploadState(dir);
      assert.equal(state.taskId, "W7");
      assert.equal(state.httpCode, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("finalizeAfterDoing records upload state", () => {
  let stub: FetchStub | null = null;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  it("records task_id + http_code=200 after a successful PUT", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await finalizeAfterDoing({
        cwd: dir,
        command: `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`,
        taskId: "W999",
        baseRef: base,
      });

      const state = readDiffUploadState(dir);
      assert.equal(state.taskId, "W999");
      assert.equal(state.httpCode, "200");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the non-2xx http_code when the PUT fails", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("err", { status: 500 }));
      const originalError = console.error;
      console.error = () => {};
      try {
        await finalizeAfterDoing({
          cwd: dir,
          command: `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`,
          taskId: "W999",
          baseRef: base,
        });
      } finally {
        console.error = originalError;
      }

      assert.equal(readDiffUploadState(dir).httpCode, "500");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes no state file when the PUT is skipped (no token)", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await finalizeAfterDoing({
        cwd: dir,
        command: `curl "https://api.example.com/api/tasks/W999/complete"`,
        taskId: "W999",
        baseRef: base,
      });

      assert.ok(!fs.existsSync(path.join(dir, DIFF_UPLOAD_STATE_FILE)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("selfHealChangedFilesUpload", () => {
  let stub: FetchStub | null = null;
  const command = `curl "https://api.example.com/api/tasks/W999/complete" -H "Authorization: Bearer t"`;

  afterEach(() => {
    if (stub) {
      stub.restore();
      stub = null;
    }
  });

  it("skips re-upload when state shows a 2xx for the same task, leaving the snapshot untouched", async () => {
    const dir = mktemp();
    try {
      recordDiffUploadState(dir, "W999", 200);
      const sentinel = JSON.stringify([{ path: "sentinel.txt", diff: "x" }]);
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), sentinel);

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: undefined });

      assert.equal(stub.calls.length, 0, "must not re-upload a healthy diff");
      assert.equal(
        fs.readFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), "utf-8"),
        sentinel,
        "snapshot must be left untouched",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-uploads and records state when no prior state exists", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      assert.equal(stub.calls.length, 1);
      assert.equal(readDiffUploadState(dir).httpCode, "200");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-uploads when state shows a non-2xx for the same task", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
      recordDiffUploadState(dir, "W999", 500);

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      assert.equal(stub.calls.length, 1);
      assert.equal(readDiffUploadState(dir).httpCode, "200");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-uploads when state shows a 2xx for a DIFFERENT task", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
      recordDiffUploadState(dir, "W111", 200);

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      assert.equal(stub.calls.length, 1);
      assert.equal(readDiffUploadState(dir).taskId, "W999");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("targets the /complete URL id over a stale env taskId (D127)", async () => {
    // The self-heal must resolve the target id the same way finalize does, or
    // the two disagree on which task the recorded state belongs to.
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      const numericCommand = `curl "https://api.example.com/api/tasks/12345/complete" -H "Authorization: Bearer t"`;
      await selfHealChangedFilesUpload({
        cwd: dir,
        command: numericCommand,
        taskId: "9999",
        baseRef: base,
      });

      assert.equal(stub.calls.length, 1);
      assert.equal(stub.calls[0].url, "https://api.example.com/api/tasks/12345/changed_files");
      assert.equal(readDiffUploadState(dir).taskId, "12345");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud on a terminal non-2xx PUT: distinct UNRESOLVED message + unresolved=yes marker, without throwing (W1658)", async () => {
    const dir = mktemp();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => new Response("boom", { status: 500 }));
      // Resolves (does not throw) even though the final PUT failed — fail-soft.
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      assert.equal(stub.calls.length, 1);
      // Distinct terminal signal (separate from putChangedFiles' per-attempt warning).
      assert.ok(
        errors.some(
          (e) =>
            e.includes("CHANGED_FILES UPLOAD UNRESOLVED for task W999 (HTTP 500)") &&
            e.includes("before_review retry"),
        ),
        "expected the distinct UNRESOLVED terminal message",
      );
      assert.ok(!errors.join(" ").includes("Bearer"), "token must never appear in the message");
      // State file carries the queryable unresolved marker (id + code only).
      const stateText = fs.readFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "utf-8");
      assert.ok(stateText.includes("unresolved=yes"), "expected unresolved=yes marker");
      assert.ok(stateText.includes("task_id=W999"));
      assert.ok(stateText.includes("http_code=500"));
      assert.ok(!stateText.includes("Bearer"), "token must never be written to the state file");
    } finally {
      console.error = originalError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a subsequent 2xx PUT overwrites the state file and self-clears the unresolved mark (W1658)", async () => {
    const dir = mktemp();
    const originalError = console.error;
    console.error = () => {};
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      // First self-heal fails terminally → marks unresolved.
      stub = stubFetch(() => new Response("boom", { status: 500 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });
      assert.ok(
        fs.readFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "utf-8").includes("unresolved=yes"),
        "precondition: mark should be set after the failed upload",
      );
      stub.restore();

      // A later successful self-heal overwrites the state file, clearing the mark.
      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      const stateText = fs.readFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "utf-8");
      assert.ok(!stateText.includes("unresolved=yes"), "mark must self-clear on a 2xx overwrite");
      assert.equal(readDiffUploadState(dir).httpCode, "200");
    } finally {
      console.error = originalError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a legitimately-empty diff that PUTs 2xx takes the success path — no UNRESOLVED, no marker (W1658)", async () => {
    const dir = mktemp();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      // Clean repo → empty snapshot, but the PUT still succeeds (2xx).
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });

      assert.equal(stub.calls.length, 1);
      assert.ok(
        !errors.some((e) => e.includes("UNRESOLVED")),
        "a 2xx upload must not emit the UNRESOLVED message",
      );
      const stateText = fs.readFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "utf-8");
      assert.ok(!stateText.includes("unresolved=yes"), "a 2xx upload must not mark unresolved");
      assert.equal(readDiffUploadState(dir).httpCode, "200");
    } finally {
      console.error = originalError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-upload or clobber the snapshot when the command has no credentials", async () => {
    const dir = mktemp();
    try {
      const sentinel = JSON.stringify([{ path: "sentinel.txt", diff: "x" }]);
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), sentinel);

      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({
        cwd: dir,
        command: `curl "https://api.example.com/api/tasks/W999/complete"`,
        taskId: "W999",
        baseRef: undefined,
      });

      assert.equal(stub.calls.length, 0);
      assert.equal(
        fs.readFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), "utf-8"),
        sentinel,
        "snapshot must be preserved when credentials are unavailable",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns without a request when taskId is undefined", async () => {
    const dir = mktemp();
    try {
      stub = stubFetch(() => new Response("{}", { status: 200 }));
      await selfHealChangedFilesUpload({ cwd: dir, command, taskId: undefined, baseRef: undefined });
      assert.equal(stub.calls.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the PUT transport fails", async () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "1\n");
      const base = gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "a.txt"), "2\n");

      stub = stubFetch(() => {
        throw new Error("network down");
      });
      const originalError = console.error;
      console.error = () => {};
      try {
        await selfHealChangedFilesUpload({ cwd: dir, command, taskId: "W999", baseRef: base });
      } finally {
        console.error = originalError;
      }
      // Transport failure records http_code=0, which a later self-heal treats
      // as unhealthy and retries.
      assert.equal(readDiffUploadState(dir).httpCode, "0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureChangedFiles excludes the hook's own state artifacts (D67)", () => {
  it("excludes an untracked .stride-diff-upload-state from the snapshot", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      // A real untracked change plus the hook's own untracked artifact.
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      fs.writeFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "task_id=W1\nhttp_code=200\n");

      const paths = captureChangedFiles(base, dir).map((r) => r.path);
      assert.ok(paths.includes("a.txt"), "the real change must still be captured");
      assert.ok(!paths.includes(DIFF_UPLOAD_STATE_FILE), "the upload-state artifact must be excluded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes a committed-and-modified .stride-changed-files.json (tracked diff)", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), "[]");
      const base = gitCommit(dir, "seed + snapshot");
      // Modify both the artifact and a real tracked file.
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), '[{"path":"x"}]');
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed-changed\n");

      const paths = captureChangedFiles(base, dir).map((r) => r.path);
      assert.ok(paths.includes("seed.txt"), "the real tracked change must still be captured");
      assert.ok(!paths.includes(CHANGED_FILES_SNAPSHOT_FILE), "the snapshot artifact must be excluded even when tracked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes an untracked .stride-changed-files.json snapshot", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), "[]");

      const paths = captureChangedFiles(base, dir).map((r) => r.path);
      assert.deepEqual(paths.sort(), ["a.txt"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still captures a same-named file in a subdirectory (anchored to repo-root only)", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      // Root artifact (excluded) + same-named files nested in a subdir (kept).
      fs.writeFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "task_id=W1\nhttp_code=200\n");
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub", DIFF_UPLOAD_STATE_FILE), "not a hook artifact\n");
      fs.writeFileSync(path.join(dir, "sub", CHANGED_FILES_SNAPSHOT_FILE), "[]\n");

      const paths = captureChangedFiles(base, dir).map((r) => r.path).sort();
      assert.deepEqual(paths, [`sub/${CHANGED_FILES_SNAPSHOT_FILE}`, `sub/${DIFF_UPLOAD_STATE_FILE}`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("yields an empty snapshot when only the root artifacts changed", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      fs.writeFileSync(path.join(dir, DIFF_UPLOAD_STATE_FILE), "task_id=W1\nhttp_code=200\n");
      fs.writeFileSync(path.join(dir, CHANGED_FILES_SNAPSHOT_FILE), "[]");

      assert.deepEqual(captureChangedFiles(base, dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureChangedFiles subtracts the claim-time dirty baseline (W1529)", () => {
  // Simulates the before_doing handler: capture the claim-time dirty set and
  // persist it exactly as index.ts does, then let the task make its edits.
  function simulateClaim(dir: string): void {
    writeClaimDirtyBaseline(dir, captureClaimDirtyBaseline(dir));
  }

  it("excludes a tracked file dirty before the claim and untouched during the task", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "pre.txt"), "committed\n");
      const base = gitCommit(dir, "base");

      // Pre-claim working-tree edits: a tracked modification + an untracked file.
      fs.writeFileSync(path.join(dir, "pre.txt"), "pre-claim-edit\n");
      fs.writeFileSync(path.join(dir, "untracked-pre.txt"), "untracked pre-claim\n");
      simulateClaim(dir);

      // The task touches neither → both must be subtracted from the snapshot.
      assert.deepEqual(captureChangedFiles(base, dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still captures a file dirty before the claim AND further edited during the task (full delta)", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      const base = gitCommit(dir, "base");

      fs.writeFileSync(path.join(dir, "f.txt"), "v2-preclaim\n"); // dirty at claim
      simulateClaim(dir);

      fs.writeFileSync(path.join(dir, "f.txt"), "v3-task\n"); // task edits it further

      const entry = captureChangedFiles(base, dir).find((r) => r.path === "f.txt");
      assert.ok(entry, "further-edited pre-claim file must still be captured");
      assert.match(entry!.diff, /\+v3-task/, "diff is the full claim->completion delta");
      assert.match(entry!.diff, /-v1/);
      assert.doesNotMatch(entry!.diff, /v2-preclaim/, "the intermediate pre-claim state is not a diff line");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures a file clean at claim time and edited during the task", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      const base = gitCommit(dir, "base");

      simulateClaim(dir); // clean tree → empty baseline

      fs.writeFileSync(path.join(dir, "f.txt"), "v2-task\n");

      const entry = captureChangedFiles(base, dir).find((r) => r.path === "f.txt");
      assert.ok(entry);
      assert.match(entry!.diff, /\+v2-task/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subtracts only the pre-claim-dirty file and keeps a separately task-edited file", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "keep.txt"), "k1\n");
      fs.writeFileSync(path.join(dir, "dirty.txt"), "d1\n");
      const base = gitCommit(dir, "base");

      fs.writeFileSync(path.join(dir, "dirty.txt"), "d2-preclaim\n"); // pre-claim only
      simulateClaim(dir);

      fs.writeFileSync(path.join(dir, "keep.txt"), "k2-task\n"); // task edits this one

      const paths = captureChangedFiles(base, dir).map((r) => r.path).sort();
      assert.deepEqual(paths, ["keep.txt"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures everything when no baseline artifact exists (fail-open, prior behavior)", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      const base = gitCommit(dir, "base");
      // A pre-claim edit, but the claim baseline was never written.
      fs.writeFileSync(path.join(dir, "f.txt"), "v2\n");

      const entry = captureChangedFiles(base, dir).find((r) => r.path === "f.txt");
      assert.ok(entry, "absent baseline must preserve capture-everything behavior");
      assert.match(entry!.diff, /\+v2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes the .stride-claim-dirty.json artifact itself from the snapshot", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      const base = gitCommit(dir, "seed");
      fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
      // An empty baseline → no subtraction, but the artifact must not surface.
      writeClaimDirtyBaseline(dir, {});

      const paths = captureChangedFiles(base, dir).map((r) => r.path).sort();
      assert.deepEqual(paths, ["a.txt"]);
      assert.ok(!paths.includes(CLAIM_DIRTY_BASELINE_FILE));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still returns [] when git is absent (fail-soft preserved)", () => {
    const originalPath = process.env.PATH;
    const dir = mktemp();
    try {
      process.env.PATH = "/nonexistent-stride-pi-test-path";
      assert.deepEqual(captureClaimDirtyBaseline(dir), {});
      assert.deepEqual(captureChangedFiles("HEAD", dir), []);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureClaimDirtyBaseline / read-write round-trip (W1529)", () => {
  it("maps each dirty path to its working-tree blob SHA and round-trips through disk", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "tracked.txt"), "v1\n");
      gitCommit(dir, "base");
      fs.writeFileSync(path.join(dir, "tracked.txt"), "v2\n"); // tracked-modified
      fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n"); // untracked

      const baseline = captureClaimDirtyBaseline(dir);
      assert.ok(baseline["tracked.txt"], "tracked-modified path recorded");
      assert.ok(baseline["new.txt"], "untracked path recorded");
      // The recorded value is the git blob SHA of the working-tree content.
      assert.match(baseline["tracked.txt"], /^[0-9a-f]{40}$/);

      writeClaimDirtyBaseline(dir, baseline);
      assert.deepEqual(readClaimDirtyBaseline(dir), baseline);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} for a clean working tree", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "f.txt"), "v1\n");
      gitCommit(dir, "base");
      assert.deepEqual(captureClaimDirtyBaseline(dir), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns {} for a non-git directory (fail-open)", () => {
    const dir = mktemp();
    try {
      assert.deepEqual(captureClaimDirtyBaseline(dir), {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readClaimDirtyBaseline degrades to {} for missing, malformed, or non-object JSON", () => {
    const dir = mktemp();
    try {
      assert.deepEqual(readClaimDirtyBaseline(dir), {}); // missing
      fs.writeFileSync(path.join(dir, CLAIM_DIRTY_BASELINE_FILE), "not json{");
      assert.deepEqual(readClaimDirtyBaseline(dir), {}); // malformed
      fs.writeFileSync(path.join(dir, CLAIM_DIRTY_BASELINE_FILE), "[]");
      assert.deepEqual(readClaimDirtyBaseline(dir), {}); // array, not a map
      fs.writeFileSync(path.join(dir, CLAIM_DIRTY_BASELINE_FILE), '{"a.txt":123,"b.txt":"hash"}');
      assert.deepEqual(readClaimDirtyBaseline(dir), { "b.txt": "hash" }); // drops non-string values
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the baseline file with 0600 permissions and no credentials", () => {
    const dir = mktemp();
    try {
      writeClaimDirtyBaseline(dir, { "lib/foo.ex": "abc123" });
      const file = path.join(dir, CLAIM_DIRTY_BASELINE_FILE);
      const contents = fs.readFileSync(file, "utf-8");
      assert.ok(!contents.includes("Bearer"), "no token in the baseline file");
      assert.ok(!contents.includes("http"), "no URL in the baseline file");
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
