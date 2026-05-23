// SPDX-License-Identifier: MIT
//
// Version-consistency gate (bead qwen-coprocessor-stack-djv).
//
// The release surface advertises a version string in four places:
//
//   1. mcp-bridges/qwen-agent-server/src/version.ts  — SUPERVISOR_VERSION,
//      reported on the MCP wire as ServerInfo.version.
//   2. .claude-plugin/plugin.json                    — plugin manifest.
//   3. .claude-plugin/marketplace.json               — metadata.version.
//   4. .claude-plugin/marketplace.json               — plugins[0].version.
//
// Any release bump that misses one of these surfaces ships a confusing
// state (e.g. plugin says 0.11.0, marketplace still says 0.10.0). The
// pre-djv surface had marketplace stuck at 0.10.0 and the MCP server
// reporting "0.0.1" forever. This test asserts all four agree.
//
// To bump version: edit src/version.ts, plugin.json, and both fields in
// marketplace.json together. Failing this test in CI is the gate.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUPERVISOR_VERSION } from "../src/version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function readJson(rel: string): Record<string, unknown> {
  const p = path.join(repoRoot, rel);
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("version consistency", () => {
  it("SUPERVISOR_VERSION matches plugin.json and both marketplace.json fields", () => {
    const plugin = readJson(".claude-plugin/plugin.json");
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const metadata = marketplace["metadata"] as Record<string, unknown>;
    const plugins = marketplace["plugins"] as Array<Record<string, unknown>>;

    expect(plugin["version"]).toBe(SUPERVISOR_VERSION);
    expect(metadata["version"]).toBe(SUPERVISOR_VERSION);
    expect(plugins[0]?.["version"]).toBe(SUPERVISOR_VERSION);
  });

  it("LICENSE file exists at repository root", () => {
    // plugin.json declares license:MIT and source files carry SPDX
    // headers — the actual LICENSE text must be present too or GitHub /
    // tooling license detection silently fails. (Pre-djv: missing.)
    const licensePath = path.join(repoRoot, "LICENSE");
    const text = readFileSync(licensePath, "utf8");
    expect(text).toMatch(/MIT License/);
    expect(text).toMatch(/Hal Hildebrand/);
  });
});
