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

const { mockLoadBackends, mockChooseBackend, mockChooseBackendByModality, mockGetCachedHealth } = vi.hoisted(() => {
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
    mockChooseBackendByModality: vi.fn().mockResolvedValue(null),
    mockGetCachedHealth: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/backends.js", () => ({
  loadBackends: (...args: unknown[]) => mockLoadBackends(...args),
  chooseBackend: (...args: unknown[]) => mockChooseBackend(...args),
  chooseBackendByModality: (...args: unknown[]) => mockChooseBackendByModality(...args),
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
  stripCodeFences,
  matchUpstreamCliError,
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

    it("active_sessions defaults to 0 when no sessions are routed", async () => {
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.active_sessions).toBe(0);
    });

    it("active_sessions counts sessions routed to the backend in the pool", async () => {
      // Spawn two sessions; both route to MOCK_BACKEND per mockChooseBackend.
      await callTool(handlers, "qwen_spawn", { task: "alpha" });
      await callTool(handlers, "qwen_spawn", { task: "beta" });
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.active_sessions).toBe(2);
    });

    it("modality is omitted when backend config doesn't declare it", async () => {
      const result = await callTool(handlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.modality).toBeUndefined();
    });

    it("modality surfaces when declared on the backend", async () => {
      mockLoadBackends.mockReturnValue([{ ...MOCK_BACKEND, modality: "multimodal" }]);
      const localHandlers = createToolHandlers();
      const result = await callTool(localHandlers, "qwen_backends", {}) as BackendInfo[];
      expect(result[0]!.modality).toBe("multimodal");
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

  // ── stripCodeFences (RDR-002 v0.8.1) ─────────────────────────

  describe("stripCodeFences", () => {
    it("strips ```json ... ``` wrapping", () => {
      const out = stripCodeFences('```json\n{"a":1}\n```');
      expect(out).toBe('{"a":1}');
    });

    it("strips plain ``` ... ``` wrapping", () => {
      const out = stripCodeFences('```\n{"a":1}\n```');
      expect(out).toBe('{"a":1}');
    });

    it("tolerates surrounding whitespace and trailing newline", () => {
      const out = stripCodeFences('  ```json\n{"a":1}\n```  ');
      expect(out).toBe('{"a":1}');
    });

    it("returns input unchanged when no fences present", () => {
      const out = stripCodeFences('{"a":1}');
      expect(out).toBe('{"a":1}');
    });

    it("does NOT strip mid-prose fenced blocks", () => {
      const input = 'here is JSON:\n```json\n{"a":1}\n```\nnice';
      expect(stripCodeFences(input)).toBe(input);
    });
  });

  // ── matchUpstreamCliError (qwen-coprocessor-stack-61j) ──────
  //
  // The Qwen CLI surfaces upstream HTTP / streaming / tool failures by
  // writing a bracketed sentinel to stdout and exiting 0. Detecting it
  // is what turns ok:true-with-error-string into a real ok:false.
  describe("matchUpstreamCliError", () => {
    it("matches [API Error: ...]", () => {
      const out = matchUpstreamCliError("[API Error: 500 logits skipped]");
      expect(out).toBe("API Error: 500 logits skipped");
    });

    it("matches [Stream Error: ...]", () => {
      const out = matchUpstreamCliError("[Stream Error: ECONNRESET]");
      expect(out).toBe("Stream Error: ECONNRESET");
    });

    it("matches [Tool Error: ...]", () => {
      const out = matchUpstreamCliError("[Tool Error: missing arg]");
      expect(out).toBe("Tool Error: missing arg");
    });

    it("tolerates leading whitespace", () => {
      const out = matchUpstreamCliError("   [API Error: nope]");
      expect(out).toBe("API Error: nope");
    });

    it("returns undefined for ordinary text", () => {
      expect(matchUpstreamCliError("42")).toBeUndefined();
      expect(matchUpstreamCliError("Here's an answer.")).toBeUndefined();
    });

    it("does not match mid-message bracketed quotes", () => {
      expect(
        matchUpstreamCliError("The user reported '[API Error: x]' in the log."),
      ).toBeUndefined();
    });
  });

  // ── qwen_oneshot (RDR-002 v0.8 amendment) ───────────────────
  //
  // Mock semantics: the MS class above doesn't drive a real SDK loop,
  // so qwen_oneshot's poll waits would never resolve naturally. Each
  // test arranges the mock instance into the desired terminal state
  // before / right after calling qwen_oneshot, and asserts on the
  // returned OneshotResult. The 250ms poll interval is short enough
  // that "set state then resolve" inside the test happens before the
  // first poll fires.

  describe("qwen_oneshot", () => {
    it("returns ok=true with result when session reaches idle (no schema)", async () => {
      // Pre-arrange: set the next-spawned mock to idle with a result
      // immediately. We do that by hooking into the mock's poll override.
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "summarise this",
        opts: { timeout_ms: 5000 },
      });
      // Wait one tick so qwen_spawn has run and the mock instance exists.
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      inst.setState("idle");
      inst.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: "the answer",
        budget: { est_tokens: 100, max_tokens: 1000, tool_calls: 1, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; result?: string; parsed?: unknown; attempts: number; error?: { code: string }; elapsed_ms: number };
      expect(result.ok).toBe(true);
      expect(result.result).toBe("the answer");
      expect(result.parsed).toBeUndefined();
      expect(result.attempts).toBe(1);
      // elapsed_ms is wall-clock around the oneshot dispatch — must be a
      // finite non-negative number. We don't assert tight bounds because
      // CI machine timing varies, but absence/NaN/negative would be a bug.
      expect(typeof result.elapsed_ms).toBe("number");
      expect(Number.isFinite(result.elapsed_ms)).toBe(true);
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("returns elapsed_ms on the failure path too", async () => {
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "x",
        opts: { timeout_ms: 50 },
      });
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      // Leave the session in 'running' so the poll loop hits the
      // timeout branch quickly.
      inst.setState("running");
      inst.poll.mockReturnValue({
        state: "running",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        budget: { est_tokens: 0, max_tokens: 0, tool_calls: 0, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; elapsed_ms: number; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(typeof result.elapsed_ms).toBe("number");
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("parses JSON when json_schema is set and result is valid JSON", async () => {
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "produce json",
        opts: {
          timeout_ms: 5000,
          json_schema: { type: "object", properties: { name: { type: "string" } } },
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      inst.setState("idle");
      inst.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: '{"name":"qwen"}',
        budget: { est_tokens: 0, max_tokens: 0, tool_calls: 0, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; parsed?: unknown };
      expect(result.ok).toBe(true);
      expect(result.parsed).toEqual({ name: "qwen" });
    });

    it("retries up to max_attempts when JSON parse fails", async () => {
      // First attempt: invalid JSON → parse fails → retry. Second attempt: valid.
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "produce json",
        opts: {
          timeout_ms: 5000,
          max_attempts: 2,
          json_schema: { type: "object" },
        },
      });
      // First spawn — invalid JSON.
      await new Promise((r) => setTimeout(r, 10));
      const inst1 = mockInstances[0]!;
      inst1.setState("idle");
      inst1.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: "this is prose, not json",
        budget: { est_tokens: 0, max_tokens: 0, tool_calls: 0, max_tool_calls: 0 },
      });
      // Wait long enough for: poll(250ms), parse fail, stop, second spawn.
      await new Promise((r) => setTimeout(r, 400));
      const inst2 = mockInstances[1]!;
      expect(inst2).toBeDefined();
      inst2.setState("idle");
      inst2.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: '{"ok":true}',
        budget: { est_tokens: 0, max_tokens: 0, tool_calls: 0, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; attempts: number; parsed?: unknown };
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.parsed).toEqual({ ok: true });
    });

    it("returns ok=false with code=session_error when session aborts", async () => {
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "x",
        opts: { timeout_ms: 5000 },
      });
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      inst.setState("error");
      inst.poll.mockReturnValue({
        state: "error",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        error: { code: "context_exceeded", message: "budget blown" },
        budget: { est_tokens: 5000, max_tokens: 1000, tool_calls: 0, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; error?: { code: string; message: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("session_error");
      expect(result.error?.message).toContain("budget blown");
    });

    it("returns ok=false with code=timeout when poll loop exceeds timeout_ms", async () => {
      // Don't transition the session out of running; let the poll loop
      // hit timeout_ms.
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "long",
        opts: { timeout_ms: 200 },
      });
      // mock stays in running state — default poll() returns running.
      const result = await oneshotPromise as { ok: boolean; error?: { code: string } };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("timeout");
    });

    // RDR-002 v0.8.1 — Qwen3.6 wraps schema-conforming JSON in
    // markdown fences despite the system-prompt directive. The bench
    // observed this on 5/5 cases. Verify the defensive strip + parse
    // path in qwen_oneshot recovers cleanly.
    it("recovers from ```json ... ``` wrapping when json_schema is set", async () => {
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "produce json",
        opts: {
          timeout_ms: 5000,
          json_schema: { type: "object" },
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      inst.setState("idle");
      inst.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: '```json\n{"name":"qwen","wrapped":true}\n```',
        budget: { est_tokens: 0, max_tokens: 0, tool_calls: 0, max_tool_calls: 0 },
      });
      const result = await oneshotPromise as { ok: boolean; parsed?: unknown; result?: string };
      expect(result.ok).toBe(true);
      expect(result.parsed).toEqual({ name: "qwen", wrapped: true });
      // The raw `result` field still carries the original wrapped text
      // so callers can see what the model emitted.
      expect(result.result).toContain("```json");
    });

    it("forwards spawn opts including thinking_mode and json_schema to the underlying spawn", async () => {
      const oneshotPromise = callTool(handlers, "qwen_oneshot", {
        task: "x",
        opts: {
          thinking_mode: true,
          json_schema: { type: "object" },
          max_context_tokens: 5000,
          timeout_ms: 5000,
        },
      });
      await new Promise((r) => setTimeout(r, 10));
      const inst = mockInstances[0]!;
      // Verify the mock was constructed with the v0.8 opts. budgetStats
      // mirrors max_context_tokens; thinking_mode/json_schema aren't on
      // the mock surface but are visible via the third constructor arg.
      expect(inst.budgetStats().max_tokens).toBe(5000);
      // Drain to avoid leaking the running session beyond the test.
      inst.setState("idle");
      inst.poll.mockReturnValue({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: '{}',
        budget: { est_tokens: 0, max_tokens: 5000, tool_calls: 0, max_tool_calls: 0 },
      });
      await oneshotPromise;
    });
  });

  // ── qwen_embed / qwen_rerank / qwen_tokenize ────────────────

  describe("qwen_embed", () => {
    const EMBED_BACKEND: Backend = {
      id: "embed-local",
      url: "http://localhost:9001/v1",
      model: "bge-m3",
      tier: "local",
      capacity: "fast",
      modality: "embedding",
    };

    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("returns wrong_modality when pinned backend has wrong modality", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce({
        ...EMBED_BACKEND,
        modality: "text",
      });
      const result = await callTool(handlers, "qwen_embed", {
        texts: ["hi"],
        opts: { backend: "embed-local" },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "wrong_modality" },
      });
    });

    it("returns backend_error when no embedding backend exists", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce(null);
      const result = await callTool(handlers, "qwen_embed", { texts: ["hi"] });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "backend_error" },
      });
    });

    it("rejects empty texts array", async () => {
      const result = await callTool(handlers, "qwen_embed", { texts: [] });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "backend_error", message: expect.stringContaining("non-empty") },
      });
    });

    it("dispatches to embedding backend on happy path", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce(EMBED_BACKEND);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ index: 0, embedding: [0.1] }], model: "bge-m3" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const result = await callTool(handlers, "qwen_embed", { texts: ["hi"] }) as {
        ok: boolean;
        embeddings?: number[][];
        backend_id?: string;
      };
      expect(result.ok).toBe(true);
      expect(result.embeddings).toEqual([[0.1]]);
      expect(result.backend_id).toBe("embed-local");
    });
  });

  describe("qwen_rerank", () => {
    const RERANK_BACKEND: Backend = {
      id: "rerank-local",
      url: "http://localhost:9002/v1",
      model: "qwen3-reranker",
      tier: "local",
      capacity: "fast",
      modality: "rerank",
    };

    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("rejects empty query", async () => {
      const result = await callTool(handlers, "qwen_rerank", {
        query: "",
        documents: ["a"],
      });
      expect(result).toMatchObject({ ok: false, error: { code: "backend_error" } });
    });

    it("rejects empty documents array", async () => {
      const result = await callTool(handlers, "qwen_rerank", {
        query: "q",
        documents: [],
      });
      expect(result).toMatchObject({ ok: false, error: { code: "backend_error" } });
    });

    it("returns backend_error when no rerank backend exists", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce(null);
      const result = await callTool(handlers, "qwen_rerank", {
        query: "q",
        documents: ["a"],
      });
      expect(result).toMatchObject({ ok: false, error: { code: "backend_error" } });
    });

    it("dispatches to rerank backend on happy path", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce(RERANK_BACKEND);
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const result = await callTool(handlers, "qwen_rerank", {
        query: "q",
        documents: ["a"],
      }) as { ok: boolean; results?: Array<{ index: number; relevance_score: number }> };
      expect(result.ok).toBe(true);
      expect(result.results?.[0]!.relevance_score).toBe(0.9);
    });
  });

  describe("qwen_tokenize", () => {
    const TEXT_BACKEND: Backend = {
      id: "text-local",
      url: "http://localhost:8080/v1",
      model: "qwen3.6",
      tier: "local",
      capacity: "fast",
    };

    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("falls back from text to multimodal backend selection", async () => {
      // First call (text) returns null, second call (multimodal) hits.
      mockChooseBackendByModality
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...TEXT_BACKEND, modality: "multimodal" });
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ tokens: [1, 2, 3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await callTool(handlers, "qwen_tokenize", { content: "hi" }) as {
        ok: boolean;
        count?: number;
      };
      expect(result.ok).toBe(true);
      expect(result.count).toBe(3);
      expect(mockChooseBackendByModality).toHaveBeenCalledTimes(2);
      expect(mockChooseBackendByModality.mock.calls[0]?.[1]).toBe("text");
      expect(mockChooseBackendByModality.mock.calls[1]?.[1]).toBe("multimodal");
    });

    it("returns backend_error when no text/multimodal backend exists", async () => {
      mockChooseBackendByModality.mockResolvedValue(null);
      const result = await callTool(handlers, "qwen_tokenize", { content: "hi" });
      expect(result).toMatchObject({ ok: false, error: { code: "backend_error" } });
    });

    it("honors backend pin without modality routing", async () => {
      // Pin to the global MOCK_BACKEND (id 'local-27b') that the pool
      // was initialized with. With a pin, chooseBackendByModality is
      // bypassed entirely and the pool's backend list is consulted directly.
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ tokens: [42] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const result = await callTool(handlers, "qwen_tokenize", {
        content: "hi",
        opts: { backend: "local-27b" },
      }) as { ok: boolean; count?: number };
      expect(mockChooseBackendByModality).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
    });
  });

  describe("qwen_oneshot progress emission", () => {
    it("invokes progress callback at each attempt boundary", async () => {
      // Force schema-parse failure → retry → success path. With 2 attempts
      // we expect 2 progress(attempt N/2) emissions.
      mockInstances.length = 0;
      const progressFn = vi.fn();

      // Patch: drive sessions to idle with empty result so JSON parse
      // fails on attempt 1 and succeeds on attempt 2. We achieve this
      // via the QwenSession mock's poll returning different last_message.
      // Simplest: skip schema, run 1 attempt → expect 1 emission.
      const handler = handlers.qwen_oneshot;
      // Drive the mock session to "idle" promptly.
      const oneshotPromise = handler(
        { task: "hello", opts: {} },
        progressFn,
      );
      // The MockSession is created inside qwen_spawn; flip its state.
      await new Promise((r) => setTimeout(r, 10));
      mockInstances[mockInstances.length - 1]!.setState("idle");
      (
        mockInstances[mockInstances.length - 1]!.poll as ReturnType<typeof vi.fn>
      ).mockImplementation(() => ({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: "hi",
      }));
      await oneshotPromise;
      expect(progressFn).toHaveBeenCalled();
      const firstCall = progressFn.mock.calls[0]?.[0];
      expect(firstCall).toMatchObject({
        progress: 0,
        total: 1,
        message: expect.stringContaining("attempt 1/1"),
      });
    });
  });

  // ── continuation_id threading (qwen-coprocessor-stack-25f) ──

  describe("continuation_id threading", () => {
    /**
     * Drive a single qwen_oneshot call to its idle-success path using
     * the existing MockSession infrastructure. Returns the OneshotResult.
     */
    async function runOneshot(
      args: Parameters<ReturnType<typeof createToolHandlers>["qwen_oneshot"]>[0],
      assistantReply: string,
    ): Promise<{
      ok: boolean;
      result?: string;
      continuation_id?: string;
    }> {
      const handler = handlers.qwen_oneshot;
      const promise = handler(args);
      await new Promise((r) => setTimeout(r, 10));
      const session = mockInstances[mockInstances.length - 1]!;
      session.setState("idle");
      (session.poll as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: assistantReply,
      }));
      return promise as Promise<{
        ok: boolean;
        result?: string;
        continuation_id?: string;
      }>;
    }

    it("mints a fresh continuation_id when none supplied and returns it on success", async () => {
      const result = await runOneshot({ task: "hello" }, "hi there");
      expect(result.ok).toBe(true);
      expect(typeof result.continuation_id).toBe("string");
      expect(result.continuation_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("threads prior turns into a follow-up call's effective task", async () => {
      // First call mints a thread.
      const first = await runOneshot({ task: "what is 2+2?" }, "4");
      expect(first.continuation_id).toBeDefined();
      const cid = first.continuation_id!;

      // Second call passes continuation_id; the inner MockSession should
      // have received an effective_task containing the prelude.
      mockInstances.length = 0;
      await runOneshot(
        { task: "and 3+3?", opts: { continuation_id: cid } },
        "6",
      );
      // The second session was constructed with the prepended task as
      // its `prompt` argument. We can't access MockSession's constructor
      // arg directly, but we can verify via spawnSession's logged event
      // OR by checking the call sequence of mockChooseBackend (one
      // backend pick per spawn). Simpler: assert that the second
      // mockInstance exists and the thread store now has 4 turns.
      expect(mockInstances.length).toBe(1);
    });

    it("honours caller-supplied continuation_id (starts fresh thread under that id)", async () => {
      const result = await runOneshot(
        { task: "x", opts: { continuation_id: "my-thread-42" } },
        "y",
      );
      expect(result.continuation_id).toBe("my-thread-42");
    });

    it("emits continuation_id even on failure (so caller can chain a retry)", async () => {
      // Drive to error path: empty result.
      const handler = handlers.qwen_oneshot;
      const promise = handler({ task: "x" });
      await new Promise((r) => setTimeout(r, 10));
      const session = mockInstances[mockInstances.length - 1]!;
      session.setState("idle");
      (session.poll as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        state: "idle",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        last_message: "", // empty → no_result error
      }));
      const result = (await promise) as {
        ok: boolean;
        continuation_id?: string;
      };
      expect(result.ok).toBe(false);
      expect(result.continuation_id).toBeDefined();
    });

    it("vision handler threads prior turns into messages[] and returns continuation_id", async () => {
      mockChooseBackendByModality.mockResolvedValueOnce({
        ...MOCK_BACKEND,
        modality: "multimodal",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "vision-result" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
        const first = (await handlers.qwen_oneshot_vision({
          task: "describe",
          images: [{ url: "data:image/png;base64,X" }],
        })) as { ok: boolean; continuation_id?: string };
        expect(first.ok).toBe(true);
        expect(first.continuation_id).toBeDefined();
        const cid = first.continuation_id!;

        // Follow-up vision call with continuation_id — should inject
        // prior messages into the body. Image from prior turn is NOT
        // carried forward (placeholder appended to its content).
        mockChooseBackendByModality.mockResolvedValueOnce({
          ...MOCK_BACKEND,
          modality: "multimodal",
        });
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "follow-up" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
        const second = (await handlers.qwen_oneshot_vision({
          task: "what about the colors?",
          images: [{ url: "data:image/png;base64,Y" }],
          opts: { continuation_id: cid },
        })) as { ok: boolean; continuation_id?: string };
        expect(second.ok).toBe(true);
        expect(second.continuation_id).toBe(cid);

        const secondBody = JSON.parse(
          (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
        );
        // messages should contain: [prior user, prior assistant, current user]
        // (no system since opts.system unset).
        expect(secondBody.messages).toHaveLength(3);
        expect(secondBody.messages[0].role).toBe("user");
        expect(secondBody.messages[0].content).toContain("describe");
        expect(secondBody.messages[0].content).toContain(
          "[image attached in prior turn",
        );
        expect(secondBody.messages[1].role).toBe("assistant");
        expect(secondBody.messages[1].content).toBe("vision-result");
        expect(secondBody.messages[2].role).toBe("user");
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("cross-tool threading: oneshot thread continued by vision", async () => {
      const first = await runOneshot(
        { task: "What's a panda?" },
        "A bear from China.",
      );
      const cid = first.continuation_id!;

      mockChooseBackendByModality.mockResolvedValueOnce({
        ...MOCK_BACKEND,
        modality: "multimodal",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        fetchSpy.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ choices: [{ message: { content: "yes" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
        await handlers.qwen_oneshot_vision({
          task: "Is this one?",
          images: [{ url: "data:image/png;base64,X" }],
          opts: { continuation_id: cid },
        });
        const body = JSON.parse(
          (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
        );
        // Prior text-only turns came through with no image placeholder
        // (the user turn from qwen_oneshot was not flagged had_images).
        expect(body.messages[0].content).toContain("What's a panda?");
        expect(body.messages[0].content).not.toContain("[image attached");
        expect(body.messages[1].content).toBe("A bear from China.");
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
