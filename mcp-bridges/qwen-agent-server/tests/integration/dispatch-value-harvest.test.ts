// SPDX-License-Identifier: MIT
//
// RDR-010 P2 integration test (bead qwen-coprocessor-stack-2ee): the executor
// value-harvest end-to-end. A dispatched leaf's terminal structured return
// (PollResult.last_message → QwenPollSnapshot.lastMessage → RunContext.finalMessage)
// is harvested into a {kind:"value"} artifact when the run selects harvest:"value"
// (or "both"), through the FULL dispatch machinery (real supervisor adapter + real
// dispatcher + real selectHarvester), with a stub spawn/poll (no live Qwen).
//
// This is the RDR-010 MVV: a structured non-patch artifact is reachable through a
// real qwen_dispatch path, not a hand-built RunContext. The default harvest:"patch"
// is exercised too (the regression guard — coding runs unchanged).

import { describe, expect, it, vi } from "vitest";

import { makeQwenSpawnDispatch } from "../../src/dispatch.js";
import { makeSupervisorQwenSpawnEffects, selectHarvester } from "../../src/dispatch-tool.js";
import { patchArtifact } from "../../src/types.js";
import type { AgentProvider, AgentTask } from "../../src/types.js";

const provider: AgentProvider = {
  id: "qwen-coder-mac",
  kind: "agent-cli",
  agentKind: "qwen-local",
  modalities: ["text"],
  excludes: [],
  costClass: "free-local",
};

const TASK: AgentTask = {
  prompt: "produce the plan",
  worktree: "/work/wt",
  maxTurns: 50,
  minTokens: 16384,
  timeout: 600_000,
};

const BASE = "base-sha";

/** A stub supervisor whose terminal poll returns `lastMessage` (the leaf's
 *  structured return) — no real Qwen, no real git. */
function stubHandlers(lastMessage: string) {
  return {
    qwen_spawn: vi.fn().mockResolvedValue({ task_id: "t-1", chosen_backend: "mac" }),
    qwen_poll: vi.fn().mockResolvedValue({
      state: "complete",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "1",
      turns_completed: 3,
      last_message: lastMessage,
    }),
  };
}

describe("qwen_dispatch value-harvest (RDR-010 P2, end-to-end via the real adapter+dispatcher)", () => {
  it('harvest:"value" returns the leaf finalMessage as a {kind:"value"} (parsed JSON)', async () => {
    const plan = JSON.stringify({ phases: 2, beads: ["a", "b"] });
    const effects = makeSupervisorQwenSpawnEffects(
      stubHandlers(plan),
      async () => "UNUSED git diff",
      { clock: { now: () => 0, sleep: async () => {} }, harvest: selectHarvester("value", async () => "UNUSED") },
    );
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: BASE });

    const result = await dispatch(TASK, provider);

    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(3);
    // The value artifact carries the parsed plan; NO patch artifact (value mode).
    expect(result.artifacts).toEqual([{ kind: "value", value: { phases: 2, beads: ["a", "b"] } }]);
    expect(patchArtifact(result)).toBeUndefined();
  });

  it('harvest:"both" returns the git-diff patch AND the value (patch first, value last)', async () => {
    const effects = makeSupervisorQwenSpawnEffects(
      stubHandlers('{"ok":true}'),
      async () => "diff --git a/x b/x\n",
      { clock: { now: () => 0, sleep: async () => {} }, harvest: selectHarvester("both", async () => "diff --git a/x b/x\n") },
    );
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: BASE });

    const result = await dispatch(TASK, provider);

    expect(result.artifacts).toEqual([
      { kind: "patch", diff: "diff --git a/x b/x\n", base: BASE },
      { kind: "value", value: { ok: true } },
    ]);
  });

  it('default harvest:"patch" is unchanged — one patch artifact, no value (regression guard)', async () => {
    const effects = makeSupervisorQwenSpawnEffects(
      stubHandlers('{"ignored":"in patch mode"}'),
      async () => "diff --git a/x b/x\n",
      { clock: { now: () => 0, sleep: async () => {} }, harvest: selectHarvester("patch", async () => "diff --git a/x b/x\n") },
    );
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: BASE });

    const result = await dispatch(TASK, provider);

    expect(result.artifacts).toEqual([{ kind: "patch", diff: "diff --git a/x b/x\n", base: BASE }]);
  });

  it('harvest:"value" with no finalMessage yields [] (leaf returned nothing structured)', async () => {
    const handlers = {
      qwen_spawn: vi.fn().mockResolvedValue({ task_id: "t", chosen_backend: "mac" }),
      qwen_poll: vi.fn().mockResolvedValue({
        state: "complete",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "1",
        turns_completed: 1,
      }),
    };
    const effects = makeSupervisorQwenSpawnEffects(handlers, async () => "x", {
      clock: { now: () => 0, sleep: async () => {} },
      harvest: selectHarvester("value", async () => "x"),
    });
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: BASE });

    expect((await dispatch(TASK, provider)).artifacts).toEqual([]);
  });
});
