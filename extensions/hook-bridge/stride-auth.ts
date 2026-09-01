/**
 * (W2151) Reader for `.stride_auth.md`, the TypeScript twin of
 * stride-hook.sh's resolve_stride_api_url / resolve_stride_api_token.
 *
 * The bash resolvers also lift credentials out of the intercepted curl
 * `$COMMAND` when the file yields nothing. That fallback has no analogue here:
 * `before_agent_start` fires before any tool call, so there is no command
 * string to read. File only.
 *
 * There is likewise no `STRIDE_API_URL` / `STRIDE_API_TOKEN` environment
 * fallback. The bash resolvers do not read those either, and adding an
 * environment path would widen the credential surface for no established need.
 * An unresolvable credential is a silent no-op, which is the safe direction.
 *
 * SECURITY CONTRACT. The token this module returns has exactly ONE permitted
 * destination: the value of an `Authorization: Bearer` header. It must never be
 * logged, written to disk, placed in an injected message, embedded in an Error,
 * or included in any diagnostic. This module therefore contains no logging of
 * any kind, and every failure is a return of empty strings rather than a throw
 * — a thrown exception is a string that travels.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const STRIDE_AUTH_FILE = ".stride_auth.md";

export interface StrideAuth {
  apiBase: string;
  token: string;
}

const API_URL_LABEL = "**API URL:**";

/**
 * A LITERAL substring test, never a regex. The file may also carry a
 * `**Local API Token:**` line, and the production token is the one the fleet
 * uses. `**API Token:**` does not occur inside `**Local API Token:**` — the
 * `**` must be immediately followed by `API` — so the literal selects
 * correctly regardless of which line comes first. Loosening this to
 * `/API Token:/` would silently select the local token instead.
 */
const API_TOKEN_LABEL = "**API Token:**";

const URL_RE = /https?:\/\/[A-Za-z0-9._:/@-]+/;
const BACKTICKED_RE = /`([^`]+)`/;

/**
 * Loopback hosts, the only ones allowed to carry the token over plaintext http.
 * A developer pointing at a local Stride keeps working; a plaintext URL to
 * anywhere else does not, because that would put a bearer token on the wire.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Re-parse the regex match with a real URL parser and return its origin, or ""
 * if it is not a destination this module will send a token to.
 *
 * This is a DELIBERATE divergence from the shell resolver in
 * stride-hook.sh, which does the regex match and stops. Two properties of the
 * bare match make it unsafe as a token destination:
 *
 *  - **Userinfo truncation.** The original charset excluded `@`, so
 *    `https://evil.example@www.stridelikeaboss.com` matched only
 *    `https://evil.example` and the token went to the attacker's host — a
 *    different host than any conformant URL parser would resolve. `@` is now IN
 *    the charset so the whole thing is captured, and userinfo is then rejected
 *    outright rather than silently reinterpreted.
 *  - **Cleartext.** `http://` to a non-loopback host puts a bearer token on the
 *    wire in the clear.
 *
 * Both require write access to the local, gitignored `.stride_auth.md`, which
 * is already a high-privilege position — this is hardening, not a live exploit.
 * The shell twin has the same two properties and has NOT been tightened here;
 * that is a separate change to a separate file.
 */
function safeApiOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.username !== "" || url.password !== "") return "";
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return "";
}

/**
 * Resolve the API base and token from `<cwd>/.stride_auth.md`. Returns empty
 * strings for anything it cannot resolve; the caller treats an empty value as
 * "no credentials" and makes no network call. Never throws.
 */
export function readStrideAuth(cwd: string): StrideAuth {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, STRIDE_AUTH_FILE), "utf8");
  } catch {
    return { apiBase: "", token: "" };
  }
  let apiBase = "";
  let token = "";
  for (const line of text.split("\n")) {
    // First match wins on each, mirroring the shell's `head -n 1`.
    if (!apiBase && line.includes(API_URL_LABEL)) {
      const matched = URL_RE.exec(line)?.[0] ?? "";
      // A rejected URL yields "", which the caller reads as "no credentials"
      // and makes no request — the existing silent no-op, which is the safe
      // direction.
      apiBase = matched ? safeApiOrigin(matched) : "";
    }
    if (!token && line.includes(API_TOKEN_LABEL)) {
      token = BACKTICKED_RE.exec(line)?.[1] ?? "";
    }
    if (apiBase && token) break;
  }
  return { apiBase, token };
}
