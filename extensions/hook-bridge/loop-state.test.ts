import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  LOOP_STATE_FILE,
  canonicalBelongsToCompletion,
  clearLoopState,
  completedAtNow,
  loopStateFieldsFrom,
  loopStateSafe,
  readLoopState,
  recordLoopStateForCompletion,
  writeLoopState,
} from "./loop-state.ts";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-loop-"));
}

function withTmp(fn: (dir: string) => void): void {
  const dir = mktemp();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loopPath(dir: string): string {
  return path.join(dir, LOOP_STATE_FILE);
}

function readRecord(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(loopPath(dir), "utf8"));
}

/** A successful /complete body: `data` plus the plural `hooks` array. */
function completeBody(
  identifier: string,
  needsReview: boolean,
  id: number = 42,
): string {
  return JSON.stringify({
    data: { id, identifier, needs_review: needsReview },
    hooks: [],
  });
}

describe("loopStateSafe", () => {
  it("accepts the fleet charset and rejects everything else", () => {
    assert.equal(loopStateSafe("W2150"), true);
    assert.equal(loopStateSafe("ses_a.b:c-d"), true);
    assert.equal(loopStateSafe(""), false);
    assert.equal(loopStateSafe("W 2150"), false);
    assert.equal(loopStateSafe("W/2150"), false);
    assert.equal(loopStateSafe("x".repeat(64)), true);
    assert.equal(loopStateSafe("x".repeat(65)), false);
    assert.equal(loopStateSafe(undefined), false);
    assert.equal(loopStateSafe(42), false);
  });
});

