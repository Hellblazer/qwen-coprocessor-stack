// SPDX-License-Identifier: MIT
//
// Unit tests for extensions/qwen-toolkit/battery/driver-lib.ts's pure
// parts (bead qwen-coprocessor-stack-3su.8). Deliberately dist/-free, so
// these run without `npm run build` having touched
// mcp-bridges/qwen-agent-server/dist/ first. Collaborators (fs reads,
// mtimes) are passed in per the repo's injected-function style
// (see mcp-bridges/qwen-agent-server/tests/extensions.test.ts) rather
// than mocked with vi.mock.
//
// Run (vitest is a devDependency of mcp-bridges/qwen-agent-server):
//   cd mcp-bridges/qwen-agent-server
//   npx vitest run ../../extensions/qwen-toolkit/battery/driver-lib.test.ts

import { describe, expect, it } from "vitest";

import {
  buildSpawnOpts,
  checkDistFreshness,
  extensionsOnlyForArm,
  parseArm,
  parseTaskSpec,
  type FreshnessDeps,
} from "./driver-lib.js";

// ── parseArm ─────────────────────────────────────────────────────

describe("parseArm", () => {
  it("accepts --arm toolkit", () => {
    expect(parseArm(["--arm", "toolkit"])).toBe("toolkit");
  });

  it("accepts --arm control", () => {
    expect(parseArm(["--arm", "control"])).toBe("control");
  });

  it("ignores other argv entries around --arm", () => {
    expect(parseArm(["--foo", "bar", "--arm", "control", "--baz"])).toBe("control");
  });

  it("throws when --arm is missing entirely", () => {
    expect(() => parseArm([])).toThrowError(/usage: driver\.ts --arm/);
  });

  it("throws when --arm has no following value", () => {
    expect(() => parseArm(["--arm"])).toThrowError(/usage: driver\.ts --arm/);
  });

  it("throws on an unrecognized arm value", () => {
    expect(() => parseArm(["--arm", "bogus"])).toThrowError(/--arm must be toolkit\|control, got 'bogus'/);
  });
});

// ── parseTaskSpec ────────────────────────────────────────────────

const VALID_SPEC = JSON.stringify({
  name: "001-interval-debug",
  family: "debug",
  prompt: "fix the bug",
  setup: { copy_dir: "files" },
  verify: { command: ["python3", "-m", "unittest", "-v", "test_intervals"], expected_exit_code: 0 },
  max_tool_calls: 30,
  timeout_ms: 2_400_000,
  notes: "calibration, not a baseline",
});

describe("parseTaskSpec", () => {
  it("parses a full valid spec, carrying every field through", () => {
    const spec = parseTaskSpec(VALID_SPEC);
    expect(spec.name).toBe("001-interval-debug");
    expect(spec.family).toBe("debug");
    expect(spec.prompt).toBe("fix the bug");
    expect(spec.max_tool_calls).toBe(30);
    expect(spec.timeout_ms).toBe(2_400_000);
    expect(spec.notes).toBe("calibration, not a baseline");
    expect(spec.setup).toEqual({ copy_dir: "files" });
    expect(spec.cwd).toBeUndefined();
  });

  it("carries an optional cwd through when present", () => {
    const withCwd = JSON.stringify({ ...JSON.parse(VALID_SPEC), cwd: "/tmp/instance-42" });
    expect(parseTaskSpec(withCwd).cwd).toBe("/tmp/instance-42");
  });

  it("accepts a minimal spec with only the required fields", () => {
    const minimal = JSON.stringify({ name: "x", prompt: "y", max_tool_calls: 1, timeout_ms: 1000 });
    const spec = parseTaskSpec(minimal);
    expect(spec.name).toBe("x");
    expect(spec.prompt).toBe("y");
    expect(spec.family).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTaskSpec("{not json")).toThrowError(/stdin is not valid JSON/);
  });

  it("throws when the JSON is not an object", () => {
    expect(() => parseTaskSpec("[1,2,3]")).toThrowError(/must be a JSON object/);
    expect(() => parseTaskSpec('"just a string"')).toThrowError(/must be a JSON object/);
  });

  it("throws when name is missing", () => {
    const spec = JSON.parse(VALID_SPEC);
    delete spec.name;
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/required non-empty string field: name/);
  });

  it("throws when prompt is empty", () => {
    const spec = { ...JSON.parse(VALID_SPEC), prompt: "" };
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/required non-empty string field: prompt/);
  });

  it("throws when max_tool_calls is missing", () => {
    const spec = JSON.parse(VALID_SPEC);
    delete spec.max_tool_calls;
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/required positive-number field: max_tool_calls/);
  });

  it("throws when max_tool_calls is zero or negative", () => {
    const spec = { ...JSON.parse(VALID_SPEC), max_tool_calls: 0 };
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/required positive-number field: max_tool_calls/);
  });

  it("throws when timeout_ms is missing", () => {
    const spec = JSON.parse(VALID_SPEC);
    delete spec.timeout_ms;
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/required positive-number field: timeout_ms/);
  });

  it("throws when cwd is present but not a string", () => {
    const spec = { ...JSON.parse(VALID_SPEC), cwd: 42 };
    expect(() => parseTaskSpec(JSON.stringify(spec))).toThrowError(/field 'cwd' must be a string/);
  });

  it("carries an optional max_output_tokens through when present", () => {
    const withCap = JSON.stringify({ ...JSON.parse(VALID_SPEC), max_output_tokens: 16384 });
    expect(parseTaskSpec(withCap).max_output_tokens).toBe(16384);
  });

  it("throws when max_output_tokens is present but not a positive number", () => {
    const zero = { ...JSON.parse(VALID_SPEC), max_output_tokens: 0 };
    expect(() => parseTaskSpec(JSON.stringify(zero))).toThrowError(/field 'max_output_tokens' must be a positive number/);
    const nonNumeric = { ...JSON.parse(VALID_SPEC), max_output_tokens: "16384" };
    expect(() => parseTaskSpec(JSON.stringify(nonNumeric))).toThrowError(/field 'max_output_tokens' must be a positive number/);
  });
});

