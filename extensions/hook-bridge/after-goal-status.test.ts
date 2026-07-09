import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CANONICAL_RESPONSE_FILE,
  type FetchFn,
  getAfterGoalStatus,
  readCanonicalResponse,
  writeCanonicalResponse,
} from "./after-goal-status.ts";
import { captureChangedFiles } from "./changed-files.ts";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-ags-"));
}

function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Build an injected fetch that records every call and returns one canned
 * Response. No globalThis monkeypatch — getAfterGoalStatus takes fetch as a
 * parameter, so we pass the stub directly (pitfall W742: no real network).
 */
function stubFetch(
  status: number,
  body: unknown,
): { fetch: FetchFn; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

const CREDS = { apiBase: "https://stride.test", token: "tok-123", taskId: "4976" };

describe("getAfterGoalStatus", () => {
  it("parses armed=true, goalId, and env via the injected fetch", async () => {
    // JSON.parse gives a genuine own `__proto__` property, which round-trips
    // through the stub's stringify → Response.json parse, exercising the
    // prototype-pollution guard.
    const body = JSON.parse(
      '{"after_goal_armed":true,"goal_id":4975,"goal_identifier":"G17",' +
        '"env":{"__proto__":"evil","GOAL_ID":"4975","GOAL_TITLE":"Ship it","COUNT":7}}',
    );
    const { fetch, calls } = stubFetch(200, body);

    const res = await getAfterGoalStatus({ fetch, ...CREDS });

    assert.equal(res.armed, true);
    assert.equal(res.goalId, 4975);
    // Non-string COUNT and prototype-pollution __proto__ are dropped.
    assert.deepEqual(res.env, { GOAL_ID: "4975", GOAL_TITLE: "Ship it" });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://stride.test/api/tasks/4976/after_goal_status",
    );
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer tok-123",
    );
  });

  it("strips a trailing slash from apiBase when building the url", async () => {
    const { fetch, calls } = stubFetch(200, { after_goal_armed: false });
    await getAfterGoalStatus({ ...CREDS, apiBase: "https://stride.test/", fetch });
    assert.equal(
      calls[0].url,
      "https://stride.test/api/tasks/4976/after_goal_status",
    );
  });

  it("no-ops (disarmed) when the server reports after_goal_armed=false", async () => {
    const { fetch } = stubFetch(200, {
      after_goal_armed: false,
      goal_id: null,
      env: {},
    });
    const res = await getAfterGoalStatus({ fetch, ...CREDS });
    assert.deepEqual(res, { armed: false, goalId: null, env: {} });
  });

  it("no-ops on a non-2xx response", async () => {
    const { fetch } = stubFetch(500, { error: "boom" });
    const res = await getAfterGoalStatus({ fetch, ...CREDS });
    assert.deepEqual(res, { armed: false, goalId: null, env: {} });
  });

  it("no-ops on a network error", async () => {
    const fetch: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await getAfterGoalStatus({ fetch, ...CREDS });
    assert.deepEqual(res, { armed: false, goalId: null, env: {} });
  });

  it("no-ops on an unparseable body without throwing", async () => {
    const fetch: FetchFn = async () =>
      new Response("not json{", { status: 200 });
    const res = await getAfterGoalStatus({ fetch, ...CREDS });
    assert.deepEqual(res, { armed: false, goalId: null, env: {} });
  });

  it("never calls fetch when a credential is missing", async () => {
    let called = false;
    const fetch: FetchFn = async () => {
      called = true;
      return new Response("{}", { status: 200 });
    };
    for (const bad of [
      { ...CREDS, apiBase: "" },
      { ...CREDS, token: "" },
      { ...CREDS, taskId: "" },
    ]) {
      const res = await getAfterGoalStatus({ fetch, ...bad });
      assert.deepEqual(res, { armed: false, goalId: null, env: {} });
    }
    assert.equal(called, false);
  });

  it("defaults goalId to null when goal_id is not a number", async () => {
    const { fetch } = stubFetch(200, {
      after_goal_armed: true,
      goal_id: "4975",
      env: {},
    });
    const res = await getAfterGoalStatus({ fetch, ...CREDS });
    assert.equal(res.armed, true);
    assert.equal(res.goalId, null);
  });
});

describe("readCanonicalResponse / writeCanonicalResponse", () => {
  function withTmp(fn: (dir: string) => void): void {
    const dir = mktemp();
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("round-trips valid JSON through the canonical file", () => {
    withTmp((dir) => {
      const text = JSON.stringify({ data: { hooks: [] }, ok: true });
      assert.equal(writeCanonicalResponse(dir, text), true);
      assert.equal(readCanonicalResponse(dir), text);
      assert.ok(fs.existsSync(path.join(dir, CANONICAL_RESPONSE_FILE)));
    });
  });

  it("creates the .stride/ directory when it does not exist", () => {
    withTmp((dir) => {
      assert.equal(fs.existsSync(path.join(dir, ".stride")), false);
      assert.equal(writeCanonicalResponse(dir, "{}"), true);
      assert.ok(fs.existsSync(path.join(dir, ".stride")));
    });
  });

  it("returns null for an absent file", () => {
    withTmp((dir) => {
      assert.equal(readCanonicalResponse(dir), null);
    });
  });

  it("returns null for an empty / whitespace-only file", () => {
    withTmp((dir) => {
      fs.mkdirSync(path.join(dir, ".stride"), { recursive: true });
      fs.writeFileSync(path.join(dir, CANONICAL_RESPONSE_FILE), "   \n");
      assert.equal(readCanonicalResponse(dir), null);
    });
  });

  it("returns null for an invalid-JSON file", () => {
    withTmp((dir) => {
      fs.mkdirSync(path.join(dir, ".stride"), { recursive: true });
      fs.writeFileSync(path.join(dir, CANONICAL_RESPONSE_FILE), "{not json");
      assert.equal(readCanonicalResponse(dir), null);
    });
  });

  it("refuses to write non-JSON and leaves no file behind", () => {
    withTmp((dir) => {
      assert.equal(writeCanonicalResponse(dir, "garbage{"), false);
      assert.equal(fs.existsSync(path.join(dir, CANONICAL_RESPONSE_FILE)), false);
    });
  });

  it("never overwrites a good file with garbage", () => {
    withTmp((dir) => {
      const good = JSON.stringify({ keep: true });
      assert.equal(writeCanonicalResponse(dir, good), true);
      assert.equal(writeCanonicalResponse(dir, "corrupt{"), false);
      assert.equal(readCanonicalResponse(dir), good);
    });
  });
});

describe("changed_files excludes the .stride/ runtime dir", () => {
  it("omits the canonical response file from the captured diff", () => {
    const dir = mktemp();
    try {
      gitInit(dir);
      fs.writeFileSync(path.join(dir, "real.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf-8",
      }).trim();

      // Edit a real file and drop a canonical response file (untracked).
      fs.writeFileSync(path.join(dir, "real.txt"), "changed\n");
      assert.equal(
        writeCanonicalResponse(dir, JSON.stringify({ data: {} })),
        true,
      );

      const paths = captureChangedFiles(base, dir).map((c) => c.path);
      assert.ok(paths.includes("real.txt"));
      assert.ok(
        !paths.some((p) => p.startsWith(".stride/")),
        `.stride/ paths leaked into changed_files: ${paths.join(", ")}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
