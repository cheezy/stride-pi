import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { STRIDE_AUTH_FILE, readStrideAuth } from "./stride-auth.ts";

// Every credential in this file is a fake, in-test literal. Nothing here is a
// real token, and no fixture is read from the developer's own .stride_auth.md.
const FAKE_PROD = "tok-fixture-production-not-a-credential";
const FAKE_LOCAL = "tok-fixture-local-not-a-credential";

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stride-pi-auth-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeAuth(dir: string, body: string): void {
  fs.writeFileSync(path.join(dir, STRIDE_AUTH_FILE), body);
}

describe("readStrideAuth", () => {
  it("selects the production token even though the local one comes first", () => {
    withTmp((dir) => {
      // Ordered exactly like the real file: Local BEFORE the production line.
      writeAuth(
        dir,
        [
          "# Stride API Authentication",
          "",
          "- **API URL:** `https://stride.test`",
          "- **Local API Token:** `" + FAKE_LOCAL + "`",
          "- **API Token:** `" + FAKE_PROD + "`",
          "- **Token Name:** Fixture",
          "",
        ].join("\n"),
      );
      const auth = readStrideAuth(dir);
      assert.equal(auth.apiBase, "https://stride.test");
      assert.equal(auth.token, FAKE_PROD);
      assert.notEqual(auth.token, FAKE_LOCAL);
    });
  });

  it("still selects the production token when it comes first", () => {
    withTmp((dir) => {
      writeAuth(
        dir,
        [
          "- **API URL:** `https://stride.test`",
          "- **API Token:** `" + FAKE_PROD + "`",
          "- **Local API Token:** `" + FAKE_LOCAL + "`",
        ].join("\n"),
      );
      assert.equal(readStrideAuth(dir).token, FAKE_PROD);
    });
  });

  it("returns empty strings when the file is absent", () => {
    withTmp((dir) => {
      assert.deepEqual(readStrideAuth(dir), { apiBase: "", token: "" });
    });
  });

  it("returns empty strings when the path is a directory", () => {
    withTmp((dir) => {
      fs.mkdirSync(path.join(dir, STRIDE_AUTH_FILE), { recursive: true });
      assert.deepEqual(readStrideAuth(dir), { apiBase: "", token: "" });
    });
  });

  it("takes the first URL when a line carries two", () => {
    withTmp((dir) => {
      writeAuth(dir, "- **API URL:** `https://first.test` (was https://second.test)");
      assert.equal(readStrideAuth(dir).apiBase, "https://first.test");
    });
  });

  it("yields an empty token when the label carries no backticked span", () => {
    withTmp((dir) => {
      writeAuth(dir, "- **API URL:** `https://stride.test`\n- **API Token:** none yet");
      const auth = readStrideAuth(dir);
      assert.equal(auth.apiBase, "https://stride.test");
      assert.equal(auth.token, "");
    });
  });

  it("yields an empty apiBase when the label carries no URL", () => {
    withTmp((dir) => {
      writeAuth(dir, "- **API URL:** to be decided\n- **API Token:** `" + FAKE_PROD + "`");
      const auth = readStrideAuth(dir);
      assert.equal(auth.apiBase, "");
      assert.equal(auth.token, FAKE_PROD);
    });
  });

  it("refuses a URL carrying userinfo, which would send the token elsewhere", () => {
    withTmp((dir) => {
      // The `@` form is the sharp one: with `@` outside the charset the regex
      // matched only `https://evil.example` and the token went there. Now the
      // whole value is captured and the userinfo is refused outright.
      writeAuth(
        dir,
        "- **API URL:** `https://evil.example@www.stridelikeaboss.com`\n" +
          "- **API Token:** `" + FAKE_PROD + "`",
      );
      const auth = readStrideAuth(dir);
      assert.equal(auth.apiBase, "");
      assert.equal(auth.apiBase.includes("evil.example"), false);
      // The token is still read, but with no apiBase the caller makes no request.
      assert.equal(auth.token, FAKE_PROD);
    });
  });

  it("refuses plaintext http to a non-loopback host", () => {
    withTmp((dir) => {
      writeAuth(dir, "- **API URL:** `http://www.stridelikeaboss.com`");
      assert.equal(readStrideAuth(dir).apiBase, "");
    });
  });

  it("allows plaintext http to loopback, so local development still works", () => {
    for (const host of ["localhost:4000", "127.0.0.1:4000"]) {
      withTmp((dir) => {
        writeAuth(dir, "- **API URL:** `http://" + host + "`");
        assert.equal(readStrideAuth(dir).apiBase, "http://" + host);
      });
    }
  });

  it("normalises to the origin and accepts ordinary https", () => {
    withTmp((dir) => {
      writeAuth(dir, "- **API URL:** `https://www.stridelikeaboss.com/api/v1`");
      assert.equal(readStrideAuth(dir).apiBase, "https://www.stridelikeaboss.com");
    });
  });

  it("returns only the local token's absence, never the local token itself", () => {
    withTmp((dir) => {
      // The production label is missing entirely; the local one must NOT stand in.
      writeAuth(
        dir,
        "- **API URL:** `https://stride.test`\n- **Local API Token:** `" + FAKE_LOCAL + "`",
      );
      assert.equal(readStrideAuth(dir).token, "");
    });
  });
});
