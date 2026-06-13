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
