// SPDX-License-Identifier: MIT
//
// Tests for Backend.pin_only (bead 9jui): a pin_only backend is never chosen by
// automatic selection; it is reachable by an explicit id pin, an explicit role,
// or a dispatch provider whose `backend` pins it. No network: health is injected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../src/log.js", () => {
  const make = () => {
    const rec = () => {};
    return { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec, child: () => make() };
  };
  return { createLogger: () => make() };
});

import {
  chooseBackend,
  chooseBackendByModality,
  chooseBackendByRole,
  loadBackends,
  resetHealthCache,
  _resetConfigCache,
} from "../src/backends.js";
import { makeSupervisorQwenSpawnEffects } from "../src/dispatch-tool.js";
import { pinOnlyHint } from "../src/pin-only.js";
import type { AgentProvider, AgentTask, Backend, SpawnOpts } from "../src/types.js";

const coderBox: Backend = { id: "coder-box", url: "http://box:1235/v1", model: "qwen", tier: "remote", capacity: "heavy", weight: 1, modality: "text", roles: ["code"] };
const coderMac: Backend = { id: "coder-mac", url: "http://mac:8085/v1", model: "qwen", tier: "remote", capacity: "heavy", weight: 2, modality: "text", roles: ["code"] };
const paid: Backend = { id: "paid", url: "https://or.ai/api/v1", model: "x/y", tier: "remote", capacity: "heavy", weight: 1, modality: "text", roles: ["deepseek"], pin_only: true };
const paidLocal: Backend = { id: "paid-local", url: "http://l/v1", model: "x/y", tier: "local", capacity: "fast", modality: "text", pin_only: true };
const embedPaid: Backend = { id: "embed-paid", url: "https://e/v1", model: "e", tier: "remote", capacity: "fast", modality: "embedding", pin_only: true };
const embedFree: Backend = { id: "embed-free", url: "http://e/v1", model: "e", tier: "local", capacity: "fast", modality: "embedding" };

const allHealthy = async (_b: Backend): Promise<boolean> => true;
const HEAVY = "Design and architect a refactor. " + "context ".repeat(3000);
const LIGHT = "fix the typo";

beforeEach(() => resetHealthCache());

describe("pin_only: unpinned agentic selection (chooseBackend)", () => {
  it("never returns a pin_only backend across many draws, with healthy alternatives", async () => {
    const pool = [coderBox, paid, coderMac];
    for (const prompt of [LIGHT, HEAVY]) {
      const seen = new Set<string>();
      for (let i = 0; i < 120; i++) seen.add((await chooseBackend(pool, {}, prompt, allHealthy))!.id);
      expect(seen.has("paid")).toBe(false);
      expect(seen.has("coder-box")).toBe(true);
      expect(seen.has("coder-mac")).toBe(true);
    }
  });

  it("never returns one when the alternatives are unhealthy (no fallback to pin_only)", async () => {
    const pool = [coderBox, paid];
    const onlyPaidUp = async (b: Backend): Promise<boolean> => b.id === "paid";
    for (let i = 0; i < 20; i++) expect(await chooseBackend(pool, {}, HEAVY, onlyPaidUp)).toBeNull();
  });

  it("returns null when only pin_only backends are in the pool", async () => {
    for (let i = 0; i < 20; i++) expect(await chooseBackend([paid, paidLocal], {}, HEAVY, allHealthy)).toBeNull();
  });

  it("excludes pin_only from the tier and capacity fall-through widenings too", async () => {
    // tier "local" requested, only a remote pin_only matches capacity: still excluded.
    expect(await chooseBackend([coderBox, paid], { tier: "remote", capacity: "heavy" }, LIGHT, allHealthy)).toMatchObject({ id: "coder-box" });
    expect(await chooseBackend([paidLocal, coderBox], { tier: "local" }, LIGHT, allHealthy)).toMatchObject({ id: "coder-box" });
  });

  it("an explicit opts.backend pin selects it, healthy or not (as any pinned backend)", async () => {
    expect((await chooseBackend([coderBox, paid], { backend: "paid" }, HEAVY, allHealthy))?.id).toBe("paid");
    const down = async (): Promise<boolean> => false;
    expect((await chooseBackend([coderBox, paid], { backend: "paid" }, HEAVY, down))?.id).toBe("paid");
    // unknown pin stays null, as today
    expect(await chooseBackend([coderBox, paid], { backend: "nope" }, HEAVY, allHealthy)).toBeNull();
  });

  it("absent and false flag behave identically to today (weighted ~2:1 across the two coders)", async () => {
    const withFalse = { ...coderBox, pin_only: false };
    const counts: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const b = await chooseBackend([withFalse, coderMac], {}, HEAVY, allHealthy);
      counts[b!.id] = (counts[b!.id] ?? 0) + 1;
    }
    expect(counts["coder-box"]).toBe(100);
    expect(counts["coder-mac"]).toBe(200);
  });
});

