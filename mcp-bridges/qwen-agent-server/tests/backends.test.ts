// SPDX-License-Identifier: MIT
//
// Routing tests for src/backends.ts. No network: health_lookup is
// injected as a stub returning controlled values.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approxTokens,
  chooseBackend,
  chooseBackendByModality,
  classifyCapacity,
  getSessionBudgetDefaults,
  loadBackends,
  refreshPoolBackends,
  resetHealthCache,
  _resetConfigCache,
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

// Isolate every test from the operator's actual ~/.qwen-coprocessor-stack/
// config file by pointing QWEN_CONFIG_DIR at a per-suite empty tmpdir for
// the tests that don't explicitly populate one. Tests that DO want a config
// file override this in their own beforeEach.
let _suiteTmpDir: string | null = null;

beforeEach(() => {
  resetHealthCache();
  delete process.env["ROUTER_HEAVY_THRESHOLD_TOKENS"];
  delete process.env["ROUTER_HEAVY_KEYWORDS"];
  delete process.env["QWEN_BACKENDS"];
  _suiteTmpDir = mkdtempSync(join(tmpdir(), "qwen-test-noconfig-"));
  process.env["QWEN_CONFIG_DIR"] = _suiteTmpDir;
  _resetConfigCache();
});

afterEach(() => {
  resetHealthCache();
  if (_suiteTmpDir) {
    rmSync(_suiteTmpDir, { recursive: true, force: true });
    _suiteTmpDir = null;
  }
  delete process.env["QWEN_CONFIG_DIR"];
  _resetConfigCache();
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

describe("loadBackends — config file resolution", () => {
  let tmpConfigDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "qwen-config-"));
    configPath = join(tmpConfigDir, "config.json");
    process.env["QWEN_CONFIG_DIR"] = tmpConfigDir;
    delete process.env["QWEN_BACKENDS"];
    _resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
    delete process.env["QWEN_CONFIG_DIR"];
    _resetConfigCache();
  });

  it("reads backends from config.json when present", () => {
    writeFileSync(configPath, JSON.stringify({ backends: [remote35, remote72] }), "utf8");
    const pool = loadBackends();
    expect(pool).toHaveLength(2);
    expect(pool[0]?.id).toBe("remote-35b");
    expect(pool[1]?.id).toBe("remote-72b");
  });

  it("falls back to default when config file does not exist", () => {
    // No file written
    const pool = loadBackends();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.id).toBe("local-27b");
  });

  it("falls back to default when config file has empty backends array", () => {
    writeFileSync(configPath, JSON.stringify({ backends: [] }), "utf8");
    const pool = loadBackends();
    expect(pool[0]?.id).toBe("local-27b");
  });

  it("falls back to default when config file is malformed JSON (logs but doesn't crash)", () => {
    writeFileSync(configPath, "{not-json", "utf8");
    const pool = loadBackends();
    expect(pool[0]?.id).toBe("local-27b");
  });

  it("env var QWEN_BACKENDS takes priority over config file", () => {
    writeFileSync(configPath, JSON.stringify({ backends: [remote35] }), "utf8");
    process.env["QWEN_BACKENDS"] = JSON.stringify([remote72]);
    const pool = loadBackends();
    expect(pool).toHaveLength(1);
    expect(pool[0]?.id).toBe("remote-72b"); // from env, not from file
  });

  it("hot-reload: file edit between calls is observed", () => {
    writeFileSync(configPath, JSON.stringify({ backends: [remote35] }), "utf8");
    const before = loadBackends();
    expect(before[0]?.id).toBe("remote-35b");

    // Edit file. Bump mtime to force cache miss (some FS clocks are coarse).
    writeFileSync(configPath, JSON.stringify({ backends: [remote72] }), "utf8");
    const future = new Date(Date.now() + 5000);
    utimesSync(configPath, future, future);

    const after = loadBackends();
    expect(after[0]?.id).toBe("remote-72b");
  });

  it("mtime cache: same file, no edit, no re-parse", () => {
    writeFileSync(configPath, JSON.stringify({ backends: [remote35] }), "utf8");
    const first = loadBackends();
    const second = loadBackends();
    // Same array contents — proves cache returned consistent shape
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe("refreshPoolBackends", () => {
  it("mutates pool.backends in place from current config", () => {
    const pool = { backends: [local27] };
    process.env["QWEN_BACKENDS"] = JSON.stringify([remote35, remote72]);
    refreshPoolBackends(pool);
    expect(pool.backends).toHaveLength(2);
    expect(pool.backends[0]?.id).toBe("remote-35b");
    delete process.env["QWEN_BACKENDS"];
  });

  it("clears pool.backends down to default when env unset and no file", () => {
    const pool = { backends: [local27, remote35, remote72] };
    delete process.env["QWEN_BACKENDS"];
    // Outer beforeEach already pointed QWEN_CONFIG_DIR at an empty tmpdir,
    // so config file resolution returns null and the default applies.
    refreshPoolBackends(pool);
    expect(pool.backends).toHaveLength(1);
    expect(pool.backends[0]?.id).toBe("local-27b");
  });
});

describe("approxTokens / classifyCapacity", () => {
  it("counts tokens approximately at 1.3× word-count", () => {
    const ten = "one two three four five six seven eight nine ten";
    expect(approxTokens(ten)).toBe(13);
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("   ")).toBe(0);
  });

  it("applies a chars/4 floor on whitespace-poor input (dense blob)", () => {
    // Pre-1m4: trimmed.split(/\s+/).length counted a 10KB base64-style
    // blob with zero whitespace as 1 word → 1.3 tokens. The dense input
    // sailed past the heavy threshold and routed to fast.
    const dense = "x".repeat(10_000);
    expect(approxTokens(dense)).toBe(2_500); // chars/4 = 10000/4
  });

  it("classifies a whitespace-poor 10KB blob as heavy via the chars/4 floor", () => {
    const dense = "x".repeat(10_000);
    expect(classifyCapacity(dense)).toBe("heavy");
  });

  it("takes the max of word-count and chars/4 (whichever is larger)", () => {
    // Verbose English: word-count wins.
    const verbose = "lots of words separated by single spaces here";
    const wordEst = Math.round(verbose.split(/\s+/).length * 1.3);
    const charEst = Math.round(verbose.length / 4);
    expect(approxTokens(verbose)).toBe(Math.max(wordEst, charEst));
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

  it("falls back to the default threshold on a malformed ROUTER_HEAVY_THRESHOLD_TOKENS (regression: NaN must not disable token classification)", () => {
    // A bare parseInt would yield NaN here and `tokens >= NaN` is always false,
    // silently routing every large prompt to a 'fast' backend. The guarded
    // parse must ignore the junk value and apply the 2000-token default.
    process.env["ROUTER_HEAVY_THRESHOLD_TOKENS"] = "abc";
    const huge = Array.from({ length: 3000 }, () => "word").join(" ");
    expect(classifyCapacity(huge)).toBe("heavy");
    // And a small prompt with no keyword still classifies fast.
    expect(classifyCapacity("fix this typo")).toBe("fast");
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

  it("explicit weight:0 degrades to equal weighting (not NaN-index last-pin)", async () => {
    // `?? 1` lets an explicit 0 through, which zeroed totalWeight -> NaN index
    // -> the for-loop fell through and always returned the LAST candidate. The
    // clamp must make both zero-weight backends reachable.
    const a = { ...local27, id: "zero-a", weight: 0 };
    const b = { ...local27, id: "zero-b", weight: 0 };
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const r = await chooseBackend([a, b], {}, "x", allHealthy);
      if (r) picks.add(r.id);
    }
    expect(picks).toEqual(new Set(["zero-a", "zero-b"]));
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

  // Bead qwen-coprocessor-stack-w63: chat dispatch must never land on
  // an embedding/rerank backend (no /v1/chat/completions support).
  describe("chat-modality filter", () => {
    const embedFast: Backend = {
      id: "embed-local",
      url: "http://localhost:8081/v1",
      model: "bge-m3",
      tier: "local",
      capacity: "fast",
      modality: "embedding",
    };
    const rerankFast: Backend = {
      id: "rerank-local",
      url: "http://localhost:8082/v1",
      model: "bge-reranker-v2-m3",
      tier: "local",
      capacity: "fast",
      modality: "rerank",
    };

    it("excludes embedding backends from default selection", async () => {
      const pool = [embedFast, local27];
      for (let i = 0; i < 10; i++) {
        const r = await chooseBackend(pool, {}, "x", allHealthy);
        expect(r?.id).not.toBe("embed-local");
        expect(r?.id).toBe("local-27b");
      }
    });

    it("excludes rerank backends from default selection", async () => {
      const pool = [rerankFast, local27];
      for (let i = 0; i < 10; i++) {
        const r = await chooseBackend(pool, {}, "x", allHealthy);
        expect(r?.id).not.toBe("rerank-local");
      }
    });

    it("returns null when pool is entirely embed/rerank", async () => {
      const pool = [embedFast, rerankFast];
      const r = await chooseBackend(pool, {}, "x", allHealthy);
      expect(r).toBeNull();
    });

    it("includes multimodal backends in default selection", async () => {
      const mm: Backend = { ...local27, id: "mm-local", modality: "multimodal" };
      const pool = [mm];
      const r = await chooseBackend(pool, {}, "x", allHealthy);
      expect(r?.id).toBe("mm-local");
    });

    it("explicit pin to embedding backend still returns it (caller authority)", async () => {
      const pool = [embedFast, local27];
      const r = await chooseBackend(
        pool,
        { backend: "embed-local" },
        "x",
        allHealthy,
      );
      expect(r?.id).toBe("embed-local");
    });

    it("local-fallback step also respects chat-modality filter", async () => {
      // Remote chat backend down, local embed up — must NOT fall back to embed.
      const pool = [remote35, embedFast];
      const lookup = async (b: Backend): Promise<boolean> => b.id === "embed-local";
      const r = await chooseBackend(pool, {}, "x", lookup);
      expect(r).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// chooseBackendByModality — used by qwen_embed / qwen_rerank /
// qwen_tokenize. Filters by declared modality, then health, then
// round-robins. Treats unset modality as 'text'.

describe("chooseBackendByModality", () => {
  const embedA: Backend = {
    id: "embed-a",
    url: "http://a:9001/v1",
    model: "bge-m3",
    tier: "local",
    capacity: "fast",
    modality: "embedding",
  };
  const embedB: Backend = { ...embedA, id: "embed-b", url: "http://b:9001/v1" };
  const rerankA: Backend = {
    id: "rerank-a",
    url: "http://a:9002/v1",
    model: "qwen3-reranker",
    tier: "local",
    capacity: "fast",
    modality: "rerank",
  };
  const allHealthy = async (): Promise<boolean> => true;
  const allDown = async (): Promise<boolean> => false;

  it("returns pinned backend regardless of modality", async () => {
    const r = await chooseBackendByModality(
      [local27, embedA],
      "embedding",
      "local-27b",
      allHealthy,
    );
    expect(r?.id).toBe("local-27b");
  });

  it("pin to nonexistent returns null", async () => {
    const r = await chooseBackendByModality([embedA], "embedding", "ghost", allHealthy);
    expect(r).toBeNull();
  });

  it("filters by exact modality match (treats unset as 'text')", async () => {
    const r = await chooseBackendByModality(
      [local27, embedA, rerankA],
      "embedding",
      undefined,
      allHealthy,
    );
    expect(r?.modality).toBe("embedding");
  });

  it("no candidates with wanted modality → null", async () => {
    const r = await chooseBackendByModality(
      [local27, rerankA],
      "embedding",
      undefined,
      allHealthy,
    );
    expect(r).toBeNull();
  });

  it("all candidates unhealthy → null", async () => {
    const r = await chooseBackendByModality(
      [embedA, embedB],
      "embedding",
      undefined,
      allDown,
    );
    expect(r).toBeNull();
  });

  it("round-robins across multiple healthy candidates with same modality", async () => {
    const picks = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await chooseBackendByModality(
        [embedA, embedB],
        "embedding",
        undefined,
        allHealthy,
      );
      if (r) picks.add(r.id);
    }
    expect(picks.size).toBe(2);
  });

  it("empty pool returns null", async () => {
    const r = await chooseBackendByModality([], "embedding", undefined, allHealthy);
    expect(r).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// excludes enforcement (RDR-007 P2 / azf.5) — NET-NEW guard.
//
// A backend tagged `no_schema` (MLX: ignores response_format.json_schema)
// projects to AgentProvider.excludes = ["schemaSynth"]. select() drops any
// provider that excludes the classified TaskKind. The guard covers the
// UNPINNED routing path; explicit pins + the role path bypass it (documented).

describe("excludes enforcement (RDR-007 P2)", () => {
  const allHealthy = async (): Promise<boolean> => true;

  // MLX text backend that cannot enforce json_schema. modality 'text' so it is
  // reachable via chooseBackendByModality('text') (the qwen_chat rot path).
  const mlxText: Backend = {
    id: "reason-mac",
    url: "http://mac.local:8084/v1",
    model: "mlx-community/Qwen3.6-35B-A3B-4bit",
    tier: "remote",
    capacity: "fast",
    modality: "text",
    no_schema: true,
  };
  // llama.cpp text backend that CAN enforce json_schema.
  const llamaText: Backend = {
    id: "coder-box",
    url: "http://box:1235/v1",
    model: "qwen",
    tier: "remote",
    capacity: "fast",
    modality: "text",
  };

  describe("chat / modality path (chooseBackendByModality)", () => {
    it("schemaSynth task EXCLUDES the no_schema backend → routes to the llama backend", async () => {
      // Run many times: RR must never land on the excluded MLX backend.
      for (let i = 0; i < 20; i++) {
        const r = await chooseBackendByModality(
          [mlxText, llamaText],
          "text",
          undefined,
          allHealthy,
          "schemaSynth",
        );
        expect(r?.id).toBe("coder-box");
      }
    });

    it("schemaSynth task with ONLY a no_schema backend → null (blocked, no unguarded fallback)", async () => {
      const r = await chooseBackendByModality(
        [mlxText],
        "text",
        undefined,
        allHealthy,
        "schemaSynth",
      );
      expect(r).toBeNull();
    });

    it("a plain chat task (no taskKind) leaves the no_schema backend selectable (behaviour-neutral)", async () => {
      // Existing 4-arg callers (embed/rerank/tokenize/plain chat) are unchanged:
      // without an explicit schemaSynth taskKind, no exclusion applies.
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await chooseBackendByModality([mlxText, llamaText], "text", undefined, allHealthy);
        if (r) seen.add(r.id);
      }
      expect(seen.has("reason-mac")).toBe(true);
      expect(seen.has("coder-box")).toBe(true);
    });

    it("an explicit 'chat' taskKind does NOT exclude the no_schema backend", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await chooseBackendByModality(
          [mlxText, llamaText],
          "text",
          undefined,
          allHealthy,
          "chat",
        );
        if (r) seen.add(r.id);
      }
      expect(seen.has("reason-mac")).toBe(true);
    });

    // vision-mac (MLX multimodal, no_schema) is reachable by TWO paths with
    // DIFFERENT excludes behaviour (azf.6 review S1):
    //  - qwen_chat's multimodal FALLBACK passes kind=schemaSynth → EXCLUDED here.
    //  - the dedicated qwen_oneshot_vision passes NO taskKind (M2=NO) → reachable.
    const visionMac: Backend = {
      id: "vision-mac",
      url: "http://mac.local:8083/v1",
      model: "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
      tier: "remote",
      capacity: "fast",
      modality: "multimodal",
      no_schema: true,
    };

    it("schemaSynth EXCLUDES a no_schema multimodal backend (qwen_chat fallback path)", async () => {
      const r = await chooseBackendByModality([visionMac], "multimodal", undefined, allHealthy, "schemaSynth");
      expect(r).toBeNull(); // the tag is live on this path — not dead config
    });

    it("a no_schema multimodal backend is reachable without a taskKind (dedicated-vision path, M2=NO)", async () => {
      const r = await chooseBackendByModality([visionMac], "multimodal", undefined, allHealthy);
      expect(r?.id).toBe("vision-mac");
    });

    it("a pinned no_schema backend STILL returns it even for schemaSynth (caller authority)", async () => {
      const r = await chooseBackendByModality(
        [mlxText, llamaText],
        "text",
        "reason-mac",
        allHealthy,
        "schemaSynth",
      );
      expect(r?.id).toBe("reason-mac");
    });
  });

  describe("agentic path (chooseBackend)", () => {
    // A synthetic MLX backend that IS in the agentic pool (no_agentic absent) —
    // defends future MLX-agentic topologies even though the current config
    // marks reason-mac no_agentic.
    const mlxAgentic: Backend = { ...mlxText, id: "mlx-agentic" };

    it("a json_schema request never routes to a no_schema agentic backend", async () => {
      for (let i = 0; i < 20; i++) {
        const r = await chooseBackend(
          [mlxAgentic, llamaText],
          { json_schema: { type: "object" } },
          "synthesize JSON",
          allHealthy,
        );
        expect(r?.id).toBe("coder-box");
      }
    });

    it("a non-schema agentic request still pools across both (no exclusion)", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const r = await chooseBackend([mlxAgentic, llamaText], {}, "x", allHealthy);
        if (r) seen.add(r.id);
      }
      expect(seen.has("mlx-agentic")).toBe(true);
      expect(seen.has("coder-box")).toBe(true);
    });

    it("an explicit pin to a no_schema backend + json_schema still wins (documented limitation)", async () => {
      const r = await chooseBackend(
        [mlxAgentic, llamaText],
        { backend: "mlx-agentic", json_schema: { type: "object" } },
        "x",
        allHealthy,
      );
      expect(r?.id).toBe("mlx-agentic");
    });
  });

  describe("exhaustive parity over the closed TaskKind set", () => {
    // For every TaskKind, a provider that excludes that kind must never be
    // selected for a call classified as that kind. TaskKind is closed (RF-2)
    // so this matrix is complete. We exercise the schemaSynth row through both
    // public selectors; the other kinds have empty excludes by construction
    // (only no_schema→schemaSynth exists in P2), so their invariant is that the
    // guard NEVER spuriously excludes them.
    const ALL_KINDS = ["schemaSynth", "agenticLoop", "embed", "rerank", "chat"] as const;

    it("only schemaSynth is ever excluded in P2; all other kinds pass through", async () => {
      for (const kind of ALL_KINDS) {
        const r = await chooseBackendByModality(
          [mlxText],
          "text",
          undefined,
          allHealthy,
          kind,
        );
        if (kind === "schemaSynth") {
          expect(r).toBeNull(); // excluded
        } else {
          expect(r?.id).toBe("reason-mac"); // not excluded
        }
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// getSessionBudgetDefaults — RDR-002 Session-budget resolution chain
//
// Priority for max_context_tokens:
//   1. QWEN_MAX_CONTEXT_TOKENS env (numeric)
//   2. config.session_budget.max_context_tokens
//   3. floor(0.85 * backend.ctx_size) when a backend with positive
//      ctx_size is supplied (v0.7 amendment — closes the gap where a
//      small-ctx local backend got the qwentescence-shaped default)
//   4. Hardcoded 111000.

describe("getSessionBudgetDefaults", () => {
  beforeEach(() => {
    delete process.env["QWEN_MAX_CONTEXT_TOKENS"];
    delete process.env["QWEN_MAX_TOOL_CALLS"];
  });

  it("returns hardcoded defaults (111000 / 0) when nothing else resolves", () => {
    const r = getSessionBudgetDefaults({});
    expect(r).toEqual({ max_context_tokens: 111_000, max_tool_calls: 0 });
  });

  it("env QWEN_MAX_CONTEXT_TOKENS overrides everything", () => {
    const r = getSessionBudgetDefaults(
      { QWEN_MAX_CONTEXT_TOKENS: "12345" },
      { ...local27, ctx_size: 8192 },
    );
    expect(r.max_context_tokens).toBe(12_345);
  });

  it("config.session_budget.max_context_tokens wins over backend.ctx_size", () => {
    const cfgPath = join(_suiteTmpDir!, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      session_budget: { max_context_tokens: 7777 },
    }));
    _resetConfigCache();
    const r = getSessionBudgetDefaults({}, { ...local27, ctx_size: 8192 });
    expect(r.max_context_tokens).toBe(7_777);
  });

  it("falls through to floor(0.85 * backend.ctx_size) when no env or config", () => {
    const r = getSessionBudgetDefaults({}, { ...local27, ctx_size: 8192 });
    // floor(0.85 * 8192) = 6963
    expect(r.max_context_tokens).toBe(6_963);
  });

  it("ignores backend.ctx_size when zero or absent", () => {
    const r1 = getSessionBudgetDefaults({}, { ...local27, ctx_size: 0 });
    expect(r1.max_context_tokens).toBe(111_000);
    const r2 = getSessionBudgetDefaults({}, local27);
    expect(r2.max_context_tokens).toBe(111_000);
  });

  it("preserves zero from any tier (operator-chooses)", () => {
    const cfgPath = join(_suiteTmpDir!, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      session_budget: { max_context_tokens: 0, max_tool_calls: 0 },
    }));
    _resetConfigCache();
    // Even with a backend that would otherwise contribute, 0 wins.
    const r = getSessionBudgetDefaults({}, { ...local27, ctx_size: 8192 });
    expect(r.max_context_tokens).toBe(0);
    expect(r.max_tool_calls).toBe(0);
  });

  it("env QWEN_MAX_TOOL_CALLS wins over config and default", () => {
    const cfgPath = join(_suiteTmpDir!, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      session_budget: { max_tool_calls: 50 },
    }));
    _resetConfigCache();
    const r = getSessionBudgetDefaults({ QWEN_MAX_TOOL_CALLS: "5" });
    expect(r.max_tool_calls).toBe(5);
  });

  it("rejects non-numeric env values and falls through", () => {
    const r = getSessionBudgetDefaults({ QWEN_MAX_CONTEXT_TOKENS: "lol" });
    expect(r.max_context_tokens).toBe(111_000);
  });
});
