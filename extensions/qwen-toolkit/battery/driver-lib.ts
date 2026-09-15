// SPDX-License-Identifier: MIT
//
// extensions/qwen-toolkit/battery/driver-lib.ts — pure logic for the
// battery dispatch driver (bead qwen-coprocessor-stack-3su.8).
//
// Deliberately dist/-free: nothing here imports the compiled supervisor
// (mcp-bridges/qwen-agent-server/dist/*.js). driver.ts is the thin CLI
// entrypoint that wires these pure functions to the real supervisor path;
// this file is what vitest exercises directly, with fs/CLI collaborators
// passed in rather than mocked, so `npm run build` need not have run yet
// to test this file's behavior.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── task-spec contract (extensions/qwen-toolkit/battery/README.md /
//    tasks/*/task.json shape, bead 3su.7) ───────────────────────────

export interface VerifySpec {
  command: string[];
  cwd?: string;
  expected_exit_code: number;
}

export interface OracleSpec {
  match: "set" | "exact";
  expected: Record<string, unknown>;
}

/**
 * The driver's stdin envelope: the 3su.7 task.json shape, plus an
 * optional `cwd`.
 *
 * `cwd`, when present, is the absolute path to the already-materialized
 * working tree for this task instance -- i.e. `setup.copy_dir`'s
 * contents, already copied into a fresh directory by the caller. This
 * driver does no file materialization of its own ("thin by design" --
 * see driver.ts header); that is the Python runner's job (bead 3su.9).
 * Omitting `cwd` is only for ad hoc/manual invocation -- the inner
 * session then runs wherever SpawnOpts.cwd's own default puts it
 * (process.cwd()), which is almost never what a real battery run wants.
 * The runner should always set it.
 *
 * `max_output_tokens`, when present, is forwarded to
 * `SpawnOpts.max_output_tokens` (the inner Qwen Code process's per-turn
 * generation cap). This repo's own eval-methodology finding (CLAUDE.md
 * "Eval methodology" §4, also RDR-006): too low a cap truncates a tool
 * call mid-write, which reads as a stall rather than a failure -- the
 * runner (bead 3su.9) sets this generously (16384) rather than leaving
 * it at the qwen-code default.
 */
export interface DriverStdinEnvelope {
  name: string;
  family?: "debug" | "implement-tdd" | "docs-explain";
  prompt: string;
  setup?: { copy_dir: string };
  verify?: VerifySpec;
  max_tool_calls: number;
  timeout_ms: number;
  notes?: string;
  oracle?: OracleSpec;
  cwd?: string;
  max_output_tokens?: number;
}

export type Arm = "toolkit" | "control";

/**
 * One dispatch's result, written as the driver's sole stdout line. This
 * is a DISPATCH record, not a grade -- `ok: true` means the session
 * produced a final turn within its budget, not that the task was solved.
 * Pass/fail against `verify.command` is the Python runner's job.
 */
export interface DispatchResult {
  ok: boolean;
  task: string;
  arm: Arm;
  elapsed_ms: number;
  tool_calls: number;
  final_message: string | undefined;
  error: string | undefined;
  chosen_backend: string | undefined;
  /**
   * The extension set the real resolveExtensions() call actually
   * produced for this dispatch -- echoed from the live resolution
   * result, never hand-derived from `arm`, so a future change to
   * framework-required extensions or the installed-extensions cache
   * shows up here rather than silently drifting from what was assumed.
   */
  resolved_extensions: string[] | "none" | undefined;
}

// ── CLI arg parsing ──────────────────────────────────────────────

/**
 * `--arm toolkit|control` is the one CLI flag this driver takes. It is
 * NOT part of the 3su.7 task-spec contract (task.json says nothing
 * about which arm to dispatch as) -- the runner picks the arm per
 * dispatch and passes it here, since the same task.json is dispatched
 * twice (once per arm) to get a toolkit/control pair.
 */
export function parseArm(argv: string[]): Arm {
  const idx = argv.indexOf("--arm");
  const value = idx === -1 ? undefined : argv[idx + 1];
  if (value === undefined) {
    throw new Error("usage: driver.ts --arm <toolkit|control>");
  }
  if (value !== "toolkit" && value !== "control") {
    throw new Error(`--arm must be toolkit|control, got '${value}'`);
  }
  return value;
}

// ── task-spec parsing ────────────────────────────────────────────

function requireString(spec: Record<string, unknown>, field: string): string {
  const value = spec[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`task spec missing required non-empty string field: ${field}`);
  }
  return value;
}

function requirePositiveNumber(spec: Record<string, unknown>, field: string): number {
  const value = spec[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`task spec missing required positive-number field: ${field}`);
  }
  return value;
}

