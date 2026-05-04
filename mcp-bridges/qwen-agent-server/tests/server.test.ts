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
    private _state: "running" | "complete" | "error" | "awaiting_input" = "running";
    stopCalled = false;

    constructor(backend: { id: string }, _prompt: string, _opts: SpawnOpts) {
      this.task_id = `q-mock-${++_idCounter}`;
      this.backend = backend;
      _instances.push(this);
    }

    get state() { return this._state; }
    setState(s: MS["_state"]) { this._state = s; }

    stop = vi.fn().mockImplementation(() => {
      this.stopCalled = true;
      this._state = "error";
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
  resetHealthCache: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────
// Import under test AFTER mocks

import { createToolHandlers } from "../src/server.js";

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
});
