/**
 * Tests for attachments.ts (W2532), the Pi port of stride-hook.sh's
 * download_task_attachments. Every request goes to an injected fetch and every
 * write to a temp dir, so the suite never reaches the network or the real
 * project. Run with `node --test extensions/hook-bridge/*.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  ATTACHMENT_FILE_BYTES,
  ATTACHMENT_USER_AGENT,
  attachmentIdString,
  downloadAttachments,
  downloadClaimAttachments,
  planAttachments,
  safeDownloadPath,
  sanitiseAttachmentName,
  type AttachmentDeps,
} from "./attachments.ts";

const API = "https://stride.test";
const FAKE_TOKEN = "tok-fixture-attachments-not-a-credential";
const TASK_ID = 7722;
const MIB = 1024 * 1024;

function withTmpDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-attachments-"));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Served {
  status?: number;
  body?: Uint8Array | null;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch serving `routes` by URL; an unknown URL answers 404. */
function fakeFetch(routes: Record<string, Served | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const route = routes[url];
    if (typeof route === "function") return route();
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? null, {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
  return { fetch, calls };
}

function attachment(id: number, filename: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return {
    id,
    filename,
    content_type: "application/octet-stream",
    byte_size: bytes.length,
    sha256: sha(bytes),
    comment_id: null,
    uploaded_at: "2026-11-08T10:00:00Z",
    download_url: `/api/tasks/${TASK_ID}/attachments/${id}`,
    ...extra,
  };
}

function task(attachments: unknown, extra: Record<string, unknown> = {}) {
  return { id: TASK_ID, identifier: "W2532", title: "t", attachments, ...extra };
}

function deps(fetch: AttachmentDeps["fetch"], extra: Partial<AttachmentDeps> = {}) {
  const lines: string[] = [];
  const d: AttachmentDeps = {
    fetch,
    readAuth: () => ({ apiBase: API, token: FAKE_TOKEN }),
    stderr: (line) => lines.push(line),
    ...extra,
  };
  return { deps: d, lines };
}

function taskDir(cwd: string): string {
  return path.join(cwd, ".stride", "attachments", "W2532");
}

function readManifest(cwd: string): {
  manifest_version: number;
  task: { id: number | null; identifier: string | null };
  caps: Record<string, number>;
  attachments: Array<Record<string, unknown>>;
} {
  return JSON.parse(fs.readFileSync(path.join(taskDir(cwd), "manifest.json"), "utf-8"));
}

function url(id: number): string {
  return `${API}/api/tasks/${TASK_ID}/attachments/${id}`;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%fixture\n");
const TXT = new TextEncoder().encode("plain text attachment\n");

describe("downloadAttachments — happy path", () => {
  it("downloads every listed attachment with an injected fetch, verifies sha256, writes manifest.json last and writes .stride/attachments/.gitignore", async () => {
    await withTmpDir(async (cwd) => {
      const manifestPath = path.join(taskDir(cwd), "manifest.json");
      const seenManifestDuringFetch: boolean[] = [];
      const serve = (bytes: Uint8Array) => async () => {
        seenManifestDuringFetch.push(fs.existsSync(manifestPath));
        return new Response(bytes, { status: 200 });
      };
      const { fetch, calls } = fakeFetch({
        [url(812)]: serve(PNG),
        [url(813)]: serve(PDF),
        [url(814)]: serve(TXT),
      });
      const list = [
        attachment(812, "screenshot.png", PNG, { content_type: "image/png" }),
        attachment(813, "spec.pdf", PDF, { content_type: "application/pdf", comment_id: 5 }),
        attachment(814, "notes.txt", TXT, { content_type: "text/plain" }),
      ];
      const { deps: d, lines } = deps(fetch);
      const summary = await downloadAttachments(cwd, task(list), d);

      assert.deepEqual(summary, { stem: "W2532", downloaded: 3, skipped: 0, failed: 0 });
      assert.equal(calls.length, 3);
      assert.deepEqual(seenManifestDuringFetch, [false, false, false], "manifest is written last");
      assert.deepEqual(fs.readFileSync(path.join(taskDir(cwd), "812-screenshot.png")), Buffer.from(PNG));
      assert.deepEqual(fs.readFileSync(path.join(taskDir(cwd), "813-spec.pdf")), Buffer.from(PDF));
      assert.deepEqual(fs.readFileSync(path.join(taskDir(cwd), "814-notes.txt")), Buffer.from(TXT));
      assert.equal(fs.readFileSync(path.join(cwd, ".stride", "attachments", ".gitignore"), "utf-8"), "*\n");

      const text = fs.readFileSync(manifestPath, "utf-8");
      assert.ok(text.endsWith("}\n") && !text.includes("\n  "), "compact JSON with one trailing LF");
      const expected = {
        manifest_version: 1,
        task: { id: TASK_ID, identifier: "W2532" },
        caps: { file_bytes: 26214400, files: 20, total_bytes: 104857600, budget_seconds: 120 },
        attachments: list.map((a) => ({
          id: a.id,
          filename: a.filename,
          local_file: `${a.id}-${a.filename}`,
          content_type: a.content_type,
          byte_size: a.byte_size,
          sha256: a.sha256,
          comment_id: a.comment_id,
          uploaded_at: a.uploaded_at,
          download_path: a.download_url,
          status: "downloaded",
          reason: null,
        })),
      };
      assert.equal(text, JSON.stringify(expected) + "\n", "exact key order and values");
      assert.ok(!text.includes(API), "no absolute URL in the manifest");
      const leftovers = fs.readdirSync(taskDir(cwd)).filter((n) => n.startsWith("."));
      assert.deepEqual(leftovers, [], "no staged .part or .manifest file is left behind");
      assert.deepEqual(lines, ["stride: attachments W2532: 3 downloaded, 0 skipped, 0 failed\n"]);
    });
  });
});

describe("downloadAttachments — null / empty", () => {
  it("no attachments key, null or [] creates no directory", async () => {
    for (const t of [
      { id: TASK_ID, identifier: "W2532" },
      task(null),
      task([]),
      task("not-a-list"),
    ]) {
      await withTmpDir(async (cwd) => {
        const { fetch, calls } = fakeFetch({});
        const { deps: d, lines } = deps(fetch);
        assert.equal(await downloadAttachments(cwd, t, d), null);
        assert.equal(calls.length, 0);
        assert.ok(!fs.existsSync(path.join(cwd, ".stride")), "no .stride directory is created");
        assert.deepEqual(lines, []);
      });
    }
  });

  it("a re-claim listing no attachments removes the directory an earlier claim left", async () => {
    await withTmpDir(async (cwd) => {
      fs.mkdirSync(taskDir(cwd), { recursive: true });
      fs.writeFileSync(path.join(taskDir(cwd), "manifest.json"), "{}\n");
      fs.writeFileSync(path.join(taskDir(cwd), "1-old.txt"), "old");
      const { fetch } = fakeFetch({});
      assert.equal(await downloadAttachments(cwd, task([]), deps(fetch).deps), null);
      assert.ok(!fs.existsSync(taskDir(cwd)));
    });
  });

  it("a task with no safe stem writes nothing", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch, calls } = fakeFetch({});
      const t = { id: "not-numeric", identifier: "../x", attachments: [attachment(1, "a", TXT)] };
      assert.equal(await downloadAttachments(cwd, t, deps(fetch).deps), null);
      assert.equal(calls.length, 0);
      assert.ok(!fs.existsSync(path.join(cwd, ".stride")));
    });
  });
});

