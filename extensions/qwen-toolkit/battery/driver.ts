#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
//
// extensions/qwen-toolkit/battery/driver.ts — thin dispatch driver for the
// qwen-toolkit objective battery (RDR-002 W4, bead qwen-coprocessor-stack-3su.8).
//
// Turns one battery task spec into ONE dispatch through the REAL
// supervisor extension-resolution path (qwen_spawn -> opts.extensions.only)
// and writes ONE result JSON to stdout. All grading (materializing
// `setup.copy_dir`, running `verify.command`, deciding pass/fail) lives in
// the Python runner (bead 3su.9, not yet built), not here.
//
// ── HARD PREREQUISITE ───────────────────────────────────────────────
// `cd mcp-bridges/qwen-agent-server && npm run build` MUST run first. This
// driver imports COMPILED dist/*.js (mirrors scripts/bench/qwen_vs_claude.ts,
// deliberately -- a fresh in-process pool here does not perturb the
// operator's running supervisor process). A stale dist/ silently exercises
// old supervisor code with zero error -- checkDistFreshness() (driver-lib.ts)
// refuses to run instead of risking that (plan-audit finding on 3su.8).
//
// ── USAGE ────────────────────────────────────────────────────────────
//   cd mcp-bridges/qwen-agent-server && npm run build
//   echo '<task-spec-json>' | npx tsx ../../extensions/qwen-toolkit/battery/driver.ts --arm toolkit
//   echo '<task-spec-json>' | npx tsx ../../extensions/qwen-toolkit/battery/driver.ts --arm control
//
// stdin: one task-spec JSON (the 3su.7 task.json shape, plus an optional
// `cwd` -- see driver-lib.ts's DriverStdinEnvelope doc). stdout: one result
// JSON, nothing else -- the Python runner parses stdout as JSON.
//
// `--arm toolkit` dispatches with `opts.extensions.only = ["qwen-toolkit"]`.
// `--arm control` dispatches with `opts.extensions.only = []`, which
// resolveExtensions() renders as the "none" sentinel -- the honest control
// arm, not "whatever the CLI defaults happen to be". `only` is used
// (never `enable`/`disable`): `resolveExtensions` THROWS when
// `enable`/`disable` is supplied under the `leave-defaults` session
// default (src/extensions.ts:577-582), and `leave-defaults` is the
// default state.
//
// ── CONCURRENCY (bead qwen-coprocessor-stack-7i1) ──────────────────────
// The box's llama-server serves a SHARED 64K unified-KV pool across its
// n_parallel slots -- two concurrent big agentic requests can starve or
// kill BOTH. This driver dispatches exactly ONE task per process
// invocation and never starts a second dispatch before the first
// session is stopped (see the single `await dispatchOne(...)` call in
// main() below -- there is no loop here to accidentally parallelize).
// The Python runner that invokes this driver repeatedly MUST also
// serialize: one driver subprocess at a time, wait for exit, then the
// next. Do NOT "helpfully" add concurrency to either side.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Arm,
  type DispatchResult,
  buildSpawnOpts,
  checkDistFreshness,
  parseArm,
  parseTaskSpec,
  type DriverStdinEnvelope,
} from "./driver-lib.js";

// dist/*.js imports -- see HARD PREREQUISITE above. Deliberately deferred
// past the freshness check (main() calls checkDistFreshness() before
// touching any of these), but static ESM imports are hoisted regardless,
// so a missing dist/ still surfaces as a clear "Cannot find module" node
// error rather than the driver silently importing nothing -- the
// freshness check's job is catching STALE (present but outdated) dist/,
// which a missing-module error can't detect.
import {
  createInstalledExtensionsCache,
  ExtensionResolutionError,
  getSessionDefaultExtensions,
  resolveExtensions,
  resolveQwenRealBin,
  resolveWrapperPath,
  type InstalledExtensionsCache,
} from "../../../mcp-bridges/qwen-agent-server/dist/extensions.js";
import { createPool } from "../../../mcp-bridges/qwen-agent-server/dist/pool.js";
import { createToolHandlers, type ToolHandlers } from "../../../mcp-bridges/qwen-agent-server/dist/server.js";
import type { PollResult, SpawnOpts } from "../../../mcp-bridges/qwen-agent-server/dist/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SUPERVISOR_ROOT = join(__dirname, "..", "..", "..", "mcp-bridges", "qwen-agent-server");
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── one dispatch ─────────────────────────────────────────────────
//
// Exported so a dry-run test can exercise the full resolve/spawn/poll/stop
// wiring against a hand-built, mocked `ToolHandlers` (no real backend, no
// real qwen_spawn) instead of the live box -- see driver.dryrun.test.ts.
// The live A/B is bead 3su.10; this bead ships wiring, not a live result.

