// SPDX-License-Identifier: MIT
//
// RDR-014 Item1: opts.codeIntel (agent-lsp opt-in) server-side expansion.
// Exercises applyCodeIntel directly (the single-site synthesis at the
// opts-resolution boundary) and the qwen_oneshot/qwen_spawn schema acceptance.
// Tests (a)–(h) from RDR-014 §In-scope item 5, plus an explicit qwen_oneshot
// path assertion (nx_plan_audit advisory: both call sites must be covered).

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SpawnOpts } from "../src/types.js";

// Mock the logger BEFORE importing server.js so the module-level
// `const log = createLogger(...)` is captured. Mirrors session.test.ts.
const logCapture = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock("../src/log.js", () => {
  const make = () => {
    const rec = (...args: unknown[]) => {
      logCapture.lines.push(args);
    };
    return {
      info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec,
      child: () => make(),
    };
  };
  return { createLogger: () => make() };
});

import { applyCodeIntel, buildSpawnOptsFromRaw, qwenSpawnOptsSchema } from "../src/server.js";
import type { McpServerConfig } from "@qwen-code/sdk";

const LSP_KEY = "agent-lsp";

// McpServerConfig is a union (CLI | SDK); the synthesized entry is always the
// stdio CLI shape. Narrow for field assertions.
type CliCfg = { command?: string; args?: string[]; cwd?: string; includeTools?: string[] };
const cli = (entry: unknown): CliCfg => (entry ?? {}) as CliCfg;
const servers = (r: Record<string, unknown>): Record<string, McpServerConfig> =>
  r as Record<string, McpServerConfig>;

// The pinned high-signal allow-list (RDR-014 RF-4 / bead 60v). Kept here as the
// regression anchor — if the production list changes, this test must change too.
const EXPECTED_INCLUDE_TOOLS = [
  "start_lsp",
  "list_symbols",
  "find_symbol",
  "find_references",
  "find_callers",
  "inspect_symbol",
  "explore_symbol",
  "go_to_definition",
  "get_symbol_source",
  "get_diagnostics",
];

function warned(eventType: string): boolean {
  return logCapture.lines.some((args) => {
    const fields = args[0] as { event_type?: string } | undefined;
    return fields?.event_type === eventType;
  });
}