describe("downloadAttachments — caps", () => {
  it("over-25 MiB, 21st-file and over-100 MiB entries are skipped with their reasons and never fetched", async () => {
    await withTmpDir(async (cwd) => {
      // Accepted entries answer 500 so the test never builds a large body; a
      // skipped entry must never be requested at all.
      const routes: Record<string, Served> = {};
      const big = (id: number, size: number) => {
        routes[url(id)] = { status: 500, body: new TextEncoder().encode("boom") };
        return { ...attachment(id, `f${id}.bin`, TXT), byte_size: size };
      };
      const list = [
        big(1, ATTACHMENT_FILE_BYTES + 1), // too_large
        big(2, ATTACHMENT_FILE_BYTES), // exactly 25 MiB: accepted (25)
        big(3, ATTACHMENT_FILE_BYTES), // accepted (50)
        big(4, ATTACHMENT_FILE_BYTES), // accepted (75)
        big(5, 20 * MIB), // accepted (95)
        big(6, ATTACHMENT_FILE_BYTES), // total_cap: 120 MiB would pass the cap
        big(7, 5 * MIB), // accepted: exactly 100 MiB, since the skip added nothing
        big(8, 1), // total_cap: one byte past 100 MiB
        { ...attachment(9, "neg.bin", TXT), byte_size: -1 }, // too_large
        { ...attachment(10, "frac.bin", TXT), byte_size: 1.5 }, // too_large
        { ...attachment(11, "str.bin", TXT), byte_size: "12" }, // too_large
        { ...attachment(12, "none.bin", TXT), byte_size: undefined }, // too_large
      ];
      const { fetch, calls } = fakeFetch(routes);
      await downloadAttachments(cwd, task(list), deps(fetch).deps);
      const m = readManifest(cwd);
      assert.deepEqual(
        m.attachments.map((e) => [e.id, e.status, e.reason]),
        [
          [1, "skipped", "too_large"],
          [2, "failed", "http_500"],
          [3, "failed", "http_500"],
          [4, "failed", "http_500"],
          [5, "failed", "http_500"],
          [6, "skipped", "total_cap"],
          [7, "failed", "http_500"],
          [8, "skipped", "total_cap"],
          [9, "skipped", "too_large"],
          [10, "skipped", "too_large"],
          [11, "skipped", "too_large"],
          [12, "skipped", "too_large"],
        ],
      );
      assert.deepEqual(
        calls.map((c) => c.url),
        [url(2), url(3), url(4), url(5), url(7)],
        "only accepted entries are requested",
      );
    });

    await withTmpDir(async (cwd) => {
      const routes: Record<string, Served> = {};
      const list = Array.from({ length: 21 }, (_, i) => {
        const bytes = new TextEncoder().encode(`file ${i}`);
        routes[url(i + 1)] = { body: bytes };
        return attachment(i + 1, `f${i + 1}.txt`, bytes);
      });
      const { fetch, calls } = fakeFetch(routes);
      const summary = await downloadAttachments(cwd, task(list), deps(fetch).deps);
      assert.deepEqual(summary, { stem: "W2532", downloaded: 20, skipped: 1, failed: 0 });
      const last = readManifest(cwd).attachments[20];
      assert.deepEqual([last.id, last.status, last.reason, last.local_file], [21, "skipped", "count_cap", null]);
      assert.equal(calls.length, 20);
      assert.ok(!calls.some((c) => c.url === url(21)), "the 21st file is never fetched");
    });
  });

  it("caps count accepted entries only, in server order (planAttachments)", () => {
    const entry = (id: number, size: number) => ({
      id,
      filename: "x",
      byte_size: size,
      sha256: "0".repeat(64),
      download_url: `/api/tasks/${TASK_ID}/attachments/${id}`,
    });
    // The contract's 60/60/30 MiB illustration cannot occur under the 25 MiB
    // per-file cap, so the same accepted-only rule is shown at 25 MiB sizes.
    const f = ATTACHMENT_FILE_BYTES;
    const reasons = planAttachments(
      [entry(1, f), entry(2, f), entry(3, f), entry(4, f), entry(5, 1), entry(6, 0)],
      String(TASK_ID),
    ).map((p) => p.entry.reason);
    assert.deepEqual(reasons, [null, null, null, null, "total_cap", null]);

    // A skipped entry adds nothing to the count: 20 accepted after a skip.
    const list = [{ ...entry(99, 1), id: "a b" }, ...Array.from({ length: 21 }, (_, i) => entry(i + 1, 1))];
    const planned = planAttachments(list, String(TASK_ID)).map((p) => p.entry.reason);
    assert.equal(planned[0], "unsafe_id");
    assert.equal(planned.filter((r) => r === null).length, 20);
    assert.equal(planned[21], "count_cap");
  });
});

