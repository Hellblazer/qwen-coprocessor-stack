// SPDX-License-Identifier: MIT
//
// Unit tests for resolveQwenRealBin / resolveWrapperPath in src/extensions.ts.
// RDR-002 §Decision → 'The wrapper-script bridge'.

import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";

import { resolveQwenRealBin, resolveWrapperPath } from "../src/extensions.js";

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
