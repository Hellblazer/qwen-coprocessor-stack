// SPDX-License-Identifier: MIT
//
// Tests for chooseBackendByRole — explicit operator-role routing (bead k8j).

import { describe, expect, it } from "vitest";
import { chooseBackend, chooseBackendByModality, chooseBackendByRole } from "../src/backends.js";
import type { Backend } from "../src/types.js";

const coderMac: Backend = { id: "coder-mac", url: "http://localhost:8080/v1", model: "coder", tier: "remote", capacity: "heavy", weight: 2, modality: "text", roles: ["code"] };
const coderBox: Backend = { id: "coder-box", url: "http://qwentescence:1235/v1", model: "qwen", tier: "remote", capacity: "heavy", weight: 1, modality: "text", roles: ["code"] };
const visionBox: Backend = { id: "vision-box", url: "http://qwentescence:1234/v1", model: "qwen3.6-35b-a3b", tier: "remote", capacity: "fast", modality: "multimodal", vision_only: true, roles: ["general", "reasoning"] };
const embed: Backend = { id: "embed-local", url: "http://localhost:8081/v1", model: "bge-m3", tier: "local", capacity: "fast", modality: "embedding" };

const POOL: Backend[] = [coderMac, coderBox, visionBox, embed];
const allHealthy = async (_b: Backend): Promise<boolean> => true;

describe("chooseBackendByRole", () => {
  it("routes role='general' to the backend tagged general — even though it is vision_only/multimodal", async () => {
    const b = await chooseBackendByRole(POOL, "general", undefined, allHealthy);
    expect(b?.id).toBe("vision-box");
  });

  it("routes role='reasoning' to the same 35B (multi-role backend)", async () => {
    const b = await chooseBackendByRole(POOL, "reasoning", undefined, allHealthy);
    expect(b?.id).toBe("vision-box");
  });

  it("routes role='code' only to the Coder-Next pool", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const b = await chooseBackendByRole(POOL, "code", undefined, allHealthy);
      seen.add(b!.id);
    }
    for (const id of seen) expect(["coder-mac", "coder-box"]).toContain(id);
    expect(seen.has("vision-box")).toBe(false);
  });

  it("returns null when no backend advertises the role", async () => {
    const b = await chooseBackendByRole(POOL, "nonesuch", undefined, allHealthy);
    expect(b).toBeNull();
  });

  it("skips unhealthy backends; null if the only role-match is down", async () => {
    const visionDown = async (b: Backend): Promise<boolean> => b.id !== "vision-box";
    expect(await chooseBackendByRole(POOL, "general", undefined, visionDown)).toBeNull();
    // role=code still resolves (coder pool healthy)
    expect((await chooseBackendByRole(POOL, "code", undefined, visionDown))?.id).toMatch(/coder-/);
  });

  it("an explicit id pin short-circuits role filtering (caller authority)", async () => {
    const b = await chooseBackendByRole(POOL, "general", "coder-mac", allHealthy);
    expect(b?.id).toBe("coder-mac");
  });

  it("backends without a roles array never match a role query", async () => {
    // embed-local has no roles; a role query must not return it.
    const b = await chooseBackendByRole([embed], "general", undefined, allHealthy);
    expect(b).toBeNull();
  });
});

describe("no_tokenize exclusion (bead id7)", () => {
  // coder-mac (MLX) lacks /tokenize; mark it no_tokenize. coder-box (llama.cpp)
  // serves /tokenize. Unpinned tokenize routing filters no_tokenize then picks
  // by modality — mirrors the server.ts qwen_tokenize handler.
  const coderMacNoTok: Backend = { ...coderMac, no_tokenize: true };
  const POOL3: Backend[] = [coderMacNoTok, coderBox, visionBox, embed];

  it("unpinned tokenize routing (filter no_tokenize → modality) skips the MLX backend", async () => {
    const tokPool = POOL3.filter((b) => b.no_tokenize !== true);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const b =
        (await chooseBackendByModality(tokPool, "text", undefined, allHealthy)) ??
        (await chooseBackendByModality(tokPool, "multimodal", undefined, allHealthy));
      seen.add(b!.id);
    }
    expect(seen.has("coder-mac")).toBe(false); // MLX excluded
    expect(seen.has("coder-box")).toBe(true); // llama.cpp serves /tokenize
  });

  it("falls back to multimodal (vision-box) when the only text backend is no_tokenize", async () => {
    const tokPool = [coderMacNoTok, visionBox].filter((b) => b.no_tokenize !== true);
    const b =
      (await chooseBackendByModality(tokPool, "text", undefined, allHealthy)) ??
      (await chooseBackendByModality(tokPool, "multimodal", undefined, allHealthy));
    expect(b?.id).toBe("vision-box"); // multimodal llama.cpp has /tokenize
  });
});

describe("no_agentic exclusion (bead 081)", () => {
  // coder-box mirrors the shipped config: text, role=code, but no_agentic.
  const coderBoxNoAgentic: Backend = { ...coderBox, no_agentic: true };
  const POOL2: Backend[] = [coderMac, coderBoxNoAgentic, visionBox, embed];

  it("chooseBackend (agentic pool) never routes to a no_agentic backend", async () => {
    for (let i = 0; i < 40; i++) {
      const b = await chooseBackend(POOL2, {}, "fix the bug in foo.ts", allHealthy);
      expect(b!.id).toBe("coder-mac");
    }
  });

  it("but an explicit pin to a no_agentic backend still wins (caller authority)", async () => {
    const b = await chooseBackend(POOL2, { backend: "coder-box" }, "x", allHealthy);
    expect(b?.id).toBe("coder-box");
  });

  it("no_agentic backend is STILL reachable for direct chat by role and modality", async () => {
    // role=code resolves across both coder backends (direct qwen_chat path)
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      seen.add((await chooseBackendByRole(POOL2, "code", undefined, allHealthy))!.id);
    }
    expect(seen.has("coder-box")).toBe(true); // not excluded from role routing
    // modality=text selection also still includes it
    const textSeen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      textSeen.add((await chooseBackendByModality(POOL2, "text", undefined, allHealthy))!.id);
    }
    expect(textSeen.has("coder-box")).toBe(true);
  });
});