describe("downloadAttachments — size and digest", () => {
  it("a body longer than byte_size or failing sha256 is removed and recorded failed", async () => {
    await withTmpDir(async (cwd) => {
      const long = new TextEncoder().encode("this body is longer than declared");
      const short = new TextEncoder().encode("ab");
      const list = [
        { ...attachment(1, "long.txt", TXT), byte_size: 5 },
        { ...attachment(2, "short.txt", TXT), byte_size: 10 },
        { ...attachment(3, "badsha.txt", TXT), sha256: sha(PDF) },
        { ...attachment(4, "malformed.txt", TXT), sha256: sha(TXT).toUpperCase() },
        { ...attachment(5, "nosha.txt", TXT), sha256: null },
        attachment(6, "good.txt", TXT),
      ];
      const { fetch } = fakeFetch({
        [url(1)]: { body: long },
        [url(2)]: { body: short },
        [url(3)]: { body: TXT },
        [url(4)]: { body: TXT },
        [url(5)]: { body: TXT },
        [url(6)]: { body: TXT },
      });
      const summary = await downloadAttachments(cwd, task(list), deps(fetch).deps);
      assert.deepEqual(summary, { stem: "W2532", downloaded: 1, skipped: 0, failed: 5 });
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => [e.id, e.status, e.reason, e.local_file]),
        [
          [1, "failed", "size_mismatch", null],
          [2, "failed", "size_mismatch", null],
          [3, "failed", "sha256_mismatch", null],
          [4, "failed", "sha256_mismatch", null],
          [5, "failed", "sha256_mismatch", null],
          [6, "downloaded", null, "6-good.txt"],
        ],
      );
      assert.deepEqual(fs.readdirSync(taskDir(cwd)).sort(), ["6-good.txt", "manifest.json"]);
    });
  });
});

