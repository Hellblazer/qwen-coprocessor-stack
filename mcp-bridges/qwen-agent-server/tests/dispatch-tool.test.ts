// SPDX-License-Identifier: MIT
//
// Unit tests for src/dispatch-tool.ts — the qwen_dispatch orchestration
// (RDR-008 P2, bead qwen-coprocessor-stack-exn). No git / no supervisor: the
// registry resolution and the spawn/poll handlers are injected as fakes. The
// real-git base_commit semantics are covered by the integration test
// (tests/integration/dispatch-base-commit.test.ts).

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  countDeniedWrites,
  makeSupervisorQwenSpawnEffects,
  qwenDispatchInputShape,
  QwenDispatchError,
  runQwenDispatch,
  type QwenDispatchInput,
} from "../src/dispatch-tool.js";
import { makeQwenSpawnDispatch, type Dispatch } from "../src/dispatch.js";
import type { AgentProvider, AgentResult, AgentTask } from "../src/types.js";

describe("qwenDispatchInputShape — input validation", () => {
  const schema = z.object(qwenDispatchInputShape);
  const base = { prompt: "fix it", base_commit: "abc123" };

  it("rejects a relative worktree path (would make `git -C` diff the wrong tree)", () => {
    const r = schema.safeParse({ ...base, worktree: "relative/path" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /absolute/.test(i.message))).toBe(true);
    }
  });

  it("accepts an absolute worktree path", () => {
    expect(schema.safeParse({ ...base, worktree: "/abs/wt" }).success).toBe(true);
  });

  it("rejects an unknown agent_kind at input validation (not downstream as 'no provider')", () => {
    expect(schema.safeParse({ ...base, worktree: "/wt", agent_kind: "claude-local" }).success).toBe(
      false,
    );
  });

  it("accepts the known agent_kind 'qwen-local'", () => {
    expect(
      schema.safeParse({ ...base, worktree: "/wt", agent_kind: "qwen-local" }).success,
    ).toBe(true);
  });
});

const qwenProvider: AgentProvider = {
  id: "qwen-coder-mac",
  kind: "agent-cli",
  agentKind: "qwen-local",
  modalities: ["text"],
  excludes: [],
  costClass: "free-local",
};

const RESULT: AgentResult = {
  artifacts: [{ kind: "patch", diff: "diff", base: "abc123" }],
  turns: 4,
  outcome: "completed",
  cost: 0,
};

const INPUT: QwenDispatchInput = {
  prompt: "fix it",
  worktree: "/work/wt",
  base_commit: "abc123",
};

