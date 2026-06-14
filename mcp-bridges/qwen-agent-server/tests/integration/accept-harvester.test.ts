// SPDX-License-Identifier: MIT
//
// RDR-009 Phase 2 integration test (bead qwen-coprocessor-stack-nh9.3): the
// /accept harvester — the PUSH path. Unlike the git-diff harvester (PULL,
// reads the worktree end-state), this one surfaces non-patch artifacts WITHOUT
// touching git or the raw supervisor event log (RF-1):
//   - `run.emitted` passes through verbatim (the deterministic /accept spine is
//     host code that emits its entity/tier artifacts directly);
//   - `run.finalMessage` (the leaf agent's structured return) is parsed to one
//     {kind:"value"}.
//
// It exercises the full RunContext (both channels) and a downstream reader
// consuming the result — the RDR-009 MVV: a non-patch artifact (spine-emitted
// entity + leaf-returned value) flows end-to-end through the harvester and is
// read back by kind. (SWE-bench still yields a {kind:"patch"} via P1's git-diff
// harvester — proven in dispatch-base-commit.test.ts.)

import { describe, expect, it } from "vitest";

import { acceptHarvester } from "../../src/dispatch.js";
import { patchArtifact } from "../../src/types.js";
import type { Artifact, RunContext } from "../../src/types.js";

describe("acceptHarvester (RDR-009 Phase 2, the PUSH path)", () => {
  it("combines emitted entity/tier with the finalMessage value (the /accept shape)", async () => {
    // The /accept spine emitted these DIRECTLY as it created the bead / wrote T2
    // (RF-1: not derived from a raw event log).
    const emitted: Artifact[] = [
      { kind: "entity", type: "bead", id: "qwen-coprocessor-stack-zzz", op: "created" },
      { kind: "tier", tier: "T2", key: "RDR-009" },
    ];
    // The dispatched planner LEAF returned its plan as structured JSON.
    const planJson = JSON.stringify({ phases: 3, beads: ["nh9.1", "nh9.2", "nh9.3"] });
    const run: RunContext = {
      emitted,
      finalMessage: planJson,
      environment: {}, // no worktree — this is not a git-diff run
    };

    const artifacts = await acceptHarvester(run);

    // All three present: the two spine emissions + the leaf's value.
    expect(artifacts).toHaveLength(3);

    // A downstream reader consumes by kind (the MVV's "consumed by a reader").
    const entities = artifacts.filter((a) => a.kind === "entity");
    const tiers = artifacts.filter((a) => a.kind === "tier");
    const values = artifacts.filter((a) => a.kind === "value");
    expect(entities).toEqual([
      { kind: "entity", type: "bead", id: "qwen-coprocessor-stack-zzz", op: "created" },
    ]);
    expect(tiers).toEqual([{ kind: "tier", tier: "T2", key: "RDR-009" }]);
    expect(values).toHaveLength(1);
    // finalMessage is parsed from JSON into the value (not left as a string).
    expect((values[0] as Extract<Artifact, { kind: "value" }>).value).toEqual({
      phases: 3,
      beads: ["nh9.1", "nh9.2", "nh9.3"],
    });

    // An /accept run yields NO patch artifact — a patch-only consumer gets undefined
    // (the back-compat accessor's documented "none when absent").
    expect(patchArtifact({ artifacts, turns: 0, outcome: "completed", cost: 0 })).toBeUndefined();
  });

  it("emitted passes through verbatim and order is preserved (spine emissions first)", async () => {
    const emitted: Artifact[] = [
      { kind: "entity", type: "rdr", id: "RDR-009", op: "updated" },
      { kind: "entity", type: "link", id: "1.2->1.3", op: "created" },
      { kind: "tier", tier: "T3", key: "knowledge/x" },
    ];
    const artifacts = await acceptHarvester({ emitted, finalMessage: "{}", environment: {} });
    // The three emitted artifacts come first, in order; the value is appended last.
    expect(artifacts.slice(0, 3)).toEqual(emitted);
    expect(artifacts[3]).toEqual({ kind: "value", value: {} });
  });

  it("a non-JSON finalMessage is surfaced as a raw-string value (not dropped, not thrown)", async () => {
    const artifacts = await acceptHarvester({
      emitted: [],
      finalMessage: "done: created 3 beads",
      environment: {},
    });
    expect(artifacts).toEqual([{ kind: "value", value: "done: created 3 beads" }]);
  });

  it("reads neither source, or a whitespace-only finalMessage → [] (no throw)", async () => {
    expect(await acceptHarvester({ emitted: [], environment: {} })).toEqual([]);
    // An empty / whitespace-only finalMessage is "no structured return" → no value.
    expect(await acceptHarvester({ emitted: [], finalMessage: "   ", environment: {} })).toEqual([]);
  });

  it("literal JSON null finalMessage → no value (degenerate answer), but false/0/\"\" ARE values", async () => {
    // `null` is a degenerate "no answer" — not surfaced.
    expect(await acceptHarvester({ emitted: [], finalMessage: "null", environment: {} })).toEqual([]);
    // false / 0 / empty-string-JSON are genuine structured values — surfaced.
    expect(await acceptHarvester({ emitted: [], finalMessage: "false", environment: {} })).toEqual([
      { kind: "value", value: false },
    ]);
    expect(await acceptHarvester({ emitted: [], finalMessage: "0", environment: {} })).toEqual([
      { kind: "value", value: 0 },
    ]);
    expect(await acceptHarvester({ emitted: [], finalMessage: '""', environment: {} })).toEqual([
      { kind: "value", value: "" },
    ]);
  });
});