describe("downloadAttachments — unsafe input", () => {
  it("unsafe filenames are sanitised; unsafe ids and download_url values are refused without a fetch", async () => {
    const long = "a".repeat(150);
    const cases: Array<[unknown, string]> = [
      ["screenshot.png", "screenshot.png"],
      ["../../etc/passwd", "passwd"],
      ["C:\\temp\\.env", "env"],
      ["..", "attachment"],
      [".env", "env"],
      ["", "attachment"],
      [null, "attachment"],
      ["dir/", "attachment"],
      ["résumé final.pdf", "r_sum__final.pdf"],
      ["café résumé.pdf", "caf__r_sum_.pdf"],
      ["shot 😀.png", "shot__.png"],
      ["line\nbreak.txt", "line_break.txt"],
      ["nul\u0000byte.txt", "nul_byte.txt"],
      [`${long}.png`, `${"a".repeat(96)}.png`],
      [long, "a".repeat(100)],
      [`${long}.${"e".repeat(16)}`, "a".repeat(100)],
      [`${long}.${"e".repeat(15)}`, `${"a".repeat(84)}.${"e".repeat(15)}`],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitiseAttachmentName(input), expected, `sanitise ${JSON.stringify(input)}`);
    }
    for (const [, expected] of cases) assert.ok(expected.length <= 100);

    assert.equal(attachmentIdString(812), "812");
    assert.equal(attachmentIdString("abc-123"), "abc-123");
    for (const bad of ["../x", "a b", "", "x\n", -1, 1.5, 1e21, null, true, {}]) {
      assert.equal(attachmentIdString(bad), null, `id ${JSON.stringify(bad)}`);
    }

    const tid = String(TASK_ID);
    assert.equal(safeDownloadPath(`/api/tasks/${tid}/attachments/1`, tid), `/api/tasks/${tid}/attachments/1`);
    for (const bad of [
      "https://evil.example/x",
      "//evil.example/api/x",
      "/api/../x",
      "/api/tasks/1?x=y",
      `/api/tasks/${tid}/attachments/1?x=y`,
      `/api/tasks/${tid}/attachments/1#frag`,
      `/api/tasks/${tid}/attachments/%2e%2e`,
      `/api/tasks/${tid}/attachments/1\n`,
      `/api/tasks/${tid}//attachments/1`,
      `/api/tasks/${tid}/attachments/1/../2`,
      `/api/tasks/9999/attachments/1`,
      `${API}/api/tasks/${tid}/attachments/1`,
      42,
    ]) {
      assert.equal(safeDownloadPath(bad, tid), null, `url ${JSON.stringify(bad)}`);
    }
    assert.equal(safeDownloadPath(`/api/tasks/${tid}/attachments/1`, null), null);

    await withTmpDir(async (cwd) => {
      const list = [
        { ...attachment(1, "../../etc/passwd", TXT) },
        { ...attachment(2, "a", TXT), id: "../x" },
        { ...attachment(3, "a", TXT), id: "a b" },
        { ...attachment(4, "a", TXT), download_url: "https://evil.example/x" },
        { ...attachment(5, "a", TXT), download_url: "//evil.example/api/x" },
        { ...attachment(6, "a", TXT), download_url: "/api/../x" },
        { ...attachment(7, "a", TXT), download_url: "/api/tasks/1?x=y" },
        attachment(8, "same.txt", TXT),
        attachment(9, "same.txt", TXT),
        "not-an-object",
      ];
      const { fetch, calls } = fakeFetch({
        [url(1)]: { body: TXT },
        [url(8)]: { body: TXT },
        [url(9)]: { body: TXT },
      });
      await downloadAttachments(cwd, task(list), deps(fetch).deps);
      const m = readManifest(cwd);
      assert.deepEqual(
        m.attachments.map((e) => [e.status, e.reason, e.local_file, e.download_path]),
        [
          ["downloaded", null, "1-passwd", `/api/tasks/${TASK_ID}/attachments/1`],
          ["skipped", "unsafe_id", null, `/api/tasks/${TASK_ID}/attachments/2`],
          ["skipped", "unsafe_id", null, `/api/tasks/${TASK_ID}/attachments/3`],
          ["skipped", "unsafe_url", null, null],
          ["skipped", "unsafe_url", null, null],
          ["skipped", "unsafe_url", null, null],
          ["skipped", "unsafe_url", null, null],
          ["downloaded", null, "8-same.txt", `/api/tasks/${TASK_ID}/attachments/8`],
          ["downloaded", null, "9-same.txt", `/api/tasks/${TASK_ID}/attachments/9`],
          ["skipped", "unsafe_id", null, null],
        ],
      );
      assert.equal(m.attachments[0].filename, "../../etc/passwd", "the original filename is kept as data");
      assert.deepEqual(
        calls.map((c) => c.url),
        [url(1), url(8), url(9)],
        "refused entries make no request",
      );
      assert.ok(!fs.existsSync(path.join(cwd, "etc")), "nothing escapes the task directory");
    });
  });
});

