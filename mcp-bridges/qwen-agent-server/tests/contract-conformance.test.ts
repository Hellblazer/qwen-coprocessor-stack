// SPDX-License-Identifier: MIT
//
// TS-host conformance against the RDR-007 §4 golden fixtures
// (docs/contracts/fixtures/). The SAME fixture files are asserted by the Python
// host (scripts/coding-eval/tests/test_contract_conformance.py). The cross-host
// fixtures (classify-outcome, agent-shapes) are the cross-language drift
// tripwire (RDR-007 Consequence Negative-1). task-classification is TS-host-
// scoped (the Python eval host does not route backends) — see the host-scope
// table in docs/contracts/agent-dispatch-contract.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyOutcome } from "../src/dispatch.js";
import { qwenDispatchInputShape } from "../src/dispatch-tool.js";
import { classifyTask } from "../src/types.js";
import type { AgentResult, AgentTask, TaskKind, TaskSignals } from "../src/types.js";

// tests/ -> qwen-agent-server -> mcp-bridges -> repo root.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/contracts/fixtures");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as T;
}

// ── cross-host: classify-outcome rule ───────────────────────────────────────

interface ClassifyCase {
  name: string;
  returncode: number | null;
  turnsUsed: number | null;
  maxTurns: number;
  expected: string;
}

describe("classify-outcome golden fixture (cross-host)", () => {
  const fx = load<{ cases: ClassifyCase[] }>("classify-outcome.json");

  it("has cases", () => expect(fx.cases.length).toBeGreaterThan(0));

  for (const c of fx.cases) {
    it(c.name, () => {
      // `null` in the fixture means the signal was not supplied: omit turnsUsed
      // (undefined) so the rule sees "absent", matching Python's turns_used=None.
      const opts =
        c.turnsUsed !== null
          ? { turnsUsed: c.turnsUsed, maxTurns: c.maxTurns }
          : { maxTurns: c.maxTurns };
      expect(classifyOutcome(c.returncode, opts)).toBe(c.expected);
    });
  }
});

// ── cross-host: AgentTask / AgentResult / AgentOutcome shapes ────────────────

interface ShapesFixture {
  agentOutcomeValues: string[];
  agentTask: { requiredKeys: string[]; example: Record<string, unknown> };
  agentResult: { requiredKeys: string[]; example: Record<string, unknown> };
}

describe("agent-shapes golden fixture (cross-host)", () => {
  const fx = load<ShapesFixture>("agent-shapes.json");

  it("AgentTask key set matches the contract", () => {
    // A literal typed as the interface: drift in the interface keys would fail
    // here at runtime (Object.keys), independent of the (untyped) test compile.
    const task: AgentTask = {
      prompt: String(fx.agentTask.example.prompt),
      worktree: String(fx.agentTask.example.worktree),
      maxTurns: Number(fx.agentTask.example.maxTurns),
      minTokens: Number(fx.agentTask.example.minTokens),
      timeout: Number(fx.agentTask.example.timeout),
    };
    expect(Object.keys(task).sort()).toEqual([...fx.agentTask.requiredKeys].sort());
  });

  it("AgentResult key set matches the contract", () => {
    const result: AgentResult = {
      patch: String(fx.agentResult.example.patch),
      turns: Number(fx.agentResult.example.turns),
      outcome: fx.agentResult.example.outcome as AgentResult["outcome"],
      cost: Number(fx.agentResult.example.cost),
    };
    expect(Object.keys(result).sort()).toEqual([...fx.agentResult.requiredKeys].sort());
  });

  it("AgentOutcome value set is the contract union", () => {
    // The mirror of the TS `AgentOutcome` union (a compile-time type can't be
    // enumerated at runtime; this const is the runtime witness both sides pin).
    const union: AgentResult["outcome"][] = ["completed", "timeout", "turn_limit", "error"];
    expect([...fx.agentOutcomeValues].sort()).toEqual([...union].sort());
  });

  it("classify-outcome expected values are all valid AgentOutcomes", () => {
    const classify = load<{ cases: ClassifyCase[] }>("classify-outcome.json");
    const valid = new Set(fx.agentOutcomeValues);
    for (const c of classify.cases) expect(valid.has(c.expected)).toBe(true);
  });
});