describe("completedAtNow", () => {
  it("reproduces `date -u +%Y-%m-%dT%H:%M:%SZ` with no milliseconds", () => {
    const ts = completedAtNow(new Date("2026-08-31T14:03:22.123Z"));
    assert.equal(ts, "2026-08-31T14:03:22Z");
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("recordLoopStateForCompletion", () => {
  it("needs_review false produces the right identifier", () => {
    withTmp((dir) => {
      const wrote = recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W2150", false)],
        sessionId: "ses_abc",
      });
      assert.equal(wrote, true);
      const rec = readRecord(dir);
      assert.equal(rec.identifier, "W2150");
      assert.equal(rec.needs_review, false);
      assert.equal(typeof rec.needs_review, "boolean");
      assert.equal(rec.session_id, "ses_abc");
    });
  });

  it("needs_review true recorded verbatim as a boolean", () => {
    withTmp((dir) => {
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: [completeBody("W42", true)],
          sessionId: "ses_abc",
        }),
        true,
      );
      const rec = readRecord(dir);
      assert.equal(rec.needs_review, true);
      assert.equal(typeof rec.needs_review, "boolean");
    });
  });

  it("unwraps the Bash-tool {stdout} envelope", () => {
    withTmp((dir) => {
      const wrapped = JSON.stringify({ stdout: completeBody("W7", false) });
      assert.equal(
        recordLoopStateForCompletion({ cwd: dir, ownCandidates: [wrapped] }),
        true,
      );
      assert.equal(readRecord(dir).identifier, "W7");
    });
  });

  it("a failed 422 completion writes nothing", () => {
    withTmp((dir) => {
      const body = JSON.stringify({
        errors: { completion_summary: ["can't be blank"] },
      });
      assert.equal(
        recordLoopStateForCompletion({ cwd: dir, ownCandidates: [body] }),
        false,
      );
      assert.equal(fs.existsSync(loopPath(dir)), false);
    });
  });

  it("a truncated response writes nothing", () => {
    withTmp((dir) => {
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: ['{"data":{"identifier":"W21'],
        }),
        false,
      );
      assert.equal(fs.existsSync(loopPath(dir)), false);
    });
  });

  it("rejects a stringified needs_review — the gate tests for a boolean", () => {
    withTmp((dir) => {
      const body = JSON.stringify({
        data: { id: 1, identifier: "W1", needs_review: "false" },
        hooks: [],
      });
      assert.equal(
        recordLoopStateForCompletion({ cwd: dir, ownCandidates: [body] }),
        false,
      );
      assert.equal(fs.existsSync(loopPath(dir)), false);
    });
  });

  it("rejects an unsafe or oversized identifier", () => {
    withTmp((dir) => {
      for (const bad of ["W 2150", "x".repeat(65)]) {
        assert.equal(
          recordLoopStateForCompletion({
            cwd: dir,
            ownCandidates: [completeBody(bad, false)],
          }),
          false,
        );
        assert.equal(fs.existsSync(loopPath(dir)), false);
      }
    });
  });

  it("falls back to 'unknown' for an unsafe or absent session id", () => {
    withTmp((dir) => {
      for (const bad of [undefined, "", "ses abc", "s".repeat(65)]) {
        assert.equal(
          recordLoopStateForCompletion({
            cwd: dir,
            ownCandidates: [completeBody("W9", false)],
            sessionId: bad,
          }),
          true,
        );
        assert.equal(readRecord(dir).session_id, "unknown");
      }
    });
  });

  it("creates .stride/ when absent and leaves no temp file behind", () => {
    withTmp((dir) => {
      assert.equal(fs.existsSync(path.join(dir, ".stride")), false);
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: [completeBody("W2150", false)],
        }),
        true,
      );
      const entries = fs.readdirSync(path.join(dir, ".stride"));
      assert.deepEqual(entries, [".loop-state.json"]);
    });
  });

  it("is never fatal when the write cannot succeed", () => {
    withTmp((dir) => {
      // .stride is a regular file, so mkdirSync throws.
      fs.writeFileSync(path.join(dir, ".stride"), "not a directory");
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: [completeBody("W2150", false)],
        }),
        false,
      );
    });
  });

  it("leaves no temp file behind when the staging write fails", () => {
    withTmp((dir) => {
      // Reach the catch AFTER `tmp` has been assigned: .stride exists but is
      // not writable, so mkdirSync succeeds (already present) and the staging
      // write throws EACCES. Residual limit, stated rather than implied: the
      // temp is never created on this path, so what this proves is that the
      // cleanup branch runs and leaves nothing — not that an already-created
      // temp is unlinked. Reaching THAT would need a rename stub or a
      // production seam, which a best-effort writer does not justify.
      fs.mkdirSync(path.join(dir, ".stride"), { recursive: true });
      fs.chmodSync(path.join(dir, ".stride"), 0o500);
      try {
        assert.equal(
          writeLoopState(dir, {
            identifier: "W1",
            needs_review: false,
            completed_at: "2026-08-31T00:00:00Z",
            session_id: "unknown",
          }),
          false,
        );
        const leftovers = fs
          .readdirSync(path.join(dir, ".stride"))
          .filter((f) => /^loop-state\..*\.tmp$/.test(f));
        assert.deepEqual(leftovers, []);
      } finally {
        fs.chmodSync(path.join(dir, ".stride"), 0o700);
      }
    });
  });

  it("refuses a non-regular destination rather than renaming into it", () => {
    withTmp((dir) => {
      fs.mkdirSync(path.join(dir, ".stride", ".loop-state.json"), {
        recursive: true,
      });
      assert.equal(
        writeLoopState(dir, {
          identifier: "W1",
          needs_review: false,
          completed_at: "2026-08-31T00:00:00Z",
          session_id: "unknown",
        }),
        false,
      );
      assert.equal(fs.statSync(loopPath(dir)).isDirectory(), true);
    });
  });

  it("(D226) refuses a canonical file holding the previous CLAIM", () => {
    withTmp((dir) => {
      // A claim payload: singular `hook`, and a different task id.
      const claim = JSON.stringify({
        hook: { name: "before_doing" },
        data: { id: 7, identifier: "W7", needs_review: false },
      });
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: ['{"data":{"identifier":"W21'], // truncated
          canonicalText: claim,
          taskId: "42",
        }),
        false,
      );
      assert.equal(fs.existsSync(loopPath(dir)), false);
    });
  });

  it("(D226) accepts a canonical file that is demonstrably this completion", () => {
    withTmp((dir) => {
      assert.equal(
        recordLoopStateForCompletion({
          cwd: dir,
          ownCandidates: ['{"data":{"identifier":"W21'], // truncated
          canonicalText: completeBody("W42", true, 42),
          taskId: "42",
        }),
        true,
      );
      const rec = readRecord(dir);
      assert.equal(rec.identifier, "W42");
      assert.equal(rec.needs_review, true);
    });
  });
});

describe("canonicalBelongsToCompletion", () => {
  it("requires a plural hooks array and a matching data.id", () => {
    assert.equal(canonicalBelongsToCompletion(completeBody("W42", false, 42), "42"), true);
    assert.equal(canonicalBelongsToCompletion(completeBody("W42", false, 42), "43"), false);
    assert.equal(canonicalBelongsToCompletion(completeBody("W42", false, 42), ""), false);
    assert.equal(
      canonicalBelongsToCompletion(
        JSON.stringify({ hook: {}, data: { id: 42, identifier: "W42", needs_review: false } }),
        "42",
      ),
      false,
    );
    assert.equal(canonicalBelongsToCompletion(null, "42"), false);
    assert.equal(canonicalBelongsToCompletion("not json", "42"), false);
  });
});