describe("downloadAttachments — errors", () => {
  it("a 500 for one attachment records http_500 and the rest still download; nothing throws", async () => {
    await withTmpDir(async (cwd) => {
      const list = [
        attachment(1, "a.txt", TXT),
        attachment(2, "b.txt", TXT),
        attachment(3, "c.txt", TXT),
        attachment(4, "d.txt", TXT),
        attachment(5, "e.txt", TXT),
      ];
      const { fetch } = fakeFetch({
        [url(1)]: { body: TXT },
        [url(2)]: { status: 500, body: new TextEncoder().encode("x".repeat(500)) },
        [url(3)]: async () => {
          throw new TypeError("fetch failed");
        },
        [url(4)]: { status: 429, headers: { "retry-after": "30" } },
        [url(5)]: { body: TXT },
      });
      const { deps: d, lines } = deps(fetch);
      const summary = await downloadAttachments(cwd, task(list), d);
      assert.deepEqual(summary, { stem: "W2532", downloaded: 2, skipped: 0, failed: 3 });
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
        [
          ["downloaded", null],
          ["failed", "http_500"],
          ["failed", "transport"],
          ["failed", "http_429"],
          ["downloaded", null],
        ],
      );
      assert.deepEqual(lines, ["stride: attachments W2532: 2 downloaded, 0 skipped, 3 failed\n"]);
    });
  });

  it("a body stream that errors part-way records transport and leaves no partial file", async () => {
    await withTmpDir(async (cwd) => {
      const broken = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(TXT.slice(0, 4));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        );
      const { fetch } = fakeFetch({ [url(1)]: broken, [url(2)]: { body: TXT } });
      await downloadAttachments(cwd, task([attachment(1, "a.txt", TXT), attachment(2, "b.txt", TXT)]), deps(fetch).deps);
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
        [
          ["failed", "transport"],
          ["downloaded", null],
        ],
      );
      assert.deepEqual(fs.readdirSync(taskDir(cwd)).sort(), ["2-b.txt", "manifest.json"]);
    });
  });

  it("no usable API URL or token fetches nothing and records transport", async () => {
    for (const auth of [
      { apiBase: "", token: FAKE_TOKEN },
      { apiBase: API, token: "" },
    ]) {
      await withTmpDir(async (cwd) => {
        const { fetch, calls } = fakeFetch({});
        await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), deps(fetch, { readAuth: () => auth }).deps);
        assert.equal(calls.length, 0);
        assert.deepEqual(
          readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
          [["failed", "transport"]],
        );
      });
    }
  });

  it("a fetch that throws synchronously or a readAuth that throws never escapes", async () => {
    await withTmpDir(async (cwd) => {
      const throwing = (() => {
        throw new Error("sync boom");
      }) as unknown as AttachmentDeps["fetch"];
      const r1 = await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), deps(throwing).deps);
      assert.equal(r1?.failed, 1);
      const r2 = await downloadAttachments(
        cwd,
        task([attachment(1, "a", TXT)]),
        deps(fakeFetch({}).fetch, {
          readAuth: () => {
            throw new Error("auth boom");
          },
        }).deps,
      );
      assert.equal(r2?.failed, 1);
    });
  });

  it("the wall-clock budget skips entries not started and fails one cut off mid-request", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
      const summary = await downloadAttachments(
        cwd,
        task([attachment(1, "a", TXT), attachment(2, "b", TXT)]),
        deps(fetch, { budgetSeconds: 0 }).deps,
      );
      assert.deepEqual(summary, { stem: "W2532", downloaded: 0, skipped: 2, failed: 0 });
      assert.equal(calls.length, 0);
      const m = readManifest(cwd);
      assert.equal(m.caps.budget_seconds, 0);
      assert.deepEqual(m.attachments.map((e) => e.reason), ["time_budget", "time_budget"]);
    });

    await withTmpDir(async (cwd) => {
      // The first clock read fixes the deadline; later reads leave 50 ms, so
      // the hanging request is cut off by its own signal and the next entry
      // finds the budget spent.
      let reads = 0;
      const start = 1_000_000;
      const now = () => (reads++ === 0 ? start : reads <= 2 ? start + 119_950 : start + 120_000);
      const hang = async (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      const summary = await downloadAttachments(
        cwd,
        task([attachment(1, "a", TXT), attachment(2, "b", TXT)]),
        deps(hang, { now }).deps,
      );
      assert.deepEqual(summary, { stem: "W2532", downloaded: 0, skipped: 1, failed: 1 });
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
        [
          ["failed", "time_budget"],
          ["skipped", "time_budget"],
        ],
      );
    });
  });

  it("a budget larger than 120 s is ignored", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch } = fakeFetch({ [url(1)]: { body: TXT } });
      await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), deps(fetch, { budgetSeconds: 900 }).deps);
      assert.equal(readManifest(cwd).caps.budget_seconds, 120);
    });
  });
});

