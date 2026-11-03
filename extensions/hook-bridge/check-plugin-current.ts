/**
 * (W2609) Stale-install check, run once by stride-workflow Step 0.
 *
 *   node "<skill folder>/../../extensions/hook-bridge/check-plugin-current.ts" "<skill folder>"
 *
 * `<skill folder>` is the directory holding stride-workflow's SKILL.md, so
 * two levels up is the install root: `~/.pi/agent`, a project's `.pi`, or a
 * stride-pi checkout that Pi runs directly.
 *
 * Pi loads whatever copy is installed, and every claim reports the same
 * skills_version, so nothing on the server can tell an old install from a
 * current one. This compares the installed version with the version on main
 * and speaks up, in a single line, only for an install behind main. Every other outcome —
 * current, newer, unknown, unreadable, offline, malformed — prints nothing.
 * It exits 0 on every path: Step 0 must never wait on it or fail because of it.
 *
 * Where the installed version comes from, in order:
 *   1. `<root>/package.json`, only when its `name` is "stride-pi" (a
 *      repository run). The nested extensions' own package.json files are
 *      never read; releases do not bump them.
 *   2. `<root>/extensions/hook-bridge/.stride-pi-version`, which install.sh
 *      writes, because a loose install copies no root package.json.
 *   3. Nothing — the check stays silent rather than guess.
 *
 * Known limit: installs come from main, and main's version moves only at
 * release, so an install made between two releases reads as current.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchFn } from "./after-goal-status.ts";

/** The pin. A fixed literal: nothing from a task, the env or argv reaches it. */
export const PIN_URL = "https://raw.githubusercontent.com/cheezy/stride-pi/main/package.json";

/** The record install.sh writes beside the installed hook bridge. */
export const VERSION_RECORD_FILE = ".stride-pi-version";

/** Step 0 waits on this, so keep it short. */
export const CHECK_TIMEOUT_MS = 3_000;

/** Larger than any real package.json; anything bigger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

const INSTALL_ONE_LINER = "curl -fsSL https://raw.githubusercontent.com/cheezy/stride-pi/main/install.sh | bash";

/** Dotted digits with an optional pre-release suffix, whole string only. */
export const VERSION_RE = /^[0-9]{1,9}(\.[0-9]{1,9}){0,5}(-[0-9A-Za-z.-]{1,32})?$/;

export interface ParsedVersion {
  core: number[];
  pre: string | null;
}

/** A version string, or null when it is not dotted digits (refused, never repaired). */
export function parseVersion(value: unknown): ParsedVersion | null {
  if (typeof value !== "string" || !VERSION_RE.test(value)) return null;
  const dash = value.indexOf("-");
  const coreText = dash === -1 ? value : value.slice(0, dash);
  const pre = dash === -1 ? null : value.slice(dash + 1);
  return { core: coreText.split(".").map((part) => Number(part)), pre };
}

/**
 * -1 when `a` is older, 0 when equal, 1 when newer, null when the order is
 * unknown. Components compare as numbers, so 1.22.0 beats 1.9.0; absent
 * trailing parts read as zero; a build with a `-suffix` ranks under the plain
 * version it leads up to; and two suffixed builds of one version have no order.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 | null {
  const width = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < width; i++) {
    const x = a.core[i] ?? 0;
    const y = b.core[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return null;
}

/** How the install got here, which decides the update command. */
export type InstallKind = "repository" | "global" | "project";

export interface InstalledVersion {
  version: string;
  kind: InstallKind;
}

function readJsonFile(file: string): unknown {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BODY_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readFirstLine(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256) return null;
    return fs.readFileSync(file, "utf-8").split(/\r?\n/, 1)[0].trim();
  } catch {
    return null;
  }
}

/** The installed version and install kind, or null when no source is readable. */
export function readInstalledVersion(skillFolder: string): InstalledVersion | null {
  if (typeof skillFolder !== "string" || skillFolder.length === 0) return null;
  const root = path.resolve(skillFolder, "..", "..");

  const pkg = readJsonFile(path.join(root, "package.json"));
  if (pkg && typeof pkg === "object" && (pkg as { name?: unknown }).name === "stride-pi") {
    const version = (pkg as { version?: unknown }).version;
    // A checkout whose version is unusable says nothing; the record below
    // belongs to a loose install, never to a checkout.
    return parseVersion(version) ? { version: version as string, kind: "repository" } : null;
  }

  const recorded = readFirstLine(path.join(root, "extensions", "hook-bridge", VERSION_RECORD_FILE));
  if (recorded !== null && parseVersion(recorded)) {
    return { version: recorded, kind: path.basename(root) === ".pi" ? "project" : "global" };
  }
  return null;
}

/** The version on main, or null on any failure. Sends no credentials. */
export async function fetchPinnedVersion(fetch: FetchFn, timeoutMs = CHECK_TIMEOUT_MS): Promise<string | null> {
  try {
    const response = await fetch(PIN_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const version = (JSON.parse(text) as { version?: unknown } | null)?.version;
    return parseVersion(version) ? (version as string) : null;
  } catch {
    return null;
  }
}

export function updateCommand(kind: InstallKind): string {
  if (kind === "repository") return "git pull in the stride-pi checkout";
  if (kind === "project") return `${INSTALL_ONE_LINER} -s -- --project`;
  return INSTALL_ONE_LINER;
}

/** The one warning line, or null when there is nothing to say. Never throws. */
export async function checkPluginCurrent(opts: {
  skillFolder: string;
  fetch: FetchFn;
  timeoutMs?: number;
}): Promise<string | null> {
  try {
    const installed = readInstalledVersion(opts.skillFolder);
    if (!installed) return null; // Unknown install: never fetch, never guess.
    const pinned = await fetchPinnedVersion(opts.fetch, opts.timeoutMs);
    if (!pinned) return null;
    const order = compareVersions(parseVersion(installed.version)!, parseVersion(pinned)!);
    if (order !== -1) return null;
    // Both versions passed VERSION_RE, so nothing fetched is echoed unchecked.
    return `stride-pi ${installed.version} is installed, but ${pinned} is current on main; update with: ${updateCommand(installed.kind)}`;
  } catch {
    return null;
  }
}

function runAsScript(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  process.exitCode = 0;
  const skillFolder = process.argv[2] ?? "";
  checkPluginCurrent({ skillFolder, fetch: globalThis.fetch as FetchFn })
    .then((line) => {
      if (line) process.stdout.write(line + "\n");
    })
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0;
    });
}
