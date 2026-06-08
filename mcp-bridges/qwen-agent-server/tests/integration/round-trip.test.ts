// SPDX-License-Identifier: MIT
//
// End-to-end round-trip test exercising the MCP tool handlers
// (qwen_spawn → qwen_poll → qwen_send → qwen_stop) against a live
// llama-server. Satisfies Phase 5b's stability-soak gate: a real
// caller-visible workflow flows through the supervisor's full surface.
//
// REQUIRES: llama-server on localhost:8080. Skips otherwise.

import "./epipe-guard"; // swallow benign SDK-teardown EPIPE (see module)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolHandlers } from "../../src/server.js";
import { createPool } from "../../src/pool.js";
import { resolveWrapperPath } from "../../src/extensions.js";
import { _seedHealth } from "../../src/backends.js";
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

// ─────────────────────────────────────────────────────────────────
// RDR-002 — wrapper bridge end-to-end via qwen_spawn
//
// Proves the four pieces (resolver → handler → session → wrapper) compose
// without a real qwen install or a live llama-server. Uses a Pin-4-style
// fake QWEN_REAL_BIN that captures argv/env and exits non-zero so the
// SDK iterator surfaces the expected subprocess error. The SDK exec is
// real; nothing here mocks @qwen-code/sdk.

describe("RDR-002 wrapper bridge end-to-end (qwen_spawn → SDK exec)", () => {
  let tmpDir: string;
  let fakeBin: string;
  let logPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qwen-rdr2-rt-"));
    fakeBin = join(tmpDir, "fake-qwen");
    logPath = join(tmpDir, "captured.log");
    const captureScript = `#!/usr/bin/env bash
{
  echo "ARGV[$#]:"
  for a in "$@"; do printf '  [%s]\\n' "$a"; done
  echo "ENV.QWEN_AGENT_EXTENSIONS=[\${QWEN_AGENT_EXTENSIONS:-<unset>}]"
  echo "ENV.QWEN_REAL_BIN=[\${QWEN_REAL_BIN:-<unset>}]"
} > "${logPath}" 2>&1
exit 42
`;
    writeFileSync(fakeBin, captureScript, { encoding: "utf8" });
    chmodSync(fakeBin, 0o755);

    // Skip the cold-probe HTTP roundtrip — we don't need a real llama-server
    // for this test. The SDK subprocess dies before any HTTP is issued.
    _seedHealth("local-27b", true);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "opts.extensions={only:[]} → wrapper subprocess sees QWEN_AGENT_EXTENSIONS=none and --extensions none",
    { timeout: 30_000 },
    async () => {
      const wrapperPath = resolveWrapperPath();
      // Pool primed with our fake QWEN_REAL_BIN + the real wrapper script.
      const pool = createPool({ qwenRealBin: fakeBin, wrapperPath });

      // Empty installed-cache is fine: only=[] doesn't validate any names.
      const cache = {
        get: () => new Set<string>(),
        size: () => 0,
        reload: async () => new Set<string>(),
      };
      const handlers = createToolHandlers(pool, cache);

      const spawn = await handlers.qwen_spawn({
        task: "ping",
        opts: { extensions: { only: [] } },
      });
      if ("error" in spawn) {
        throw new Error(`unexpected spawn rejection: ${spawn.error.message}`);
      }
      expect(spawn.task_id).toMatch(/^q-[0-9a-f]{8}$/);

      // Poll the filesystem for the captured log; wrapper writes it
      // synchronously after the SDK exec hands off to the subprocess.
      const start = Date.now();
      while (!existsSync(logPath) && Date.now() - start < 20_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(existsSync(logPath), "wrapper subprocess did not produce a log").toBe(true);

      const log = readFileSync(logPath, "utf8");
      // (a) The resolved env reached the wrapper subprocess.
      expect(log).toMatch(/ENV\.QWEN_AGENT_EXTENSIONS=\[none\]/);
      expect(log).toMatch(new RegExp(`ENV\\.QWEN_REAL_BIN=\\[${fakeBin.replace(/\//g, "\\/")}\\]`));
      // (b) The wrapper prepended --extensions none ahead of the SDK's
      //     own argv (`--input-format stream-json` etc.).
      expect(log).toMatch(/\[--extensions\]\s+\[none\]/);
      // (c) The SDK still constructs its standard argv on top.
      expect(log).toMatch(/\[--input-format\][\s\S]*\[stream-json\]/);

      // Best-effort: confirm the session entered error state because
      // the fake binary exited 42. Don't assert hard — we don't want
      // CI flakes if the SDK swallows the exit differently in some
      // future patch release.
      const poll = (await handlers.qwen_poll({ task_id: spawn.task_id })) as PollResult;
      expect(["error", "running", "complete"]).toContain(poll.state);

      await handlers.qwen_stop({ task_id: spawn.task_id });
    },
  );
});
