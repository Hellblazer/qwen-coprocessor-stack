// SPDX-License-Identifier: MIT
//
// Routing tests for src/backends.ts. No network: health_lookup is
// injected as a stub returning controlled values.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approxTokens,
  chooseBackend,
  classifyCapacity,
  loadBackends,
  resetHealthCache,
} from "../src/backends.js";
import type { Backend } from "../src/types.js";

const local27: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

const remote35: Backend = {
  id: "remote-35b",
  url: "http://strix.local:8080/v1",
  model: "qwen3.6-35b-a3b",
  tier: "remote",
  capacity: "fast",
};

const remote72: Backend = {
  id: "remote-72b",
  url: "http://strix.local:8082/v1",
  model: "qwen3.6-72b",
  tier: "remote",
  capacity: "heavy",
};

const allHealthy = async (_b: Backend): Promise<boolean> => true;
const allDown = async (_b: Backend): Promise<boolean> => false;

beforeEach(() => {
  resetHealthCache();
  delete process.env["ROUTER_HEAVY_THRESHOLD_TOKENS"];
  delete process.env["ROUTER_HEAVY_KEYWORDS"];
  delete process.env["QWEN_BACKENDS"];
});

afterEach(() => {
  resetHealthCache();
});

describe("loadBackends", () => {
  it("returns the default single local backend when env unset", () => {
    const pool = loadBackends();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.id).toBe("local-27b");
    expect(pool[0]?.url).toBe("http://localhost:8080/v1");
  });

  it("parses QWEN_BACKENDS as JSON array", () => {
    process.env["QWEN_BACKENDS"] = JSON.stringify([local27, remote35]);
    const pool = loadBackends();
    expect(pool).toHaveLength(2);
    expect(pool[1]?.id).toBe("remote-35b");
  });

  it("falls back to default on invalid JSON", () => {
    process.env["QWEN_BACKENDS"] = "not-json";
    const pool = loadBackends();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.id).toBe("local-27b");
  });
});

describe("approxTokens / classifyCapacity", () => {
  it("counts tokens approximately at 1.3× word-count", () => {
    const ten = "one two three four five six seven eight nine ten";
    expect(approxTokens(ten)).toBe(13);
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("   ")).toBe(0);
  });

  it("classifies short prompts as fast", () => {
    expect(classifyCapacity("fix this typo")).toBe("fast");
  });

  it("classifies prompts ≥ ROUTER_HEAVY_THRESHOLD_TOKENS as heavy", () => {
    const longPrompt = Array.from({ length: 1700 }, () => "word").join(" ");
    expect(approxTokens(longPrompt)).toBeGreaterThanOrEqual(2000);
    expect(classifyCapacity(longPrompt)).toBe("heavy");
  });

  it("classifies prompts containing a heavy keyword as heavy", () => {
    expect(classifyCapacity("please architect a solution")).toBe("heavy");
    expect(classifyCapacity("PROVE that 1+1=2")).toBe("heavy");
    expect(classifyCapacity("derive the closed form")).toBe("heavy");
  });

  it("matches keywords whole-word, not substring", () => {
    // 'architect' is a keyword; 'architectured' should NOT match it
    // as a whole word — the regex uses \b boundaries.
    expect(classifyCapacity("look at architects of this system")).toBe("fast");
  });

  it("respects custom ROUTER_HEAVY_THRESHOLD_TOKENS", () => {
    process.env["ROUTER_HEAVY_THRESHOLD_TOKENS"] = "100";
    const ninety = Array.from({ length: 90 }, () => "word").join(" ");
    expect(classifyCapacity(ninety)).toBe("heavy");
  });

  it("respects custom ROUTER_HEAVY_KEYWORDS", () => {
    process.env["ROUTER_HEAVY_KEYWORDS"] = "tricky,subtle";
    expect(classifyCapacity("a tricky problem")).toBe("heavy");
    expect(classifyCapacity("an architectural choice")).toBe("fast"); // arch* no longer keyword
  });
});

describe("chooseBackend — routing algorithm", () => {
  it("explicit opts.backend pin bypasses all filters", async () => {
    const pool = [local27, remote35, remote72];
    const result = await chooseBackend(
      pool,
      { backend: "remote-72b" },
      "trivial prompt",
      allHealthy,
    );
    expect(result?.id).toBe("remote-72b");
  });

  it("explicit pin to nonexistent backend returns null", async () => {
    const pool = [local27];
    const result = await chooseBackend(
      pool,
      { backend: "ghost" },
      "x",
      allHealthy,
    );
    expect(result).toBeNull();
  });

  it("opts.tier='remote' excludes local backends", async () => {
    const pool = [local27, remote35];
    const result = await chooseBackend(
      pool,
      { tier: "remote" },
      "x",
      allHealthy,
    );
    expect(result?.tier).toBe("remote");
  });

  it("heavy-classified prompt picks heavy-capacity backend when available", async () => {
    const pool = [local27, remote72];
    const result = await chooseBackend(
      pool,
      {},
      "please architect this system",
      allHealthy,
    );
    expect(result?.id).toBe("remote-72b");
  });

  it("token-count threshold triggers heavy capacity", async () => {
    const pool = [local27, remote72];
    const longPrompt = Array.from({ length: 1700 }, () => "x").join(" ");
    const result = await chooseBackend(pool, {}, longPrompt, allHealthy);
    expect(result?.capacity).toBe("heavy");
  });

  it("falls back to mixed-capacity pool when no backend matches required capacity", async () => {
    // Only fast backends in pool; heavy prompt → router still has to pick something
    const pool = [local27, remote35]; // both fast
    const result = await chooseBackend(
      pool,
      {},
      "please architect this",
      allHealthy,
    );
    expect(result).not.toBeNull();
    // Should pick from the fast pool (no heavy candidates)
    expect(result?.capacity).toBe("fast");
  });

  it("round-robin distributes across multiple matching survivors", async () => {
    const pool = [local27, { ...local27, id: "local-b" }, { ...local27, id: "local-c" }];
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await chooseBackend(pool, {}, "x", allHealthy);
      if (r) picks.push(r.id);
    }
    // Each id should appear at least once
    expect(new Set(picks).size).toBe(3);
  });

  it("weighted selection biases toward higher weight", async () => {
    const heavyHitter = { ...local27, id: "weighted", weight: 9 };
    const pool = [local27, heavyHitter];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const r = await chooseBackend(pool, {}, "x", allHealthy);
      if (r) counts[r.id] = (counts[r.id] ?? 0) + 1;
    }
    // weight 1 vs 9 → expected ~10% / ~90%, allow generous tolerance
    expect(counts["weighted"]).toBeGreaterThan(800);
    expect(counts["local-27b"]).toBeGreaterThan(50);
  });

  it("when all backends unhealthy and no local available, returns null", async () => {
    // Only remote backends, all down
    const pool = [remote35, remote72];
    const result = await chooseBackend(pool, {}, "x", allDown);
    expect(result).toBeNull();
  });

  it("when filtered pool has no live but local pool does, falls back to local", async () => {
    const pool = [local27, remote35, remote72];
    // Tell health that remotes are down, local up
    const lookup = async (b: Backend): Promise<boolean> =>
      b.tier === "local";
    const result = await chooseBackend(pool, { tier: "remote" }, "x", lookup);
    expect(result?.tier).toBe("local");
  });
});
