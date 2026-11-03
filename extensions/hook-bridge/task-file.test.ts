import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  claimDataFromOutput,
  deleteTaskFileAfterCompletion,
  deleteTaskFileForEnv,
  recordClaimedTask,
  runClaimSteps,
  taskFilePath,
  taskFileStem,
  writeTaskFile,
} from "./task-file.ts";

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-task-file-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A claim task body the way the server sends it. */
function claimData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7897,
    identifier: "W1",
    title: "Write the task file",
    acceptance_criteria: "One\nTwo",
    key_files: [{ file_path: "a.ts", note: "n", position: 0 }],
    needs_review: false,
    ...overrides,
  };
}

/** A successful claim response: `data` with `hook` beside it. */
function claimBody(data: unknown): string {
  return JSON.stringify({
    data,
    hook: { name: "before_doing", env: { AUTHORIZATION: "not-a-real-header" } },
    current_skills_version: "1.0",
  });
}

function strideEntries(dir: string): string[] {
  const stride = path.join(dir, ".stride");
  return fs.existsSync(stride) ? fs.readdirSync(stride).sort() : [];
}

describe("taskFileStem", () => {
  it("uses a safe identifier", () => {
    assert.equal(taskFileStem({ identifier: "W2607", id: 7897 }), "W2607");
    assert.equal(taskFileStem({ identifier: "a_B-9", id: 1 }), "a_B-9");
  });

  it("accepts a 64-character identifier and refuses a 65-character one", () => {
    assert.equal(taskFileStem({ identifier: "W".repeat(64), id: 5 }), "W".repeat(64));
    assert.equal(taskFileStem({ identifier: "W".repeat(65), id: 5 }), "5");
  });

  it("falls back to the numeric id for an unsafe identifier", () => {
    for (const identifier of ["../../x", "W1/..", "W1\n", "", "W 1", "W1.json", 12, null]) {
      assert.equal(taskFileStem({ identifier, id: 7897 }), "7897", JSON.stringify(identifier));
    }
  });

  it("accepts a digits-only string id", () => {
    assert.equal(taskFileStem({ identifier: "../x", id: "7897" }), "7897");
  });

  it("returns null when neither the identifier nor the id is safe", () => {
    for (const id of [-1, 1.5, "../1", "1\n", "", NaN, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      assert.equal(taskFileStem({ identifier: "../x", id }), null, String(id));
    }
  });
});

describe("claimDataFromOutput", () => {
  it("reads the data object from details.output before content", () => {
    const fromDetails = claimData({ identifier: "W1" });
    const fromContent = claimData({ identifier: "W2" });
    const data = claimDataFromOutput(claimBody(fromContent), { output: claimBody(fromDetails) });
    assert.deepEqual(data, fromDetails);
  });

  it("falls back to content when details.output does not parse", () => {
    const data = claimDataFromOutput(claimBody(claimData()), { output: '{"data": {"id"' });
    assert.deepEqual(data, claimData());
  });

  it("peels the {stdout} wrapper", () => {
    const wrapped = JSON.stringify({ stdout: claimBody(claimData()) });
    assert.deepEqual(claimDataFromOutput(wrapped, undefined), claimData());
  });

  it("never accepts a bare root object without data", () => {
    assert.equal(claimDataFromOutput(JSON.stringify(claimData()), undefined), null);
  });
});

describe("recordClaimedTask", () => {
  it("a proven claim writes .stride/.task-W1.json equal to the data object", () => {
    withTmp((dir) => {
      const data = claimData();
      const dest = recordClaimedTask(dir, claimBody(data), undefined);
      assert.equal(dest, taskFilePath(dir, "W1"));
      const text = fs.readFileSync(path.join(dir, ".stride", ".task-W1.json"), "utf-8");
      // Exactly the data object, compact, one line -- nothing from beside it.
      assert.equal(text, JSON.stringify(data) + "\n");
      assert.deepEqual(JSON.parse(text), data);
      assert.ok(!text.includes("hook"), "the hook entry beside data is not written");
      assert.ok(!text.includes("AUTHORIZATION"), "nothing outside data reaches the file");
      assert.equal(fs.statSync(dest!).mode & 0o777, 0o600);
    });
  });

  it("a hostile identifier falls back to the numeric id", () => {
    withTmp((dir) => {
      const data = claimData({ identifier: "../../x" });
      recordClaimedTask(dir, claimBody(data), undefined);
      assert.deepEqual(strideEntries(dir), [".task-7897.json"]);
      assert.deepEqual(fs.readdirSync(dir), [".stride"], "nothing escapes .stride/");
      assert.deepEqual(
        JSON.parse(fs.readFileSync(taskFilePath(dir, "7897"), "utf-8")),
        data,
      );
    });
  });

  it("an identifier longer than 64 characters falls back to the numeric id", () => {
    withTmp((dir) => {
      recordClaimedTask(dir, claimBody(claimData({ identifier: "W".repeat(65) })), undefined);
      assert.deepEqual(strideEntries(dir), [".task-7897.json"]);
    });
  });

  it("writes nothing when neither the identifier nor the id is safe", () => {
    withTmp((dir) => {
      const dest = recordClaimedTask(
        dir,
        claimBody(claimData({ identifier: "../x", id: "../1" })),
        undefined,
      );
      assert.equal(dest, null);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  });

  it("a failed claim response writes nothing", () => {
    withTmp((dir) => {
      const earlier = claimBody(claimData());
      recordClaimedTask(dir, earlier, undefined);
      const before = fs.readFileSync(taskFilePath(dir, "W1"));
      for (const body of [
        JSON.stringify({ errors: { identifier: ["is not available"] } }),
        JSON.stringify({ error: "Task not found" }),
        JSON.stringify({ data: { identifier: "W1" }, error: "no id" }),
      ]) {
        assert.equal(recordClaimedTask(dir, body, { output: body }), null, body);
      }
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
      assert.deepEqual(fs.readFileSync(taskFilePath(dir, "W1")), before, "earlier file untouched");
    });
  });

  it("an unparsable or truncated response writes nothing", () => {
    withTmp((dir) => {
      const full = claimBody(claimData());
      const truncated = full.slice(0, Math.floor(full.length / 2));
      const truncatedWrapper = JSON.stringify({ stdout: full }).slice(0, 40);
      for (const [content, details] of [
        [truncated, undefined],
        [truncatedWrapper, { output: truncatedWrapper }],
        ["", { output: "" }],
        ["   \n", undefined],
        [undefined, undefined],
        [42, { output: 42 }],
        [JSON.stringify({ stdout: "not json" }), undefined],
      ] as Array<[unknown, unknown]>) {
        assert.equal(recordClaimedTask(dir, content, details), null, String(content));
      }
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  });

  it("an empty data object writes nothing", () => {
    withTmp((dir) => {
      for (const data of [{}, null, [], "W1"]) {
        assert.equal(recordClaimedTask(dir, claimBody(data), undefined), null, JSON.stringify(data));
      }
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  });

  it("two claims in a row overwrite rather than append", () => {
    withTmp((dir) => {
      recordClaimedTask(dir, claimBody(claimData({ title: "first" })), undefined);
      const second = claimData({ title: "second" });
      recordClaimedTask(dir, claimBody(second), undefined);
      const text = fs.readFileSync(taskFilePath(dir, "W1"), "utf-8");
      assert.equal(text, JSON.stringify(second) + "\n");
      assert.equal(text.split("\n").length, 2, "one line plus its newline");
    });
  });

  it("claims of two different tasks leave both files", () => {
    withTmp((dir) => {
      recordClaimedTask(dir, claimBody(claimData({ identifier: "W1", id: 1 })), undefined);
      recordClaimedTask(dir, claimBody(claimData({ identifier: "W2", id: 2 })), undefined);
      assert.deepEqual(strideEntries(dir), [".task-W1.json", ".task-W2.json"]);
    });
  });

  it("writes under the given directory's .stride/, never a parent's", () => {
    // The bridge has no walk-up to .stride.md: every state file it writes
    // (the env cache and diff artifacts at the root, .stride/.loop-state.json,
    // .stride/.last-api-response.json) is resolved from ctx.cwd, as is
    // .stride.md itself, and this file is too.
    withTmp((root) => {
      fs.writeFileSync(path.join(root, ".stride.md"), "## before_doing\n");
      const cwd = path.join(root, "sub");
      fs.mkdirSync(cwd);
      recordClaimedTask(cwd, claimBody(claimData()), undefined);
      assert.ok(fs.existsSync(taskFilePath(cwd, "W1")));
      assert.ok(!fs.existsSync(path.join(root, ".stride")));
    });
  });
});

describe("recordClaimedTask with the prior task's identity", () => {
  const prior = { TASK_IDENTIFIER: "W1", TASK_ID: "1" };

  it("deletes the previous task's file when a different task is claimed", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData({ identifier: "W1", id: 1 }));
      recordClaimedTask(dir, claimBody(claimData({ identifier: "W2", id: 2 })), undefined, prior);
      assert.deepEqual(strideEntries(dir), [".task-W2.json"]);
    });
  });

  it("a re-claim of the same task leaves its file holding the new claim", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData({ identifier: "W1", id: 1, title: "first" }));
      const again = claimData({ identifier: "W1", id: 1, title: "again" });
      recordClaimedTask(dir, claimBody(again), undefined, prior);
      assert.equal(fs.readFileSync(taskFilePath(dir, "W1"), "utf-8"), JSON.stringify(again) + "\n");
    });
  });

  it("an unproven claim deletes nothing", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData({ identifier: "W1", id: 1 }));
      recordClaimedTask(dir, JSON.stringify({ error: "not available" }), undefined, prior);
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
    });
  });
});

