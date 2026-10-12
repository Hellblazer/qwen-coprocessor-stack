// SPDX-License-Identifier: MIT
//
// Tests for src/session-settings.ts — the in-memory per-session settings and
// the "page value if set, else the existing rule" resolution (bead
// qwen-coprocessor-stack-9sm2). The HTTP surface is covered in
// settings-page.test.ts; this file is the precedence contract plus the
// qwen_dispatch path driven through the real gates.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAgentProviders } from "../src/backends.js";
import { isDispatchEnabled, runQwenDispatch } from "../src/dispatch-tool.js";
import { getSessionDefaultExtensions } from "../src/extensions.js";
import {
  createSessionSettings,
  effectiveDefaultExtensions,
  effectiveDispatchEnabled,
  effectiveProviders,
  settingsDispatchGates,
} from "../src/session-settings.js";
import type { AgentProvider, AgentResult } from "../src/types.js";

vi.mock("../src/log.js", () => {
  const make = () => {
    const noop = () => {};
    return { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => make() };
  };
  return { createLogger: () => make() };
});

let tmpConfigDir: string;
const SAVED = {
  QWEN_CONFIG_DIR: process.env["QWEN_CONFIG_DIR"],
  QWEN_AGENT_PROVIDERS: process.env["QWEN_AGENT_PROVIDERS"],
  QWEN_DEFAULT_EXTENSIONS: process.env["QWEN_DEFAULT_EXTENSIONS"],
  QWEN_DISPATCH_ENABLE: process.env["QWEN_DISPATCH_ENABLE"],
};

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "qwen-session-settings-"));
  process.env["QWEN_CONFIG_DIR"] = tmpConfigDir;
  delete process.env["QWEN_AGENT_PROVIDERS"];
  delete process.env["QWEN_DEFAULT_EXTENSIONS"];
  delete process.env["QWEN_DISPATCH_ENABLE"];
});

afterEach(() => {
  rmSync(tmpConfigDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const pageProvider = (id: string, backend: string): AgentProvider => ({
  id,
  kind: "agent-cli",
  agentKind: "qwen-local",
  modalities: ["text"],
  excludes: [],
  backend,
});

describe("createSessionSettings", () => {
  it("starts with nothing set and instances do not share state", () => {
    const a = createSessionSettings();
    const b = createSessionSettings();
    a.writer.apply({ dispatchEnabled: true });
    expect(a.view.get().dispatchEnabled).toBe(true);
    expect(b.view.get().dispatchEnabled).toBeUndefined();
    expect(b.view.get().providers).toBeUndefined();
    expect(b.view.get().defaultExtensions).toBeUndefined();
  });

  it("null and an empty array clear a field back to not-set", () => {
    const s = createSessionSettings();
    s.writer.apply({
      dispatchEnabled: true,
      providers: [pageProvider("p", "coder-box")],
      defaultExtensions: ["qwen-toolkit"],
    });
    s.writer.apply({ dispatchEnabled: null, providers: [], defaultExtensions: null });
    expect(s.view.get()).toEqual({
      dispatchEnabled: undefined,
      providers: undefined,
      defaultExtensions: undefined,
    });
  });

  it("an omitted field is left alone", () => {
    const s = createSessionSettings();
    s.writer.apply({ dispatchEnabled: false, defaultExtensions: ["a"] });
    s.writer.apply({ providers: [pageProvider("p", "b")] });
    const got = s.view.get();
    expect(got.dispatchEnabled).toBe(false);
    expect(got.defaultExtensions).toEqual(["a"]);
    expect(got.providers).toHaveLength(1);
  });

  it("snapshots are deep copies and frozen: mutating one (top level or nested arrays) changes nothing", () => {
    const s = createSessionSettings();
    s.writer.apply({ providers: [pageProvider("p", "b")], defaultExtensions: ["a"] });
    const snap = s.view.get();
    const attempts: Array<() => void> = [
      () => ((snap as { dispatchEnabled: boolean }).dispatchEnabled = true),
      () => ((snap.providers as AgentProvider[])[0]!.backend = "hijacked"),
      () => (snap.providers as AgentProvider[]).push(pageProvider("q", "b")),
      () => (snap.providers![0]!.modalities as string[]).push("embedding"),
      () => (snap.providers![0]!.excludes as string[]).push("schemaSynth"),
      () => (snap.defaultExtensions as string[]).push("x"),
    ];
    for (const a of attempts) {
      try {
        a(); // frozen objects throw in strict mode; either way nothing may stick
      } catch {
        /* expected */
      }
    }
    const again = s.view.get();
    expect(again.dispatchEnabled).toBeUndefined();
    expect(again.providers).toHaveLength(1);
    expect(again.providers![0]!.backend).toBe("b");
    expect(again.providers![0]!.modalities).toEqual(["text"]);
    expect(again.providers![0]!.excludes).toEqual([]);
    expect(again.defaultExtensions).toEqual(["a"]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.providers)).toBe(true);
    expect(Object.isFrozen(snap.providers![0])).toBe(true);
    expect(Object.isFrozen(snap.providers![0]!.modalities)).toBe(true);
    expect(Object.isFrozen(snap.defaultExtensions)).toBe(true);
  });

  it("apply() copies its input: mutating the patch afterwards changes nothing", () => {
    const s = createSessionSettings();
    const prov = pageProvider("p", "b");
    const exts = ["a"];
    s.writer.apply({ providers: [prov], defaultExtensions: exts });
    prov.backend = "hijacked";
    prov.modalities.push("embedding");
    exts.push("x");
    expect(s.view.get().providers![0]!.backend).toBe("b");
    expect(s.view.get().providers![0]!.modalities).toEqual(["text"]);
    expect(s.view.get().defaultExtensions).toEqual(["a"]);
  });

  it("the settings object, view and writer are frozen (no swapping a method out)", () => {
    const s = createSessionSettings();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.view)).toBe(true);
    expect(Object.isFrozen(s.writer)).toBe(true);
    expect(() => {
      (s.view as { get: unknown }).get = () => ({ dispatchEnabled: true });
    }).toThrow();
    expect(s.view.get().dispatchEnabled).toBeUndefined();
  });

  it("writes nothing to the config dir", () => {
    const s = createSessionSettings();
    s.writer.apply({ dispatchEnabled: true, providers: [pageProvider("p", "b")], defaultExtensions: ["a"] });
    // The temp config dir was created empty by beforeEach and must stay empty.
    expect(readdirSync(tmpConfigDir)).toEqual([]);
  });
});

