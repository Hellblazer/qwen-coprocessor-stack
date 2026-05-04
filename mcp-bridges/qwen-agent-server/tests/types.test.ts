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
  AwaitingInput,
  Backend,
  BackendInfo,
  Event,
  LastKnown,
  PollOpts,
  PollResult,
  PriorContext,
  SessionState,
  SpawnOpts,
  SpawnResult,
} from "../src/types.js";

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
      "awaiting_input",
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

  it("SessionState covers four states", () => {
    const states: SessionState[] = [
      "running",
      "awaiting_input",
      "complete",
      "error",
    ];
    expect(states.length).toBe(4);
  });

  it("AwaitingInput supports structured questions", () => {
    const _a: AwaitingInput = {
      tool_name: "ask_user_question",
      tool_use_id: "tu_abc123",
      questions: [
        {
          question: "Which file?",
          header: "Codebase",
          options: [
            { label: "A.ts", description: "first match" },
            { label: "B.ts", description: "second match" },
          ],
        },
      ],
    };
    void _a;
    expect(true).toBe(true);
  });

  it("PollResult shape with awaiting_input", () => {
    const _p: PollResult = {
      state: "awaiting_input",
      recent_events: [],
      more_events_available: false,
      latest_event_id: "evt-7",
      awaiting_input: {
        tool_name: "ask_user_question",
        tool_use_id: "tu_x",
      },
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
