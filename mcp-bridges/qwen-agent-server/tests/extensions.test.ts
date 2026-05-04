// SPDX-License-Identifier: MIT
//
// Unit tests for resolveQwenRealBin / resolveWrapperPath in src/extensions.ts.
// RDR-002 §Decision → 'The wrapper-script bridge'.

import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";

import {
  createInstalledExtensionsCache,
  parseInstalledExtensions,
  resolveQwenRealBin,
  resolveWrapperPath,
} from "../src/extensions.js";

describe("resolveQwenRealBin", () => {
  // ── Case 1: env override set and pointing at a real executable ─

  it("returns env QWEN_REAL_BIN verbatim when it points to an existing executable", () => {
    // process.execPath is the node binary — guaranteed to exist and be
    // executable on every platform vitest runs on.
    const env: NodeJS.ProcessEnv = { QWEN_REAL_BIN: process.execPath };
    const result = resolveQwenRealBin(env, () => {
      throw new Error("which should not be called when env is set");
    });
    expect(result).toBe(process.execPath);
  });

  // ── Case 2: env override set but path does not exist ───────────

  it("throws a descriptive error when QWEN_REAL_BIN is set but missing", () => {
    const fakePath = "/nonexistent-zzz-qwen-binary-9c8f2a";
    const env: NodeJS.ProcessEnv = { QWEN_REAL_BIN: fakePath };
    expect(() => resolveQwenRealBin(env, () => "/should/not/be/called"))
      .toThrowError(/QWEN_REAL_BIN.*\/nonexistent-zzz-qwen-binary-9c8f2a/);
  });

  // ── Case 3: env unset, which() finds the binary ────────────────

  it("returns the path which() reports when QWEN_REAL_BIN is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = resolveQwenRealBin(env, (cmd) => {
      expect(cmd).toBe("qwen");
      return "/usr/local/bin/qwen-from-which";
    });
    expect(result).toBe("/usr/local/bin/qwen-from-which");
  });

  // ── Case 4: env unset, which() returns null/empty ──────────────

  it("throws a fail-fast error when QWEN_REAL_BIN is unset and 'qwen' is not on PATH", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => resolveQwenRealBin(env, () => null))
      .toThrowError(/QWEN_REAL_BIN unset.*not on PATH/);
    expect(() => resolveQwenRealBin(env, () => ""))
      .toThrowError(/QWEN_REAL_BIN unset.*not on PATH/);
  });

  // ── Edge: empty-string env override is treated as unset ────────

  it("treats an empty-string QWEN_REAL_BIN as unset (falls through to which)", () => {
    const env: NodeJS.ProcessEnv = { QWEN_REAL_BIN: "" };
    const result = resolveQwenRealBin(env, () => "/from/which");
    expect(result).toBe("/from/which");
  });
});

