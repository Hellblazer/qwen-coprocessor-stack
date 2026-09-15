// SPDX-License-Identifier: MIT
//
// Dry-run tests for driver.ts's dispatchOne() (bead qwen-coprocessor-
// stack-3su.8) against a hand-built, MOCKED ToolHandlers -- no real
// backend, no real qwen_spawn, no live box. The first live A/B against
// the box is bead 3su.10, deliberately out of scope here.
//
// Importing driver.ts pulls in its top-level dist/*.js imports (the real
// resolveExtensions/createInstalledExtensionsCache/createPool/
// createToolHandlers function DEFINITIONS), so `npm run build` must have
// run first -- but this file never CALLS createPool/createToolHandlers/
// createInstalledExtensionsCache; every ToolHandlers-shaped collaborator
// below is a fake, injected directly into the exported dispatchOne().
//
// Run:
//   cd mcp-bridges/qwen-agent-server && npm run build
//   npx vitest run --dir ../../extensions/qwen-toolkit/battery

import { describe, expect, it } from "vitest";

import { dispatchOne } from "./driver.js";
import { parseTaskSpec, type DriverStdinEnvelope } from "./driver-lib.js";

const SPEC: DriverStdinEnvelope = parseTaskSpec(
  JSON.stringify({
    name: "001-interval-debug",
    family: "debug",
    prompt: "fix the bug",
    max_tool_calls: 30,
    timeout_ms: 2_400_000,
  }),
);

// Minimal fakes -- structurally shaped like ToolHandlers /
// InstalledExtensionsCache, built by hand rather than via vi.mock, per
// the repo's injected-function testing convention.

function fakeInstalledExtensions(installed: string[]) {
  const set = new Set(installed);
  return {
    get: () => set,
    reload: async () => set,
    size: () => set.size,
  };
}

interface Calls {
  spawn: number;
  poll: number;
  stop: number;
}

function fakeHandlers(opts: {
  spawnResult: { task_id: string; chosen_backend: string } | { error: { code: string; message: string } };
  pollResults: Array<Record<string, unknown>>;
  calls: Calls;
}) {
  let pollIdx = 0;
  return {
    qwen_spawn: async () => {
      opts.calls.spawn++;
      return opts.spawnResult as never;
    },
    qwen_poll: async () => {
      opts.calls.poll++;
      const next = opts.pollResults[Math.min(pollIdx, opts.pollResults.length - 1)];
      pollIdx++;
      return next as never;
    },
    qwen_stop: async () => {
      opts.calls.stop++;
      return { ack: true } as never;
    },
  } as never;
}

describe("dispatchOne (mocked handlers, no live box)", () => {
  it("toolkit arm: idle poll result -> ok:true, echoes real resolved_extensions", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { task_id: "task-1", chosen_backend: "local-27b" },
      pollResults: [
        { state: "idle", last_message: "fixed both bugs, 14/14 tests pass", budget: { tool_calls: 11 } },
      ],
      calls,
    });

    const result = await dispatchOne(handlers, fakeInstalledExtensions(["qwen-toolkit"]), SPEC, "toolkit");

    expect(result.ok).toBe(true);
    expect(result.task).toBe("001-interval-debug");
    expect(result.arm).toBe("toolkit");
    expect(result.tool_calls).toBe(11);
    expect(result.final_message).toBe("fixed both bugs, 14/14 tests pass");
    expect(result.chosen_backend).toBe("local-27b");
    expect(result.resolved_extensions).toEqual(["qwen-toolkit"]);
    expect(result.error).toBeUndefined();
    expect(calls).toEqual({ spawn: 1, poll: 1, stop: 1 });
  });

  it("control arm: resolved_extensions echoes the 'none' sentinel, not an assumption", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { task_id: "task-2", chosen_backend: "local-27b" },
      pollResults: [{ state: "complete", last_message: "done", budget: { tool_calls: 3 } }],
      calls,
    });

    const result = await dispatchOne(handlers, fakeInstalledExtensions(["qwen-toolkit"]), SPEC, "control");

    expect(result.ok).toBe(true);
    expect(result.resolved_extensions).toBe("none");
    expect(calls.spawn).toBe(1);
  });

  it("unknown extension: fails BEFORE qwen_spawn is ever called, with a legible error", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { task_id: "unused", chosen_backend: "unused" },
      pollResults: [{ state: "idle", last_message: "unused", budget: { tool_calls: 0 } }],
      calls,
    });

    // qwen-toolkit is NOT in the installed-extensions cache.
    const result = await dispatchOne(handlers, fakeInstalledExtensions([]), SPEC, "toolkit");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown extension.*qwen-toolkit/);
    expect(result.resolved_extensions).toBeUndefined();
    expect(calls.spawn).toBe(0);
    expect(calls.poll).toBe(0);
    expect(calls.stop).toBe(0);
  });

  it("qwen_spawn returns an error envelope -> ok:false, resolved_extensions still populated", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { error: { code: "spawn_error", message: "no healthy backend" } },
      pollResults: [],
      calls,
    });

    const result = await dispatchOne(handlers, fakeInstalledExtensions(["qwen-toolkit"]), SPEC, "toolkit");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no healthy backend");
    expect(result.resolved_extensions).toEqual(["qwen-toolkit"]);
    expect(calls.poll).toBe(0);
    expect(calls.stop).toBe(0);
  });

  it("session ends in error state -> ok:false, session is still stopped", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { task_id: "task-3", chosen_backend: "local-27b" },
      pollResults: [
        { state: "error", last_message: "partial output", error: { code: "backend_offline", message: "backend died" } },
      ],
      calls,
    });

    const result = await dispatchOne(handlers, fakeInstalledExtensions(["qwen-toolkit"]), SPEC, "toolkit");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("backend died");
    expect(result.final_message).toBe("partial output");
    expect(calls.stop).toBe(1);
  });

  it("deadline exceeded while still running -> ok:false timeout, session is still stopped", async () => {
    const calls: Calls = { spawn: 0, poll: 0, stop: 0 };
    const handlers = fakeHandlers({
      spawnResult: { task_id: "task-4", chosen_backend: "local-27b" },
      pollResults: [{ state: "running", budget: { tool_calls: 2 } }],
      calls,
    });

    // timeout_ms: 1 -- the deadline is in the past within at most one
    // POLL_INTERVAL_MS sleep of the first poll (sub-millisecond fake I/O
    // means the very first deadline check can land either side of the 1ms
    // line, so this asserts "terminates via timeout, session stopped
    // exactly once" rather than an exact poll count).
    const tightSpec: DriverStdinEnvelope = { ...SPEC, timeout_ms: 1 };

    const result = await dispatchOne(handlers, fakeInstalledExtensions(["qwen-toolkit"]), tightSpec, "toolkit");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 1ms/);
    expect(calls.poll).toBeGreaterThanOrEqual(1);
    expect(calls.stop).toBe(1);
  });
});
