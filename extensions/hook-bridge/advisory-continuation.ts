/**
 * (W2151) Advisory loop continuation for the Pi port.
 *
 * **This is NOT a gate, and the distinction is structural rather than a matter
 * of degree.** Stride's Claude Code plugin refuses to end a session while a
 * claimable task remains: `stride-stop-gate.sh` exits 2 from a `Stop` hook and
 * the harness honours the refusal. Pi has no such surface — `turn_end` and
 * `agent_end` register with no result type at all, so a handler on either is
 * structurally incapable of returning a refusal; whatever it computes is
 * discarded. `before_agent_start` does take a result, but it fires at the head
 * of the NEXT turn. By the time this module can speak, the turn that should
 * have claimed the next task is already over, and if the human never prompts
 * again it never speaks at all.
 *
 * So this advises; it does not enforce. See the ADR-002 addendum.
 *
 * The decision logic lives here rather than in index.ts because index.ts
 * imports the Pi runtime and cannot load under `node --test`. Keeping this
 * module Pi-free — and taking `fetch` as a parameter rather than reaching for
 * the global — is what makes "the API is never called from a test" true by
 * construction rather than by discipline: a test can only ever call the stub
 * it passes in.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { FetchFn } from "./after-goal-status.js";
import { LOOP_STATE_FILE, loopStateSafe, readLoopState } from "./loop-state.ts";
import { readStrideAuth, type StrideAuth } from "./stride-auth.ts";

/**
 * Deliberately NOT the shell gate's `.stride/.stop-gate-blocks`. The two
 * mechanisms are independent and can run over the same checkout — the
 * loop-state record is an explicit fleet contract shared with
 * stride-stop-gate.sh — so a shared counter would let a refused stop in one
 * runtime silently spend the other's budget, with no way for either to tell
 * why. They also count different events, and may want different budgets.
 */
export const ADVISORY_COUNTER_FILE = ".stride/.pi-advisory-continuations";

/** One injection is the intended path; two leaves a benign extra. */
export const ADVISORY_MAX_INJECTIONS = 2;

export const ADVISORY_CUSTOM_TYPE = "stride-advisory-continuation";

/** The fetch bound sits in front of the user's turn, so keep it short. */
export const ADVISORY_TIMEOUT_MS = 5_000;

/**
 * A closed vocabulary of skip reasons. Closed on purpose: these values are the
 * only thing this module reports about a refusal, and a union of string
 * literals cannot interpolate a token, a URL, or a response body by
 * construction.
 */
export type AdvisorySkipReason =
  | "no_loop_state"
  | "malformed_loop_state"
  | "needs_review"
  | "foreign_session"
  | "budget_spent"
  | "no_credentials"
  | "api_unreachable"
  | "api_non_200"
  | "api_body_unusable"
  | "identifier_not_shaped"
  | "counter_write_failed";

export type AdvisoryDecision =
  | { inject: false; reason: AdvisorySkipReason }
  | { inject: true; identifier: string; text: string; injectionCount: number };

/**
 * The one server-supplied string that reaches an injected prompt, and so the
 * one that gets the stricter guard.
 *
 * `loopStateSafe` is the fleet's STORAGE charset: it admits `.` and `:` and
 * runs to 64 characters, which is right for a filename field and too loose for
 * a value quoted into text a model will read. Real identifiers are `W2151`,
 * `G69`, `D226`.
 *
 * Anything else is REFUSED, never sanitised. A scrubbed value is still an
 * attacker-chosen value, and the caller drops the whole injection rather than
 * emitting a cleaned-up one.
 */
