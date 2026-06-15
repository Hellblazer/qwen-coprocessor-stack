// SPDX-License-Identifier: MIT
//
// Tests for src/dispatch.ts — the RDR-007 §4 agentic dispatch() interface
// (P3 / bead azf.7). No real processes / network: every effect is injected
// as a fake. Covers both kind:"agent-cli" impls (claude -p, qwen_spawn
// poll-to-completion), outcome classification, blocking semantics, the
// wall-clock timeout, and rejection of kind:"model-endpoint" providers.

import { describe, expect, it, vi } from "vitest";

import {
  classifyOutcome,
  assertAgentCli,
  makeClaudeCliDispatch,
  makeQwenSpawnDispatch,
} from "../src/dispatch.js";
import { patchArtifact } from "../src/types.js";
import type { AgentProvider, AgentTask, Artifact, RunContext } from "../src/types.js";

/** A harvest stub returning a single patch artifact with the given diff (the
 *  P1 git-diff harvester's output shape). */
function patchHarvest(diff: string) {
  return vi.fn(async (run: RunContext): Promise<Artifact[]> => [
    { kind: "patch", diff, base: run.environment.baseCommit ?? "" },
  ]);
}

const TASK: AgentTask = {
  prompt: "fix the bug",
  worktree: "/tmp/wt",
  maxTurns: 50,
  minTokens: 16384,
  timeout: 600_000,
};

// RDR-008 P2: base_commit is threaded into the dispatcher (opts), then to
// extractPatch — never carried on the fixture-locked AgentTask.
const BASE = "base-sha";
const OPTS = { baseCommit: BASE };

const claudeProvider: AgentProvider = {
  id: "claude-sonnet",
  kind: "agent-cli",
  modalities: ["text"],
  excludes: [],
  costClass: "metered",
};

const qwenProvider: AgentProvider = {
  id: "qwen-coder-box",
  kind: "agent-cli",
  modalities: ["text"],
  excludes: [],
  costClass: "free-local",
};

const endpointProvider: AgentProvider = {
  id: "coder-box",
  kind: "model-endpoint",
  modalities: ["text"],
  excludes: [],
};

// ── classifyOutcome (pure spine; mirrors run_arm.classify_outcome) ──────────

describe("classifyOutcome", () => {
  it("non-zero returncode → error (wins over turn count)", () => {
    expect(classifyOutcome(1, { turnsUsed: 5, maxTurns: 50 })).toBe("error");
    expect(classifyOutcome(137, { turnsUsed: 99, maxTurns: 50 })).toBe("error");
  });

  it("turnsUsed >= maxTurns → turn_limit", () => {
    expect(classifyOutcome(0, { turnsUsed: 50, maxTurns: 50 })).toBe("turn_limit");
    expect(classifyOutcome(0, { turnsUsed: 51, maxTurns: 50 })).toBe("turn_limit");
  });

  it("clean exit under the turn budget → completed", () => {
    expect(classifyOutcome(0, { turnsUsed: 10, maxTurns: 50 })).toBe("completed");
    expect(classifyOutcome(0, { maxTurns: 50 })).toBe("completed");
  });

  it("null returncode (unknown exit) is treated as non-zero → error", () => {
    expect(classifyOutcome(null, { turnsUsed: 1, maxTurns: 50 })).toBe("error");
  });
});

// ── assertAgentCli (runtime guard) ──────────────────────────────────────────

describe("assertAgentCli", () => {
  it("accepts a kind:'agent-cli' provider", () => {
    expect(() => assertAgentCli(claudeProvider)).not.toThrow();
  });

  it("rejects a kind:'model-endpoint' provider", () => {
    expect(() => assertAgentCli(endpointProvider)).toThrow(/model-endpoint/);
  });
});

// ── claude -p dispatch ──────────────────────────────────────────────────────