describe("RDR-014 codeIntel (applyCodeIntel)", () => {
  beforeEach(() => {
    logCapture.lines.length = 0;
  });

  it("(a) codeIntel:true, no caller agent-lsp → synthesizes the uvx agent-lsp entry with the pinned includeTools", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true, cwd: "/work/repo" };
    applyCodeIntel(opts);
    const entry = cli(opts.mcpServers?.[LSP_KEY]);
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("uvx");
    expect(entry?.args).toEqual(["agent-lsp"]);
    expect(entry?.cwd).toBe("/work/repo");
    expect(entry?.includeTools).toEqual(EXPECTED_INCLUDE_TOOLS);
  });

  it("(a') synthesized cwd falls back to process.cwd() when opts.cwd is unset", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true };
    applyCodeIntel(opts);
    expect(cli(opts.mcpServers?.[LSP_KEY]).cwd).toBe(process.cwd());
  });

  it("(b) codeIntel unset → mcpServers undefined AND no guidance in system", () => {
    const opts: Partial<SpawnOpts> = { system: "base prompt" };
    applyCodeIntel(opts);
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.system).toBe("base prompt");
    expect(opts.max_tool_calls).toBeUndefined();
  });

  it("(b') codeIntel:false → byte-for-byte unset behavior", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: false, system: "x" };
    applyCodeIntel(opts);
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.system).toBe("x");
    expect(opts.max_tool_calls).toBeUndefined();
  });

  it("(c) codeIntel:true + caller-supplied agent-lsp → caller entry preserved, WARN emitted, guidance SUPPRESSED (coupling)", () => {
    const callerEntry = { command: "my-own-lsp", args: ["--stdio"] };
    const opts: Partial<SpawnOpts> = {
      codeIntel: true,
      system: "caller system",
      mcpServers: servers({ [LSP_KEY]: { ...callerEntry } }),
    };
    applyCodeIntel(opts);
    // caller entry untouched
    expect(opts.mcpServers?.[LSP_KEY]).toEqual(callerEntry);
    // WARN emitted
    expect(warned("codeintel_lsp_key_present")).toBe(true);
    // guidance NOT injected (coupling C2)
    expect(opts.system).toBe("caller system");
    // budget default STILL applies on collision (independent of server injection)
    expect(opts.max_tool_calls).toBe(12);
  });

  it("(c') collision but caller set max_tool_calls → caller value preserved (no re-cap)", () => {
    const opts: Partial<SpawnOpts> = {
      codeIntel: true,
      max_tool_calls: 3,
      mcpServers: servers({ [LSP_KEY]: { command: "x" } }),
    };
    applyCodeIntel(opts);
    expect(opts.max_tool_calls).toBe(3);
    expect(warned("codeintel_lsp_key_present")).toBe(true);
  });

  it("(d) codeIntel:true, max_tool_calls undefined → defaults to 12", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true };
    applyCodeIntel(opts);
    expect(opts.max_tool_calls).toBe(12);
  });

  it("(e) caller set max_tool_calls:5 → stays 5", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true, max_tool_calls: 5 };
    applyCodeIntel(opts);
    expect(opts.max_tool_calls).toBe(5);
  });

  it("(f) codeIntel:true, max_tool_calls:0 (explicit unbounded) → stays 0, NOT re-capped to 12 [C1 guard]", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true, max_tool_calls: 0 };
    applyCodeIntel(opts);
    expect(opts.max_tool_calls).toBe(0);
  });

  it("(g) codeIntel:true, no collision → guidance present in system, no WARN, caller system preserved as prefix", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true, system: "caller system" };
    applyCodeIntel(opts);
    // precise: caller system, then a blank-line separator, then the guidance.
    expect(opts.system?.startsWith("caller system\n\n")).toBe(true);
    expect(opts.system).toContain("agent-lsp");
    expect(opts.system).toContain("symbol-GRAPH");
    expect(warned("codeintel_lsp_key_present")).toBe(false);
  });

  it("(g-seq) guidance carries the start_lsp → find_symbol sequencing rules (rough-edge fix, bead 14t)", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true };
    applyCodeIntel(opts);
    const sys = opts.system ?? "";
    // start_lsp must come first, with the right root_dir and a ready-timeout.
    expect(sys).toContain("start_lsp");
    expect(sys).toContain("root_dir");
    expect(sys).toContain("ready_timeout_seconds");
    expect(sys).toContain("manifest");
    // the tsserver "No Project" / open-a-file-before-find_symbol recovery.
    expect(sys).toContain("No Project");
    // Non-vacuous: pin the open-file-before-find_symbol sentence specifically.
    // (A bare /find_symbol/ would pass on the pre-existing guidance — assert the
    //  recovery phrase AND its ordering instead.)
    expect(sys).toContain("open one known file first with");
    expect(sys).toContain("retry `find_symbol`");
    expect(sys.indexOf("open one known file first with")).toBeLessThan(
      sys.indexOf("retry `find_symbol`"),
    );
    // and the explicit "don't fall back to grep" steer.
    expect(sys.toLowerCase()).toContain("grep");
  });

  it("(g''') codeIntel:true, empty-string system → treated as unset (guidance is the whole prompt, no leading separator)", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true, system: "" };
    applyCodeIntel(opts);
    expect(opts.system?.startsWith("## Code intelligence")).toBe(true);
  });

  it("(g') codeIntel:true, no caller system → guidance becomes the system prompt", () => {
    const opts: Partial<SpawnOpts> = { codeIntel: true };
    applyCodeIntel(opts);
    expect(opts.system).toContain("agent-lsp");
    expect(opts.system).not.toMatch(/^\n\n/); // no dangling leading separator
  });

  it("(g'') codeIntel:true merges with an unrelated caller mcpServers entry (does not clobber)", () => {
    const opts: Partial<SpawnOpts> = {
      codeIntel: true,
      mcpServers: servers({ other: { command: "x" } }),
    };
    applyCodeIntel(opts);
    expect(opts.mcpServers?.["other"]).toEqual({ command: "x" });
    expect(cli(opts.mcpServers?.[LSP_KEY]).command).toBe("uvx");
  });

  it("(h) zod: codeIntel accepts boolean (true/false), rejects non-boolean", () => {
    expect(qwenSpawnOptsSchema.safeParse({ codeIntel: true }).success).toBe(true);
    expect(qwenSpawnOptsSchema.safeParse({ codeIntel: false }).success).toBe(true);
    expect(qwenSpawnOptsSchema.safeParse({ codeIntel: "yes" }).success).toBe(false);
    expect(qwenSpawnOptsSchema.safeParse({ codeIntel: 1 }).success).toBe(false);
  });

  it("(h') buildSpawnOptsFromRaw carries codeIntel through; absent when unset", () => {
    expect(buildSpawnOptsFromRaw({ codeIntel: true }).codeIntel).toBe(true);
    expect(buildSpawnOptsFromRaw({}).codeIntel).toBeUndefined();
    expect(buildSpawnOptsFromRaw(undefined).codeIntel).toBeUndefined();
  });

  it("(oneshot) qwen_oneshot's extended schema accepts codeIntel + applyCodeIntel composition path (wire-line coverage is in session.test.ts capturedOptions cases)", () => {
    const oneshotSchema = qwenSpawnOptsSchema.unwrap().extend({});
    expect(oneshotSchema.safeParse({ codeIntel: true }).success).toBe(true);
    // and the full pipeline through buildSpawnOptsFromRaw + applyCodeIntel
    const resolved = applyCodeIntel(buildSpawnOptsFromRaw({ codeIntel: true, cwd: "/r" }));
    expect(cli(resolved.mcpServers?.[LSP_KEY]).command).toBe("uvx");
    expect(resolved.max_tool_calls).toBe(12);
  });
});