describe("effectiveDispatchEnabled", () => {
  it("with nothing set from the page it equals isDispatchEnabled(env)", () => {
    const s = createSessionSettings();
    for (const v of [undefined, "", "0", "false", "1", "true", "YES", " 1 "]) {
      const env = v === undefined ? {} : { QWEN_DISPATCH_ENABLE: v };
      const got = effectiveDispatchEnabled(s.view, env);
      expect(got.enabled).toBe(isDispatchEnabled(env));
      expect(got.source).toBe(got.enabled ? "env" : "off");
    }
  });

  it("a page value wins over the env in both directions", () => {
    const s = createSessionSettings();
    s.writer.apply({ dispatchEnabled: true });
    expect(effectiveDispatchEnabled(s.view, {})).toEqual({ enabled: true, source: "page" });
    s.writer.apply({ dispatchEnabled: false });
    expect(effectiveDispatchEnabled(s.view, { QWEN_DISPATCH_ENABLE: "1" })).toEqual({
      enabled: false,
      source: "page",
    });
  });

  it("an undefined view behaves as nothing set", () => {
    expect(effectiveDispatchEnabled(undefined, { QWEN_DISPATCH_ENABLE: "1" })).toEqual({
      enabled: true,
      source: "env",
    });
  });
});

describe("effectiveProviders", () => {
  it("with nothing set from the page it returns exactly what loadAgentProviders returns", () => {
    process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
      { id: "box", agentKind: "qwen-local", backend: "coder-box" },
    ]);
    const s = createSessionSettings();
    const got = effectiveProviders(s.view, loadAgentProviders);
    expect(got.providers).toEqual(loadAgentProviders());
    expect(got.source).toBe("env");
  });

  it("reports the config file as the source when the env is unset", () => {
    writeFileSync(
      join(tmpConfigDir, "config.json"),
      JSON.stringify({ agent_providers: [{ id: "c", agentKind: "qwen-local", backend: "b" }] }),
    );
    const s = createSessionSettings();
    const got = effectiveProviders(s.view, loadAgentProviders);
    expect(got.providers.map((p) => p.id)).toEqual(["c"]);
    expect(got.source).toBe("config");
  });

  it("source is none when nothing is declared", () => {
    const s = createSessionSettings();
    expect(effectiveProviders(s.view, loadAgentProviders)).toEqual({ providers: [], source: "none" });
  });

  it("page providers replace env/config providers entirely", () => {
    process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
      { id: "env-one", agentKind: "qwen-local", backend: "coder-box" },
    ]);
    const s = createSessionSettings();
    s.writer.apply({ providers: [pageProvider("page-one", "coder-mac")] });
    const got = effectiveProviders(s.view, loadAgentProviders);
    expect(got.providers.map((p) => p.id)).toEqual(["page-one"]);
    expect(got.source).toBe("page");
  });

  it("an empty page provider list falls back to env/config", () => {
    process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
      { id: "env-one", agentKind: "qwen-local", backend: "coder-box" },
    ]);
    const s = createSessionSettings();
    s.writer.apply({ providers: [pageProvider("page-one", "coder-mac")] });
    s.writer.apply({ providers: [] });
    expect(effectiveProviders(s.view, loadAgentProviders).providers.map((p) => p.id)).toEqual(["env-one"]);
  });
});

