// SPDX-License-Identifier: MIT
//
// Tests for SessionPool — LRU eviction, reaper, and env-var overrides.
// All QwenSession construction is mocked; no SDK or network calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────
// Hoisted mock state — must be defined before vi.mock calls

const { mockSessions, MockSession, getMockCounter, resetMockCounter } = vi.hoisted(() => {
  let _counter = 0;
  const _sessions: Map<string, InstanceType<typeof MS>> = new Map();

  class MS {
    readonly task_id: string;
    readonly backend: { id: string };
    last_polled_at: number = Date.now();
    private _state: "running" | "idle" | "complete" | "error" = "running";
    stopCalled = false;

    constructor(backend: { id: string; url: string; model: string; tier: string; capacity: string }, _prompt: string, _opts: unknown) {
      this.task_id = `q-mock-${++_counter}`;
      this.backend = backend;
      _sessions.set(this.task_id, this);
    }

    get state() { return this._state; }
    setState(s: MS["_state"]) { this._state = s; }

    stop() {
      this.stopCalled = true;
      this._state = "complete";
    }

    poll(_opts: unknown) {
      return {
        state: this._state,
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
      };
    }

    send(_msg: string) { /* noop */ }
  }

  return {
    mockSessions: _sessions,
    MockSession: MS,
    getMockCounter: () => _counter,
    resetMockCounter: () => { _counter = 0; _sessions.clear(); },
  };
});

vi.mock("../src/session.js", () => ({
  QwenSession: MockSession,
  _resetEventSeq: () => { /* noop */ },
}));

// Mock backends so loadBackends() is predictable
vi.mock("../src/backends.js", () => {
  const backend = {
    id: "local-27b",
    url: "http://localhost:8080/v1",
    model: "qwen3.6-27b-instruct",
    tier: "local" as const,
    capacity: "fast" as const,
  };

  return {
    loadBackends: () => [backend],
    chooseBackend: async () => backend,
    getCachedHealth: async () => true,
    resetHealthCache: () => { /* noop */ },
    // pool.spawnSession calls this to fill in budget defaults after
    // backend choice (v0.7). Returns zero-disabled to match prior
    // behaviour for tests that don't exercise the budget surface.
    getSessionBudgetDefaults: () => ({ max_context_tokens: 0, max_tool_calls: 0 }),
  };
});

// ─────────────────────────────────────────────────────────────────
// Import pool functions AFTER mocks are set up

import {
  createPool,
  spawnSession,
  removeSession,
  lruEvict,
  reapSweep,
} from "../src/pool.js";

// ─────────────────────────────────────────────────────────────────
// Helpers

const LOCAL_BACKEND: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

// ─────────────────────────────────────────────────────────────────
// Tests

