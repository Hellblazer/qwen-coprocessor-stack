// SPDX-License-Identifier: MIT
//
// Unit tests for resolveQwenRealBin / resolveWrapperPath in src/extensions.ts.
// RDR-002 §Decision → 'The wrapper-script bridge'.

import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";

import {
  createInstalledExtensionsCache,
  ExtensionResolutionError,
  getSessionDefaultExtensions,
  parseInstalledExtensions,
  resolveExtensions,
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

  it("rejects glyph-less first lines (HEADER_RE requires the status glyph)", () => {
    // Phase-6 review finding #1: HEADER_RE requires the leading ✓/✗
    // status glyph that handleList always emits (cli.js:456701 with
    // inline2=false). A first line like 'something (1.0.0)' WITHOUT
    // the glyph must NOT register — it's the kind of accidental match
    // that would surface if a future SDK output change orphans a
    // (version)-shaped string from its block boundary.
    const stdout = [
      "something-without-glyph (1.0.0)",
      " Path: /tmp/x",
      "",
      "another-without-glyph (2.0.0)",
      " Path: /tmp/y",
    ].join("\n");
    expect(parseInstalledExtensions(stdout)).toEqual([]);
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

// ─────────────────────────────────────────────────────────────────
// getSessionDefaultExtensions

describe("getSessionDefaultExtensions", () => {
  it("returns 'leave-defaults' when QWEN_DEFAULT_EXTENSIONS is unset", () => {
    expect(getSessionDefaultExtensions({})).toBe("leave-defaults");
  });

  it("returns 'leave-defaults' when QWEN_DEFAULT_EXTENSIONS is empty", () => {
    expect(getSessionDefaultExtensions({ QWEN_DEFAULT_EXTENSIONS: "" })).toBe("leave-defaults");
  });

  it("parses a comma-separated list and lowercases names", () => {
    expect(
      getSessionDefaultExtensions({ QWEN_DEFAULT_EXTENSIONS: "Serena, Web-Fetch , CUSTOM" }),
    ).toEqual(["serena", "web-fetch", "custom"]);
  });

  it("dedupes repeated names", () => {
    expect(
      getSessionDefaultExtensions({ QWEN_DEFAULT_EXTENSIONS: "a,b,a,b,c" }),
    ).toEqual(["a", "b", "c"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// resolveExtensions — RDR-002 §Resolution-algorithm steps 1–9

describe("resolveExtensions", () => {
  // Installed cache used by all tests; the resolver lowercases input
  // before lookup so case-insensitive matching is exercised by the
  // dedicated case below.
  const cache = new Set(["a", "b", "c", "serena", "web-fetch"]);

  // ── leave-defaults branch ─────────────────────────────────────

  it("opts undefined + session leave-defaults → leave-defaults sentinel", () => {
    const result = resolveExtensions(undefined, "leave-defaults", cache);
    expect(result).toEqual({ envValue: null, resolved: "leave-defaults" });
  });

  it("opts {} + session leave-defaults → leave-defaults sentinel", () => {
    const result = resolveExtensions({}, "leave-defaults", cache);
    expect(result).toEqual({ envValue: null, resolved: "leave-defaults" });
  });

  // ── only-mode (exact-set semantics) ───────────────────────────

  it("only=['a'] → resolved=['a'], envValue='a' (enable/disable IGNORED)", () => {
    const result = resolveExtensions(
      { only: ["a"], enable: ["b"], disable: ["c"] },
      ["a", "b", "c"],
      cache,
    );
    expect(result).toEqual({ envValue: "a", resolved: ["a"] });
  });

  it("only=['a','b'] → resolved=['a','b'], envValue='a,b'", () => {
    const result = resolveExtensions({ only: ["a", "b"] }, "leave-defaults", cache);
    expect(result).toEqual({ envValue: "a,b", resolved: ["a", "b"] });
  });

  it("only=[] (explicit empty) → resolved='none', envValue='none'", () => {
    const result = resolveExtensions({ only: [] }, "leave-defaults", cache);
    expect(result).toEqual({ envValue: "none", resolved: "none" });
  });

  // ── session-default base + enable / disable ───────────────────

  it("session-default ['a','b'], no opts → resolved=['a','b'], envValue='a,b'", () => {
    const result = resolveExtensions(undefined, ["a", "b"], cache);
    expect(result).toEqual({ envValue: "a,b", resolved: ["a", "b"] });
  });

  it("session-default ['a','b'], enable=['c'] → ['a','b','c']", () => {
    const result = resolveExtensions({ enable: ["c"] }, ["a", "b"], cache);
    expect(result).toEqual({ envValue: "a,b,c", resolved: ["a", "b", "c"] });
  });

  it("session-default ['a','b'], disable=['a'] → ['b']", () => {
    const result = resolveExtensions({ disable: ["a"] }, ["a", "b"], cache);
    expect(result).toEqual({ envValue: "b", resolved: ["b"] });
  });

  it("session-default ['a','b'], enable=['c'], disable=['a'] → ['b','c']", () => {
    const result = resolveExtensions(
      { enable: ["c"], disable: ["a"] },
      ["a", "b"],
      cache,
    );
    expect(result).toEqual({ envValue: "b,c", resolved: ["b", "c"] });
  });

  it("disable wins on overlap with enable (enable=['a'], disable=['a'])", () => {
    const result = resolveExtensions(
      { enable: ["a"], disable: ["a"] },
      ["b"],
      cache,
    );
    expect(result).toEqual({ envValue: "b", resolved: ["b"] });
  });

  it("session-default ['a'], disable=['a'] → 'none' (resolved-to-empty)", () => {
    const result = resolveExtensions({ disable: ["a"] }, ["a"], cache);
    expect(result).toEqual({ envValue: "none", resolved: "none" });
  });

  // ── case-insensitive matching ────────────────────────────────

  it("case-insensitive: only=['SERENA'] matches cache entry 'serena'", () => {
    const result = resolveExtensions({ only: ["SERENA"] }, "leave-defaults", cache);
    expect(result).toEqual({ envValue: "serena", resolved: ["serena"] });
  });

  it("dedupes repeated names within an input list", () => {
    const result = resolveExtensions(
      { only: ["a", "a", "b", "a"] },
      "leave-defaults",
      cache,
    );
    expect(result).toEqual({ envValue: "a,b", resolved: ["a", "b"] });
  });

  // ── unknown-name validation (step 6) ─────────────────────────

  it("only=['nonexistent'] → ExtensionResolutionError listing 'nonexistent'", () => {
    expect(() =>
      resolveExtensions({ only: ["nonexistent"] }, "leave-defaults", cache),
    ).toThrowError(ExtensionResolutionError);
    try {
      resolveExtensions({ only: ["nonexistent"] }, "leave-defaults", cache);
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionResolutionError);
      expect((err as ExtensionResolutionError).unknown).toEqual(["nonexistent"]);
      expect((err as Error).message).toMatch(/nonexistent/);
    }
  });

  it("enable=['nonexistent'] (without only) → ExtensionResolutionError", () => {
    expect(() =>
      resolveExtensions({ enable: ["nonexistent"] }, ["a"], cache),
    ).toThrowError(/nonexistent/);
  });

  it("multi-unknown listing: only=['x','a','y'] → reports both x and y", () => {
    try {
      resolveExtensions({ only: ["x", "a", "y"] }, "leave-defaults", cache);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionResolutionError);
      expect((err as ExtensionResolutionError).unknown).toEqual(["x", "y"]);
    }
  });

  it("enable with unknown name is NOT validated when only is set (only wins)", () => {
    // Step 2a: enable / disable IGNORED when only is specified. Therefore
    // an unknown name in enable doesn't cause an error in this branch.
    const result = resolveExtensions(
      { only: ["a"], enable: ["nonexistent-but-ignored"] },
      "leave-defaults",
      cache,
    );
    expect(result).toEqual({ envValue: "a", resolved: ["a"] });
  });

  // ── leave-defaults + enable/disable rejection ────────────────

  it("session leave-defaults + enable without only → ExtensionResolutionError", () => {
    expect(() =>
      resolveExtensions({ enable: ["c"] }, "leave-defaults", cache),
    ).toThrowError(ExtensionResolutionError);
  });

  it("session leave-defaults + disable without only → ExtensionResolutionError", () => {
    expect(() =>
      resolveExtensions({ disable: ["a"] }, "leave-defaults", cache),
    ).toThrowError(ExtensionResolutionError);
  });

  // ── step-7 framework-required union (Phase-6 review #2) ──────

  it("step 7 framework-required union runs after step 6 validation in the only branch", () => {
    // The framework-required set is empty today, so step 7 is a no-op.
    // This test pins the ordering: validation throws on unknown user
    // names BEFORE step 7 union touches the result. If a future change
    // makes framework-required non-empty without a corresponding
    // startup-time validation, this ordering ensures the user-supplied
    // unknown name still triggers the spawn_error envelope.
    expect(() =>
      resolveExtensions({ only: ["nonexistent"] }, "leave-defaults", cache),
    ).toThrowError(ExtensionResolutionError);
  });

  it("step 7 framework-required union runs after step 6 validation in the session-default branch", () => {
    // Same ordering pin for the enable/disable code path.
    expect(() =>
      resolveExtensions({ enable: ["nonexistent"] }, ["a"], cache),
    ).toThrowError(ExtensionResolutionError);
  });
});
