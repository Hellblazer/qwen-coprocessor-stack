// SPDX-License-Identifier: MIT
//
// Tests for src/dispatch-registry.ts — the RDR-008 P1 dispatcher registry
// (bead qwen-coprocessor-stack-q8k). The registry is the plugin SEAM:
// providerKind (`AgentProvider.agentKind`) → `Dispatch`. Resolving + invoking
// a dispatcher is uniform; adding a new kind is a registration. Single-member
// by design until a real second dispatcher appears (RDR-008 discipline) — these
// tests register the local-Qwen dispatcher only.
//
// No real processes / network: the registered Dispatch is a fake.

import { describe, expect, it, vi } from "vitest";

import { createDispatcherRegistry } from "../src/dispatch-registry.js";
import type { Dispatch } from "../src/dispatch.js";
import type { AgentProvider, AgentResult, AgentTask } from "../src/types.js";

const TASK: AgentTask = {
  prompt: "fix the bug",
  worktree: "/tmp/wt",
  maxTurns: 50,
  minTokens: 16384,
  timeout: 600_000,
};

const RESULT: AgentResult = { patch: "diff", turns: 3, outcome: "completed", cost: 0 };

const qwenProvider: AgentProvider = {
  id: "qwen-coder-mac",
  kind: "agent-cli",
  agentKind: "qwen-local",
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

describe("createDispatcherRegistry", () => {
  it("resolves a registered providerKind to its Dispatch and invokes it", async () => {
    const fake: Dispatch = vi.fn().mockResolvedValue(RESULT);
    const registry = createDispatcherRegistry();
    registry.register("qwen-local", fake);

    const dispatch = registry.resolve(qwenProvider);
    const r = await dispatch(TASK, qwenProvider);

    expect(r).toEqual(RESULT);
    expect(fake).toHaveBeenCalledWith(TASK, qwenProvider);
  });

  it("knows whether a providerKind is registered", () => {
    const registry = createDispatcherRegistry();
    expect(registry.has("qwen-local")).toBe(false);
    registry.register("qwen-local", async () => RESULT);
    expect(registry.has("qwen-local")).toBe(true);
    expect(registry.kinds()).toEqual(["qwen-local"]);
  });

  it("resolve rejects a kind:'model-endpoint' provider (no agentic loop)", () => {
    const registry = createDispatcherRegistry();
    registry.register("qwen-local", async () => RESULT);
    expect(() => registry.resolve(endpointProvider)).toThrow(/model-endpoint/);
  });

  it("resolve throws on an agent-cli provider with no agentKind declared", () => {
    const registry = createDispatcherRegistry();
    registry.register("qwen-local", async () => RESULT);
    const undeclared: AgentProvider = {
      id: "mystery",
      kind: "agent-cli",
      modalities: ["text"],
      excludes: [],
    };
    expect(() => registry.resolve(undeclared)).toThrow(/agentKind/);
  });

  it("resolve throws a clear error for an unregistered providerKind", () => {
    const registry = createDispatcherRegistry();
    // nothing registered
    expect(() => registry.resolve(qwenProvider)).toThrow(/qwen-local/);
  });

  it("register is last-write-wins for the same providerKind", async () => {
    const first: Dispatch = vi.fn().mockResolvedValue(RESULT);
    const second: Dispatch = vi.fn().mockResolvedValue({ ...RESULT, turns: 9 });
    const registry = createDispatcherRegistry();
    registry.register("qwen-local", first);
    registry.register("qwen-local", second);

    const r = await registry.resolve(qwenProvider)(TASK, qwenProvider);
    expect(r.turns).toBe(9);
    expect(first).not.toHaveBeenCalled();
  });
});
