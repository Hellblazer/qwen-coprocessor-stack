// SPDX-License-Identifier: MIT
//
// Unit tests for resolveQwenRealBin / resolveWrapperPath in src/extensions.ts.
// RDR-002 §Decision → 'The wrapper-script bridge'.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDisableArgv,
  buildEnableArgv,
  buildInstallArgv,
  buildLinkArgv,
  buildUninstallArgv,
  buildUpdateArgv,
  classifySource,
  createInstalledExtensionsCache,
  DEFAULT_DISABLE_SCOPE,
  DEFAULT_ENABLE_SCOPE,
  defaultExecExtensionsMutate,
  disableExtension,
  enableExtension,
  EXTENSION_INSTALL_METADATA_FILENAME,
  ExtensionLifecycleError,
  ExtensionResolutionError,
  getSessionDefaultExtensions,
  installExtension,
  isRemoteSourceType,
  linkExtension,
  listInstalledExtensions,
  parseInstalledExtensions,
  parseInstalledExtensionsRich,
  QWEN_ALLOW_REMOTE_INSTALL_ENV,
  resolveExtensions,
  resolveQwenRealBin,
  resolveWrapperPath,
  uninstallExtension,
  unionFrameworkRequired,
  updateExtensions,
  validateScope,
} from "../src/extensions.js";
import { _resetConfigCache } from "../src/backends.js";

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

