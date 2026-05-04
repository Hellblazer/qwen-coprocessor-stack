// SPDX-License-Identifier: MIT
//
// Per-spawn extension loadout helpers — RDR-002.
//
// This module currently exposes:
//
//   resolveQwenRealBin(env, whichFn?)  — resolve the real qwen binary
//     path the wrapper script will exec. Called once at supervisor
//     startup; result is cached on the handlers/pool context and
//     forwarded to every session via QueryOptions.env.QWEN_REAL_BIN.
//
//   resolveWrapperPath()  — absolute path to the bash wrapper shipped
//     in this package at scripts/qwen-extensions-wrapper.sh. The
//     wrapper is a fixed file; per-session variation is via env vars
//     (QWEN_REAL_BIN, QWEN_AGENT_EXTENSIONS).
//
// Subsequent phases will add the installed-extensions cache and the
// resolveExtensions(opts, sessionDefault, installedCache) algorithm.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Default `which` implementation used when a caller doesn't inject one.
 * Returns the resolved absolute path or null if the command is not on
 * PATH. Never throws.
 */
function defaultWhich(cmd: string): string | null {
  try {
    const out = execFileSync("/usr/bin/env", ["which", cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * Resolve the real qwen binary path the wrapper script will `exec`.
 *
 * Policy (RDR-002 §The wrapper-script bridge → QWEN_REAL_BIN bullet):
 *
 *   1. If `env.QWEN_REAL_BIN` is set and non-empty, honour it verbatim.
 *      Verify the path exists and has any executable bit set; throw
 *      with a descriptive message on miss. The supervisor exits
 *      non-zero at startup rather than failing at first spawn.
 *   2. Else, run `which qwen`. If empty/null, throw — the supervisor
 *      cannot start without a resolvable qwen binary.
 *
 * The `whichFn` parameter is injected for testability; production code
 * leaves it undefined and `defaultWhich` is used.
 */
export function resolveQwenRealBin(
  env: NodeJS.ProcessEnv,
  whichFn?: (cmd: string) => string | null,
): string {
  const override = env["QWEN_REAL_BIN"];
  if (override !== undefined && override !== "") {
    let mode: number;
    try {
      const stat = statSync(override);
      if (!stat.isFile()) {
        throw new Error(
          `QWEN_REAL_BIN=${override} is not a regular file`,
        );
      }
      mode = stat.mode;
    } catch (err) {
      // Re-throw our own descriptive errors; wrap fs errors with the path.
      if (err instanceof Error && err.message.startsWith("QWEN_REAL_BIN=")) {
        throw err;
      }
      throw new Error(
        `QWEN_REAL_BIN=${override} does not exist or is not accessible`,
      );
    }
    if ((mode & 0o111) === 0) {
      throw new Error(
        `QWEN_REAL_BIN=${override} exists but is not executable (mode bits 0o111 unset)`,
      );
    }
    return override;
  }

  const which = whichFn ?? defaultWhich;
  const found = which("qwen");
  if (found === null || found === "") {
    throw new Error(
      "QWEN_REAL_BIN unset and 'qwen' not on PATH — install Qwen Code or set QWEN_REAL_BIN",
    );
  }
  return found;
}

/**
 * Absolute path to the wrapper script shipped at
 * `mcp-bridges/qwen-agent-server/scripts/qwen-extensions-wrapper.sh`.
 *
 * Resolution is anchored on `import.meta.url` so the same code works
 * whether the module loads from `src/` (during tests) or from `dist/`
 * (after `tsc` build) — both sit one level below the package root.
 */
export function resolveWrapperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "scripts", "qwen-extensions-wrapper.sh");
}