describe("effectiveDefaultExtensions", () => {
  it("with nothing set from the page it equals getSessionDefaultExtensions(env)", () => {
    const s = createSessionSettings();
    // leave-defaults
    expect(effectiveDefaultExtensions(s.view, {}).value).toEqual(getSessionDefaultExtensions({}));
    expect(effectiveDefaultExtensions(s.view, {}).source).toBe("none");
    // env
    const env = { QWEN_DEFAULT_EXTENSIONS: "Qwen-Toolkit, other" };
    expect(effectiveDefaultExtensions(s.view, env).value).toEqual(getSessionDefaultExtensions(env));
    expect(effectiveDefaultExtensions(s.view, env).source).toBe("env");
    // config file
    writeFileSync(join(tmpConfigDir, "config.json"), JSON.stringify({ default_extensions: ["from-file"] }));
    expect(effectiveDefaultExtensions(s.view, {}).value).toEqual(["from-file"]);
    expect(effectiveDefaultExtensions(s.view, {}).source).toBe("config");
  });

  it("the page value wins over env and config", () => {
    writeFileSync(join(tmpConfigDir, "config.json"), JSON.stringify({ default_extensions: ["from-file"] }));
    const s = createSessionSettings();
    s.writer.apply({ defaultExtensions: ["qwen-toolkit"] });
    expect(effectiveDefaultExtensions(s.view, { QWEN_DEFAULT_EXTENSIONS: "env-ext" })).toEqual({
      value: ["qwen-toolkit"],
      source: "page",
    });
  });
});

describe("qwen_dispatch through the settings gates", () => {
  const RESULT: AgentResult = {
    artifacts: [{ kind: "patch", diff: "d", base: "abc" }],
    turns: 1,
    outcome: "completed",
    cost: 0,
  };
  const input = { prompt: "do it", worktree: "/wt", base_commit: "abc" } as const;

  it("is dispatch_not_enabled before the page enables it, and proceeds after", async () => {
    const s = createSessionSettings();
    const gates = settingsDispatchGates(s.view, loadAgentProviders, {});
    const resolveDispatch = vi.fn(() => async () => RESULT);
    const deps = { ...gates, resolveDispatch, backendIds: () => ["coder-box"] };

    await expect(runQwenDispatch(input, deps)).rejects.toMatchObject({ code: "dispatch_not_enabled" });
    expect(resolveDispatch).not.toHaveBeenCalled();

    s.writer.apply({ dispatchEnabled: true });
    // Enabled but no provider declared anywhere: the next check is reached.
    await expect(runQwenDispatch(input, deps)).rejects.toMatchObject({ code: "no_provider" });

    s.writer.apply({ providers: [pageProvider("box", "coder-box")] });
    const result = await runQwenDispatch(input, deps);
    expect(result).toEqual(RESULT);
    expect(resolveDispatch).toHaveBeenCalledTimes(1);
    const resolvedProvider = (resolveDispatch.mock.calls[0] as unknown as [AgentProvider])[0];
    expect(resolvedProvider.backend).toBe("coder-box");
  });

  it("the dispatch_not_enabled message points at the settings page as well as the env var", async () => {
    const s = createSessionSettings();
    const deps = { ...settingsDispatchGates(s.view, loadAgentProviders, {}), resolveDispatch: vi.fn() };
    await expect(runQwenDispatch(input, deps)).rejects.toThrow(/QWEN_DISPATCH_ENABLE=1[\s\S]*qwen_settings/);
  });

  it("a page-set provider still has to name a backend in the pool", async () => {
    const s = createSessionSettings();
    s.writer.apply({ dispatchEnabled: true, providers: [pageProvider("box", "gone-box")] });
    const deps = {
      ...settingsDispatchGates(s.view, loadAgentProviders, {}),
      resolveDispatch: vi.fn(() => async () => RESULT),
      backendIds: () => ["coder-box"],
    };
    await expect(runQwenDispatch(input, deps)).rejects.toMatchObject({ code: "backend_unavailable" });
  });

  it("with nothing set from the page it behaves as the env-only path", async () => {
    process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
      { id: "box", agentKind: "qwen-local", backend: "coder-box" },
    ]);
    const s = createSessionSettings();
    const resolveDispatch = vi.fn(() => async () => RESULT);
    const mk = (env: NodeJS.ProcessEnv) => ({
      ...settingsDispatchGates(s.view, loadAgentProviders, env),
      resolveDispatch,
      backendIds: () => ["coder-box"],
    });
    await expect(runQwenDispatch(input, mk({}))).rejects.toMatchObject({ code: "dispatch_not_enabled" });
    await expect(runQwenDispatch(input, mk({ QWEN_DISPATCH_ENABLE: "1" }))).resolves.toEqual(RESULT);
  });

  it("the page can turn dispatch off even when the env enabled it", async () => {
    const s = createSessionSettings();
    s.writer.apply({ dispatchEnabled: false });
    const deps = {
      ...settingsDispatchGates(s.view, loadAgentProviders, { QWEN_DISPATCH_ENABLE: "1" }),
      resolveDispatch: vi.fn(),
    };
    await expect(runQwenDispatch(input, deps)).rejects.toMatchObject({ code: "dispatch_not_enabled" });
  });
});