describe("deleteTaskFileAfterCompletion", () => {
  const env = { TASK_IDENTIFIER: "W1", TASK_ID: "7897" };
  const completion = (data: unknown) => JSON.stringify({ data, hooks: [] });

  function withTaskFile(fn: (dir: string) => void): void {
    withTmp((dir) => {
      writeTaskFile(dir, claimData());
      fn(dir);
    });
  }

  it("deletes the file when this task's completion needs no review", () => {
    withTaskFile((dir) => {
      const raw = completion({ identifier: "W1", needs_review: false });
      assert.equal(deleteTaskFileAfterCompletion(dir, [raw], env), true);
      assert.deepEqual(strideEntries(dir), []);
    });
  });

  it("reads a wrapped completion after a truncated candidate", () => {
    withTaskFile((dir) => {
      const raw = completion({ identifier: "W1", needs_review: false });
      const wrapped = JSON.stringify({ stdout: raw });
      assert.equal(deleteTaskFileAfterCompletion(dir, [raw.slice(0, 20), wrapped], env), true);
      assert.deepEqual(strideEntries(dir), []);
    });
  });

  it("keeps the file when the task needs review, or the response is not this task's success", () => {
    withTaskFile((dir) => {
      for (const raw of [
        completion({ identifier: "W1", needs_review: true }),
        completion({ identifier: "W1", needs_review: "false" }),
        completion({ identifier: "W2", needs_review: false }),
        JSON.stringify({ errors: { completion_summary: ["can't be blank"] } }),
        completion({ identifier: "W1", needs_review: false }).slice(0, 30),
      ]) {
        assert.equal(deleteTaskFileAfterCompletion(dir, [raw], env), false, raw);
      }
      assert.equal(deleteTaskFileAfterCompletion(dir, [], env), false);
      const ok = completion({ identifier: "W1", needs_review: false });
      assert.equal(deleteTaskFileAfterCompletion(dir, [ok], {}), false, "no identity, no delete");
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
    });
  });
});