describe("downloadAttachments — requests", () => {
  it("a cross-origin redirect is not followed, so no Authorization crosses origins, and requests carry a curl-like User-Agent", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch, calls } = fakeFetch({
        [url(1)]: { status: 302, headers: { Location: "https://evil.example/steal" } },
        [url(2)]: { body: TXT },
      });
      await downloadAttachments(
        cwd,
        task([attachment(1, "a", TXT), attachment(2, "b", TXT)]),
        deps(fetch).deps,
      );
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
        [
          ["failed", "http_302"],
          ["downloaded", null],
        ],
      );
      assert.deepEqual(
        calls.map((c) => c.url),
        [url(1), url(2)],
        "only the configured origin is ever requested; the Location is never fetched",
      );
      for (const call of calls) {
        assert.ok(call.url.startsWith(`${API}/`));
        assert.equal(call.init?.redirect, "manual");
        assert.equal(call.init?.method, "GET");
        const headers = new Headers(call.init?.headers);
        assert.match(headers.get("user-agent") ?? "", /^curl\//);
        assert.equal(headers.get("user-agent"), ATTACHMENT_USER_AGENT);
        assert.equal(headers.get("authorization"), `Bearer ${FAKE_TOKEN}`);
        assert.ok(call.init?.signal instanceof AbortSignal, "each request has a time limit");
      }
    });
  });

  it("with Node's real fetch, a 302 to another origin is recorded http_302 and that origin receives nothing", async () => {
    // Two loopback servers on different ports are two origins. A answers 302
    // to B; B must never see a request, so no Authorization can reach it.
    const seenByA: http.IncomingHttpHeaders[] = [];
    let hitsOnB = 0;
    const b = http.createServer((_req, res) => {
      hitsOnB += 1;
      res.end("stolen");
    });
    const listen = (server: http.Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
      );
    const portB = await listen(b);
    const a = http.createServer((req, res) => {
      seenByA.push(req.headers);
      res.writeHead(302, { Location: `http://127.0.0.1:${portB}/steal` });
      res.end();
    });
    const portA = await listen(a);
    try {
      await withTmpDir(async (cwd) => {
        await downloadAttachments(cwd, task([attachment(1, "a.txt", TXT)]), {
          fetch: globalThis.fetch,
          readAuth: () => ({ apiBase: `http://127.0.0.1:${portA}`, token: FAKE_TOKEN }),
          stderr: () => {},
        });
        assert.deepEqual(
          readManifest(cwd).attachments.map((e) => [e.status, e.reason]),
          [["failed", "http_302"]],
        );
      });
      assert.equal(hitsOnB, 0, "the redirect target is never requested");
      assert.equal(seenByA.length, 1);
      assert.equal(seenByA[0]["user-agent"], ATTACHMENT_USER_AGENT, "Node's default User-Agent is replaced");
      assert.equal(seenByA[0].authorization, `Bearer ${FAKE_TOKEN}`);
    } finally {
      await new Promise((resolve) => a.close(resolve));
      await new Promise((resolve) => b.close(resolve));
    }
  });
});

