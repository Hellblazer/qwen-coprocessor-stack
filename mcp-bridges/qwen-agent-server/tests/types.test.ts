// SPDX-License-Identifier: MIT
//
// Compile-only assertions for the shared type surface in src/types.ts.
//
// The point isn't behavioral coverage — it's a regression net for the
// types: if the public shape drifts (a field renamed, a discriminant
// dropped), the literals below stop satisfying their declared types
// and `tsc --noEmit` (run by `vitest` via the test script) catches it.
//
// Each `const _x: T = {...}` reads as "the literal on the right MUST
// be assignable to T." If T's required fields change, this file fails
// to compile. The runtime `expect(true).toBe(true)` keeps the test
// runner from complaining about an empty suite.

import { describe, expect, it } from "vitest";

import type {
  AgentProvider,
  Backend,
  BackendInfo,
  CostClass,
  Event,
  EventType,
  LastKnown,
  PollOpts,
  PollResult,
  PriorContext,
  SessionState,
  SpawnOpts,
  SpawnResult,
  TaskKind,
} from "../src/types.js";
import { backendToAgentProvider, classifyTask } from "../src/types.js";

describe("types.ts compile-only assertions", () => {
  it("Backend literal satisfies the type", () => {
    const _b: Backend = {
      id: "local-27b",
      url: "http://localhost:8080/v1",
      model: "qwen3.6-27b-instruct",
      tier: "local",
      capacity: "fast",
    };
    void _b;
    expect(true).toBe(true);
  });

  it("Backend with optional weight satisfies the type", () => {
    const _b: Backend = {
      id: "remote-35b",
      url: "http://strix.local:8080/v1",
      model: "qwen3.6-35b-a3b",
      tier: "remote",
      capacity: "heavy",
      weight: 2,
    };
    void _b;
    expect(true).toBe(true);
  });

  it("SpawnOpts is fully optional and accepts a minimum literal", () => {
    const _empty: SpawnOpts = {};
    const _full: SpawnOpts = {
      backend: "local-27b",
      tier: "local",
      capacity: "fast",
      write_authority: false,
      allow_subagents: false,
      prior_context: {
        conversation_summary: "earlier we discussed X",
        last_user_message: "what about Y?",
      },
      system: "You are a coprocessor.",
    };
    void _empty;
    void _full;
    expect(true).toBe(true);
  });

  it("SpawnOpts.extensions accepts the documented enable/disable/only shape", () => {
    // RDR-002 §Decision Layer 2: opts.extensions is the per-spawn extension
    // loadout the orchestrator passes to the supervisor. All three sub-fields
    // are independently optional (Zod refines additional rules; type only
    // expresses the shape).
    const _onlyMode: SpawnOpts = {
      extensions: { only: ["serena"] },
    };
    const _enableDisable: SpawnOpts = {
      extensions: { enable: ["custom-a"], disable: ["legacy-b"] },
    };
    const _empty: SpawnOpts = {
      extensions: {},
    };
    const _all: SpawnOpts = {
      extensions: {
        enable: ["a", "b"],
        disable: ["c"],
        only: ["d"],
      },
    };
    void _onlyMode;
    void _enableDisable;
    void _empty;
    void _all;
    expect(true).toBe(true);
  });

  it("PollOpts accepts cursor and cap", () => {
    const _p: PollOpts = { since: "evt-3", max_events: 32 };
    const _empty: PollOpts = {};
    void _p;
    void _empty;
    expect(true).toBe(true);
  });

  it("Event covers all six categorical types", () => {
    const types: Event["type"][] = [
      "tool_call",
      "tool_result",
      "permission_denied",
      "model_message_summary",
      "turn_complete",
      "error",
    ];
    expect(types.length).toBe(6);
    const _e: Event = {
      id: "evt-1",
      type: "tool_call",
      ts: Date.now(),
      summary: "called read_file on probe.mjs",
      data: { tool_name: "read_file" },
    };
    void _e;
  });

  it("EventType includes 'extensions_loaded' (RDR-002 step 11)", () => {
    // Resolution-algorithm step 11: the supervisor emits extensions_loaded
    // as the first event of every spawned session, capturing the resolved
    // extension set for observability.
    const _t: EventType = "extensions_loaded";
    void _t;
    const _e: Event = {
      id: "evt-0",
      type: "extensions_loaded",
      ts: Date.now(),
      summary: "extensions: serena, web-fetch",
      data: { resolved: ["serena", "web-fetch"] },
    };
    void _e;
    expect(true).toBe(true);
  });

  it("SessionState covers four states", () => {
    const states: SessionState[] = [
      "running",
      "idle",
      "complete",
      "error",
    ];
    expect(states.length).toBe(4);
  });

  it("PollResult shape on idle includes last_message", () => {
    const _p: PollResult = {
      state: "idle",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "evt-7",
      last_message: "Which file should I refactor?",
    };
    void _p;
    expect(true).toBe(true);
  });

  it("PollResult shape on backend failure includes last_known", () => {
    const lk: LastKnown = {
      turns_completed: 4,
      last_user_message: "now refactor it",
      last_assistant_summary: "renamed oldFoo to foo across 4 files",
    };
    const _p: PollResult = {
      state: "error",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "evt-9",
      error: { code: "backend_offline", message: "ECONNREFUSED" },
      last_known: lk,
    };
    void _p;
    expect(true).toBe(true);
  });

  it("SpawnResult / BackendInfo / PriorContext all instantiate", () => {
    const _s: SpawnResult = { task_id: "q-abc", chosen_backend: "local-27b" };
    const _b: BackendInfo = {
      id: "local-27b",
      url: "http://localhost:8080/v1",
      model: "qwen3.6-27b-instruct",
      tier: "local",
      capacity: "fast",
      healthy: null,
    };
    const _pc: PriorContext = {
      conversation_summary: "we covered X",
    };
    void _s;
    void _b;
    void _pc;
    expect(true).toBe(true);
  });
});