describe("makeClaudeCliDispatch", () => {
  it("resolves an AgentResult; the patch artifact comes from harvest, NOT the agent", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: 0,
      turnsUsed: 12,
      cost: 0.42,
      timedOut: false,
    });
    const harvest = patchHarvest("diff --git a/x b/x\n+real");
    const dispatch = makeClaudeCliDispatch({ run, harvest }, OPTS);

    const r = await dispatch(TASK, claudeProvider);

    expect(r).toEqual({
      artifacts: [{ kind: "patch", diff: "diff --git a/x b/x\n+real", base: BASE }],
      turns: 12,
      outcome: "completed",
      cost: 0.42,
    });
    expect(patchArtifact(r)?.diff).toBe("diff --git a/x b/x\n+real");
    expect(run).toHaveBeenCalledWith(TASK, claudeProvider);
    // harvest receives the one-shot RunContext: empty PUSH channel, environment
    // carrying the worktree + base for the PULL (git-diff) channel.
    expect(harvest).toHaveBeenCalledWith({
      emitted: [],
      environment: { worktree: "/tmp/wt", baseCommit: BASE },
    });
  });

  it("timedOut from the runner → outcome timeout (patch still harvested)", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: null,
      turnsUsed: 3,
      cost: 0.1,
      timedOut: true,
    });
    const dispatch = makeClaudeCliDispatch({ run, harvest: patchHarvest("partial") }, OPTS);

    const r = await dispatch(TASK, claudeProvider);
    expect(r.outcome).toBe("timeout");
    expect(patchArtifact(r)?.diff).toBe("partial");
  });

  it("turn-limit signal classifies as turn_limit", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: 0,
      turnsUsed: 50,
      cost: 1,
      timedOut: false,
    });
    const dispatch = makeClaudeCliDispatch({ run, harvest: patchHarvest("") }, OPTS);
    expect((await dispatch(TASK, claudeProvider)).outcome).toBe("turn_limit");
  });

  it("rejects a model-endpoint provider before running anything", async () => {
    const run = vi.fn();
    const dispatch = makeClaudeCliDispatch({ run, harvest: patchHarvest("") }, OPTS);
    await expect(dispatch(TASK, endpointProvider)).rejects.toThrow(/model-endpoint/);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes NO finalMessage — claude-cli is not the value-harvest target (RDR-010 RF-1)", async () => {
    const harvest = vi.fn(async (_run: RunContext): Promise<Artifact[]> => []);
    const run = vi.fn().mockResolvedValue({ returncode: 0, turnsUsed: 1, cost: 0, timedOut: false });
    const dispatch = makeClaudeCliDispatch({ run, harvest }, OPTS);
    await dispatch(TASK, claudeProvider);
    // ClaudeRunResult has no finalMessage source; the qwen<->claude asymmetry is
    // intentional (RDR-010: the value-harvest source is the qwen poll path).
    expect("finalMessage" in harvest.mock.calls[0]![0]).toBe(false);
  });
});

// ── qwen_spawn dispatch (poll-to-completion) ────────────────────────────────

