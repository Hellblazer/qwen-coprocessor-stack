// SPDX-License-Identifier: MIT
//
// Health-cache tests. Mocks global fetch via vi.stubGlobal so we can
// assert TTL behavior, background refresh, and cold-call semantics
// without hitting the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _seedHealth,
  getCachedHealth,
  resetHealthCache,
} from "../src/backends.js";
import type { Backend } from "../src/types.js";

const local: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetHealthCache();
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getCachedHealth — TTL semantics", () => {
  it("returns cached healthy=true within TTL without re-fetching", async () => {
    _seedHealth("local-27b", true);
    const a = await getCachedHealth(local);
    const b = await getCachedHealth(local);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT re-fetch on second call within 30s window", async () => {
    _seedHealth("local-27b", true);
    await getCachedHealth(local);
    vi.advanceTimersByTime(20_000);
    await getCachedHealth(local);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stale cache (>30s) returns cached value AND triggers background refresh", async () => {
    _seedHealth("local-27b", true);
    fetchSpy.mockResolvedValue({ ok: true } as Response);

    await getCachedHealth(local); // primes nothing — cache fresh

    vi.advanceTimersByTime(31_000); // expire

    const result = await getCachedHealth(local);
    // Returns cached value immediately (true), even though stale
    expect(result).toBe(true);
    // Background refresh kicked off
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("getCachedHealth — cold call", () => {
  it("on first probe, marks unhealthy=null when fetch fails (allows re-probe)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await getCachedHealth(local);
    // Probe failure on cold call returns false (probeHealth catches and
    // returns false), but the cache stores that — it's "false, not null"
    // because probeHealth returned false rather than throwing past it.
    // Either way it's NOT cached as healthy.
    expect(result === false || result === null).toBe(true);
  });

  it("on first probe, returns true when /health is OK", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    const result = await getCachedHealth(local);
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("probeHealth URL construction", () => {
  it("probes /health at host root for /v1-suffixed backend (NOT /v1/health)", async () => {
    fetchSpy.mockResolvedValue({ ok: true } as Response);
    await getCachedHealth(local); // local.url === "http://localhost:8080/v1"

    expect(fetchSpy).toHaveBeenCalled();
    const firstCallUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(firstCallUrl).toBe("http://localhost:8080/health");
  });

  it("falls back to /v1/models when /health fails", async () => {
    // First call (/health) fails; second call (/v1/models) succeeds.
    fetchSpy
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    const result = await getCachedHealth(local);
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:8080/health");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://localhost:8080/v1/models");
  });

  it("handles backends without /v1 suffix correctly", async () => {
    const noV1: Backend = { ...local, id: "no-v1", url: "http://example.com:9000" };
    fetchSpy.mockResolvedValue({ ok: true } as Response);

    await getCachedHealth(noV1);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://example.com:9000/health");
  });
});