describe("clearLoopState", () => {
  it("a claim clears the record, and a missing file is not an error", () => {
    withTmp((dir) => {
      clearLoopState(dir); // absent — must not throw
      recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W2150", false)],
      });
      assert.equal(fs.existsSync(loopPath(dir)), true);
      clearLoopState(dir);
      assert.equal(fs.existsSync(loopPath(dir)), false);
    });
  });

  it("integration: a claim, complete, claim cycle carries nothing stale", () => {
    withTmp((dir) => {
      clearLoopState(dir);
      assert.equal(fs.existsSync(loopPath(dir)), false);

      recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W42", false, 42)],
        sessionId: "ses_one",
      });
      assert.equal(readRecord(dir).identifier, "W42");

      clearLoopState(dir);
      assert.equal(fs.existsSync(loopPath(dir)), false);

      recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W43", true, 43)],
        sessionId: "ses_two",
      });
      const rec = readRecord(dir);
      assert.equal(rec.identifier, "W43");
      assert.equal(rec.needs_review, true);
      assert.equal(rec.session_id, "ses_two");
    });
  });
});

describe("the fleet record shape", () => {
  it("matches the contract every runtime reads", () => {
    withTmp((dir) => {
      recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W2150", false)],
        sessionId: "ses_abc",
      });
      const loopStatePath = loopPath(dir);

      // (W2150) The record is a FLEET contract: the shell Stop gate, the
      // PowerShell twin and the other port all read this file out of a shared
      // checkout. This block is byte-identical in
      // stride-pi/extensions/hook-bridge/loop-state.test.ts and
      // stride-opencode/src/capture.test.ts (modulo assert vs expect). If one
      // port's writer drifts, exactly one of the two copies fails, and the
      // diff names the drift.
      const parsed = JSON.parse(fs.readFileSync(loopStatePath, "utf8"));
      assert.deepEqual(Object.keys(parsed), [
        "identifier",
        "needs_review",
        "completed_at",
        "session_id",
      ]);
      assert.deepEqual(
        Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v])),
        {
          identifier: "string",
          needs_review: "boolean",
          completed_at: "string",
          session_id: "string",
        },
      );
      assert.match(parsed.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.match(parsed.identifier, /^[A-Za-z0-9_.:-]{1,64}$/);
      assert.match(parsed.session_id, /^[A-Za-z0-9_.:-]{1,64}$/);
      assert.equal(fs.readFileSync(loopStatePath, "utf8").endsWith("\n"), true);
    });
  });

  it("reads a record the OpenCode port would have written", () => {
    // The cross-runtime case reduced to a fixture: the sibling port's canonical
    // completion payload must yield the same fields through this port's reader.
    const openCodeFixture = JSON.stringify({
      data: { id: 99, identifier: "W99", needs_review: true },
      hooks: [{ name: "after_doing" }],
    });
    assert.deepEqual(loopStateFieldsFrom(openCodeFixture), {
      identifier: "W99",
      needsReview: true,
    });
  });
});

describe("readLoopState", () => {
  it("round-trips a record the writer produced", () => {
    withTmp((dir) => {
      recordLoopStateForCompletion({
        cwd: dir,
        ownCandidates: [completeBody("W2151", true)],
        sessionId: "ses_abc",
      });
      assert.deepEqual(readLoopState(dir), {
        identifier: "W2151",
        needs_review: true,
        completed_at: readRecord(dir).completed_at,
        session_id: "ses_abc",
      });
    });
  });

  it("returns null for anything the writer would not have produced", () => {
    const bad: [string, string][] = [
      ["non-JSON", "{not json"],
      ["a JSON array", "[]"],
      ["a bare string", '"W2151"'],
      ["stringified needs_review", '{"identifier":"W1","needs_review":"false","completed_at":"t","session_id":"s"}'],
      ["unsafe identifier", '{"identifier":"W 1","needs_review":false,"completed_at":"t","session_id":"s"}'],
      ["missing session_id", '{"identifier":"W1","needs_review":false,"completed_at":"t"}'],
      ["missing completed_at", '{"identifier":"W1","needs_review":false,"session_id":"s"}'],
    ];
    for (const [label, body] of bad) {
      withTmp((dir) => {
        fs.mkdirSync(path.join(dir, ".stride"), { recursive: true });
        fs.writeFileSync(loopPath(dir), body);
        assert.equal(readLoopState(dir), null, label);
      });
    }
  });

  it("returns null when the file is absent", () => {
    withTmp((dir) => {
      assert.equal(readLoopState(dir), null);
    });
  });
});
