// SPDX-License-Identifier: MIT
//
// Tests for the 5 MCP tools wired in server.ts.
// All heavy deps (SDK, QwenSession, backends) are mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, SpawnOpts, PollOpts, PollResult, BackendInfo } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────
// Hoisted mock state — must be before vi.mock calls (vitest hoists vi.mock)

const { MockSession, mockInstances, resetMockInstances } = vi.hoisted(() => {
  let _idCounter = 0;
  const _instances: InstanceType<typeof MS>[] = [];

  class MS {
    readonly task_id: string;
    readonly backend: { id: string };
    last_polled_at: number = Date.now();
    private _state: "running" | "idle" | "complete" | "error" = "running";
    stopCalled = false;
    // qwen_sessions surface (v0.7) — production QwenSession exposes
    // turns_completed as a getter and budgetStats() as a method.
    private _turns_completed = 0;
    private _maxContextTokens = 0;
    private _maxToolCalls = 0;

    constructor(backend: { id: string }, _prompt: string, opts: SpawnOpts) {
      this.task_id = `q-mock-${++_idCounter}`;
      this.backend = backend;
      this._maxContextTokens = opts?.max_context_tokens ?? 0;
      this._maxToolCalls = opts?.max_tool_calls ?? 0;
      _instances.push(this);
    }

    get state() { return this._state; }
    get turns_completed() { return this._turns_completed; }
    setState(s: MS["_state"]) { this._state = s; }
    setTurns(n: number) { this._turns_completed = n; }

    budgetStats() {
      return {
        est_tokens: 0,
        max_tokens: this._maxContextTokens,
        tool_calls: 0,
        max_tool_calls: this._maxToolCalls,
      };
    }

    stop = vi.fn().mockImplementation(() => {
      this.stopCalled = true;
      this._state = "complete";
    });

    poll = vi.fn().mockImplementation((_opts: PollOpts): PollResult => ({
      state: this._state,
      recent_events: [],
      more_events_available: false,
      latest_event_id: "",
    }));

    send = vi.fn();
  }

  return {
    MockSession: MS,
    mockInstances: _instances,
    resetMockInstances: () => { _idCounter = 0; _instances.length = 0; },
  };
});

vi.mock("../src/session.js", () => ({
  QwenSession: MockSession,
  _resetEventSeq: () => { /* noop */ },
}));

// ─────────────────────────────────────────────────────────────────
// Hoisted backend mocks

const { mockLoadBackends, mockChooseBackend, mockGetCachedHealth } = vi.hoisted(() => {
  const MOCK_BACKEND = {
    id: "local-27b",
    url: "http://localhost:8080/v1",
    model: "qwen3.6-27b-instruct",
    tier: "local" as const,
    capacity: "fast" as const,
  };

  return {
    mockLoadBackends: vi.fn().mockReturnValue([MOCK_BACKEND]),
    mockChooseBackend: vi.fn().mockResolvedValue(MOCK_BACKEND),
    mockGetCachedHealth: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/backends.js", () => ({
  loadBackends: (...args: unknown[]) => mockLoadBackends(...args),
  chooseBackend: (...args: unknown[]) => mockChooseBackend(...args),
  getCachedHealth: (...args: unknown[]) => mockGetCachedHealth(...args),
  refreshPoolBackends: vi.fn(),
  resetHealthCache: vi.fn(),
  // Imported by extensions.ts now that getSessionDefaultExtensions reads
  // the config file as a fall-through. The default mock returns null so
  // env / leave-defaults is the active path in tests.
  readConfigDefaultExtensions: vi.fn(() => null),
  _resetConfigCache: vi.fn(),
  // RDR-002 §Session budget — server.ts calls this on every spawn to
  // resolve env/config/hardcoded defaults. Tests don't exercise the
  // budget surface yet (session.test.ts owns that); return zero-disabled
  // for both knobs so existing assertions are unaffected.
  getSessionBudgetDefaults: vi.fn(() => ({ max_context_tokens: 0, max_tool_calls: 0 })),
}));

// ─────────────────────────────────────────────────────────────────
// Import under test AFTER mocks

import {
  createToolHandlers,
  qwenSpawnOptsSchema,
  buildSpawnOptsFromRaw,
} from "../src/server.js";

// ─────────────────────────────────────────────────────────────────
// Helpers

const MOCK_BACKEND: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

async function callTool(
  handlers: ReturnType<typeof createToolHandlers>,
  name: keyof ReturnType<typeof createToolHandlers>,
  args: unknown,
): Promise<unknown> {
  const handler = handlers[name] as (args: unknown) => Promise<unknown>;
  return handler(args);
}

// ─────────────────────────────────────────────────────────────────
// Tests

