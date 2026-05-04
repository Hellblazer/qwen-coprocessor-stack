// SPDX-License-Identifier: MIT
//
// Tests for makeCanUseTool (src/permissions.ts).
// No network — QwenSession constructor is partially mocked here to isolate
// permissions from the full session lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend, SpawnOpts } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────
// SDK Mock (same pattern as session.test.ts; must appear before imports)

vi.mock("@qwen-code/sdk", () => {
  function query() {
    return Object.assign(
      (async function* () {})(),
      { return: async () => ({ value: undefined, done: true }) },
    );
  }
  return { query };
});

// ─────────────────────────────────────────────────────────────────
// Module imports (after mock registration)

import { makeCanUseTool, WRITE_TOOLS } from "../src/permissions.js";
import type { QwenSession } from "../src/session.js";

// ─────────────────────────────────────────────────────────────────
// Minimal stub for QwenSession (only what permissions.ts needs)

interface EventRecord {
  type: string;
  summary: string;
  data?: unknown;
}

function makeStubSession(overrides: Partial<{
  state: string;
  write_authority: boolean;
}> = {}): {
  session: QwenSession;
  events: EventRecord[];
  awaitingInputCalls: Array<{ tool_use_id: string; tool_name: string }>;
} {
  const events: EventRecord[] = [];
  const awaitingInputCalls: Array<{ tool_use_id: string; tool_name: string }> = [];

  // We construct a partial stub that satisfies the permissions.ts contract.
  const session = {
    state: overrides.state ?? "running",
    backend: {} as Backend,
    task_id: "q-test",
    pushEvent(type: string, summary: string, data?: unknown) {
      events.push({ type, summary, data });
      return { id: "1", type, ts: Date.now(), summary, data };
    },
    setAwaitingInput(pending: { tool_use_id: string; tool_name: string; resolve: (a: string) => void; questions?: unknown }) {
      awaitingInputCalls.push({ tool_use_id: pending.tool_use_id, tool_name: pending.tool_name });
      // Simulate what QwenSession does: transition state.
      (session as { state: string }).state = "awaiting_input";
      // Store resolve so test can call it.
      (session as { _resolve?: (a: string) => void })._resolve = pending.resolve;
    },
    send(answer: string) {
      const s = session as { _resolve?: (a: string) => void; state: string };
      if (s._resolve) {
        const r = s._resolve;
        s._resolve = undefined;
        s.state = "running";
        r(answer);
      }
    },
  } as unknown as QwenSession;

  return { session, events, awaitingInputCalls };
}

const ABORT_SIGNAL = new AbortController().signal;

// ─────────────────────────────────────────────────────────────────
// Tests

describe("makeCanUseTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── ask_user_question routing ──────────────────────────────

  describe("ask_user_question routing (§Q1)", () => {
    it("routes ask_user_question to setAwaitingInput, not write-gating", async () => {
      const { session, events, awaitingInputCalls } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      // Start the call but don't await — it holds a Promise.
      const prom = canUseTool(
        "ask_user_question",
        { tool_use_id: "tuid-99", questions: [{ question: "Which branch?" }] },
        { signal: ABORT_SIGNAL },
      );

      // Give microtasks a tick to run.
      await Promise.resolve();

      // setAwaitingInput should have been called.
      expect(awaitingInputCalls).toHaveLength(1);
      expect(awaitingInputCalls[0]!.tool_name).toBe("ask_user_question");
      expect(awaitingInputCalls[0]!.tool_use_id).toBe("tuid-99");

      // No permission_denied event for ask_user_question.
      expect(events.find((e) => e.type === "permission_denied")).toBeUndefined();

      // Send answer → promise resolves with deny-message (§Q1 spike-B).
      (session as unknown as { send: (a: string) => void }).send("main");
      const result = await prom;

      expect(result).toEqual({ behavior: "deny", message: "main" });
    });

    it("ask_user_question Promise resolves with deny+message when answer delivered", async () => {
      const { session } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      const prom = canUseTool(
        "ask_user_question",
        { tool_use_id: "t-abc" },
        { signal: ABORT_SIGNAL },
      );

      await Promise.resolve();
      (session as unknown as { send: (a: string) => void }).send("the answer");

      const result = await prom;
      expect(result.behavior).toBe("deny");
      expect((result as { behavior: "deny"; message: string }).message).toBe("the answer");
    });
  });

  // ── Write tool gating ──────────────────────────────────────

  describe("write tool gating (§S4)", () => {
    it.each(Array.from(WRITE_TOOLS))(
      "write tool '%s' emits permission_denied event and returns deny",
      async (toolName) => {
        const { session, events } = makeStubSession();
        const canUseTool = makeCanUseTool(session);

        const result = await canUseTool(
          toolName,
          { path: "/x" },
          { signal: ABORT_SIGNAL },
        );

        expect(result.behavior).toBe("deny");
        expect((result as { message: string }).message).toContain("write_authority not granted");

        const denied = events.find((e) => e.type === "permission_denied");
        expect(denied).toBeDefined();
        expect(denied?.summary).toContain(toolName);
      },
    );

    it("write_file with write_authority:false returns deny message", async () => {
      const { session } = makeStubSession({ write_authority: false });
      const canUseTool = makeCanUseTool(session);

      const result = await canUseTool("write_file", {}, { signal: ABORT_SIGNAL });
      expect(result.behavior).toBe("deny");
    });
  });

  // ── Read / other tools (auto-allow) ───────────────────────

  describe("read and other tools (auto-allow)", () => {
    it.each(["read_file", "grep_search", "glob", "web_fetch", "ls", "cat"])(
      "read tool '%s' is NOT in WRITE_TOOLS and returns allow",
      async (toolName) => {
        const { session, events } = makeStubSession();
        const canUseTool = makeCanUseTool(session);

        const result = await canUseTool(
          toolName,
          { path: "/x" },
          { signal: ABORT_SIGNAL },
        );

        expect(result.behavior).toBe("allow");
        expect(events.find((e) => e.type === "permission_denied")).toBeUndefined();
      },
    );

    it("any tool not in WRITE_TOOLS and not ask_user_question returns allow", async () => {
      const { session } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      const result = await canUseTool(
        "some_future_read_tool",
        {},
        { signal: ABORT_SIGNAL },
      );

      expect(result.behavior).toBe("allow");
    });

    it("allow result carries updatedInput", async () => {
      const { session } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      const input = { path: "/etc/hosts" };
      const result = await canUseTool("read_file", input, { signal: ABORT_SIGNAL });

      expect(result.behavior).toBe("allow");
      expect((result as { updatedInput: unknown }).updatedInput).toEqual(input);
    });
  });

  // ── WRITE_TOOLS set membership ─────────────────────────────

  describe("WRITE_TOOLS constant", () => {
    it("contains the documented write tools", () => {
      const expected = ["write_file", "edit", "run_shell_command", "replace", "multi_edit"];
      for (const t of expected) {
        expect(WRITE_TOOLS.has(t)).toBe(true);
      }
    });

    it("does NOT contain read tools", () => {
      const readTools = ["read_file", "grep_search", "glob", "web_fetch"];
      for (const t of readTools) {
        expect(WRITE_TOOLS.has(t)).toBe(false);
      }
    });
  });
});