// ── Agent dispatch contract (RDR-007 P0 / azf.1) ───────────────────────────
//
// Behavior-neutral type surface + two pure functions. No router wiring, no
// excludes enforcement (that is Phase 2 / azf.5).

describe("agent dispatch contract (RDR-007)", () => {
  it("TaskKind is a closed set of exactly five members", () => {
    // RF-2: closed union (mirrors Backend.modality), NOT an open string set
    // like Backend.roles — so the excludes-parity test (P2) is exhaustive.
    const kinds: TaskKind[] = [
      "schemaSynth",
      "agenticLoop",
      "embed",
      "rerank",
      "chat",
    ];
    expect(kinds.length).toBe(5);
  });

  it("CostClass is a closed union", () => {
    const classes: CostClass[] = ["free-local", "metered"];
    expect(classes.length).toBe(2);
  });

  it("AgentProvider model-endpoint literal satisfies the type", () => {
    const _p: AgentProvider = {
      id: "qwen-coder-box",
      kind: "model-endpoint",
      modalities: ["text"],
      url: "http://qwentescence:1235/v1",
      model: "qwen",
      tier: "remote",
      capacity: "heavy",
      strengths: ["agenticLoop", "schemaSynth"],
      excludes: [],
      latencyMult: 4.0,
      costClass: "free-local",
    };
    void _p;
    expect(true).toBe(true);
  });

  it("AgentProvider agent-cli literal needs no endpoint fields", () => {
    const _p: AgentProvider = {
      id: "claude-sonnet",
      kind: "agent-cli",
      modalities: ["text"],
      excludes: [],
      latencyMult: 1.0,
      costClass: "metered",
    };
    void _p;
    expect(true).toBe(true);
  });

  it("backendToAgentProvider defaults missing modality to [text]", () => {
    const b: Backend = {
      id: "local-27b",
      url: "http://localhost:8080/v1",
      model: "qwen3.6-27b-instruct",
      tier: "local",
      capacity: "fast",
    };
    const p = backendToAgentProvider(b);
    expect(p.kind).toBe("model-endpoint");
    expect(p.modalities).toEqual(["text"]);
    expect(p.id).toBe("local-27b");
    expect(p.tier).toBe("local");
  });

  it("backendToAgentProvider maps an explicit modality through (singular -> plural)", () => {
    const b: Backend = {
      id: "vision-mac",
      url: "http://localhost:8083/v1",
      model: "qwen2.5-vl-7b",
      tier: "remote",
      capacity: "fast",
      modality: "multimodal",
    };
    const p = backendToAgentProvider(b);
    expect(p.modalities).toEqual(["multimodal"]);
  });

  it("backendToAgentProvider does NOT translate no_agentic/vision_only into excludes (deferred to P2)", () => {
    const b: Backend = {
      id: "coder-box",
      url: "http://qwentescence:1235/v1",
      model: "qwen",
      tier: "remote",
      capacity: "heavy",
      no_agentic: true,
      vision_only: false,
    };
    const p = backendToAgentProvider(b);
    // P0 is behavior-neutral: no_agentic/vision_only are NOT folded into
    // excludes; the projection emits an empty (but present) list. P2 populates.
    expect(p.excludes).toEqual([]);
  });

  it("backendToAgentProvider maps no_schema:true -> excludes:[schemaSynth] (RDR-007 P2)", () => {
    const b: Backend = {
      id: "reason-mac",
      url: "http://mac.local:8084/v1",
      model: "mlx-community/Qwen3.6-35B-A3B-4bit",
      tier: "remote",
      capacity: "heavy",
      no_schema: true,
    };
    const p = backendToAgentProvider(b);
    // P2 net-new: the MLX no-json_schema rule becomes an enforced exclusion.
    expect(p.excludes).toEqual(["schemaSynth"]);
  });

  it("backendToAgentProvider omits the schemaSynth exclude when no_schema is unset/false (P2)", () => {
    const unset: Backend = {
      id: "coder-box",
      url: "http://box:1235/v1",
      model: "qwen",
      tier: "remote",
      capacity: "heavy",
    };
    const explicitFalse: Backend = { ...unset, id: "coder-box-2", no_schema: false };
    // Only no_schema folds into excludes; no_agentic/vision_only still do NOT
    // (they stay inline Backend-level filters — deliberate P2 scope: the bead
    // is the MLX schemaSynth guard, not a migration of the other two flags).
    expect(backendToAgentProvider(unset).excludes).toEqual([]);
    expect(backendToAgentProvider(explicitFalse).excludes).toEqual([]);
    expect(
      backendToAgentProvider({ ...unset, no_agentic: true, vision_only: true }).excludes,
    ).toEqual([]);
  });

  it("classifyTask: json_schema present on the agentic surface -> schemaSynth", () => {
    expect(classifyTask({ opts: { json_schema: { type: "object" } } })).toBe(
      "schemaSynth",
    );
  });

  it("classifyTask: precedence follows the RDR-007 §2 table (json_schema beats modality)", () => {
    // Disjoint at every real call site, but lock the spec order so a future
    // edit can't silently invert it (review M1). json_schema wins over a
    // co-supplied modality; agentic opts win over a co-supplied modality.
    expect(
      classifyTask({ opts: { json_schema: {} }, modality: "embedding" }),
    ).toBe("schemaSynth");
    expect(classifyTask({ opts: {}, modality: "rerank" })).toBe("agenticLoop");
  });

  it("classifyTask: agentic surface without a schema -> agenticLoop", () => {
    expect(classifyTask({ opts: {} })).toBe("agenticLoop");
  });

  it("classifyTask: embedding modality -> embed", () => {
    expect(classifyTask({ modality: "embedding" })).toBe("embed");
  });

  it("classifyTask: rerank modality -> rerank", () => {
    expect(classifyTask({ modality: "rerank" })).toBe("rerank");
  });

  it("classifyTask: no agentic opts and a text/plain modality -> chat", () => {
    expect(classifyTask({})).toBe("chat");
    expect(classifyTask({ modality: "text" })).toBe("chat");
    expect(classifyTask({ modality: "multimodal" })).toBe("chat");
  });
});