export async function dispatchOne(
  handlers: ToolHandlers,
  installedExtensions: InstalledExtensionsCache,
  spec: DriverStdinEnvelope,
  arm: Arm,
): Promise<DispatchResult> {
  const start = Date.now();

  // Resolve extensions ourselves first, through the REAL resolveExtensions()
  // function (same one qwen_spawn calls internally) -- this is how
  // `resolved_extensions` gets echoed from what the resolution actually
  // produced rather than hand-derived from `arm`, and it also gives us a
  // legible pre-spawn failure for an unknown extension name instead of
  // relying solely on qwen_spawn's own (already-legible, but redundant to
  // duplicate reasoning about) error return.
  let resolvedExtensions: string[] | "none";
  try {
    const sessionDefault = getSessionDefaultExtensions(process.env);
    const only = arm === "toolkit" ? ["qwen-toolkit"] : [];
    const resolution = resolveExtensions({ only }, sessionDefault, installedExtensions.get());
    if (resolution.resolved === "leave-defaults") {
      // Unreachable: `only` is always provided by this driver, which
      // short-circuits resolveExtensions's leave-defaults branch
      // (src/extensions.ts step 2a). Guarded rather than asserted away
      // so a future resolveExtensions change fails loudly here instead
      // of producing a silently wrong result.
      throw new Error("internal: resolveExtensions returned leave-defaults with `only` provided");
    }
    resolvedExtensions = resolution.resolved;
  } catch (err) {
    const message =
      err instanceof ExtensionResolutionError || err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      task: spec.name,
      arm,
      elapsed_ms: Date.now() - start,
      tool_calls: 0,
      final_message: undefined,
      chosen_backend: undefined,
      resolved_extensions: undefined,
      error: message,
    };
  }

  const spawnOpts = buildSpawnOpts(spec, arm) as Partial<SpawnOpts>;
  const spawn = await handlers.qwen_spawn({ task: spec.prompt, opts: spawnOpts });
  if ("error" in spawn) {
    return {
      ok: false,
      task: spec.name,
      arm,
      elapsed_ms: Date.now() - start,
      tool_calls: 0,
      final_message: undefined,
      chosen_backend: undefined,
      resolved_extensions: resolvedExtensions,
      error: spawn.error.message,
    };
  }

  const task_id = spawn.task_id;
  const deadline = start + spec.timeout_ms;
  let polled: PollResult | undefined;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      polled = (await handlers.qwen_poll({ task_id, opts: {} })) as PollResult;
      if (polled.state === "idle" || polled.state === "complete" || polled.state === "error") break;
      if (Date.now() >= deadline) break;
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    // Always stop -- the driver is one-dispatch-per-process; nothing else
    // will ever reap this session.
    await handlers.qwen_stop({ task_id });
  }

  const elapsed_ms = Date.now() - start;
  const tool_calls = polled?.budget?.tool_calls ?? 0;

  if (polled === undefined) {
    return {
      ok: false,
      task: spec.name,
      arm,
      elapsed_ms,
      tool_calls,
      final_message: undefined,
      chosen_backend: spawn.chosen_backend,
      resolved_extensions: resolvedExtensions,
      error: "no poll result received",
    };
  }

  if (polled.state === "error") {
    return {
      ok: false,
      task: spec.name,
      arm,
      elapsed_ms,
      tool_calls,
      final_message: polled.last_message,
      chosen_backend: spawn.chosen_backend,
      resolved_extensions: resolvedExtensions,
      error: polled.error?.message ?? "session errored without message",
    };
  }

  if (polled.state === "running") {
    // Deadline hit while the session was still running: a timeout, not a
    // completed dispatch.
    return {
      ok: false,
      task: spec.name,
      arm,
      elapsed_ms,
      tool_calls,
      final_message: polled.last_message,
      chosen_backend: spawn.chosen_backend,
      resolved_extensions: resolvedExtensions,
      error: `timed out after ${spec.timeout_ms}ms (state=running)`,
    };
  }

  // idle | complete -- the session produced a final turn within budget.
  // Whether that turn actually SOLVED the task is verify.command's call,
  // made by the Python runner against the materialized tree -- not this
  // driver's job.
  return {
    ok: true,
    task: spec.name,
    arm,
    elapsed_ms,
    tool_calls,
    final_message: polled.last_message,
    chosen_backend: spawn.chosen_backend,
    resolved_extensions: resolvedExtensions,
    error: undefined,
  };
}

// ── main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Setup-phase failures (bad CLI usage, stale/missing dist/, malformed
  // stdin, env/binary resolution) are driver misuse, not a task result --
  // they go to stderr with a non-zero exit and print NO stdout JSON, so
  // the Python runner never mistakes a usage error for a dispatch record.
  const arm = parseArm(process.argv.slice(2));
  checkDistFreshness(join(SUPERVISOR_ROOT, "dist", "server.js"), join(SUPERVISOR_ROOT, "src"));
  const rawStdin = readFileSync(0, "utf-8");
  const spec = parseTaskSpec(rawStdin);

  const qwenRealBin = resolveQwenRealBin(process.env);
  const wrapperPath = resolveWrapperPath();
  const installedExtensions = await createInstalledExtensionsCache(qwenRealBin);
  const pool = createPool({ qwenRealBin, wrapperPath });
  const handlers = createToolHandlers(pool, installedExtensions);

  // The ONE dispatch (see CONCURRENCY note in the header comment).
  const result = await dispatchOne(handlers, installedExtensions, spec, arm);

  process.stdout.write(JSON.stringify(result) + "\n");
  // Force exit -- mirrors scripts/bench/qwen_vs_claude.ts: the pool's
  // reaper interval is unref'd but pino's worker can keep the loop alive
  // briefly otherwise.
  process.exit(result.ok ? 0 : 1);
}

// Only run main() when this module is the process entrypoint -- lets
// driver-lib.ts's pure functions (and, transitively, this file's own
// exports if ever imported) be loaded by a test runner without
// triggering a live dispatch.
//
// Compares decoded filesystem paths, not raw URL strings: a naive
// `import.meta.url === \`file://${process.argv[1]}\`` breaks whenever the
// path contains characters the URL form percent-encodes (a space, for
// one -- this repo's own worktree paths under
// `.claude/worktrees/` can and do contain spaces, e.g. "Transcend Hell"
// in this checkout; import.meta.url renders that as `%20`, argv[1] does
// not, so the naive comparison silently never matches and main() never
// runs). Caught by hand-running the driver's CLI error paths, not by any
// automated test -- see the completion report for this bead.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`driver.ts: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
}