/** Parse and minimally validate the stdin envelope (see DriverStdinEnvelope). */
export function parseTaskSpec(raw: string): DriverStdinEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("task spec must be a JSON object");
  }
  const spec = parsed as Record<string, unknown>;

  const name = requireString(spec, "name");
  const prompt = requireString(spec, "prompt");
  const max_tool_calls = requirePositiveNumber(spec, "max_tool_calls");
  const timeout_ms = requirePositiveNumber(spec, "timeout_ms");

  if (spec["cwd"] !== undefined && typeof spec["cwd"] !== "string") {
    throw new Error("task spec field 'cwd' must be a string when present");
  }
  if (spec["notes"] !== undefined && typeof spec["notes"] !== "string") {
    throw new Error("task spec field 'notes' must be a string when present");
  }
  if (
    spec["max_output_tokens"] !== undefined &&
    (typeof spec["max_output_tokens"] !== "number" ||
      !Number.isFinite(spec["max_output_tokens"]) ||
      (spec["max_output_tokens"] as number) <= 0)
  ) {
    throw new Error("task spec field 'max_output_tokens' must be a positive number when present");
  }

  const envelope: DriverStdinEnvelope = { name, prompt, max_tool_calls, timeout_ms };
  if (spec["family"] !== undefined) envelope.family = spec["family"] as DriverStdinEnvelope["family"];
  if (spec["setup"] !== undefined) envelope.setup = spec["setup"] as DriverStdinEnvelope["setup"];
  if (spec["verify"] !== undefined) envelope.verify = spec["verify"] as DriverStdinEnvelope["verify"];
  if (spec["notes"] !== undefined) envelope.notes = spec["notes"] as string;
  if (spec["oracle"] !== undefined) envelope.oracle = spec["oracle"] as DriverStdinEnvelope["oracle"];
  if (spec["cwd"] !== undefined) envelope.cwd = spec["cwd"] as string;
  if (spec["max_output_tokens"] !== undefined) envelope.max_output_tokens = spec["max_output_tokens"] as number;
  return envelope;
}

// ── argv/opts construction ───────────────────────────────────────

/**
 * `opts.extensions.only` for the given arm. `toolkit` -> the real
 * extension; `control` -> the empty set, which resolveExtensions()
 * renders as the "none" sentinel (src/extensions.ts:616-618) -- the
 * honest control arm, not "whatever the CLI defaults happen to be".
 */
export function extensionsOnlyForArm(arm: Arm): string[] {
  return arm === "toolkit" ? ["qwen-toolkit"] : [];
}

/**
 * The subset of `SpawnOpts` (mcp-bridges/qwen-agent-server/src/types.ts)
 * this driver ever sets. Kept as a locally-declared structural type
 * (rather than importing SpawnOpts from dist/types.js) so this file
 * stays dist-free -- driver.ts passes the result straight through, and
 * TypeScript's structural typing accepts it as `Partial<SpawnOpts>`
 * there.
 */
export interface DispatchSpawnOpts {
  write_authority: boolean;
  extensions: { only: string[] };
  max_tool_calls: number;
  cwd?: string;
  max_output_tokens?: number;
}

/**
 * Build the SpawnOpts subset for one dispatch. `write_authority: true`
 * is unconditional -- every battery family (debug / implement-tdd /
 * docs-explain) needs the inner session to actually edit files; a
 * read-only session cannot fix a bug or add a test.
 *
 * `cwd` and `max_output_tokens` are omitted entirely (not set to
 * `undefined`) when the spec doesn't carry them, matching the
 * supervisor's own `exactOptionalPropertyTypes: true` discipline.
 */
export function buildSpawnOpts(spec: DriverStdinEnvelope, arm: Arm): DispatchSpawnOpts {
  const opts: DispatchSpawnOpts = {
    write_authority: true,
    extensions: { only: extensionsOnlyForArm(arm) },
    max_tool_calls: spec.max_tool_calls,
  };
  if (spec.cwd !== undefined) opts.cwd = spec.cwd;
  if (spec.max_output_tokens !== undefined) opts.max_output_tokens = spec.max_output_tokens;
  return opts;
}

// ── dist-staleness check (plan-audit fix, bead 3su.8 NOTES) ────────
//
// The precedent (scripts/bench/qwen_vs_claude.ts) imports compiled
// dist/*.js, not src/*.ts. A stale dist/ (built before the last src/
// edit) silently runs old supervisor code -- no error, no warning, just
// wrong behavior on every dispatch until someone notices. Refuse to run
// rather than risk that.

export interface FreshnessDeps {
  exists: (path: string) => boolean;
  mtimeMs: (path: string) => number;
  /** List of `.ts` file paths under `dir`, recursively. */
  listTsFiles: (dir: string) => string[];
}

export const realFreshnessDeps: FreshnessDeps = {
  exists: existsSync,
  mtimeMs: (path) => statSync(path).mtimeMs,
  listTsFiles: (dir) =>
    readdirSync(dir, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
      .map((entry) => join(dir, entry)),
};

/**
 * Throws when `distServerPath` is missing, or when any `.ts` file under
 * `srcDir` was modified strictly after `distServerPath` was built. A tie
 * (src mtime == dist mtime) is NOT staleness -- only a src file that is
 * newer counts.
 */
export function checkDistFreshness(
  distServerPath: string,
  srcDir: string,
  deps: FreshnessDeps = realFreshnessDeps,
): void {
  if (!deps.exists(distServerPath)) {
    throw new Error(
      `dist/ missing at ${distServerPath} -- run 'cd mcp-bridges/qwen-agent-server && npm run build' first`,
    );
  }
  const distMtime = deps.mtimeMs(distServerPath);

  let newestSrcMtime = 0;
  let newestSrcFile = "";
  for (const file of deps.listTsFiles(srcDir)) {
    const mtime = deps.mtimeMs(file);
    if (mtime > newestSrcMtime) {
      newestSrcMtime = mtime;
      newestSrcFile = file;
    }
  }

  if (newestSrcMtime > distMtime) {
    throw new Error(
      `dist/server.js is stale: ${newestSrcFile} (mtime ${new Date(newestSrcMtime).toISOString()}) ` +
        `is newer than dist/server.js (mtime ${new Date(distMtime).toISOString()}) -- ` +
        `run 'cd mcp-bridges/qwen-agent-server && npm run build' before dispatching`,
    );
  }
}