describe("downloadAttachments — directories", () => {
  it("a symlinked attachments directory is refused; a re-claim replaces the directory", async () => {
    for (const link of [".stride", ".stride/attachments", ".stride/attachments/W2532"]) {
      await withTmpDir(async (cwd) => {
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-elsewhere-"));
        try {
          fs.mkdirSync(path.dirname(path.join(cwd, link)), { recursive: true });
          fs.symlinkSync(elsewhere, path.join(cwd, link), "dir");
          const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
          const { deps: d, lines } = deps(fetch);
          assert.equal(await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), d), null);
          assert.equal(calls.length, 0, `${link}: no request`);
          assert.deepEqual(fs.readdirSync(elsewhere), [], `${link}: nothing written through the link`);
          assert.equal(lines.length, 1);
          assert.match(lines[0], /symlink or not a directory; nothing written/);
        } finally {
          fs.rmSync(elsewhere, { recursive: true, force: true });
        }
      });
    }

    for (const blocker of [".stride/attachments", ".stride/attachments/W2532"]) {
      await withTmpDir(async (cwd) => {
        // A regular file where a directory belongs is refused too.
        fs.mkdirSync(path.dirname(path.join(cwd, blocker)), { recursive: true });
        fs.writeFileSync(path.join(cwd, blocker), "not a dir");
        const { fetch, calls } = fakeFetch({});
        assert.equal(await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), deps(fetch).deps), null);
        assert.equal(calls.length, 0, `${blocker}: no request`);
        assert.equal(fs.readFileSync(path.join(cwd, blocker), "utf-8"), "not a dir");
      });
    }

    await withTmpDir(async (cwd) => {
      // A directory where .gitignore belongs refuses the run before any request.
      fs.mkdirSync(path.join(cwd, ".stride", "attachments", ".gitignore"), { recursive: true });
      const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
      const { deps: d, lines } = deps(fetch);
      assert.equal(await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), d), null);
      assert.equal(calls.length, 0);
      assert.match(lines[0] ?? "", /\.gitignore is not a regular file/);
      assert.ok(!fs.existsSync(taskDir(cwd)));
    });

    await withTmpDir(async (cwd) => {
      const { fetch } = fakeFetch({ [url(1)]: { body: TXT }, [url(2)]: { body: PDF } });
      await downloadAttachments(cwd, task([attachment(1, "first.txt", TXT)]), deps(fetch).deps);
      assert.ok(fs.existsSync(path.join(taskDir(cwd), "1-first.txt")));
      await downloadAttachments(cwd, task([attachment(2, "second.pdf", PDF)]), deps(fetch).deps);
      assert.deepEqual(fs.readdirSync(taskDir(cwd)).sort(), ["2-second.pdf", "manifest.json"]);
      assert.deepEqual(
        readManifest(cwd).attachments.map((e) => e.id),
        [2],
      );
    });

    await withTmpDir(async (cwd) => {
      // A symlinked .gitignore is replaced, never written through.
      const target = path.join(cwd, "outside.txt");
      fs.writeFileSync(target, "keep");
      fs.mkdirSync(path.join(cwd, ".stride", "attachments"), { recursive: true });
      fs.symlinkSync(target, path.join(cwd, ".stride", "attachments", ".gitignore"));
      const { fetch } = fakeFetch({ [url(1)]: { body: TXT } });
      await downloadAttachments(cwd, task([attachment(1, "a", TXT)]), deps(fetch).deps);
      assert.equal(fs.readFileSync(target, "utf-8"), "keep");
      const gi = path.join(cwd, ".stride", "attachments", ".gitignore");
      assert.ok(!fs.lstatSync(gi).isSymbolicLink());
      assert.equal(fs.readFileSync(gi, "utf-8"), "*\n");
    });
  });
});