describe("pin_only: chooseBackendByModality (qwen_chat default, embed, rerank, tokenize, vision)", () => {
  it("unpinned text selection never returns a pin_only backend", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add((await chooseBackendByModality([coderBox, paid, coderMac], "text", undefined, allHealthy))!.id);
    expect(seen.has("paid")).toBe(false);
  });

  it("returns null when only pin_only backends match the modality", async () => {
    expect(await chooseBackendByModality([paid], "text", undefined, allHealthy)).toBeNull();
  });

  it("an explicit pin selects it", async () => {
    expect((await chooseBackendByModality([coderBox, paid], "text", "paid", allHealthy))?.id).toBe("paid");
  });

  it("embedding selection goes through the same selector and skips pin_only", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await chooseBackendByModality([embedPaid, embedFree], "embedding", undefined, allHealthy))?.id).toBe("embed-free");
    }
    expect(await chooseBackendByModality([embedPaid], "embedding", undefined, allHealthy)).toBeNull();
    expect((await chooseBackendByModality([embedPaid, embedFree], "embedding", "embed-paid", allHealthy))?.id).toBe("embed-paid");
  });
});

describe("pin_only: chooseBackendByRole", () => {
  it("an explicit role selects a pin_only backend that advertises it", async () => {
    expect((await chooseBackendByRole([coderBox, paid], "deepseek", undefined, allHealthy))?.id).toBe("paid");
  });

  it("a role the pin_only backend does not advertise never reaches it", async () => {
    for (let i = 0; i < 20; i++) expect((await chooseBackendByRole([coderBox, paid], "code", undefined, allHealthy))?.id).toBe("coder-box");
  });

  it("an unhealthy role match is skipped, as for any backend", async () => {
    expect(await chooseBackendByRole([paid], "deepseek", undefined, async () => false)).toBeNull();
  });

  it("a defaulted role does not select it: qwen_chat with no role takes the modality path", async () => {
    // qwen_chat only calls chooseBackendByRole when opts.role is a non-empty string;
    // otherwise it takes the modality path, which excludes pin_only.
    expect((await chooseBackendByModality([paid, coderBox], "text", undefined, allHealthy))?.id).toBe("coder-box");
  });
});

describe("pin_only: dispatch providers", () => {
  const TASK: AgentTask = { prompt: "do", worktree: "/wt", maxTurns: 5, minTokens: 0, timeout: 1000 };
  const provider = (backend?: string): AgentProvider => ({
    id: "p",
    kind: "agent-cli",
    agentKind: "qwen-local",
    modalities: ["text"],
    excludes: [],
    ...(backend !== undefined ? { backend } : {}),
  });
  const POOL = [coderBox, paid, coderMac];

  // The real qwen_spawn handler is chooseBackend over the pool; stub it with that.
  const effectsOverPool = () => {
    const chosen: Array<string | null> = [];
    const qwen_spawn = vi.fn(async ({ task, opts }: { task: string; opts: Partial<SpawnOpts> }) => {
      const b = await chooseBackend(POOL, opts as SpawnOpts, task, allHealthy);
      chosen.push(b?.id ?? null);
      return b ? { task_id: "t", chosen_backend: b.id } : { error: { code: "spawn_no_backend", message: "none" } };
    });
    const effects = makeSupervisorQwenSpawnEffects({ qwen_spawn: qwen_spawn as never, qwen_poll: vi.fn() }, async () => "");
    return { effects, chosen };
  };

  it("a provider pinned to a pin_only backend spawns on it", async () => {
    const { effects, chosen } = effectsOverPool();
    await effects.spawn(TASK, provider("paid"));
    expect(chosen).toEqual(["paid"]);
  });

  it("an unpinned provider never lands on a pin_only backend", async () => {
    const { effects, chosen } = effectsOverPool();
    for (let i = 0; i < 60; i++) await effects.spawn(TASK, provider());
    expect(chosen).not.toContain("paid");
    expect(chosen).not.toContain(null);
  });
});

