// SPDX-License-Identifier: MIT
//
// Routing validation for the Coder-Next pool+vision deployment
// (config/coprocessor-pool-vision.json):
//   - ALL text/coding (light or heavy) POOLS across Mac+box (weighted)
//   - the vision model is vision_only -> excluded from text chat, serves
//     qwen_oneshot_vision by modality
//   - embed/rerank route to their modality backends
// Deterministic by design (no reliance on prompt-size capacity heuristics).
// No network: health_lookup injected.

import { describe, expect, it } from "vitest";
import { chooseBackend, chooseBackendByModality } from "../src/backends.js";
import type { Backend } from "../src/types.js";

// Mirrors config/coprocessor-pool-vision.json
const coderMac: Backend = { id: "coder-mac", url: "http://localhost:8080/v1", model: "mlx-community/Qwen3-Coder-Next-4bit", tier: "remote", capacity: "heavy", weight: 2, ctx_size: 262144, modality: "text" };
const coderBox: Backend = { id: "coder-box", url: "http://qwentescence:1235/v1", model: "qwen", tier: "remote", capacity: "heavy", weight: 1, ctx_size: 32768, modality: "text" };
const visionBox: Backend = { id: "vision-box", url: "http://qwentescence:1234/v1", model: "qwen3.6-35b-a3b", tier: "remote", capacity: "fast", weight: 1, ctx_size: 131072, modality: "multimodal", vision_only: true };
const embedLocal: Backend = { id: "embed-local", url: "http://localhost:8081/v1", model: "bge-m3", tier: "local", capacity: "fast", modality: "embedding" };
const rerankLocal: Backend = { id: "rerank-local", url: "http://localhost:8082/v1", model: "bge-reranker-v2-m3", tier: "local", capacity: "fast", modality: "rerank" };

const POOL: Backend[] = [coderMac, coderBox, visionBox, embedLocal, rerankLocal];
const allHealthy = async (_b: Backend): Promise<boolean> => true;

const LIGHT = "fix the typo in the README";
const HEAVY = "Design and architect a refactor. " + "context ".repeat(3000);

describe("Coder-Next pool+vision routing", () => {
  it("text chat — light AND heavy — pools ONLY across the two Coder-Next machines (vision excluded)", async () => {
    for (const prompt of [LIGHT, HEAVY]) {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        const b = await chooseBackend(POOL, {}, prompt, allHealthy);
        expect(b).not.toBeNull();
        seen.add(b!.id);
      }
      for (const id of seen) expect(["coder-mac", "coder-box"]).toContain(id);
      expect(seen.has("coder-mac")).toBe(true);   // both machines
      expect(seen.has("coder-box")).toBe(true);   // used simultaneously
      expect(seen.has("vision-box")).toBe(false); // never for text
    }
  });

  it("pool is weighted ~2:1 toward the Mac (higher weight)", async () => {
    const counts: Record<string, number> = { "coder-mac": 0, "coder-box": 0 };
    for (let i = 0; i < 600; i++) {
      const b = await chooseBackend(POOL, {}, HEAVY, allHealthy);
      counts[b!.id] = (counts[b!.id] ?? 0) + 1;
    }
    const ratio = counts["coder-mac"]! / counts["coder-box"]!;
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(2.6);
  });

  it("one machine down -> pool drains to the survivor (no mystery failure)", async () => {
    const boxDown = async (b: Backend): Promise<boolean> => b.id !== "coder-box";
    for (let i = 0; i < 20; i++) {
      const b = await chooseBackend(POOL, {}, HEAVY, boxDown);
      expect(b!.id).toBe("coder-mac");
    }
  });

  it("vision task routes to the multimodal (vision_only) backend", async () => {
    const b = await chooseBackendByModality(POOL, "multimodal", undefined, allHealthy);
    expect(b?.id).toBe("vision-box");
  });

  it("embed / rerank route to their modality backends", async () => {
    expect((await chooseBackendByModality(POOL, "embedding", undefined, allHealthy))?.id).toBe("embed-local");
    expect((await chooseBackendByModality(POOL, "rerank", undefined, allHealthy))?.id).toBe("rerank-local");
  });

  it("explicit pin still overrides (force the box, or even the vision model)", async () => {
    expect((await chooseBackend(POOL, { backend: "coder-box" }, HEAVY, allHealthy))?.id).toBe("coder-box");
    expect((await chooseBackend(POOL, { backend: "vision-box" }, HEAVY, allHealthy))?.id).toBe("vision-box");
  });
});