describe("downloadAttachments — the token", () => {
  it("the token appears in no written file and no console output", async () => {
    await withTmpDir(async (cwd) => {
      // The default readAuth path, from a fixture .stride_auth.md.
      fs.writeFileSync(
        path.join(cwd, ".stride_auth.md"),
        `- **API URL:** \`${API}\`\n- **API Token:** \`${FAKE_TOKEN}\`\n`,
      );
      const { fetch } = fakeFetch({
        [url(1)]: { body: TXT },
        [url(2)]: { status: 403, body: new TextEncoder().encode(`{"error":"${FAKE_TOKEN}"}`) },
        [url(3)]: async () => {
          throw new Error(`transport failure mentioning ${FAKE_TOKEN}`);
        },
      });
      const captured: string[] = [];
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      const origLog = console.log;
      const origError = console.error;
      const capture = (chunk: unknown): boolean => {
        captured.push(String(chunk));
        return true;
      };
      process.stdout.write = capture as typeof process.stdout.write;
      process.stderr.write = capture as typeof process.stderr.write;
      console.log = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
      console.error = (...args: unknown[]) => void captured.push(args.map(String).join(" "));
      try {
        await downloadAttachments(
          cwd,
          task([attachment(1, "a.txt", TXT), attachment(2, "b.txt", TXT), attachment(3, "c.txt", TXT)]),
          { fetch },
        );
      } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        console.log = origLog;
        console.error = origError;
      }
      assert.ok(captured.length > 0, "the summary line was emitted");
      assert.ok(captured.every((c) => !c.includes(FAKE_TOKEN)), "no output carries the token");
      assert.ok(
        captured.some((c) => c === "stride: attachments W2532: 1 downloaded, 0 skipped, 2 failed\n"),
        "the one summary line goes to stderr",
      );

      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          return e.isDirectory() ? walk(p) : [p];
        });
      const written = walk(cwd).filter((p) => path.basename(p) !== ".stride_auth.md");
      assert.ok(written.length >= 3);
      for (const file of written) {
        assert.ok(!fs.readFileSync(file, "utf-8").includes(FAKE_TOKEN), `${file} carries no token`);
      }
    });
  });
});

describe("downloadClaimAttachments — identity proof", () => {
  const claim = (data: unknown) => JSON.stringify({ data, hook: { name: "before_doing" } });

  it("a proven claim downloads; truncated, failed or id-less claims download nothing", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
      const content = claim(task([attachment(1, "a.txt", TXT)]));
      const summary = await downloadClaimAttachments(cwd, content, undefined, deps(fetch).deps);
      assert.equal(summary?.downloaded, 1);
      assert.equal(calls.length, 1);
    });

    const unproven: unknown[] = [
      claim(task([attachment(1, "a.txt", TXT)])).slice(0, 60), // truncated stdout
      JSON.stringify({ error: "Task not available" }), // a 4xx body
      JSON.stringify({ id: TASK_ID, identifier: "W2532", attachments: [attachment(1, "a", TXT)] }), // bare root
      claim({ identifier: "W2532", attachments: [attachment(1, "a", TXT)] }), // no id
      claim({ id: TASK_ID, attachments: [attachment(1, "a", TXT)] }), // no identifier
      claim({ id: "x7", identifier: "W2532", attachments: [attachment(1, "a", TXT)] }), // non-numeric id
      claim({ id: TASK_ID, identifier: "../W", attachments: [attachment(1, "a", TXT)] }), // unsafe identifier
      "",
      undefined,
    ];
    for (const content of unproven) {
      await withTmpDir(async (cwd) => {
        const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
        assert.equal(await downloadClaimAttachments(cwd, content, undefined, deps(fetch).deps), null);
        assert.equal(calls.length, 0);
        assert.ok(!fs.existsSync(path.join(cwd, ".stride")));
      });
    }
  });

  it("reads details.output before content, and the {stdout} wrapper", async () => {
    await withTmpDir(async (cwd) => {
      const { fetch, calls } = fakeFetch({ [url(1)]: { body: TXT } });
      const wrapped = JSON.stringify({ stdout: claim(task([attachment(1, "a.txt", TXT)])) });
      const summary = await downloadClaimAttachments(cwd, "garbage", { output: wrapped }, deps(fetch).deps);
      assert.equal(summary?.downloaded, 1);
      assert.equal(calls.length, 1);
    });
  });
});