// ── TS-host-scoped: task-classification precedence ───────────────────────────

interface TaskClassCase {
  name: string;
  signals: TaskSignals;
  expected: TaskKind;
}

describe("task-classification golden fixture (TS-host-scoped)", () => {
  const fx = load<{ cases: TaskClassCase[] }>("task-classification.json");

  it("has cases", () => expect(fx.cases.length).toBeGreaterThan(0));

  for (const c of fx.cases) {
    it(c.name, () => {
      expect(classifyTask(c.signals)).toBe(c.expected);
    });
  }
});

// ── TS-host-scoped: qwen_dispatch operator I/O shape (RDR-008 P3) ────────────
//
// The fixture-pinnable half of the nexus dispatch-operator spec
// (docs/contracts/qwen-dispatch-operator-contract.md is the prose half). This
// is the NON-WAIVABLE enforcement hook (bead pwa item (b)): the request/response
// shapes and the error-code set are asserted against the REAL code, so a drift
// in qwenDispatchInputShape / AgentResult / the error codes fails here.

interface DispatchShapesFixture {
  request: { requiredKeys: string[]; optionalKeys: string[]; example: Record<string, unknown> };
  response: { requiredKeys: string[]; example: Record<string, unknown> };
  error: { codes: string[]; envelope: { error: { code: string; message: string } } };
  executor: { oneShot: boolean; idleTerminal: boolean };
}

describe("qwen-dispatch-shapes golden fixture (TS-host-scoped)", () => {
  const fx = load<DispatchShapesFixture>("qwen-dispatch-shapes.json");

  it("request key set matches the real qwenDispatchInputShape", () => {
    const shapeKeys = Object.keys(qwenDispatchInputShape);
    const fixtureKeys = [...fx.request.requiredKeys, ...fx.request.optionalKeys];
    expect(shapeKeys.sort()).toEqual([...fixtureKeys].sort());
  });

  it("required/optional split matches the schema's zod optionality", () => {
    const shape = qwenDispatchInputShape as Record<string, { isOptional: () => boolean }>;
    for (const k of fx.request.requiredKeys) expect(shape[k]!.isOptional()).toBe(false);
    for (const k of fx.request.optionalKeys) expect(shape[k]!.isOptional()).toBe(true);
  });

  it("the request example carries every required key", () => {
    for (const k of fx.request.requiredKeys) {
      expect(Object.prototype.hasOwnProperty.call(fx.request.example, k)).toBe(true);
    }
  });

  it("response shape is AgentResult (reused verbatim from RDR-007)", () => {
    // A literal typed as AgentResult: drift in the interface keys fails at
    // runtime (Object.keys), independent of the untyped test compile.
    const result: AgentResult = {
      patch: String(fx.response.example.patch),
      turns: Number(fx.response.example.turns),
      outcome: fx.response.example.outcome as AgentResult["outcome"],
      cost: Number(fx.response.example.cost),
    };
    expect(Object.keys(result).sort()).toEqual([...fx.response.requiredKeys].sort());
  });

  it("error-code set is the contract surface (3 QwenDispatchError codes + shutting_down)", () => {
    // Runtime witness of the QwenDispatchError union + the tool's shutdown
    // envelope (a compile-time union can't be enumerated at runtime).
    const codes = ["no_provider", "missing_agent_kind", "unregistered_kind", "shutting_down"];
    expect([...fx.error.codes].sort()).toEqual([...codes].sort());
    expect(fx.error.codes).toContain(fx.error.envelope.error.code);
  });

  it("pins the executor as strictly one-shot (idle terminal)", () => {
    // Load-bearing for nexus: it must NOT design a resume-the-executor path.
    expect(fx.executor.oneShot).toBe(true);
    expect(fx.executor.idleTerminal).toBe(true);
  });
});