describe("getSessionDefaultExtensions — env source", () => {
  beforeEach(() => {
    delete process.env["QWEN_CONFIG_DIR"];
    _resetConfigCache();
  });

  it("returns 'leave-defaults' when QWEN_DEFAULT_EXTENSIONS is unset and no config", () => {
    expect(getSessionDefaultExtensions({})).toBe("leave-defaults");
  });

  it("returns 'leave-defaults' when QWEN_DEFAULT_EXTENSIONS is empty and no config", () => {
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

describe("getSessionDefaultExtensions — config file source", () => {
  let tmpConfigDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "qwen-defaults-"));
    configPath = join(tmpConfigDir, "config.json");
    process.env["QWEN_CONFIG_DIR"] = tmpConfigDir;
    _resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
    delete process.env["QWEN_CONFIG_DIR"];
    _resetConfigCache();
  });

  it("reads default_extensions from config.json when env unset", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ default_extensions: ["alpha", "beta"] }),
      "utf8",
    );
    expect(getSessionDefaultExtensions({})).toEqual(["alpha", "beta"]);
  });

  it("env priority: env wins over config file", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ default_extensions: ["from-file"] }),
      "utf8",
    );
    expect(
      getSessionDefaultExtensions({ QWEN_DEFAULT_EXTENSIONS: "from-env" }),
    ).toEqual(["from-env"]);
  });

  it("falls through to leave-defaults when both unset", () => {
    // Don't write the file and don't set env.
    expect(getSessionDefaultExtensions({})).toBe("leave-defaults");
  });

  it("falls through to leave-defaults when config has empty default_extensions", () => {
    writeFileSync(configPath, JSON.stringify({ default_extensions: [] }), "utf8");
    expect(getSessionDefaultExtensions({})).toBe("leave-defaults");
  });

  it("file values are dedupe-lowercased same as env values", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ default_extensions: ["Serena", "WEB-FETCH", "serena"] }),
      "utf8",
    );
    expect(getSessionDefaultExtensions({})).toEqual(["serena", "web-fetch"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseInstalledExtensionsRich + listInstalledExtensions

describe("parseInstalledExtensionsRich", () => {
  it("retains version, source, path, enabled-state, and declared lists", () => {
    const stdout = [
      "✓ serena (1.2.3)",
      " Path: /home/u/.qwen/extensions/serena",
      " Source: github.com/example/serena (Type: git)",
      " Enabled (User): true",
      " Enabled (Workspace): true",
      " Commands:",
      "  /find",
      "  /rename",
      " Skills:",
      "  symbol-nav",
      "",
      "✗ legacy-tool (0.0.5)",
      " Path: /home/u/.qwen/extensions/legacy",
      " Enabled (User): false",
      " Enabled (Workspace): false",
    ].join("\n");

    const result = parseInstalledExtensionsRich(stdout);
    expect(result).toHaveLength(2);

    const serena = result[0]!;
    expect(serena.name).toBe("serena");
    expect(serena.version).toBe("1.2.3");
    expect(serena.path).toBe("/home/u/.qwen/extensions/serena");
    expect(serena.source).toBe("github.com/example/serena");
    expect(serena.enabled_user).toBe(true);
    expect(serena.enabled_workspace).toBe(true);
    expect(serena.commands).toEqual(["find", "rename"]);
    expect(serena.skills).toEqual(["symbol-nav"]);
    expect(serena.agents).toBeUndefined();
    expect(serena.mcp_servers).toBeUndefined();

    const legacy = result[1]!;
    expect(legacy.name).toBe("legacy-tool");
    expect(legacy.enabled_user).toBe(false);
    expect(legacy.enabled_workspace).toBe(false);
  });

  it("returns [] for the No-extensions sentinel", () => {
    expect(parseInstalledExtensionsRich("No extensions installed.\n")).toEqual([]);
  });

  it("returns [] for empty / whitespace input", () => {
    expect(parseInstalledExtensionsRich("")).toEqual([]);
    expect(parseInstalledExtensionsRich("\n\n")).toEqual([]);
  });

  it("returns [] on garbage (no header matches)", () => {
    expect(parseInstalledExtensionsRich("not the qwen output")).toEqual([]);
  });

  it("strips ANSI color codes around the status glyph", () => {
    const stdout = "\x1b[32m✓\x1b[39m alpha (1.0.0)\n Path: /tmp/alpha\n";
    const result = parseInstalledExtensionsRich(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("alpha");
    expect(result[0]!.path).toBe("/tmp/alpha");
  });
});

describe("listInstalledExtensions", () => {
  it("delegates to execFn and parses the output", async () => {
    const stdout = [
      "✓ alpha (1.0.0)",
      " Path: /tmp/alpha",
      " Enabled (User): true",
    ].join("\n");
    const result = await listInstalledExtensions("/usr/bin/qwen", async () => stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("alpha");
    expect(result[0]!.version).toBe("1.0.0");
  });

  it("propagates exec errors (caller decides whether to swallow)", async () => {
    const exec = async () => {
      throw new Error("ENOENT: qwen not found");
    };
    await expect(listInstalledExtensions("/usr/bin/qwen", exec)).rejects.toThrow(/ENOENT/);
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
  //
  // Note: the load-bearing ordering pin (step 6 before step 7) is only
  // observable from `resolveExtensions` once FRAMEWORK_REQUIRED_EXTENSIONS
  // becomes non-empty. While it's empty today, these two tests serve as
  // regression nets confirming the unknown-name path still throws. The
  // direct unionFrameworkRequired(base, override) test below exercises
  // the non-empty union behaviour that resolveExtensions inherits at
  // step 7.

  it("unknown user-supplied name in only branch throws (regression net for step-6 path)", () => {
    expect(() =>
      resolveExtensions({ only: ["nonexistent"] }, "leave-defaults", cache),
    ).toThrowError(ExtensionResolutionError);
  });

  it("unknown user-supplied name in session-default branch throws (regression net for step-6 path)", () => {
    expect(() =>
      resolveExtensions({ enable: ["nonexistent"] }, ["a"], cache),
    ).toThrowError(ExtensionResolutionError);
  });
});

// ─────────────────────────────────────────────────────────────────
// unionFrameworkRequired — direct coverage of the non-empty path

describe("unionFrameworkRequired", () => {
  it("returns base unchanged when frameworkRequired is empty (default)", () => {
    expect(unionFrameworkRequired(["a", "b"])).toEqual(["a", "b"]);
  });

  it("appends framework-required names not already present", () => {
    expect(unionFrameworkRequired(["a"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("dedupes against the existing base (lowercased) without reordering", () => {
    expect(unionFrameworkRequired(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("lowercases framework-required names before insertion / dedup", () => {
    expect(unionFrameworkRequired(["a"], ["B", "C"])).toEqual(["a", "b", "c"]);
    expect(unionFrameworkRequired(["b"], ["B"])).toEqual(["b"]);
  });

  it("dedupes within the framework-required list itself", () => {
    expect(unionFrameworkRequired([], ["x", "X", "x"])).toEqual(["x"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// W2 — extension lifecycle exec layer (bead qwen-coprocessor-stack-3su.13)
// RDR-002 §Layer 1, Phase 0 amendment (2026-08-22): source auto-detection
// is a single positional (no --source flag), --scope accepts only
// user|workspace, install/update of a remote source is env-gated via
// QWEN_ALLOW_REMOTE_INSTALL=1, update classifies per-extension via
// .qwen-extension-install.json and never passes --all through raw.

describe("classifySource", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qwen-source-classify-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── local paths — stat() succeeds is checked first, for every shape ──

  it("classifies an existing absolute path as local, value unchanged", () => {
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir);
    expect(classifySource(extDir, dir)).toEqual({ type: "local", value: extDir });
  });

  it("resolves a relative './x' local path to an absolute value", () => {
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir);
    expect(classifySource("./my-ext", dir)).toEqual({ type: "local", value: extDir });
  });

  it("resolves a bare relative name (no './' prefix) that exists on disk", () => {
    const extDir = join(dir, "bare-ext");
    mkdirSync(extDir);
    expect(classifySource("bare-ext", dir)).toEqual({ type: "local", value: extDir });
  });

  it("rejects a nonexistent explicit-marker local path BEFORE any exec, with a path-specific message", () => {
    const missing = join(dir, "does-not-exist");
    expect(() => classifySource("./does-not-exist", dir)).toThrowError(ExtensionLifecycleError);
    try {
      classifySource("./does-not-exist", dir);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionLifecycleError);
      expect((err as ExtensionLifecycleError).code).toBe("invalid_source");
      expect((err as Error).message).toContain(missing);
      expect((err as Error).message).toMatch(/does not exist/);
    }
  });

  it("rejects a nonexistent absolute local path before exec", () => {
    const missing = join(dir, "also-missing");
    expect(() => classifySource(missing, dir)).toThrowError(/does not exist/);
  });

  it("does NOT misclassify a nonexistent dot-relative path as an owner/repo git source", () => {
    // Regression: './foo/bar' superficially matches an owner/repo shape
    // (one slash, word characters either side). It must be rejected as a
    // missing local path, never silently reinterpreted as git.
    expect(() => classifySource("./foo/bar", dir)).toThrowError(ExtensionLifecycleError);
    try {
      classifySource("./foo/bar", dir);
    } catch (err) {
      expect((err as ExtensionLifecycleError).code).toBe("invalid_source");
      expect((err as Error).message).toMatch(/does not exist/);
    }
  });

  it("rejects empty / whitespace-only source before exec", () => {
    expect(() => classifySource("", dir)).toThrowError(ExtensionLifecycleError);
    expect(() => classifySource("   ", dir)).toThrowError(ExtensionLifecycleError);
  });

  // ── git URL ────────────────────────────────────────────────────

  it.each([
    "https://github.com/example/serena.git",
    "http://example.com/repo.git",
    "git@github.com:example/serena.git",
    "git://example.com/repo.git",
    "ssh://git@example.com/repo.git",
  ])("classifies git URL '%s' as git, value verbatim", (source) => {
    expect(classifySource(source, dir)).toEqual({ type: "git", value: source });
  });

  // ── npm @scope/name ────────────────────────────────────────────

  it("classifies '@scope/name' as npm, value verbatim", () => {
    expect(classifySource("@modelcontextprotocol/server-foo", dir)).toEqual({
      type: "npm",
      value: "@modelcontextprotocol/server-foo",
    });
  });

  // ── owner/repo shorthand → git ─────────────────────────────────

  it("classifies 'owner/repo' (no scheme, no leading path marker) as git", () => {
    expect(classifySource("example-org/example-repo", dir)).toEqual({
      type: "git",
      value: "example-org/example-repo",
    });
  });

  // ── marketplace url:name ───────────────────────────────────────

  it("classifies 'host:name' as marketplace when it matches no other shape", () => {
    expect(classifySource("marketplace.example.com:my-extension", dir)).toEqual({
      type: "marketplace",
      value: "marketplace.example.com:my-extension",
    });
  });

  it("does NOT classify a leading-dash pre-colon segment as marketplace (bead 3su.16 review: flag-injection hardening)", () => {
    // "-x:evil" superficially matches the marketplace url:name shape (one
    // colon, no space, no slash) but a leading '-' makes the whole string
    // flag-shaped from the real CLI's argv-parser point of view. Reject
    // it the same way OWNER_REPO_RE/NPM_SCOPE_RE already require an
    // alnum/@ first character — MARKETPLACE_RE was the one gap.
    expect(() => classifySource("-x:evil", dir)).toThrowError(/Install source not found/);
  });

  // ── otherwise: "Install source not found" ──────────────────────

  it("rejects an unrecognized nonexistent bare source before exec", () => {
    expect(() => classifySource("totally-not-a-thing-zzz9", dir)).toThrowError(
      /Install source not found/,
    );
  });
});

describe("isRemoteSourceType / assertRemoteAllowed via installExtension", () => {
  it("local is never remote", () => {
    expect(isRemoteSourceType("local")).toBe(false);
  });

  it.each(["git", "npm", "marketplace"] as const)("%s is remote", (type) => {
    expect(isRemoteSourceType(type)).toBe(true);
  });
});

describe("validateScope", () => {
  it("returns undefined when scope is undefined (caller applies its own default)", () => {
    expect(validateScope(undefined)).toBeUndefined();
  });

  it("accepts 'user' and 'workspace' verbatim (lowercased)", () => {
    expect(validateScope("user")).toBe("user");
    expect(validateScope("workspace")).toBe("workspace");
    expect(validateScope("User")).toBe("user");
    expect(validateScope("WORKSPACE")).toBe("workspace");
  });

  it.each(["system", "systemdefaults", "System", "SystemDefaults"])(
    "rejects '%s' with a message explaining the silent-downgrade hazard",
    (scope) => {
      expect(() => validateScope(scope)).toThrowError(ExtensionLifecycleError);
      try {
        validateScope(scope);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ExtensionLifecycleError);
        expect((err as ExtensionLifecycleError).code).toBe("invalid_scope");
        expect((err as Error).message).toMatch(/silently/);
      }
    },
  );

  it("rejects any other value with a generic invalid-scope message", () => {
    expect(() => validateScope("global")).toThrowError(ExtensionLifecycleError);
    try {
      validateScope("global");
    } catch (err) {
      expect((err as ExtensionLifecycleError).code).toBe("invalid_scope");
      expect((err as Error).message).toMatch(/user.*workspace|workspace.*user/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// argv builders — asserted exactly

describe("argv builders", () => {
  it("buildInstallArgv: extensions install <value> --consent (non-interactive; see the function doc comment)", () => {
    expect(buildInstallArgv({ type: "local", value: "/abs/path" })).toEqual([
      "extensions",
      "install",
      "/abs/path",
      "--consent",
    ]);
    expect(buildInstallArgv({ type: "git", value: "owner/repo" })).toEqual([
      "extensions",
      "install",
      "owner/repo",
      "--consent",
    ]);
  });

  it("buildUninstallArgv: extensions uninstall <name> — the remove→uninstall translation", () => {
    expect(buildUninstallArgv("serena")).toEqual(["extensions", "uninstall", "serena"]);
  });

  it("buildEnableArgv: extensions enable <name> --scope <scope>", () => {
    expect(buildEnableArgv("serena", "user")).toEqual([
      "extensions",
      "enable",
      "serena",
      "--scope",
      "user",
    ]);
    expect(buildEnableArgv("serena", "workspace")).toEqual([
      "extensions",
      "enable",
      "serena",
      "--scope",
      "workspace",
    ]);
  });

  it("buildDisableArgv: extensions disable <name> --scope <scope>", () => {
    expect(buildDisableArgv("serena", "user")).toEqual([
      "extensions",
      "disable",
      "serena",
      "--scope",
      "user",
    ]);
  });

  it("buildUpdateArgv: extensions update <name> — never --all", () => {
    expect(buildUpdateArgv("serena")).toEqual(["extensions", "update", "serena"]);
  });

  it("buildLinkArgv: extensions link <path>", () => {
    expect(buildLinkArgv("/abs/ext/path")).toEqual(["extensions", "link", "/abs/ext/path"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// installExtension — classification + remote gate + argv + exec, wired together

describe("installExtension", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qwen-install-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("local source: ungated, execs 'extensions install <abs path>'", async () => {
    const extDir = join(dir, "local-ext");
    mkdirSync(extDir);
    let capturedArgv: string[] | null = null;
    const result = await installExtension("/usr/bin/qwen", "./local-ext", {
      cwd: dir,
      env: {},
      execFn: async (bin, argv) => {
        expect(bin).toBe("/usr/bin/qwen");
        capturedArgv = argv;
        return "installed\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "install", extDir, "--consent"]);
    expect(result).toEqual({
      argv: ["extensions", "install", extDir, "--consent"],
      stdout: "installed\n",
      source: { type: "local", value: extDir },
    });
  });

  it("remote source (git): refused with typed remote_install_gated error when env unset, NO exec call", async () => {
    let execCalled = false;
    await expect(
      installExtension("/usr/bin/qwen", "example-org/example-repo", {
        cwd: dir,
        env: {},
        execFn: async () => {
          execCalled = true;
          return "should not run";
        },
      }),
    ).rejects.toMatchObject({
      name: "ExtensionLifecycleError",
      code: "remote_install_gated",
    });
    expect(execCalled).toBe(false);
  });

  it("remote source (git): the refusal error names QWEN_ALLOW_REMOTE_INSTALL", async () => {
    await expect(
      installExtension("/usr/bin/qwen", "example-org/example-repo", { cwd: dir, env: {} }),
    ).rejects.toThrow(new RegExp(QWEN_ALLOW_REMOTE_INSTALL_ENV));
  });

  it("remote source (npm): permitted and execs when QWEN_ALLOW_REMOTE_INSTALL=1", async () => {
    let capturedArgv: string[] | null = null;
    const result = await installExtension("/usr/bin/qwen", "@scope/pkg", {
      cwd: dir,
      env: { [QWEN_ALLOW_REMOTE_INSTALL_ENV]: "1" },
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "installed\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "install", "@scope/pkg", "--consent"]);
    expect(result.source).toEqual({ type: "npm", value: "@scope/pkg" });
  });

  it("remote source (marketplace): also gated, same as git/npm", async () => {
    await expect(
      installExtension("/usr/bin/qwen", "market.example.com:ext-name", { cwd: dir, env: {} }),
    ).rejects.toMatchObject({ code: "remote_install_gated" });
  });

  it("invalid source: classification error propagates, no exec attempted", async () => {
    let execCalled = false;
    await expect(
      installExtension("/usr/bin/qwen", "./nonexistent-xyz", {
        cwd: dir,
        env: {},
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    expect(execCalled).toBe(false);
  });

  it("mutation exec failure surfaces as a typed error carrying stderr (NOT fail-soft)", async () => {
    const extDir = join(dir, "fails-ext");
    mkdirSync(extDir);
    await expect(
      installExtension("/usr/bin/qwen", extDir, {
        cwd: dir,
        env: {},
        execFn: async () => {
          const err = new Error("install failed") as Error & { stderr?: string };
          err.stderr = "permission denied: cannot write extension dir";
          throw err;
        },
      }),
    ).rejects.toMatchObject({
      name: "ExtensionLifecycleError",
      code: "exec_failed",
      stderr: "permission denied: cannot write extension dir",
    });
  });
});

// ─────────────────────────────────────────────────────────────────
// uninstallExtension — the remove→uninstall translation, no gate
//
// installedNames (bead 3su.16 code-review remediation, IMPORTANT #1):
// required positional, mirroring updateExtensions' own required
// `installed` argument — a name that isn't in the installed set is
// refused BEFORE exec, same defense update already had. A flag-shaped
// name (leading '-') is refused independently, before the cache check,
// so a caller can't dodge yargs flag-misparsing by first getting a
// dash-prefixed name added to the installed set.

const KNOWN_INSTALLED = new Set(["serena"]);

describe("uninstallExtension", () => {
  it("execs 'extensions uninstall <name>' regardless of caller-facing 'remove' verb", async () => {
    let capturedArgv: string[] | null = null;
    const result = await uninstallExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "removed\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "uninstall", "serena"]);
    expect(result.stdout).toBe("removed\n");
  });

  it("matches the installed set case-insensitively and canonicalizes argv to the lowercased name (bead 3su.16 review SUGGESTION)", async () => {
    // installedNames always holds lowercased names (InstalledExtensionsCache
    // / parseInstalledExtensionsRich convention); a caller passing the
    // extension's declared-case name must still resolve.
    let capturedArgv: string[] | null = null;
    const result = await uninstallExtension("/usr/bin/qwen", "Serena", KNOWN_INSTALLED, {
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "removed\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "uninstall", "serena"]);
    expect(result.stdout).toBe("removed\n");
  });

  it("mutation failure throws typed error with stderr", async () => {
    await expect(
      uninstallExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
        execFn: async () => {
          const err = new Error("boom") as Error & { stderr?: string };
          err.stderr = "not installed";
          throw err;
        },
      }),
    ).rejects.toMatchObject({ code: "exec_failed", stderr: "not installed" });
  });

  it("unknown name: refused with code unknown_extension BEFORE exec, no exec call made", async () => {
    let execCalled = false;
    await expect(
      uninstallExtension("/usr/bin/qwen", "nonexistent", KNOWN_INSTALLED, {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "unknown_extension" });
    expect(execCalled).toBe(false);
  });

  it("flag-shaped name (leading '-'): refused with code invalid_name BEFORE exec, even if it's in the installed set", async () => {
    // Independent defense layer: the dash check must not be subsumed by
    // the cache-membership check, so it fires even for a hypothetical
    // installed name that starts with '-'.
    const installedWithDashName = new Set(["-x"]);
    let execCalled = false;
    await expect(
      uninstallExtension("/usr/bin/qwen", "-x", installedWithDashName, {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_name" });
    expect(execCalled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// enableExtension / disableExtension — explicit wrapper default + scope validation

describe("enableExtension / disableExtension", () => {
  it("DEFAULT_ENABLE_SCOPE and DEFAULT_DISABLE_SCOPE are both explicit 'user' (visible, symmetric)", () => {
    // RDR-002 Phase 0 amendment: upstream's enable→all-scopes /
    // disable→User asymmetry must NOT be silently inherited. This wrapper
    // makes a single explicit default visible in the API instead.
    expect(DEFAULT_ENABLE_SCOPE).toBe("user");
    expect(DEFAULT_DISABLE_SCOPE).toBe("user");
  });

  it("enable with no scope opt uses the explicit default, not upstream's all-scopes default", async () => {
    let capturedArgv: string[] | null = null;
    const result = await enableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "enabled\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "enable", "serena", "--scope", "user"]);
    expect(result.scope).toBe("user");
  });

  it("enable with explicit scope='workspace' passes it through", async () => {
    let capturedArgv: string[] | null = null;
    await enableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
      scope: "workspace",
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "enabled\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "enable", "serena", "--scope", "workspace"]);
  });

  it("enable with scope='system' rejects BEFORE exec, no exec call made", async () => {
    let execCalled = false;
    await expect(
      enableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
        scope: "system",
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(execCalled).toBe(false);
  });

  it("enable with unknown name: refused with code unknown_extension BEFORE exec", async () => {
    let execCalled = false;
    await expect(
      enableExtension("/usr/bin/qwen", "nonexistent", KNOWN_INSTALLED, {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "unknown_extension" });
    expect(execCalled).toBe(false);
  });

  it("enable with flag-shaped name: refused with code invalid_name BEFORE exec", async () => {
    let execCalled = false;
    await expect(
      enableExtension("/usr/bin/qwen", "--force", new Set(["--force"]), {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_name" });
    expect(execCalled).toBe(false);
  });

  it("disable with no scope opt uses the explicit default", async () => {
    let capturedArgv: string[] | null = null;
    const result = await disableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "disabled\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "disable", "serena", "--scope", "user"]);
    expect(result.scope).toBe("user");
  });

  it("disable with scope='systemdefaults' rejects BEFORE exec", async () => {
    await expect(
      disableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, { scope: "systemdefaults" }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("disable with unknown name: refused with code unknown_extension BEFORE exec", async () => {
    let execCalled = false;
    await expect(
      disableExtension("/usr/bin/qwen", "nonexistent", KNOWN_INSTALLED, {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "unknown_extension" });
    expect(execCalled).toBe(false);
  });

  it("disable with flag-shaped name: refused with code invalid_name BEFORE exec, independent of cache membership", async () => {
    let execCalled = false;
    await expect(
      disableExtension("/usr/bin/qwen", "-y", new Set(["-y"]), {
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_name" });
    expect(execCalled).toBe(false);
  });

  it("mutation failure on enable throws typed error with stderr", async () => {
    await expect(
      enableExtension("/usr/bin/qwen", "serena", KNOWN_INSTALLED, {
        execFn: async () => {
          const err = new Error("boom") as Error & { stderr?: string };
          err.stderr = "extension not found";
          throw err;
        },
      }),
    ).rejects.toMatchObject({ code: "exec_failed", stderr: "extension not found" });
  });
});

// ─────────────────────────────────────────────────────────────────
// linkExtension — always local, always ungated

describe("linkExtension", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qwen-link-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("execs 'extensions link <abs path>' for an existing local path, no gate", async () => {
    const extDir = join(dir, "dev-ext");
    mkdirSync(extDir);
    let capturedArgv: string[] | null = null;
    const result = await linkExtension("/usr/bin/qwen", "./dev-ext", {
      cwd: dir,
      execFn: async (_bin, argv) => {
        capturedArgv = argv;
        return "linked\n";
      },
    });
    expect(capturedArgv).toEqual(["extensions", "link", extDir]);
    expect(result.stdout).toBe("linked\n");
  });

  it("rejects a nonexistent local path before exec", async () => {
    await expect(
      linkExtension("/usr/bin/qwen", "./nonexistent-link-target", { cwd: dir }),
    ).rejects.toMatchObject({ code: "invalid_source" });
  });

  it("rejects a remote-shaped source — link only accepts local paths, never gated-through as remote", async () => {
    let execCalled = false;
    await expect(
      linkExtension("/usr/bin/qwen", "owner/repo", {
        cwd: dir,
        execFn: async () => {
          execCalled = true;
          return "x";
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_source" });
    expect(execCalled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// updateExtensions — per-extension classification via
// .qwen-extension-install.json, fail-closed on missing/unknown metadata,
// --all never passed through raw.

describe("updateExtensions", () => {
  const installed = [
    { name: "local-ext", path: "/exts/local-ext" },
    { name: "git-ext", path: "/exts/git-ext" },
    { name: "no-metadata-ext", path: "/exts/no-metadata-ext" },
    { name: "unknown-type-ext", path: "/exts/unknown-type-ext" },
  ];

  function metadataFor(path: string): { type?: string; source?: string } | null {
    const table: Record<string, { type?: string; source?: string } | null> = {
      "/exts/local-ext": { type: "local", source: "/exts/local-ext" },
      "/exts/git-ext": { type: "git", source: "owner/repo" },
      "/exts/no-metadata-ext": null,
      "/exts/unknown-type-ext": { type: "mystery-format" },
    };
    return table[path] ?? null;
  }

  it("EXTENSION_INSTALL_METADATA_FILENAME is the file the addendum names", () => {
    expect(EXTENSION_INSTALL_METADATA_FILENAME).toBe(".qwen-extension-install.json");
  });

  it("'all' enumerates and classifies every installed extension individually — never a raw --all argv", async () => {
    const execCalls: string[][] = [];
    const result = await updateExtensions("/usr/bin/qwen", installed, "all", {
      env: { [QWEN_ALLOW_REMOTE_INSTALL_ENV]: "1" },
      readMetadataFn: async (path) => metadataFor(path),
      execFn: async (_bin, argv) => {
        execCalls.push(argv);
        return "updated\n";
      },
    });

    // No call ever contains "--all".
    for (const argv of execCalls) {
      expect(argv).not.toContain("--all");
    }
    // Local and git targets each got their own individual argv.
    expect(execCalls).toContainEqual(["extensions", "update", "local-ext"]);
    expect(execCalls).toContainEqual(["extensions", "update", "git-ext"]);
    expect(execCalls).toHaveLength(2);

    const byName = new Map(result.items.map((i) => [i.name, i]));
    expect(byName.get("local-ext")).toMatchObject({ status: "updated" });
    expect(byName.get("git-ext")).toMatchObject({ status: "updated" });
    expect(byName.get("no-metadata-ext")).toMatchObject({ status: "refused" });
    expect(byName.get("unknown-type-ext")).toMatchObject({ status: "refused" });
    expect(result.items).toHaveLength(4);
  });

  it("fails CLOSED on missing metadata file (readMetadataFn returns null) — refused, not attempted", async () => {
    let execCalled = false;
    const result = await updateExtensions("/usr/bin/qwen", installed, ["no-metadata-ext"], {
      env: { [QWEN_ALLOW_REMOTE_INSTALL_ENV]: "1" },
      readMetadataFn: async () => null,
      execFn: async () => {
        execCalled = true;
        return "x";
      },
    });
    expect(execCalled).toBe(false);
    expect(result.items).toEqual([
      {
        name: "no-metadata-ext",
        status: "refused",
        reason: expect.stringMatching(/missing or unreadable/i),
      },
    ]);
  });

  it("fails CLOSED on an unrecognized installMetadata.type — refused, not attempted", async () => {
    let execCalled = false;
    const result = await updateExtensions("/usr/bin/qwen", installed, ["unknown-type-ext"], {
      env: { [QWEN_ALLOW_REMOTE_INSTALL_ENV]: "1" },
      readMetadataFn: async () => ({ type: "mystery-format" }),
      execFn: async () => {
        execCalled = true;
        return "x";
      },
    });
    expect(execCalled).toBe(false);
    expect(result.items[0]).toMatchObject({ status: "refused", reason: expect.stringMatching(/unknown/i) });
  });

  it("a git-classified target is refused (not attempted) when QWEN_ALLOW_REMOTE_INSTALL is unset", async () => {
    let execCalled = false;
    const result = await updateExtensions("/usr/bin/qwen", installed, ["git-ext"], {
      env: {},
      readMetadataFn: async (path) => metadataFor(path),
      execFn: async () => {
        execCalled = true;
        return "x";
      },
    });
    expect(execCalled).toBe(false);
    expect(result.items[0]).toMatchObject({
      status: "refused",
      reason: expect.stringMatching(new RegExp(QWEN_ALLOW_REMOTE_INSTALL_ENV)),
    });
  });

  it("a local-classified target updates ungated even when QWEN_ALLOW_REMOTE_INSTALL is unset", async () => {
    const result = await updateExtensions("/usr/bin/qwen", installed, ["local-ext"], {
      env: {},
      readMetadataFn: async (path) => metadataFor(path),
      execFn: async () => "updated\n",
    });
    expect(result.items[0]).toMatchObject({ status: "updated" });
  });

  it("a name not present in the installed list is refused as not-found, not attempted", async () => {
    let execCalled = false;
    const result = await updateExtensions("/usr/bin/qwen", installed, ["ghost-ext"], {
      env: { [QWEN_ALLOW_REMOTE_INSTALL_ENV]: "1" },
      readMetadataFn: async () => ({ type: "local" }),
      execFn: async () => {
        execCalled = true;
        return "x";
      },
    });
    expect(execCalled).toBe(false);
    expect(result.items[0]).toMatchObject({ name: "ghost-ext", status: "refused" });
  });

  it("an exec failure on one item is captured per-item as 'failed' with the stderr-derived reason, not thrown", async () => {
    const result = await updateExtensions("/usr/bin/qwen", installed, ["local-ext"], {
      env: {},
      readMetadataFn: async (path) => metadataFor(path),
      execFn: async () => {
        const err = new Error("update failed") as Error & { stderr?: string };
        err.stderr = "network unreachable";
        throw err;
      },
    });
    expect(result.items[0]).toMatchObject({
      name: "local-ext",
      status: "failed",
      reason: expect.stringMatching(/network unreachable|update failed/),
    });
  });

  it("a batch mixes updated / refused / failed and reports every item (no early abort)", async () => {
    const result = await updateExtensions(
      "/usr/bin/qwen",
      installed,
      ["local-ext", "git-ext", "no-metadata-ext"],
      {
        env: {}, // git-ext will be refused (gate), local-ext will succeed
        readMetadataFn: async (path) => metadataFor(path),
        execFn: async () => "updated\n",
      },
    );
    expect(result.items).toHaveLength(3);
    const byName = new Map(result.items.map((i) => [i.name, i]));
    expect(byName.get("local-ext")?.status).toBe("updated");
    expect(byName.get("git-ext")?.status).toBe("refused");
    expect(byName.get("no-metadata-ext")?.status).toBe("refused");
  });
});

// ─────────────────────────────────────────────────────────────────
// execFile regression pin — must never become exec() (shell injection)
//
// Uses a REAL subprocess (a tiny fixture script) rather than an injected
// fn: the property under test is about defaultExecExtensionsMutate's own
// exec mechanism, which an injected fn can't observe. A shell-metachar
// argument must arrive at the fixture script as one literal argv element;
// if defaultExecExtensionsMutate were ever changed to child_process.exec,
// the semicolon would be interpreted by a shell and create the marker
// file this test asserts must NOT exist.

describe("defaultExecExtensionsMutate — execFile regression pin", () => {
  let dir: string;
  let fakeQwen: string;
  let markerFile: string;
  let outFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qwen-execfile-pin-"));
    fakeQwen = join(dir, "fake-qwen.sh");
    markerFile = join(dir, "pwned-marker");
    outFile = join(dir, "argv-out");
    writeFileSync(
      fakeQwen,
      [
        "#!/usr/bin/env bash",
        `: > "${outFile}"`,
        'for a in "$@"; do printf \'%s\\n\' "$a" >> "' + outFile + '"; done',
      ].join("\n") + "\n",
      "utf8",
    );
    chmodSync(fakeQwen, 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a shell-metacharacter argument through literally, without shell interpretation", async () => {
    const maliciousName = `; touch ${markerFile} #`;
    const stdout = await defaultExecExtensionsMutate(fakeQwen, [
      "extensions",
      "uninstall",
      maliciousName,
    ]);
    void stdout;

    expect(existsSync(markerFile)).toBe(false);

    const { readFileSync } = await import("node:fs");
    const capturedLines = readFileSync(outFile, "utf8").split("\n").filter((l) => l !== "");
    expect(capturedLines).toEqual(["extensions", "uninstall", maliciousName]);
  });

  it("resolves on clean exit with stdout", async () => {
    const stdout = await defaultExecExtensionsMutate(fakeQwen, ["extensions", "list"]);
    expect(stdout).toBe("");
  });

  it("rejects with a typed ExtensionLifecycleError carrying stderr on nonzero exit", async () => {
    const failingScript = join(dir, "failing-qwen.sh");
    writeFileSync(
      failingScript,
      ["#!/usr/bin/env bash", "echo 'boom on stderr' 1>&2", "exit 1"].join("\n") + "\n",
      "utf8",
    );
    chmodSync(failingScript, 0o755);

    await expect(
      defaultExecExtensionsMutate(failingScript, ["extensions", "uninstall", "x"]),
    ).rejects.toMatchObject({
      name: "ExtensionLifecycleError",
      code: "exec_failed",
      stderr: expect.stringContaining("boom on stderr"),
    });
  });
});