// ── argv/opts construction ───────────────────────────────────────

describe("extensionsOnlyForArm", () => {
  it("toolkit arm resolves to the real extension", () => {
    expect(extensionsOnlyForArm("toolkit")).toEqual(["qwen-toolkit"]);
  });

  it("control arm resolves to the empty set (renders as 'none')", () => {
    expect(extensionsOnlyForArm("control")).toEqual([]);
  });
});

describe("buildSpawnOpts", () => {
  const baseSpec = parseTaskSpec(VALID_SPEC);

  it("always sets write_authority: true", () => {
    expect(buildSpawnOpts(baseSpec, "toolkit").write_authority).toBe(true);
    expect(buildSpawnOpts(baseSpec, "control").write_authority).toBe(true);
  });

  it("threads max_tool_calls through from the spec", () => {
    expect(buildSpawnOpts(baseSpec, "toolkit").max_tool_calls).toBe(30);
  });

  it("toolkit arm sets extensions.only = ['qwen-toolkit']", () => {
    expect(buildSpawnOpts(baseSpec, "toolkit").extensions).toEqual({ only: ["qwen-toolkit"] });
  });

  it("control arm sets extensions.only = [] (the honest control, not CLI defaults)", () => {
    expect(buildSpawnOpts(baseSpec, "control").extensions).toEqual({ only: [] });
  });

  it("omits the cwd key entirely when the spec has no cwd (exactOptionalPropertyTypes discipline)", () => {
    const opts = buildSpawnOpts(baseSpec, "toolkit");
    expect("cwd" in opts).toBe(false);
    expect(opts.cwd).toBeUndefined();
  });

  it("sets cwd when the spec carries one", () => {
    const specWithCwd = parseTaskSpec(JSON.stringify({ ...JSON.parse(VALID_SPEC), cwd: "/tmp/instance-7" }));
    expect(buildSpawnOpts(specWithCwd, "toolkit").cwd).toBe("/tmp/instance-7");
  });

  it("omits max_output_tokens entirely when the spec has none", () => {
    const opts = buildSpawnOpts(baseSpec, "toolkit");
    expect("max_output_tokens" in opts).toBe(false);
  });

  it("sets max_output_tokens when the spec carries one (RDR-006 truncation-avoidance finding)", () => {
    const specWithCap = parseTaskSpec(JSON.stringify({ ...JSON.parse(VALID_SPEC), max_output_tokens: 16384 }));
    expect(buildSpawnOpts(specWithCap, "toolkit").max_output_tokens).toBe(16384);
  });
});

// ── checkDistFreshness ───────────────────────────────────────────

function fakeDeps(files: Record<string, number>, distMtime: number | undefined): FreshnessDeps {
  const distPath = "/fake/dist/server.js";
  return {
    exists: (path) => (path === distPath ? distMtime !== undefined : true),
    mtimeMs: (path) => {
      if (path === distPath) {
        if (distMtime === undefined) throw new Error("dist does not exist");
        return distMtime;
      }
      const mtime = files[path];
      if (mtime === undefined) throw new Error(`unexpected mtimeMs() call for ${path}`);
      return mtime;
    },
    listTsFiles: () => Object.keys(files),
  };
}

describe("checkDistFreshness", () => {
  const distPath = "/fake/dist/server.js";
  const srcDir = "/fake/src";

  it("passes silently when dist is newer than every src file", () => {
    const deps = fakeDeps({ "/fake/src/a.ts": 100, "/fake/src/b.ts": 200 }, 300);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).not.toThrow();
  });

  it("throws naming the offending file when a src file is newer than dist", () => {
    const deps = fakeDeps({ "/fake/src/a.ts": 100, "/fake/src/b.ts": 999 }, 300);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).toThrowError(/\/fake\/src\/b\.ts/);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).toThrowError(/npm run build/);
  });

  it("throws when dist/server.js is missing", () => {
    const deps = fakeDeps({ "/fake/src/a.ts": 100 }, undefined);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).toThrowError(/dist\/ missing/);
  });

  it("treats an exact mtime tie as fresh, not stale", () => {
    const deps = fakeDeps({ "/fake/src/a.ts": 300 }, 300);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).not.toThrow();
  });

  it("passes when there are no src files at all", () => {
    const deps = fakeDeps({}, 300);
    expect(() => checkDistFreshness(distPath, srcDir, deps)).not.toThrow();
  });
});
