// SPDX-License-Identifier: MIT
//
// Tests for shutdown.ts — signal handlers, graceful stop, force-kill path.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────
// Helpers

function makeStoppableSession(id: string, stopDelayMs = 0) {
  let stopped = false;
  return {
    task_id: id,
    last_polled_at: Date.now(),
    get state() { return "running" as const; },
    stop: vi.fn().mockImplementation(() => {
      stopped = true;
      if (stopDelayMs > 0) {
        return new Promise<void>((resolve) => setTimeout(resolve, stopDelayMs));
      }
      return Promise.resolve();
    }),
    poll: vi.fn().mockReturnValue({ state: "running", recent_events: [], more_events_available: false, latest_event_id: "" }),
    send: vi.fn(),
    get stopped() { return stopped; },
  };
}

// A minimal SessionPool stand-in. `setupShutdown` reads ONLY `pool.sessions`
// (it iterates `.values()` to stop live sessions), so the other SessionPool
// fields (maxSessions, idleTtlMs, backends, qwenRealBin, wrapperPath) are
// omitted and the call sites widen via `as unknown as Parameters<typeof
// setupShutdown>[1]`. NOTE: if setupShutdown is ever extended to read one of
// those fields, this mock must grow to match — the cast would otherwise hide
// the missing field from tsc (silent undefined at runtime).
function makePool(sessions: ReturnType<typeof makeStoppableSession>[]) {
  const map = new Map(sessions.map((s) => [s.task_id, s]));
  return { sessions: map };
}

// ─────────────────────────────────────────────────────────────────
// Import under test

import { setupShutdown } from "../src/shutdown.js";

// ─────────────────────────────────────────────────────────────────
// Tests

describe("setupShutdown", () => {
  let exitCode: number | undefined;
  let mockExit: ReturnType<typeof vi.fn>;
  let mockServer: { close: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    exitCode = undefined;
    mockExit = vi.fn().mockImplementation((code: number) => { exitCode = code; });
    mockServer = { close: vi.fn().mockResolvedValue(undefined) };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── shutting_down flag ────────────────────────────────────

  it("returns shutting_down getter that starts false", () => {
    const pool = makePool([]);
    const { isShuttingDown } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );
    expect(isShuttingDown()).toBe(false);
  });

  it("handler sets shutting_down to true", async () => {
    const pool = makePool([]);
    const { isShuttingDown, handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    void handleSignal("SIGTERM");
    expect(isShuttingDown()).toBe(true);
  });

  it("invokes onShutdownStart once, synchronously, at the start of shutdown", async () => {
    const pool = makePool([]);
    const onShutdownStart = vi.fn();
    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
      onShutdownStart,
    );

    const p = handleSignal("SIGTERM");
    // Synchronous: the tool-handler guard must flip before the first await
    // (server.close) so no new spawn slips through the shutdown window.
    expect(onShutdownStart).toHaveBeenCalledOnce();
    await p;
    // A second signal is a no-op (shutdownStarted guard) — not re-invoked.
    await handleSignal("SIGINT");
    expect(onShutdownStart).toHaveBeenCalledOnce();
  });

  // ── clean shutdown path ───────────────────────────────────

  it("calls stop() on each live session", async () => {
    const s1 = makeStoppableSession("s1");
    const s2 = makeStoppableSession("s2");
    const pool = makePool([s1, s2]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    await handleSignal("SIGTERM");
    expect(s1.stop).toHaveBeenCalledOnce();
    expect(s2.stop).toHaveBeenCalledOnce();
  });

  it("exits with code 0 when all sessions stop cleanly within 5s", async () => {
    const s1 = makeStoppableSession("s1", 0); // stops immediately
    const pool = makePool([s1]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    const p = handleSignal("SIGTERM");
    await vi.runAllTimersAsync();
    await p;

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  // ── force-kill path ────────────────────────────────────────

  it("exits with code 1 when a session stop() exceeds 5s timeout", async () => {
    // Session that takes 10s to stop — will exceed 5s timeout
    const s1 = makeStoppableSession("s1", 10000);
    const pool = makePool([s1]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    const p = handleSignal("SIGTERM");
    // Advance timers past the 5s per-session timeout
    await vi.advanceTimersByTimeAsync(6000);
    await p.catch(() => { /* expected */ });

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("closes the MCP server on shutdown", async () => {
    const pool = makePool([]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    await handleSignal("SIGTERM");
    expect(mockServer.close).toHaveBeenCalled();
  });

  // ── double signal ─────────────────────────────────────────

  it("second signal after shutdown starts is a no-op (no double-stop)", async () => {
    const s1 = makeStoppableSession("s1");
    const pool = makePool([s1]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    const p1 = handleSignal("SIGTERM");
    const p2 = handleSignal("SIGTERM");
    await vi.runAllTimersAsync();
    await Promise.allSettled([p1, p2]);

    // stop() called exactly once despite two signals
    expect(s1.stop).toHaveBeenCalledOnce();
  });

  // ── empty pool ────────────────────────────────────────────

  it("exits cleanly with no sessions", async () => {
    const pool = makePool([]);

    const { handleSignal } = setupShutdown(
      mockServer as Parameters<typeof setupShutdown>[0],
      pool as unknown as Parameters<typeof setupShutdown>[1],
      mockExit as Parameters<typeof setupShutdown>[2],
    );

    await handleSignal("SIGTERM");
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
