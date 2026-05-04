// SPDX-License-Identifier: MIT
//
// End-to-end round-trip test exercising the MCP tool handlers
// (qwen_spawn → qwen_poll → qwen_send → qwen_stop) against a live
// llama-server. Satisfies Phase 5b's stability-soak gate: a real
// caller-visible workflow flows through the supervisor's full surface.
//
// REQUIRES: llama-server on localhost:8080. Skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { createToolHandlers } from "../../src/server.js";
import { createPool } from "../../src/pool.js";
import type { PollResult } from "../../src/types.js";

const HEALTH_URL = "http://localhost:8080/health";

async function isBackendReachable(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2_000);
    const resp = await fetch(HEALTH_URL, { signal: ac.signal });
    clearTimeout(t);
    return resp.ok;
  } catch {
    return false;
  }
}

let backendAvailable = false;
beforeAll(async () => {
  backendAvailable = await isBackendReachable();
  if (!backendAvailable) {
    console.warn("[round-trip] llama-server unreachable — SKIP");
  }
}, 10_000);

/** Poll until predicate matches or timeout. Returns final poll result. */
async function pollUntil(
  handlers: ReturnType<typeof createToolHandlers>,
  task_id: string,
  predicate: (r: PollResult) => boolean,
  timeoutMs: number,
): Promise<PollResult> {
  const start = Date.now();
  let cursor: string | undefined;
  let last: PollResult | undefined;
  while (Date.now() - start < timeoutMs) {
    const opts = cursor !== undefined ? { since: cursor } : {};
    const r = (await handlers.qwen_poll({ task_id, opts })) as PollResult;
    last = r;
    if (r.latest_event_id) cursor = r.latest_event_id;
    if (predicate(r)) return r;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!last) throw new Error("pollUntil: never received any poll result");
  return last;
}

describe("end-to-end round-trip via MCP tool handlers", () => {
  it(
    "qwen_spawn → poll until idle → qwen_send → poll until idle again → qwen_stop",
    { timeout: 600_000 },
    async () => {
      if (!backendAvailable) {
        console.log("  [SKIP] llama-server unreachable");
        return;
      }

      // Real pool, real backends, real SDK — only the MCP transport is bypassed.
      const pool = createPool();
      const handlers = createToolHandlers(pool);

      // Turn 1: spawn with an ambiguous question that should produce a
      // plain-text question (since ask_user_question is excluded).
      const spawn = await handlers.qwen_spawn({
        task:
          "Pick a color: red or blue? Reply with one word: 'red' or 'blue'. " +
          "Do not pick yourself — ask me in plain text first.",
        opts: { write_authority: false, allow_subagents: false },
      });
      if ("error" in spawn) {
        throw new Error(`spawn failed: ${spawn.error.message}`);
      }
      expect(spawn.task_id).toMatch(/^q-[0-9a-f]{8}$/);
      expect(spawn.chosen_backend).toBe("local-27b");

      // Wait for turn 1 to complete (state → idle).
      const afterTurn1 = await pollUntil(
        handlers,
        spawn.task_id,
        (r) => r.state === "idle" || r.state === "error" || r.state === "complete",
        300_000,
      );
      expect(
        afterTurn1.state,
        `turn 1 ended in unexpected state: ${afterTurn1.state} ${JSON.stringify(afterTurn1.error ?? {})}`,
      ).toBe("idle");
      expect(afterTurn1.last_message, "turn-1 last_message present (plain-text question)").toBeDefined();

      // Turn 2: deliver the answer. Idle → running.
      const sendRes = await handlers.qwen_send({
        task_id: spawn.task_id,
        message: "blue",
      });
      expect(sendRes).toEqual({ ack: true });

      // Wait for turn 2 to complete.
      const afterTurn2 = await pollUntil(
        handlers,
        spawn.task_id,
        (r) => r.state === "idle" || r.state === "error" || r.state === "complete",
        300_000,
      );
      expect(afterTurn2.state).toBe("idle");
      // The model was told to reply with one word; the answer should
      // surface in last_message.
      expect(
        (afterTurn2.last_message ?? "").toLowerCase(),
        "turn-2 last_message should reference 'blue'",
      ).toContain("blue");

      // Stop the session — idle → complete.
      const stopRes = await handlers.qwen_stop({ task_id: spawn.task_id });
      expect(stopRes).toEqual({ ack: true });

      // Polling a stopped task returns task_id_not_found (it was removed
      // from the pool).
      const afterStop = (await handlers.qwen_poll({
        task_id: spawn.task_id,
      })) as { state: string; error: { code: string } };
      expect(afterStop.state).toBe("error");
      expect(afterStop.error.code).toBe("task_id_not_found");
    },
  );
});
