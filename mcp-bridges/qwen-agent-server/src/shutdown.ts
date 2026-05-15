// SPDX-License-Identifier: MIT
//
// Graceful shutdown for the MCP server.
//
// Design: exported setupShutdown() wires SIGTERM/SIGINT handlers and
// returns { handleSignal, isShuttingDown } so tests can invoke handlers
// directly without sending real signals to the test process.
//
// Shutdown sequence:
//   1. Set shutting_down flag (qwen_spawn returns error after this)
//   2. Close MCP server transport
//   3. For each live session: call stop() with a 5s per-session timeout
//   4. If any stop() exceeds 5s → exit code 1 (force kill path)
//      Otherwise                → exit code 0
//
// The reaper interval handle is NOT cleared here — it should be
// unref()d so it doesn't block process exit (done in server.ts).

import { createLogger } from "./log.js";
import type { SessionPool } from "./pool.js";

const log = createLogger("qwen-shutdown");

const STOP_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────
// Types

export interface ShuttableServer {
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// setupShutdown

export function setupShutdown(
  server: ShuttableServer,
  pool: SessionPool,
  exit: (code: number) => void = process.exit,
): {
  handleSignal: (signal: string) => Promise<void>;
  isShuttingDown: () => boolean;
} {
  let shuttingDown = false;
  let shutdownStarted = false;

  const isShuttingDown = () => shuttingDown;

  const handleSignal = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shuttingDown = true;

    log.info({ signal, event_type: "shutdown" }, "shutdown signal received");

    // Close MCP transport — stops accepting new connections
    try {
      await server.close();
    } catch (err) {
      log.error({ err }, "error closing MCP server");
    }

    // Stop all live sessions with a per-session timeout
    const sessions = [...pool.sessions.values()];
    log.info({ count: sessions.length, event_type: "shutdown" }, "stopping sessions");

    let forcedKill = false;

    await Promise.allSettled(
      sessions.map(async (session) => {
        const raceResult = await Promise.race([
          Promise.resolve().then(() => session.stop()),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS),
          ),
        ]);

        if (raceResult === "timeout") {
          forcedKill = true;
          log.error(
            { task_id: session.task_id, event_type: "force_kill" },
            "session stop() timed out after 5s — force kill",
          );
        } else {
          log.info(
            { task_id: session.task_id, event_type: "stopped", state: session.state },
            "session stopped",
          );
        }
      }),
    );

    if (forcedKill) {
      log.error({ event_type: "shutdown" }, "forced exit with code 1");
      exit(1);
    } else {
      log.info({ event_type: "shutdown" }, "clean exit with code 0");
      exit(0);
    }
  };

  return { handleSignal, isShuttingDown };
}