describe("makeQwenSpawnDispatch", () => {
  it("polls to completion (blocking) then resolves; harvest runs once after terminal", async () => {
    const spawn = vi.fn().mockResolvedValue("task-1");
    // running, running, then complete — the loop must not resolve early.
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ state: "complete", turnsUsed: 7, cost: 0 });
    const harvest = patchHarvest("qwen-diff");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dispatch = makeQwenSpawnDispatch({ spawn, poll, harvest, sleep, now: () => 0 }, OPTS);

    const r = await dispatch(TASK, qwenProvider);

    expect(spawn).toHaveBeenCalledWith(TASK, qwenProvider);
    expect(poll).toHaveBeenCalledTimes(3); // blocked until the 3rd (terminal) poll
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      artifacts: [{ kind: "patch", diff: "qwen-diff", base: BASE }],
      turns: 7,
      outcome: "completed",
      cost: 0,
    });
  });

  it("threads the terminal lastMessage into RunContext.finalMessage (RDR-010 qwen value-harvest)", async () => {
    const harvest = vi.fn(async (_run: RunContext): Promise<Artifact[]> => []);
    const poll = vi.fn().mockResolvedValue({ state: "complete", turnsUsed: 2, lastMessage: '{"plan":"x"}' });
    const dispatch = makeQwenSpawnDispatch(
      { spawn: async () => "t", poll, harvest, sleep: async () => {}, now: () => 0 },
      OPTS,
    );
    await dispatch(TASK, qwenProvider);
    expect(harvest).toHaveBeenCalledWith({
      emitted: [],
      environment: { worktree: "/tmp/wt", baseCommit: BASE },
      finalMessage: '{"plan":"x"}',
    });
  });

  it("omits finalMessage when the terminal snapshot has none (conditional spread)", async () => {
    const harvest = vi.fn(async (_run: RunContext): Promise<Artifact[]> => []);
    const poll = vi.fn().mockResolvedValue({ state: "complete", turnsUsed: 2 });
    const dispatch = makeQwenSpawnDispatch(
      { spawn: async () => "t", poll, harvest, sleep: async () => {}, now: () => 0 },
      OPTS,
    );
    await dispatch(TASK, qwenProvider);
    expect("finalMessage" in harvest.mock.calls[0]![0]).toBe(false);
  });

  it("error terminal state → outcome error (turns/cost carried through)", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "error", turnsUsed: 2 }),
      harvest: patchHarvest(""),
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r).toEqual({
      artifacts: [{ kind: "patch", diff: "", base: BASE }],
      turns: 2,
      outcome: "error",
      cost: 0,
    });
  });

  it("idle at the turn budget → turn_limit (compound idle + turns>=max)", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "idle", turnsUsed: TASK.maxTurns, cost: 0 }),
      harvest: patchHarvest("p"),
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    expect((await dispatch(TASK, qwenProvider)).outcome).toBe("turn_limit");
  });

  it("idle is a terminal state for a one-shot agentic run", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "idle", turnsUsed: 4, cost: 0 }),
      harvest: patchHarvest("p"),
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("completed");
    expect(r.turns).toBe(4);
  });

  it("wall-clock deadline fires → outcome timeout (patch still harvested)", async () => {
    // poll never reaches a terminal state; now() jumps past the deadline.
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(TASK.timeout + 1);
    const harvest = patchHarvest("whatever-was-written");
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "running" }),
      harvest,
      sleep: async () => {},
      now,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("timeout");
    expect(harvest).toHaveBeenCalledTimes(1);
  });

  it("wall-clock timeout reaps the session via the stop effect", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(TASK.timeout + 1);
    const stop = vi.fn().mockResolvedValue(undefined);
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "task-xyz",
      poll: async () => ({ state: "running" }),
      harvest: patchHarvest("partial"),
      sleep: async () => {},
      now,
      stop,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("timeout");
    // The orphaned session must be stopped with the spawned task id.
    expect(stop).toHaveBeenCalledWith("task-xyz");
  });

  it("does NOT call stop on a clean terminal exit", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "complete" }),
      harvest: patchHarvest(""),
      sleep: async () => {},
      now: () => 0,
      stop,
    }, OPTS);
    await dispatch(TASK, qwenProvider);
    expect(stop).not.toHaveBeenCalled();
  });

  it("a throwing stop effect does not mask the timeout result", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(TASK.timeout + 1);
    const stop = vi.fn().mockRejectedValue(new Error("stop failed"));
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "running" }),
      harvest: patchHarvest("partial"),
      sleep: async () => {},
      now,
      stop,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("timeout");
  });

  it("rejects a model-endpoint provider before spawning", async () => {
    const spawn = vi.fn();
    const dispatch = makeQwenSpawnDispatch({
      spawn,
      poll: async () => ({ state: "complete" }),
      harvest: patchHarvest(""),
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    await expect(dispatch(TASK, endpointProvider)).rejects.toThrow(/model-endpoint/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