describe("MCP tool handlers", () => {
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    resetMockInstances();
    mockLoadBackends.mockReturnValue([MOCK_BACKEND]);
    mockChooseBackend.mockResolvedValue(MOCK_BACKEND);
    mockGetCachedHealth.mockResolvedValue(true);
    vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "10");
    handlers = createToolHandlers();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  // ── qwen_spawn ─────────────────────────────────────────────

  describe("qwen_spawn", () => {
    it("returns task_id and chosen_backend on success", async () => {
      const result = await callTool(handlers, "qwen_spawn", {
        task: "analyze this codebase",
      });
      expect(result).toMatchObject({
        task_id: expect.stringMatching(/^q-mock-/),
        chosen_backend: "local-27b",
      });
    });

    it("creates a QwenSession with the selected backend", async () => {
      await callTool(handlers, "qwen_spawn", { task: "do something" });
      expect(mockInstances).toHaveLength(1);
      expect(mockInstances[0]!.backend.id).toBe("local-27b");
    });

    it("returns error shape when shutting_down is true", async () => {
      // Trigger shutdown
      handlers.__setShuttingDown(true);
      const result = await callTool(handlers, "qwen_spawn", { task: "new task" }) as { error: unknown };
      expect(result).toHaveProperty("error");
    });

    it("passes opts through to chooseBackend", async () => {
      const opts: Partial<SpawnOpts> = {
        write_authority: true,
        allow_subagents: false,
        tier: "local",
      };
      await callTool(handlers, "qwen_spawn", { task: "task", opts });
      expect(mockChooseBackend).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ tier: "local", write_authority: true }),
        "task",
      );
    });

    it("throws MCP error when chooseBackend returns null", async () => {
      mockChooseBackend.mockResolvedValue(null);
      await expect(callTool(handlers, "qwen_spawn", { task: "task" })).rejects.toThrow();
    });

    // ── RDR-002 unknown-extension rejection (audit-fix #4) ──────

    it("returns spawn_error envelope when opts.extensions.only contains unknown names", async () => {
      vi.stubEnv("QWEN_DEFAULT_EXTENSIONS", "");
      const cache = {
        get: () => new Set(["serena"]),
        size: () => 1,
        reload: vi.fn(),
      };
      const localHandlers = createToolHandlers(undefined, cache);
      const result = await callTool(localHandlers, "qwen_spawn", {
        task: "task",
        opts: { extensions: { only: ["nonexistent-ext"] } },
      }) as { error: { code: string; message: string } };

      expect(result).toHaveProperty("error");
      expect(result.error.code).toBe("spawn_error");
      expect(result.error.message).toMatch(/nonexistent-ext/);
      // Session is never instantiated when validation fails.
      expect(mockInstances).toHaveLength(0);
    });

    it("happy-path: known extension resolves and reaches spawnSession", async () => {
      vi.stubEnv("QWEN_DEFAULT_EXTENSIONS", "");
      const cache = {
        get: () => new Set(["serena"]),
        size: () => 1,
        reload: vi.fn(),
      };
      const localHandlers = createToolHandlers(undefined, cache);
      const result = await callTool(localHandlers, "qwen_spawn", {
        task: "do work",
        opts: { extensions: { only: ["serena"] } },
      });
      expect(result).toMatchObject({
        task_id: expect.stringMatching(/^q-mock-/),
        chosen_backend: "local-27b",
      });
      // The MockSession captures spawnOpts on the third constructor arg;
      // verifying it received opts.extensions confirms the handler
      // forwarded the validated payload rather than dropping it.
      expect(mockInstances).toHaveLength(1);
    });

    it("Zod schema accepts opts.extensions and dispatcher round-trips its shape", () => {
      // RDR-002 audit-fix #2: the Zod schema for qwen_spawn opts must accept
      // an extensions: { enable, disable, only } payload, and the inline
      // strip-undefineds dispatcher must forward it to handlers.qwen_spawn
      // with field shape preserved.
      const raw = {
        extensions: {
          enable: ["custom-a", "custom-b"],
          disable: ["legacy-x"],
          only: undefined,
        },
        write_authority: true,
      };

      // 1. Schema parse accepts the payload (and strips the explicit `only:
      //    undefined` per Zod default behavior).
      const parsed = qwenSpawnOptsSchema.parse(raw);
      expect(parsed).toBeDefined();
      expect(parsed!.extensions).toEqual({
        enable: ["custom-a", "custom-b"],
        disable: ["legacy-x"],
      });

      // 2. Dispatcher forwards to a SpawnOpts shape with extensions preserved
      //    and undefined-stripped (exactOptionalPropertyTypes contract).
      const built = buildSpawnOptsFromRaw(parsed);
      expect(built.write_authority).toBe(true);
      expect(built.extensions).toEqual({
        enable: ["custom-a", "custom-b"],
        disable: ["legacy-x"],
      });
      expect("only" in (built.extensions ?? {})).toBe(false);
    });
  });

  // ── qwen_poll ──────────────────────────────────────────────

  describe("qwen_poll", () => {
    it("returns PollResult for a known task_id", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };
      const pollResult = await callTool(handlers, "qwen_poll", {
        task_id: spawnResult.task_id,
      });
      expect(pollResult).toMatchObject({
        state: "running",
        recent_events: expect.any(Array),
        more_events_available: false,
        latest_event_id: expect.any(String),
      });
    });

    it("returns error shape for unknown task_id", async () => {
      const result = await callTool(handlers, "qwen_poll", {
        task_id: "q-does-not-exist",
      }) as { state: string; error: { code: string } };
      expect(result.state).toBe("error");
      expect(result.error.code).toBe("task_id_not_found");
    });

    it("updates last_polled_at on the session", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "work" }) as { task_id: string };
      const session = mockInstances[0]!;
      const beforePoll = session.last_polled_at;

      // Advance time a bit
      await new Promise((r) => setTimeout(r, 5));
      await callTool(handlers, "qwen_poll", { task_id: spawnResult.task_id });
      // last_polled_at should be updated by the handler
      expect(session.last_polled_at).toBeGreaterThanOrEqual(beforePoll);
    });

    it("passes since and max_events opts to session.poll", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "work" }) as { task_id: string };
      const session = mockInstances[0]!;

      await callTool(handlers, "qwen_poll", {
        task_id: spawnResult.task_id,
        opts: { since: "5", max_events: 8 },
      });
      expect(session.poll).toHaveBeenCalledWith({ since: "5", max_events: 8 });
    });
  });

  // ── qwen_send ──────────────────────────────────────────────

  describe("qwen_send", () => {
    it("returns { ack: true } on success", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };

      const result = await callTool(handlers, "qwen_send", {
        task_id: spawnResult.task_id,
        message: "my answer",
      });
      expect(result).toEqual({ ack: true });
    });

    it("calls session.send with the message", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };
      const session = mockInstances[0]!;

      await callTool(handlers, "qwen_send", {
        task_id: spawnResult.task_id,
        message: "my answer",
      });
      expect(session.send).toHaveBeenCalledWith("my answer");
    });

    it("throws MCP error when task_id is not found", async () => {
      await expect(
        callTool(handlers, "qwen_send", {
          task_id: "q-nonexistent",
          message: "hello",
        })
      ).rejects.toThrow();
    });

    it("propagates error when session.send throws", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };
      const session = mockInstances[0]!;
      session.send.mockImplementation(() => { throw new Error("session is stopped"); });

      await expect(
        callTool(handlers, "qwen_send", {
          task_id: spawnResult.task_id,
          message: "late answer",
        })
      ).rejects.toThrow("session is stopped");
    });
  });

  // ── qwen_stop ──────────────────────────────────────────────

  describe("qwen_stop", () => {
    it("returns { ack: true } for known task_id", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };
      const result = await callTool(handlers, "qwen_stop", {
        task_id: spawnResult.task_id,
      });
      expect(result).toEqual({ ack: true });
    });

    it("calls session.stop()", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };
      const session = mockInstances[0]!;

      await callTool(handlers, "qwen_stop", { task_id: spawnResult.task_id });
      expect(session.stop).toHaveBeenCalledOnce();
    });

    it("removes session from pool after stop", async () => {
      const spawnResult = await callTool(handlers, "qwen_spawn", { task: "hello" }) as { task_id: string };

      await callTool(handlers, "qwen_stop", { task_id: spawnResult.task_id });
      // Polling after stop should return not found
      const pollResult = await callTool(handlers, "qwen_poll", {
        task_id: spawnResult.task_id,
      }) as { state: string; error: { code: string } };
      expect(pollResult.state).toBe("error");
      expect(pollResult.error.code).toBe("task_id_not_found");
    });

    it("returns { ack: false } for unknown task_id (idempotent)", async () => {
      const result = await callTool(handlers, "qwen_stop", {
        task_id: "q-nonexistent",
      });
      expect(result).toEqual({ ack: false });
    });
  });

  // ── qwen_reload_extensions (RDR-002 amendment 2026-05-09: ungated) ─

  describe("qwen_reload_extensions", () => {
    function makeMockCache() {
      let names = new Set(["alpha", "beta"]);
      return {
        get: () => names,
        size: () => names.size,
        reload: vi.fn().mockImplementation(async () => {
          names = new Set(["alpha", "beta", "gamma"]);
          return names;
        }),
      };
    }

    it("registers whenever a cache is provided (no env gate)", () => {
      const cache = makeMockCache();
      const handlers = createToolHandlers(undefined, cache);
      expect(typeof handlers.qwen_reload_extensions).toBe("function");
    });

    it("does NOT register when no cache is provided (test-shaped pool)", () => {
      const handlers = createToolHandlers(undefined);
      expect(handlers.qwen_reload_extensions).toBeUndefined();
    });

    it("calls cache.reload() and returns size + names when invoked", async () => {
      const cache = makeMockCache();
      const handlers = createToolHandlers(undefined, cache);
      const result = await handlers.qwen_reload_extensions!({});
      expect(cache.reload).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        size: 3,
        names: expect.arrayContaining(["alpha", "beta", "gamma"]),
      });
    });

    it("ignores QWEN_ADMIN_TOOLS even when explicitly set (no-op for back-compat)", () => {
      vi.stubEnv("QWEN_ADMIN_TOOLS", "1");
      const cache = makeMockCache();
      const handlers = createToolHandlers(undefined, cache);
      expect(typeof handlers.qwen_reload_extensions).toBe("function");
    });
  });

  // ── qwen_extensions (read-only listing) ────────────────────

  describe("qwen_extensions", () => {
    it("returns [] when pool.qwenRealBin is unset", async () => {
      const handlers = createToolHandlers();
      const result = await handlers.qwen_extensions({});
      expect(result).toEqual([]);
    });
  });

  // ── qwen_backends ──────────────────────────────────────────

  describe("qwen_backends", () => {
    it("returns array of BackendInfo", async () => {
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it("BackendInfo has expected shape", async () => {
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      const info = result[0]!;
      expect(info).toMatchObject({
        id: "local-27b",
        url: "http://localhost:8080/v1",
        model: expect.any(String),
        tier: expect.stringMatching(/^(local|remote)$/),
        capacity: expect.stringMatching(/^(fast|heavy)$/),
        healthy: expect.anything(),
      });
    });

    it("uses getCachedHealth (not a live probe)", async () => {
      await callTool(handlers, "qwen_backends", {});
      expect(mockGetCachedHealth).toHaveBeenCalled();
    });

    it("healthy field reflects getCachedHealth result", async () => {
      mockGetCachedHealth.mockResolvedValue(false);
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.healthy).toBe(false);
    });

    it("healthy is null when getCachedHealth returns null", async () => {
      mockGetCachedHealth.mockResolvedValue(null);
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.healthy).toBeNull();
    });
  });

  // ── qwen_sessions (RDR-002 v0.7 amendment) ──────────────────

  describe("qwen_sessions", () => {
    it("returns [] when the pool is empty", async () => {
      const result = await callTool(handlers, "qwen_sessions", {}) as unknown[];
      expect(result).toEqual([]);
    });

    it("returns one entry per pooled session with the SessionInfo shape", async () => {
      await callTool(handlers, "qwen_spawn", { task: "alpha" });
      await callTool(handlers, "qwen_spawn", { task: "beta" });
      const result = await callTool(handlers, "qwen_sessions", {}) as Array<{
        task_id: string;
        backend_id: string;
        state: string;
        last_polled_at: number;
        turns_completed: number;
        budget: { est_tokens: number; max_tokens: number; tool_calls: number; max_tool_calls: number };
      }>;
      expect(result).toHaveLength(2);
      for (const info of result) {
        expect(info.task_id).toMatch(/^q-mock-/);
        expect(info.backend_id).toBe("local-27b");
        expect(info.state).toBe("running");
        expect(typeof info.last_polled_at).toBe("number");
        expect(info.budget).toEqual({
          est_tokens: 0,
          max_tokens: 0,
          tool_calls: 0,
          max_tool_calls: 0,
        });
      }
    });

    it("budget surfaces per-session caps from spawn opts", async () => {
      await callTool(handlers, "qwen_spawn", {
        task: "with budget",
        opts: { max_context_tokens: 4_000, max_tool_calls: 7 },
      });
      const result = await callTool(handlers, "qwen_sessions", {}) as Array<{
        budget: { max_tokens: number; max_tool_calls: number };
      }>;
      expect(result[0]!.budget.max_tokens).toBe(4_000);
      expect(result[0]!.budget.max_tool_calls).toBe(7);
    });

    it("reflects mocked state changes (e.g. error after abort)", async () => {
      await callTool(handlers, "qwen_spawn", { task: "x" });
      mockInstances[0]!.setState("error");
      const result = await callTool(handlers, "qwen_sessions", {}) as Array<{ state: string }>;
      expect(result[0]!.state).toBe("error");
    });
  });
});
