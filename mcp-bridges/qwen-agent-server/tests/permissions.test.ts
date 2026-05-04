// SPDX-License-Identifier: MIT
//
// Tests for makeCanUseTool (src/permissions.ts).
// No network — QwenSession constructor is partially mocked here to isolate
// permissions from the full session lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../src/types.js";

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

function makeStubSession(): {
  session: QwenSession;
  events: EventRecord[];
} {
  const events: EventRecord[] = [];

  // Permissions.ts only touches `pushEvent` on the session.
  const session = {
    state: "running",
    backend: {} as Backend,
    task_id: "q-test",
    pushEvent(type: string, summary: string, data?: unknown) {
      events.push({ type, summary, data });
      return { id: "1", type, ts: Date.now(), summary, data };
    },
  } as unknown as QwenSession;

  return { session, events };
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

  // ── ask_user_question defense-in-depth ─────────────────────
  //
  // Post-2026-05-04 spike: ask_user_question is now in
  // DEFAULT_EXCLUDED_TOOLS so the SDK shouldn't ever invoke canUseTool
  // for it. If it somehow does (model bypass, future SDK change), we
  // deny with a clear hint message rather than allowing it through.

  describe("ask_user_question defense-in-depth (§Q1)", () => {
    it("denies ask_user_question with a hint about plain-text questions", async () => {
      const { session, events } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      const result = await canUseTool(
        "ask_user_question",
        { tool_use_id: "tuid-99", questions: [{ question: "Which branch?" }] },
        { signal: ABORT_SIGNAL },
      );

      expect(result.behavior).toBe("deny");
      expect((result as { message: string }).message).toContain("ask in plain text");
    });

    it("emits a permission_denied event when ask_user_question is denied", async () => {
      const { session, events } = makeStubSession();
      const canUseTool = makeCanUseTool(session);

      await canUseTool(
        "ask_user_question",
        { tool_use_id: "t-abc" },
        { signal: ABORT_SIGNAL },
      );

      const denied = events.find((e) => e.type === "permission_denied");
      expect(denied).toBeDefined();
      expect(denied?.summary).toContain("ask_user_question");
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
      const { session } = makeStubSession();
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