describe("pin_only: no-backend hint", () => {
  it("is empty when the pool has no pin_only backend of a relevant modality", () => {
    expect(pinOnlyHint([coderBox, coderMac], "opts.backend")).toBe("");
    expect(pinOnlyHint([coderBox, embedPaid], "opts.backend")).toBe("");
  });

  it("names the pin_only backends and how to select one", () => {
    const h = pinOnlyHint([coderBox, paid, paidLocal], "opts.backend");
    expect(h).toMatch(/pin-only/);
    expect(h).toContain("paid");
    expect(h).toContain("paid-local");
    expect(h).not.toContain("coder-box");
    expect(h).toContain("opts.backend");
  });

  it("filters by modality when asked", () => {
    expect(pinOnlyHint([paid, embedPaid], "opts.backend", ["embedding"])).toContain("[embed-paid]");
  });
});

describe("pin_only: config validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qwen-pinonly-"));
    process.env["QWEN_CONFIG_DIR"] = dir;
    delete process.env["QWEN_BACKENDS"];
    _resetConfigCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["QWEN_CONFIG_DIR"];
    delete process.env["QWEN_BACKENDS"];
    _resetConfigCache();
  });

  it("accepts pin_only true and false from the config file", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ backends: [coderBox, { ...paid, pin_only: true }, { ...coderMac, pin_only: false }] }));
    const pool = loadBackends();
    expect(pool.map((b) => [b.id, b.pin_only])).toEqual([["coder-box", undefined], ["paid", true], ["coder-mac", false]]);
  });

  it("drops a backend whose pin_only is not a boolean (fail closed, never pooled), keeping the rest", () => {
    for (const bad of ["true", 1, null, "yes"]) {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ backends: [coderBox, { ...paid, pin_only: bad }] }));
      _resetConfigCache();
      expect(loadBackends().map((b) => b.id), String(bad)).toEqual(["coder-box"]);
    }
  });

  it("applies the same check to QWEN_BACKENDS", () => {
    process.env["QWEN_BACKENDS"] = JSON.stringify([coderBox, { ...paid, pin_only: "true" }, { ...coderMac, pin_only: true }]);
    expect(loadBackends().map((b) => b.id)).toEqual(["coder-box", "coder-mac"]);
  });

  it("falls through to the default when every backend is invalid", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ backends: [{ ...paid, pin_only: "true" }] }));
    expect(loadBackends().map((b) => b.id)).toEqual(["local-27b"]);
  });
});

describe("pin_only: shipped example configs", () => {
  const read = (name: string): { backends: Array<Backend & { pin_only?: unknown }> } =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../../config/${name}`, import.meta.url)), "utf8"));

  it("openrouter example: GLM and both DeepSeek backends are pin_only", () => {
    const byId = new Map(read("coprocessor-pool-openrouter.example.json").backends.map((b) => [b.id, b]));
    for (const id of ["glm-openrouter", "deepseek-pro-openrouter", "deepseek-flash-openrouter"]) {
      expect(byId.get(id)?.pin_only, id).toBe(true);
    }
    expect(byId.get("deepseek-pro-openrouter")).toMatchObject({
      model: "deepseek/deepseek-v4-pro-0813",
      url: "https://openrouter.ai/api/v1",
      tier: "remote",
      capacity: "heavy",
      weight: 1,
      ctx_size: 1048576,
      modality: "text",
      roles: ["deepseek"],
      api_key_env: "OPENROUTER_API_KEY",
      no_tokenize: true,
    });
    expect(byId.get("deepseek-flash-openrouter")).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", roles: ["deepseek"], no_tokenize: true });
    expect(byId.get("deepseek-pro-openrouter")!.headers).toEqual(byId.get("glm-openrouter")!.headers);
  });

  it("every example pool: pin_only, where present, is a boolean; unpinned selection ignores pin_only entries", async () => {
    for (const name of [
      "coprocessor-pool-openrouter.example.json",
      "coprocessor-pool-vision.json",
      "coprocessor-pool-coder-mac.example.json",
    ]) {
      const { backends } = read(name);
      expect(backends.length, name).toBeGreaterThan(0);
      for (const b of backends) expect(["undefined", "boolean"], `${name}:${b.id}`).toContain(typeof b.pin_only);
      for (let i = 0; i < 30; i++) {
        const b = await chooseBackend(backends, {}, HEAVY, allHealthy);
        expect(b?.pin_only === true, `${name}:${b?.id}`).toBe(false);
      }
    }
  });
});