export function advisoryIdentifierShaped(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

/**
 * The injection budget, honouring `STRIDE_PI_ADVISORY_MAX`.
 *
 * The all-digit validation matters more than it looks. `Number("off")` is
 * `NaN`, and `count + 1 > NaN` is `false` — so an unvalidated override would
 * make the budget test pass forever and the advisory UNBOUNDED, reached by
 * someone trying to turn it off. The nine-digit bound also keeps every
 * accepted value inside the safe integer range.
 */
export function advisoryMaxInjections(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STRIDE_PI_ADVISORY_MAX;
  if (typeof raw === "string" && /^[0-9]{1,9}$/.test(raw)) return Number(raw);
  return ADVISORY_MAX_INJECTIONS;
}

/**
 * How many advisories this port has already injected for `key`. A missing,
 * unreadable, foreign-keyed, or malformed counter all read as a fresh 0 —
 * corruption reads as "start again", never as an error.
 */
export function readInjectionCount(cwd: string, key: string): number {
  let line: string;
  try {
    line = fs.readFileSync(path.join(cwd, ADVISORY_COUNTER_FILE), "utf8");
  } catch {
    return 0;
  }
  const [storedKey, storedCount] = line.trim().split(/\s+/);
  if (storedKey !== key) return 0;
  if (!/^[0-9]{1,9}$/.test(storedCount ?? "")) return 0;
  return Number(storedCount);
}

/** Persist the new count. False when it could not be written. */
export function recordInjection(cwd: string, key: string, count: number): boolean {
  const dest = path.join(cwd, ADVISORY_COUNTER_FILE);
  try {
    // The same guard writeLoopState uses, for the same reason: `mode` is
    // ignored when the file already exists, and writeFileSync follows a
    // symlink, so a pre-existing non-regular destination would be followed and
    // its target overwritten. Refuse instead.
    if (fs.existsSync(dest) && !fs.statSync(dest).isFile()) return false;
    // Derived, not a second literal: a move of ADVISORY_COUNTER_FILE must take
    // the directory with it.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      `${key} ${count}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Best-effort unlink. Called only where the loop state itself is gone or moot. */
export function resetInjectionCounter(cwd: string): void {
  try {
    fs.rmSync(path.join(cwd, ADVISORY_COUNTER_FILE), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Same session, exactly. `unknown` is a sentinel meaning "identity could not be
 * established" — the writer's fallback when the session id was absent or
 * unsafe — and it is never an identity: every session that ever wrote it
 * produces the same value, so honouring it would mean honouring a record from
 * an arbitrary earlier session, which is the stale-injection pitfall itself.
 *
 * The shell gate's 900-second window for `unknown` is deliberately NOT copied.
 * That approximation exists because the bash side sometimes cannot learn the
 * current session id at all; Pi always supplies a real one through
 * `ctx.sessionManager.getSessionId()`, so no time window is defensible here.
 * The cost of refusing is one missed advisory; the cost of accepting is an
 * injection naming stale work in a fresh session.
 */
function sameSession(recordSessionId: string, currentSessionId: string): boolean {
  if (!loopStateSafe(recordSessionId) || recordSessionId === "unknown") return false;
  if (!loopStateSafe(currentSessionId) || currentSessionId === "unknown") return false;
  return recordSessionId === currentSessionId;
}

/** The injected text. Takes the identifier and the budget — the token is not in scope. */
export function advisoryMessageText(identifier: string, max: number): string {
  return (
    `Stride: the last completed task recorded no review requirement, and ${identifier} ` +
    `is claimable now. Claim it with the stride-workflow skill before doing anything else. ` +
    `This is advice, not a gate — it is injected at the start of this turn and cannot ` +
    `prevent a session ending. It will be repeated at most ${max} time(s) for one ` +
    `unfollowed completion.`
  );
}

/**
 * Ask the API for the next claimable task. The token reaches exactly one place:
 * the `Authorization` header. No branch here reports it, and no branch throws.
 */
export async function nextClaimableIdentifier(opts: {
  fetch: FetchFn;
  apiBase: string;
  token: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; identifier: string }
  | {
      ok: false;
      reason:
        | "api_unreachable"
        | "api_non_200"
        | "api_body_unusable"
        | "identifier_not_shaped";
    }
> {
  const { fetch, apiBase, token, signal } = opts;
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/tasks/next`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal,
    });
  } catch {
    return { ok: false, reason: "api_unreachable" };
  }
  // An empty Ready queue answers 404, which is a normal outcome, not an error.
  if (!response.ok) return { ok: false, reason: "api_non_200" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "api_body_unusable" };
  }
  const identifier = (body as { data?: { identifier?: unknown } })?.data?.identifier;
  if (typeof identifier !== "string" || identifier.length === 0) {
    return { ok: false, reason: "api_body_unusable" };
  }
  if (!advisoryIdentifierShaped(identifier)) {
    // Refused, never scrubbed, and never echoed — the reason is a bare literal.
    return { ok: false, reason: "identifier_not_shaped" };
  }
  return { ok: true, identifier };
}

/**
 * The single entry point index.ts calls. Never throws.
 *
 * Local evidence first, network last: every refusal that can be decided from
 * disk is decided before a request is made, so an ordinary turn with no
 * outstanding completion costs nothing.
 */
export async function decideAdvisoryContinuation(opts: {
  cwd: string;
  sessionId: string;
  fetch: FetchFn;
  auth?: StrideAuth;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<AdvisoryDecision> {
  const { cwd, sessionId } = opts;

  const record = readLoopState(cwd);
  if (!record) {
    // No completion outstanding, so no budget to carry forward.
    resetInjectionCounter(cwd);
    const present = (() => {
      try {
        return fs.existsSync(path.join(cwd, LOOP_STATE_FILE));
      } catch {
        return false;
      }
    })();
    return { inject: false, reason: present ? "malformed_loop_state" : "no_loop_state" };
  }

  if (record.needs_review === true) {
    // A human owns the next move; the loop is not stalled.
    resetInjectionCounter(cwd);
    return { inject: false, reason: "needs_review" };
  }

  if (!sameSession(record.session_id, sessionId)) {
    // Not this session's state to act on, nor to clear.
    return { inject: false, reason: "foreign_session" };
  }

  const max = advisoryMaxInjections(opts.env);
  // Keyed on the COMPLETED identifier, never the claimable one: the head of the
  // Ready queue can change between prompts, and keying on it would silently
  // reset the count and restore the unbounded repetition this counter prevents.
  const count = readInjectionCount(cwd, record.identifier);
  if (count + 1 > max) {
    // Leave the spent record in place — deleting it here is what would make
    // "at most N per unfollowed completion" false.
    return { inject: false, reason: "budget_spent" };
  }

  const auth = opts.auth ?? readStrideAuth(cwd);
  if (!auth.apiBase || !auth.token) {
    return { inject: false, reason: "no_credentials" };
  }

  const next = await nextClaimableIdentifier({
    fetch: opts.fetch,
    apiBase: auth.apiBase,
    token: auth.token,
    signal: opts.signal ?? AbortSignal.timeout(ADVISORY_TIMEOUT_MS),
  });
  if (!next.ok) return { inject: false, reason: next.reason };

  // Write BEFORE injecting: an injection this port cannot count is one it
  // cannot bound, and unbounded injection is worse than a missed one.
  if (!recordInjection(cwd, record.identifier, count + 1)) {
    return { inject: false, reason: "counter_write_failed" };
  }

  return {
    inject: true,
    identifier: next.identifier,
    text: advisoryMessageText(next.identifier, max),
    injectionCount: count + 1,
  };
}