describe("resolveWrapperPath", () => {
  it("points to scripts/qwen-extensions-wrapper.sh inside the package", () => {
    const wrapperPath = resolveWrapperPath();
    expect(wrapperPath.endsWith("/scripts/qwen-extensions-wrapper.sh")).toBe(true);
  });

  it("resolves to a file that exists in the working tree", () => {
    const wrapperPath = resolveWrapperPath();
    expect(existsSync(wrapperPath)).toBe(true);
  });

  it("resolves to an executable file (mode 0755 or compatible)", () => {
    const wrapperPath = resolveWrapperPath();
    const stat = statSync(wrapperPath);
    // any executable bit set (owner/group/other)
    expect(stat.mode & 0o111).not.toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseInstalledExtensions

describe("parseInstalledExtensions", () => {
  // Output format documented in /tmp/rdr-002-cli-spike.md (T2 record
  // 002-research-005) and verified in cli.js:456690 (extensionToOutputString).
  // Each block starts with `<glyph> <name> (<version>)`, blocks are
  // joined by a blank line.

  it("extracts names from a well-formed multi-extension list", () => {
    const stdout = [
      "✓ serena (1.2.3)",
      " Path: /home/u/.qwen/extensions/serena",
      " Source: github.com/example/serena (Type: git)",
      " Enabled (User): true",
      " Enabled (Workspace): true",
      "",
      "✗ web-fetch (0.0.5)",
      " Path: /home/u/.qwen/extensions/web-fetch",
      " Enabled (User): false",
      " Enabled (Workspace): false",
      "",
      "✓ Custom-Tool (2.0.0)",
      " Path: /home/u/.qwen/extensions/custom-tool",
      " Enabled (User): true",
      " Enabled (Workspace): true",
    ].join("\n");

    const result = parseInstalledExtensions(stdout);
    // Names lowercased for the case-insensitive matching the SDK uses.
    expect(result).toEqual(["serena", "web-fetch", "custom-tool"]);
  });

  it("returns an empty array for the 'No extensions installed.' sentinel", () => {
    expect(parseInstalledExtensions("No extensions installed.\n")).toEqual([]);
  });

  it("returns an empty array for empty/whitespace input (fail-soft)", () => {
    expect(parseInstalledExtensions("")).toEqual([]);
    expect(parseInstalledExtensions("\n\n\n")).toEqual([]);
    expect(parseInstalledExtensions("   ")).toEqual([]);
  });

  it("returns an empty array on unrecognized garbage (fail-soft, no throw)", () => {
    const garbage = "this is not the output you are looking for\nbinary blob: ☃ ☃ ☃\n";
    expect(() => parseInstalledExtensions(garbage)).not.toThrow();
    expect(parseInstalledExtensions(garbage)).toEqual([]);
  });

  it("strips ANSI color codes that chalk may insert", () => {
    // Chalk-produced status glyphs (green/red) wrap the glyph in
    // SGR escapes — strip before matching.
    const stdout = "\x1b[32m✓\x1b[39m serena (1.0.0)\n Path: /tmp/serena\n";
    expect(parseInstalledExtensions(stdout)).toEqual(["serena"]);
  });

  it("does not pick up the ' Path: ... (Type: ...)' second line as a name", () => {
    // Defensive: the Path line contains parens and would match a naive
    // header regex. Block-first-line parsing avoids this.
    const stdout = [
      "✓ serena (1.0.0)",
      " Path: /home/u/.qwen/extensions/serena",
      " Source: github.com/example/serena (Type: git)",
      " Enabled (User): true",
    ].join("\n");
    expect(parseInstalledExtensions(stdout)).toEqual(["serena"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// createInstalledExtensionsCache

describe("createInstalledExtensionsCache", () => {
  it("populates the cache from execFn stdout on construction", async () => {
    const stdout = [
      "✓ alpha (1.0.0)",
      " Path: /tmp/alpha",
      "",
      "✓ beta (2.0.0)",
      " Path: /tmp/beta",
    ].join("\n");
    const cache = await createInstalledExtensionsCache("/usr/bin/qwen", async () => stdout);
    expect(cache.size()).toBe(2);
    expect(cache.get()).toEqual(new Set(["alpha", "beta"]));
  });

  it("propagates errors from execFn (fail-fast at startup)", async () => {
    const exec = async () => {
      throw new Error("ENOENT: qwen not found");
    };
    await expect(
      createInstalledExtensionsCache("/usr/bin/qwen", exec),
    ).rejects.toThrow(/ENOENT/);
  });

  it("reload() re-executes execFn and replaces internal state", async () => {
    let stdout = "✓ first (1.0.0)\n Path: /a\n";
    const cache = await createInstalledExtensionsCache("/usr/bin/qwen", async () => stdout);
    expect(cache.get()).toEqual(new Set(["first"]));

    // After first construction, mutate the closure to return new output.
    stdout = "✓ first (1.0.0)\n Path: /a\n\n✓ second (1.0.0)\n Path: /b\n";
    const newSet = await cache.reload();
    expect(newSet).toEqual(new Set(["first", "second"]));
    // get() reflects the new state (no stale closure).
    expect(cache.get()).toEqual(new Set(["first", "second"]));
  });

  it("logs a warning but does not throw when output is unparseable", async () => {
    // Cache should populate empty rather than crash — see audit-note #4.
    const cache = await createInstalledExtensionsCache(
      "/usr/bin/qwen",
      async () => "totally unexpected qwen output v9000\n",
    );
    expect(cache.size()).toBe(0);
    expect(cache.get()).toEqual(new Set<string>());
  });

  it("treats 'No extensions installed.' as a clean empty cache (no warning)", async () => {
    const cache = await createInstalledExtensionsCache(
      "/usr/bin/qwen",
      async () => "No extensions installed.\n",
    );
    expect(cache.size()).toBe(0);
  });
});