describe("writeTaskFile", () => {
  it("no temp file is left behind after a write", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData());
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
    });
  });

  it("refuses a destination that is not a regular file, leaving no temp file", () => {
    withTmp((dir) => {
      fs.mkdirSync(taskFilePath(dir, "W1"), { recursive: true });
      assert.equal(writeTaskFile(dir, claimData()), null);
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
      assert.ok(fs.statSync(taskFilePath(dir, "W1")).isDirectory());
    });
  });

  it("returns null without throwing when .stride cannot be created", () => {
    withTmp((dir) => {
      fs.writeFileSync(path.join(dir, ".stride"), "a file, not a directory");
      assert.doesNotThrow(() => assert.equal(writeTaskFile(dir, claimData()), null));
      assert.deepEqual(fs.readdirSync(dir), [".stride"]);
    });
  });
});

describe("deleteTaskFileForEnv", () => {
  it("deletes the file the env cache names", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData());
      deleteTaskFileForEnv(dir, { TASK_IDENTIFIER: "W1", TASK_ID: "7897" });
      assert.deepEqual(strideEntries(dir), []);
    });
  });

  it("uses TASK_ID when the cached identifier is unsafe", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData({ identifier: "../x" }));
      deleteTaskFileForEnv(dir, { TASK_IDENTIFIER: "../x", TASK_ID: "7897" });
      assert.deepEqual(strideEntries(dir), []);
    });
  });

  it("leaves another task's file alone", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData({ identifier: "W1", id: 1 }));
      writeTaskFile(dir, claimData({ identifier: "W2", id: 2 }));
      deleteTaskFileForEnv(dir, { TASK_IDENTIFIER: "W1", TASK_ID: "1" });
      assert.deepEqual(strideEntries(dir), [".task-W2.json"]);
    });
  });

  it("never throws when the path cannot be removed", () => {
    withTmp((dir) => {
      fs.mkdirSync(taskFilePath(dir, "W1"), { recursive: true });
      assert.doesNotThrow(() => deleteTaskFileForEnv(dir, { TASK_IDENTIFIER: "W1" }));
      assert.ok(fs.statSync(taskFilePath(dir, "W1")).isDirectory());
    });
  });

  it("is a no-op for an empty env or a missing file", () => {
    withTmp((dir) => {
      writeTaskFile(dir, claimData());
      assert.doesNotThrow(() => deleteTaskFileForEnv(dir, {}));
      assert.doesNotThrow(() => deleteTaskFileForEnv(dir, { TASK_IDENTIFIER: "W9" }));
      assert.deepEqual(strideEntries(dir), [".task-W1.json"]);
    });
  });
});

describe("runClaimSteps", () => {
  it("clears the prior task before recording the new task file", () => {
    const calls: string[] = [];
    runClaimSteps({
      clearPriorTask: () => calls.push("clear"),
      recordTaskFile: () => calls.push("record"),
    });
    assert.deepEqual(calls, ["clear", "record"]);
  });

  it("still records when the cleanup throws, and never throws itself", () => {
    const calls: string[] = [];
    assert.doesNotThrow(() =>
      runClaimSteps({
        clearPriorTask: () => {
          throw new Error("boom");
        },
        recordTaskFile: () => {
          calls.push("record");
          throw new Error("boom too");
        },
      }),
    );
    assert.deepEqual(calls, ["record"]);
  });
});