describe("SessionPool", () => {
  beforeEach(() => {
    resetMockCounter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  // ── Cap defaults ────────────────────────────────────────────

  describe("cap defaults", () => {
    it("defaults to MAX_SESSIONS=3 when env var not set", () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "");
      const pool = createPool();
      expect(pool.maxSessions).toBe(3);
    });

    it("reads MAX_SESSIONS from env var", () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "5");
      const pool = createPool();
      expect(pool.maxSessions).toBe(5);
    });

    it("defaults to IDLE_TTL_MS=1800000 when env var not set", () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "");
      const pool = createPool();
      expect(pool.idleTtlMs).toBe(30 * 60 * 1000);
    });

    it("reads IDLE_TTL_MS from env var", () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "60000");
      const pool = createPool();
      expect(pool.idleTtlMs).toBe(60000);
    });
  });

  // ── LRU eviction ────────────────────────────────────────────

  describe("LRU eviction at cap", () => {
    it("does not evict when below cap", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "3");
      const pool = createPool();

      await spawnSession(pool, "task A", {});
      await spawnSession(pool, "task B", {});
      // Two sessions, cap is 3 — no eviction yet
      expect(pool.sessions.size).toBe(2);
      const stoppedAny = [...pool.sessions.values()].some(
        (s) => (s as unknown as InstanceType<typeof MockSession>).stopCalled
      );
      expect(stoppedAny).toBe(false);
    });

    it("evicts completed sessions first at cap", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "2");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const s2 = await spawnSession(pool, "task B", {});
      // Mark s1 as complete
      (pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>).setState("complete");

      // Spawn third — s1 should be evicted (complete before LRU)
      await spawnSession(pool, "task C", {});
      expect(pool.sessions.has(s1.task_id)).toBe(false);
      expect(pool.sessions.has(s2.task_id)).toBe(true);
    });

    it("evicts error sessions before LRU when multiple terminal states exist", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "2");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const s2 = await spawnSession(pool, "task B", {});
      // Mark s2 as error
      (pool.sessions.get(s2.task_id) as unknown as InstanceType<typeof MockSession>).setState("error");

      await spawnSession(pool, "task C", {});
      // s2 should be evicted (error state)
      expect(pool.sessions.has(s2.task_id)).toBe(false);
      expect(pool.sessions.has(s1.task_id)).toBe(true);
    });

    it("evicts oldest by last_polled_at when no terminal sessions", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "2");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      // Advance time so s1 was polled long ago
      vi.setSystemTime(Date.now() + 1000);
      const s2 = await spawnSession(pool, "task B", {});
      // s1 has older last_polled_at
      const session1 = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;
      const session2 = pool.sessions.get(s2.task_id) as unknown as InstanceType<typeof MockSession>;
      // Force s1 to have older poll time
      session1.last_polled_at = Date.now() - 5000;
      session2.last_polled_at = Date.now();

      await spawnSession(pool, "task C", {});
      expect(pool.sessions.has(s1.task_id)).toBe(false);
      expect(pool.sessions.has(s2.task_id)).toBe(true);
    });

    it("calls stop() on evicted session", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "1");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const evicted = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;
      expect(evicted).toBeDefined();

      await spawnSession(pool, "task B", {});
      expect(evicted.stopCalled).toBe(true);
    });
  });

  // ── Reaper ──────────────────────────────────────────────────

  describe("reaper sweep", () => {
    it("reaps idle sessions beyond TTL", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "60000");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const session1 = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;

      // Idle session past TTL — should be reaped.
      session1.setState("idle");
      session1.last_polled_at = Date.now() - 70000;

      reapSweep(pool);
      expect(pool.sessions.has(s1.task_id)).toBe(false);
      expect(session1.stopCalled).toBe(true);
    });

    it("does not reap sessions polled within TTL", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "60000");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const session1 = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;

      // Last polled 30 seconds ago (within 60s TTL)
      session1.setState("idle");
      session1.last_polled_at = Date.now() - 30000;

      reapSweep(pool);
      expect(pool.sessions.has(s1.task_id)).toBe(true);
      expect(session1.stopCalled).toBe(false);
    });

    it("does NOT reap running sessions even when poll-stale (cap is the backstop)", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "60000");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const session1 = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;

      // Running session, not polled in 70s — the inner Qwen could be in
      // a long tool call. Reaper must skip it; lruEvict is the backstop
      // when the pool is at cap.
      session1.setState("running");
      session1.last_polled_at = Date.now() - 70000;

      reapSweep(pool);
      expect(pool.sessions.has(s1.task_id)).toBe(true);
      expect(session1.stopCalled).toBe(false);
    });

    it("reaps stale terminal (complete/error) sessions", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_IDLE_TTL_MS", "60000");
      const pool = createPool();

      const s1 = await spawnSession(pool, "task A", {});
      const s2 = await spawnSession(pool, "task B", {});
      const session1 = pool.sessions.get(s1.task_id) as unknown as InstanceType<typeof MockSession>;
      const session2 = pool.sessions.get(s2.task_id) as unknown as InstanceType<typeof MockSession>;

      session1.setState("complete");
      session2.setState("error");
      session1.last_polled_at = Date.now() - 70000;
      session2.last_polled_at = Date.now() - 70000;

      reapSweep(pool);
      expect(pool.sessions.has(s1.task_id)).toBe(false);
      expect(pool.sessions.has(s2.task_id)).toBe(false);
    });
  });

  // ── removeSession ───────────────────────────────────────────

  describe("removeSession", () => {
    it("removes a session from the pool", async () => {
      const pool = createPool();
      const s = await spawnSession(pool, "task A", {});
      removeSession(pool, s.task_id);
      expect(pool.sessions.has(s.task_id)).toBe(false);
    });

    it("is idempotent on unknown task_id", () => {
      const pool = createPool();
      expect(() => removeSession(pool, "nonexistent")).not.toThrow();
    });
  });

  // ── lruEvict directly ─────────────────────────────────────

  describe("lruEvict", () => {
    it("is a no-op when pool is below cap", async () => {
      vi.stubEnv("QWEN_SUPERVISOR_MAX_SESSIONS", "5");
      const pool = createPool();
      await spawnSession(pool, "task A", {});
      await spawnSession(pool, "task B", {});

      lruEvict(pool);
      expect(pool.sessions.size).toBe(2);
    });
  });

  // used only to suppress TS unused-var warning
  void LOCAL_BACKEND;
  void getMockCounter;
  void mockSessions;
});