describe("runQwenDispatch", () => {
  it("selects by default agentKind, resolves, runs, returns AgentResult", async () => {
    const dispatch: Dispatch = vi.fn().mockResolvedValue(RESULT);
    const resolveDispatch = vi.fn().mockReturnValue(dispatch);

    const r = await runQwenDispatch(INPUT, {
      loadProviders: () => [qwenProvider],
      resolveDispatch,
    });

    expect(r).toEqual(RESULT);
    // base_commit threaded to the resolver (→ extractPatch), not onto AgentTask.
    expect(resolveDispatch).toHaveBeenCalledWith(qwenProvider, "abc123");
    const task = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AgentTask;
    expect(task).toEqual({
      prompt: "fix it",
      worktree: "/work/wt",
      maxTurns: 50,
      minTokens: 16384,
      timeout: 1_800_000,
    });
    expect("base_commit" in task).toBe(false);
  });

  it("honours explicit overrides (turns/tokens/timeout)", async () => {
    const dispatch: Dispatch = vi.fn().mockResolvedValue(RESULT);
    await runQwenDispatch(
      { ...INPUT, max_turns: 10, min_tokens: 4096, timeout_ms: 1000 },
      { loadProviders: () => [qwenProvider], resolveDispatch: () => dispatch },
    );
    const task = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AgentTask;
    expect(task.maxTurns).toBe(10);
    expect(task.minTokens).toBe(4096);
    expect(task.timeout).toBe(1000);
  });

  it("pins by provider_id over agentKind", async () => {
    const other: AgentProvider = { ...qwenProvider, id: "qwen-coder-box" };
    const resolveDispatch = vi.fn().mockReturnValue(vi.fn().mockResolvedValue(RESULT));
    await runQwenDispatch(
      { ...INPUT, provider_id: "qwen-coder-box" },
      { loadProviders: () => [qwenProvider, other], resolveDispatch },
    );
    expect(resolveDispatch).toHaveBeenCalledWith(other, "abc123");
  });

  it("throws no_provider when nothing matches", async () => {
    await expect(
      runQwenDispatch(INPUT, { loadProviders: () => [], resolveDispatch: () => vi.fn() as never }),
    ).rejects.toMatchObject({ code: "no_provider" });
  });

  it("rejects a request with NEITHER worktree nor repo (invalid_worktree_spec)", async () => {
    const { worktree: _omit, ...noWorktree } = INPUT;
    await expect(
      runQwenDispatch(noWorktree as QwenDispatchInput, {
        loadProviders: () => [qwenProvider],
        resolveDispatch: () => vi.fn() as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_worktree_spec" });
  });

  it("rejects a request with BOTH worktree and repo (invalid_worktree_spec)", async () => {
    await expect(
      runQwenDispatch(
        { ...INPUT, repo: "acme/calc" },
        { loadProviders: () => [qwenProvider], resolveDispatch: () => vi.fn() as never },
      ),
    ).rejects.toMatchObject({ code: "invalid_worktree_spec" });
  });

  it("repo-mode selects the injected (executor-managed) worktree strategy", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockResolvedValue({ worktree: "/managed/acme", cleanup });
    const dispatch = vi.fn().mockResolvedValue(RESULT);
    const { worktree: _omit, ...repoInput } = INPUT;

    await runQwenDispatch(
      { ...repoInput, repo: "acme/calc" } as QwenDispatchInput,
      {
        loadProviders: () => [qwenProvider],
        resolveDispatch: () => dispatch,
        resolveWorktree: () => ({ prepare }),
      },
    );

    const task = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AgentTask;
    expect(task.worktree).toBe("/managed/acme");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("prepares the worktree strategy, runs on its path, and cleans up after", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const prepare = vi.fn().mockResolvedValue({ worktree: "/managed/wt", cleanup });
    const dispatch = vi.fn().mockResolvedValue(RESULT);

    await runQwenDispatch(INPUT, {
      loadProviders: () => [qwenProvider],
      resolveDispatch: () => dispatch,
      resolveWorktree: () => ({ prepare }),
    });

    // The task runs on the PREPARED worktree, not input.worktree directly.
    const task = (dispatch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as AgentTask;
    expect(task.worktree).toBe("/managed/wt");
    expect(prepare).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("cleans up the worktree even when dispatch throws (finally)", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    await expect(
      runQwenDispatch(INPUT, {
        loadProviders: () => [qwenProvider],
        resolveDispatch: () => async () => {
          throw new Error("boom");
        },
        resolveWorktree: () => ({ prepare: async () => ({ worktree: "/m", cleanup }) }),
      }),
    ).rejects.toThrow("boom");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("a cleanup failure does NOT mask a successful dispatch result", async () => {
    const dispatch = vi.fn().mockResolvedValue(RESULT);
    const cleanup = vi.fn().mockRejectedValue(new Error("prune failed"));
    const r = await runQwenDispatch(INPUT, {
      loadProviders: () => [qwenProvider],
      resolveDispatch: () => dispatch,
      resolveWorktree: () => ({ prepare: async () => ({ worktree: "/m", cleanup }) }),
    });
    expect(r).toEqual(RESULT); // cleanup error logged + swallowed, result preserved
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("a cleanup failure does NOT mask the original dispatch error", async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error("prune failed"));
    await expect(
      runQwenDispatch(INPUT, {
        loadProviders: () => [qwenProvider],
        resolveDispatch: () => async () => {
          throw new Error("dispatch boom");
        },
        resolveWorktree: () => ({ prepare: async () => ({ worktree: "/m", cleanup }) }),
      }),
    ).rejects.toThrow("dispatch boom"); // NOT "prune failed"
  });

  it("maps a registry resolution failure to unregistered_kind", async () => {
    await expect(
      runQwenDispatch(INPUT, {
        loadProviders: () => [qwenProvider],
        resolveDispatch: () => {
          throw new Error("no dispatcher registered for agentKind");
        },
      }),
    ).rejects.toBeInstanceOf(QwenDispatchError);
  });

  it("throws missing_agent_kind when a pinned provider declares no agentKind", async () => {
    const undeclared: AgentProvider = {
      id: "mystery",
      kind: "agent-cli",
      modalities: ["text"],
      excludes: [],
    };
    const resolveDispatch = vi.fn();
    await expect(
      runQwenDispatch(
        { ...INPUT, provider_id: "mystery" },
        { loadProviders: () => [undeclared], resolveDispatch: resolveDispatch as never },
      ),
    ).rejects.toMatchObject({ code: "missing_agent_kind" });
    // Never reaches the registry — it's a config error, not a registration gap.
    expect(resolveDispatch).not.toHaveBeenCalled();
  });
});

describe("makeSupervisorQwenSpawnEffects", () => {
  const TASK: AgentTask = {
    prompt: "do",
    worktree: "/wt",
    maxTurns: 5,
    minTokens: 8192,
    timeout: 1000,
  };

  it("spawn forwards prompt + worktree cwd + token floor, returns task_id", async () => {
    const qwen_spawn = vi.fn().mockResolvedValue({ task_id: "t-9", chosen_backend: "mac" });
    const effects = makeSupervisorQwenSpawnEffects(
      { qwen_spawn, qwen_poll: vi.fn() },
      async () => "",
    );
    const id = await effects.spawn(TASK, qwenProvider);
    expect(id).toBe("t-9");
    expect(qwen_spawn).toHaveBeenCalledWith({
      task: "do",
      opts: { cwd: "/wt", max_output_tokens: 8192, write_authority: true },
    });
  });

  // ── bead n8c: write authority + refused-write accounting ──

  it("spawn grants write_authority by DEFAULT — dispatch owns the worktree (n8c)", async () => {
    const qwen_spawn = vi.fn().mockResolvedValue({ task_id: "t-1", chosen_backend: "box" });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn, qwen_poll: vi.fn() }, async () => "");
    await effects.spawn(TASK, qwenProvider);
    expect(qwen_spawn.mock.calls[0]![0].opts.write_authority).toBe(true);
  });

  it("spawn honours an explicit writeAuthority:false (read-only value run)", async () => {
    const qwen_spawn = vi.fn().mockResolvedValue({ task_id: "t-1", chosen_backend: "box" });
    const effects = makeSupervisorQwenSpawnEffects(
      { qwen_spawn, qwen_poll: vi.fn() },
      async () => "",
      { writeAuthority: false },
    );
    await effects.spawn(TASK, qwenProvider);
    expect(qwen_spawn.mock.calls[0]![0].opts.write_authority).toBe(false);
  });

  it("poll walks the event stream by cursor and accumulates write denials across polls", async () => {
    const denied = (id: string, tool: string) => ({
      id,
      type: "permission_denied",
      ts: 0,
      summary: `write_authority not granted for ${tool}`,
      data: { tool_name: tool, input: {} },
    });
    const qwen_poll = vi
      .fn()
      .mockResolvedValueOnce({
        state: "running",
        recent_events: [denied("1", "edit"), { id: "2", type: "tool_call", ts: 0, summary: "read_file" }],
        more_events_available: false,
        latest_event_id: "2",
        turns_completed: 0,
      })
      .mockResolvedValueOnce({
        state: "complete",
        recent_events: [denied("3", "write_file"), denied("4", "run_shell_command")],
        more_events_available: false,
        latest_event_id: "4",
        turns_completed: 1,
      });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    const s1 = await effects.poll("t");
    const s2 = await effects.poll("t");
    expect(s1.deniedWrites).toBe(1);
    expect(s2.deniedWrites).toBe(3);
    // Cursor threaded: first call from "0", second from the last id seen.
    expect(qwen_poll.mock.calls[0]![0].opts.since).toBe("0");
    expect(qwen_poll.mock.calls[1]![0].opts.since).toBe("2");
  });

  it("poll drains a page backlog (more_events_available) within one dispatcher poll", async () => {
    const denied = (id: string) => ({
      id,
      type: "permission_denied",
      ts: 0,
      summary: "write_authority not granted for edit",
      data: { tool_name: "edit", input: {} },
    });
    const qwen_poll = vi
      .fn()
      .mockResolvedValueOnce({ state: "running", recent_events: [denied("1")], more_events_available: true, latest_event_id: "1" })
      .mockResolvedValueOnce({ state: "running", recent_events: [denied("2")], more_events_available: true, latest_event_id: "2" })
      .mockResolvedValueOnce({ state: "running", recent_events: [denied("3")], more_events_available: false, latest_event_id: "3" });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    const snap = await effects.poll("t");
    expect(qwen_poll).toHaveBeenCalledTimes(3);
    expect(snap.deniedWrites).toBe(3);
    expect(qwen_poll.mock.calls[2]![0].opts.since).toBe("2");
  });

  it("countDeniedWrites ignores non-write denials (ask_user_question) and non-denial events", () => {
    expect(
      countDeniedWrites([
        { id: "1", type: "permission_denied", ts: 0, summary: "x", data: { tool_name: "ask_user_question" } },
        { id: "2", type: "permission_denied", ts: 0, summary: "x", data: { tool_name: "edit" } },
        { id: "3", type: "permission_denied", ts: 0, summary: "x" },
        { id: "4", type: "tool_result", ts: 0, summary: "x", data: { tool_name: "edit" } },
      ]),
    ).toBe(1);
    expect(countDeniedWrites(undefined)).toBe(0);
  });

  it("end-to-end: every write refused + empty patch → outcome error, not completed (n8c)", async () => {
    const denied = { id: "1", type: "permission_denied", ts: 0, summary: "x", data: { tool_name: "edit" } };
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "complete",
      recent_events: [denied],
      more_events_available: false,
      latest_event_id: "1",
      turns_completed: 1,
    });
    const effects = makeSupervisorQwenSpawnEffects(
      { qwen_spawn: vi.fn().mockResolvedValue({ task_id: "t", chosen_backend: "b" }), qwen_poll },
      async () => "",
    );
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: "base" });
    const r = await dispatch(TASK, qwenProvider);
    expect(r.outcome).toBe("error");
    expect(r.artifacts).toEqual([{ kind: "patch", diff: "", base: "base" }]);
    expect(r.turns).toBe(1);
  });

  it("spawn throws on a supervisor error result", async () => {
    const qwen_spawn = vi.fn().mockResolvedValue({ error: { code: "spawn_no_backend", message: "none" } });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn, qwen_poll: vi.fn() }, async () => "");
    await expect(effects.spawn(TASK, qwenProvider)).rejects.toThrow(/spawn_no_backend/);
  });

  it("poll THROWS on session eviction (task_id_not_found) — infra failure, not a clean error outcome", async () => {
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "error",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "0",
      error: { code: "task_id_not_found", message: "no such task" },
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    await expect(effects.poll("gone")).rejects.toThrow(/evicted/);
  });

  it("poll maps turns from the always-present turns_completed on a SUCCESS poll (j2r)", async () => {
    const qwen_poll = vi
      .fn()
      .mockResolvedValueOnce({ state: "running", recent_events: [], more_events_available: false, latest_event_id: "0", turns_completed: 0 })
      .mockResolvedValueOnce({
        state: "complete",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "1",
        turns_completed: 4, // success path now carries the real count, not 0
      });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    expect(await effects.poll("t")).toEqual({ state: "running", turnsUsed: 0, deniedWrites: 0 });
    expect(await effects.poll("t")).toEqual({ state: "complete", turnsUsed: 4, deniedWrites: 0 });
  });

  it("poll maps last_message into the snapshot (RDR-010 finalMessage source)", async () => {
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "complete",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "1",
      turns_completed: 2,
      last_message: '{"plan":"x"}',
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    expect(await effects.poll("t")).toEqual({
      state: "complete",
      turnsUsed: 2,
      deniedWrites: 0,
      lastMessage: '{"plan":"x"}',
    });
  });

  it("poll does NOT thread last_message on a non-terminal (running) snapshot (state-gated)", async () => {
    // Defense-in-depth: even if a supervisor erroneously sends last_message on a
    // running poll, the adapter state-gates it (idle/complete only), keeping the
    // snapshot's "terminal only" invariant honest at every poll.
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "running",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "0",
      turns_completed: 0,
      last_message: '{"premature":"x"}',
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    expect("lastMessage" in (await effects.poll("t"))).toBe(false);
  });

  it("poll omits lastMessage when the poll result has none (conditional)", async () => {
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "running",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "0",
      turns_completed: 0,
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    expect("lastMessage" in (await effects.poll("t"))).toBe(false);
  });

  it("poll falls back to last_known.turns_completed for a pre-j2r supervisor", async () => {
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "error",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "1",
      last_known: { turns_completed: 6 },
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: vi.fn(), qwen_poll }, async () => "");
    expect(await effects.poll("t")).toEqual({ state: "error", turnsUsed: 6, deniedWrites: 0 });
  });

  // End-to-end TRIPWIRE for the retired "turns=0 on success" caveat (R-review):
  // proves turns_completed flows PollResult -> adapter -> dispatcher ->
  // AgentResult.turns. If the mapping regresses to 0, this fails (the conformance
  // fixture only checks key presence, not the value).
  it("turns_completed flows end-to-end to AgentResult.turns on a SUCCESS run (j2r)", async () => {
    const qwen_spawn = vi.fn().mockResolvedValue({ task_id: "t", chosen_backend: "mac" });
    const qwen_poll = vi.fn().mockResolvedValue({
      state: "complete",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "1",
      turns_completed: 4, // success path carries the real count
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn, qwen_poll }, async () => "diff");
    const dispatch = makeQwenSpawnDispatch(effects, { baseCommit: "base-sha" });

    const result = await dispatch(TASK, qwenProvider);

    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(4); // NOT 0 — the caveat is genuinely retired
  });
});
