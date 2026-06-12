// SPDX-License-Identifier: MIT
//
// Tests for chooseBackendByRole — explicit operator-role routing (bead k8j).

import { describe, expect, it } from "vitest";
import { chooseBackendByRole } from "../src/backends.js";
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
