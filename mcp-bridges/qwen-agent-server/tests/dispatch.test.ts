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
import type { AgentProvider, AgentTask } from "../src/types.js";

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
  it("resolves an AgentResult; patch comes from extractPatch, NOT the agent", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: 0,
      turnsUsed: 12,
      cost: 0.42,
      timedOut: false,
    });
    const extractPatch = vi.fn().mockResolvedValue("diff --git a/x b/x\n+real");
    const dispatch = makeClaudeCliDispatch({ run, extractPatch }, OPTS);

    const r = await dispatch(TASK, claudeProvider);

    expect(r).toEqual({
      patch: "diff --git a/x b/x\n+real",
      turns: 12,
      outcome: "completed",
      cost: 0.42,
    });
    expect(run).toHaveBeenCalledWith(TASK, claudeProvider);
    expect(extractPatch).toHaveBeenCalledWith("/tmp/wt", BASE);
  });

  it("timedOut from the runner → outcome timeout (patch still extracted)", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: null,
      turnsUsed: 3,
      cost: 0.1,
      timedOut: true,
    });
    const extractPatch = vi.fn().mockResolvedValue("partial");
    const dispatch = makeClaudeCliDispatch({ run, extractPatch }, OPTS);

    const r = await dispatch(TASK, claudeProvider);
    expect(r.outcome).toBe("timeout");
    expect(r.patch).toBe("partial");
  });

  it("turn-limit signal classifies as turn_limit", async () => {
    const run = vi.fn().mockResolvedValue({
      returncode: 0,
      turnsUsed: 50,
      cost: 1,
      timedOut: false,
    });
    const dispatch = makeClaudeCliDispatch({ run, extractPatch: async () => "" }, OPTS);
    expect((await dispatch(TASK, claudeProvider)).outcome).toBe("turn_limit");
  });

  it("rejects a model-endpoint provider before running anything", async () => {
    const run = vi.fn();
    const dispatch = makeClaudeCliDispatch({ run, extractPatch: async () => "" }, OPTS);
    await expect(dispatch(TASK, endpointProvider)).rejects.toThrow(/model-endpoint/);
    expect(run).not.toHaveBeenCalled();
  });
});

// ── qwen_spawn dispatch (poll-to-completion) ────────────────────────────────

describe("makeQwenSpawnDispatch", () => {
  it("polls to completion (blocking) then resolves; extractPatch runs once after terminal", async () => {
    const spawn = vi.fn().mockResolvedValue("task-1");
    // running, running, then complete — the loop must not resolve early.
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ state: "running" })
      .mockResolvedValueOnce({ state: "complete", turnsUsed: 7, cost: 0 });
    const extractPatch = vi.fn().mockResolvedValue("qwen-diff");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const dispatch = makeQwenSpawnDispatch({ spawn, poll, extractPatch, sleep, now: () => 0 }, OPTS);

    const r = await dispatch(TASK, qwenProvider);

    expect(spawn).toHaveBeenCalledWith(TASK, qwenProvider);
    expect(poll).toHaveBeenCalledTimes(3); // blocked until the 3rd (terminal) poll
    expect(extractPatch).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ patch: "qwen-diff", turns: 7, outcome: "completed", cost: 0 });
  });

  it("error terminal state → outcome error (turns/cost carried through)", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "error", turnsUsed: 2 }),
      extractPatch: async () => "",
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r).toEqual({ patch: "", turns: 2, outcome: "error", cost: 0 });
  });

  it("idle at the turn budget → turn_limit (compound idle + turns>=max)", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "idle", turnsUsed: TASK.maxTurns, cost: 0 }),
      extractPatch: async () => "p",
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    expect((await dispatch(TASK, qwenProvider)).outcome).toBe("turn_limit");
  });

  it("idle is a terminal state for a one-shot agentic run", async () => {
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "idle", turnsUsed: 4, cost: 0 }),
      extractPatch: async () => "p",
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("completed");
    expect(r.turns).toBe(4);
  });

  it("wall-clock deadline fires → outcome timeout (patch still extracted)", async () => {
    // poll never reaches a terminal state; now() jumps past the deadline.
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(TASK.timeout + 1);
    const extractPatch = vi.fn().mockResolvedValue("whatever-was-written");
    const dispatch = makeQwenSpawnDispatch({
      spawn: async () => "t",
      poll: async () => ({ state: "running" }),
      extractPatch,
      sleep: async () => {},
      now,
    }, OPTS);
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("timeout");
    expect(extractPatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a model-endpoint provider before spawning", async () => {
    const spawn = vi.fn();
    const dispatch = makeQwenSpawnDispatch({
      spawn,
      poll: async () => ({ state: "complete" }),
      extractPatch: async () => "",
      sleep: async () => {},
      now: () => 0,
    }, OPTS);
    await expect(dispatch(TASK, endpointProvider)).rejects.toThrow(/model-endpoint/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
