// SPDX-License-Identifier: MIT
//
// Tests for the agent-cli provider declaration/registration/config path
// (RDR-008 P1, bead qwen-coprocessor-stack-q8k, Approach item 3). agent-cli
// providers are NOT in the `backends` registry (they are not model endpoints):
// they enter config via a separate `agent_providers` array and are normalized
// into `kind:"agent-cli"` AgentProviders, with a `QWEN_AGENT_PROVIDERS` env
// override for shell parity with `QWEN_BACKENDS`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetConfigCache,
  getConfigPath,
  loadAgentProviders,
  selectAgentProvider,
} from "../src/backends.js";
import type { AgentProvider } from "../src/types.js";

let tmpConfigDir: string;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "qwen-agentprov-"));
  process.env["QWEN_CONFIG_DIR"] = tmpConfigDir;
  delete process.env["QWEN_AGENT_PROVIDERS"];
  _resetConfigCache();
});

afterEach(() => {
  rmSync(tmpConfigDir, { recursive: true, force: true });
  delete process.env["QWEN_CONFIG_DIR"];
  delete process.env["QWEN_AGENT_PROVIDERS"];
  _resetConfigCache();
});

function writeConfig(obj: unknown): void {
  writeFileSync(getConfigPath(), JSON.stringify(obj), "utf8");
  _resetConfigCache();
}

describe("loadAgentProviders", () => {
  it("returns [] when no config file and no env", () => {
    expect(loadAgentProviders()).toEqual([]);
  });

  it("returns [] when config has no agent_providers field", () => {
    writeConfig({ backends: [] });
    expect(loadAgentProviders()).toEqual([]);
  });

  it("parses a declared agent-cli provider, normalizing kind + defaults", () => {
    writeConfig({
      agent_providers: [{ id: "qwen-coder-mac", agentKind: "qwen-local" }],
    });
    const providers = loadAgentProviders();
    expect(providers).toHaveLength(1);
    const p = providers[0]!;
    expect(p.kind).toBe("agent-cli");
    expect(p.agentKind).toBe("qwen-local");
    // Defaults applied for the omitted fields.
    expect(p.modalities).toEqual(["text"]);
    expect(p.excludes).toEqual([]);
  });

  it("preserves explicitly declared fields", () => {
    writeConfig({
      agent_providers: [
        {
          id: "qwen-coder-box",
          agentKind: "qwen-local",
          modalities: ["text"],
          strengths: ["agenticLoop"],
          costClass: "free-local",
          latencyMult: 1.5,
        },
      ],
    });
    const p = loadAgentProviders()[0]!;
    expect(p.strengths).toEqual(["agenticLoop"]);
    expect(p.costClass).toBe("free-local");
    expect(p.latencyMult).toBe(1.5);
  });

  it("skips entries missing id or agentKind (logged, not thrown)", () => {
    writeConfig({
      agent_providers: [
        { id: "ok", agentKind: "qwen-local" },
        { agentKind: "qwen-local" }, // no id
        { id: "no-kind" }, // no agentKind
      ],
    });
    const providers = loadAgentProviders();
    expect(providers.map((p) => p.id)).toEqual(["ok"]);
  });

  it("QWEN_AGENT_PROVIDERS env overrides the config file", () => {
    writeConfig({
      agent_providers: [{ id: "from-file", agentKind: "qwen-local" }],
    });
    process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
      { id: "from-env", agentKind: "qwen-local" },
    ]);
    const providers = loadAgentProviders();
    expect(providers.map((p) => p.id)).toEqual(["from-env"]);
  });

  it("falls through to config when QWEN_AGENT_PROVIDERS is invalid JSON", () => {
    writeConfig({
      agent_providers: [{ id: "from-file", agentKind: "qwen-local" }],
    });
    process.env["QWEN_AGENT_PROVIDERS"] = "{not-json";
    expect(loadAgentProviders().map((p) => p.id)).toEqual(["from-file"]);
  });

  it("falls through to config when QWEN_AGENT_PROVIDERS is valid JSON but not an array", () => {
    writeConfig({
      agent_providers: [{ id: "from-file", agentKind: "qwen-local" }],
    });
    process.env["QWEN_AGENT_PROVIDERS"] = "null";
    expect(loadAgentProviders().map((p) => p.id)).toEqual(["from-file"]);
    process.env["QWEN_AGENT_PROVIDERS"] = "{}";
    expect(loadAgentProviders().map((p) => p.id)).toEqual(["from-file"]);
  });
});

describe("selectAgentProvider", () => {
  const providers: AgentProvider[] = [
    { id: "qwen-coder-mac", kind: "agent-cli", agentKind: "qwen-local", modalities: ["text"], excludes: [] },
    { id: "qwen-coder-box", kind: "agent-cli", agentKind: "qwen-local", modalities: ["text"], excludes: [] },
  ];

  it("selects by explicit id", () => {
    expect(selectAgentProvider(providers, { id: "qwen-coder-box" })?.id).toBe("qwen-coder-box");
  });

  it("selects the first provider of a given agentKind", () => {
    expect(selectAgentProvider(providers, { agentKind: "qwen-local" })?.id).toBe("qwen-coder-mac");
  });

  it("returns undefined when nothing matches", () => {
    expect(selectAgentProvider(providers, { id: "nope" })).toBeUndefined();
    expect(selectAgentProvider([], { agentKind: "qwen-local" })).toBeUndefined();
  });
});
