// SPDX-License-Identifier: MIT
//
// qwen-agent-server MCP entrypoint.
//
// Exports createToolHandlers() for testing and wires a McpServer +
// StdioServerTransport for production use when run as `node dist/server.js`.
//
// The 5 tools:
//   qwen_spawn    — create a new session
//   qwen_poll     — read events / state
//   qwen_send     — push the next user message into a session
//   qwen_stop     — cancel a session
//   qwen_backends — list backend health

import pino from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  BackendInfo,
  PollOpts,
  PollResult,
  SpawnOpts,
  SpawnResult,
} from "./types.js";
import { getCachedHealth, refreshPoolBackends } from "./backends.js";
import { QwenSession } from "./session.js";
import {
  createPool,
  reapSweep,
  removeSession,
  spawnSession,
  type SessionPool,
} from "./pool.js";
import { setupShutdown } from "./shutdown.js";
import {
  createInstalledExtensionsCache,
  ExtensionResolutionError,
  getSessionDefaultExtensions,
  listInstalledExtensions,
  resolveExtensions,
  resolveQwenRealBin,
  resolveWrapperPath,
  type ExtensionInfo,
  type InstalledExtensionsCache,
} from "./extensions.js";

const log = pino({ name: "qwen-agent-server" });

// ─────────────────────────────────────────────────────────────────
// not-found poll result
//
// PollResult.error.code union is "backend_offline"|"backend_internal"|"timeout".
// task_id_not_found is a supervisor-level sentinel, not a backend error. We
// extend the return type of qwen_poll to accommodate this case without altering
// the canonical PollResult type in types.ts.

type NotFoundPollResult = Omit<PollResult, "error"> & {
  error: { code: "task_id_not_found"; message: string };
};

// ─────────────────────────────────────────────────────────────────
// qwen_spawn opts schema
//
// Extracted to a top-level export so tests can parse payloads against it
// directly without needing a live MCP transport. The same schema is wired
// into mcpServer.tool registration in main(). Keep these in sync.

export const qwenSpawnOptsSchema = z.object({
  backend: z.string().optional(),
  tier: z.enum(["local", "remote"]).optional(),
  capacity: z.enum(["fast", "heavy"]).optional(),
  write_authority: z.boolean().optional(),
  allow_subagents: z.boolean().optional(),
  system: z.string().optional(),
  prior_context: z.object({
    conversation_summary: z.string(),
    last_user_message: z.string().optional(),
    prior_session_id: z.string().optional(),
  }).optional(),
  extensions: z.object({
    enable: z.array(z.string()).optional(),
    disable: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
  }).optional(),
}).optional();

type RawSpawnOpts = z.infer<typeof qwenSpawnOptsSchema>;

/**
 * Translate the Zod-parsed opts payload into a Partial<SpawnOpts>,
 * stripping undefined fields to satisfy `exactOptionalPropertyTypes`.
 *
 * Exported for testability — production wiring in main() funnels every
 * qwen_spawn invocation through this helper.
 */
export function buildSpawnOptsFromRaw(rawOpts: RawSpawnOpts): Partial<SpawnOpts> {
  const spawnOpts: Partial<SpawnOpts> = {};
  if (rawOpts === undefined) return spawnOpts;

  if (rawOpts.backend !== undefined) spawnOpts.backend = rawOpts.backend;
  if (rawOpts.tier !== undefined) spawnOpts.tier = rawOpts.tier;
  if (rawOpts.capacity !== undefined) spawnOpts.capacity = rawOpts.capacity;
  if (rawOpts.write_authority !== undefined) spawnOpts.write_authority = rawOpts.write_authority;
  if (rawOpts.allow_subagents !== undefined) spawnOpts.allow_subagents = rawOpts.allow_subagents;
  if (rawOpts.system !== undefined) spawnOpts.system = rawOpts.system;
  if (rawOpts.prior_context !== undefined) {
    const pc = rawOpts.prior_context;
    spawnOpts.prior_context = { conversation_summary: pc.conversation_summary };
    if (pc.last_user_message !== undefined) spawnOpts.prior_context.last_user_message = pc.last_user_message;
    if (pc.prior_session_id !== undefined) spawnOpts.prior_context.prior_session_id = pc.prior_session_id;
  }
  if (rawOpts.extensions !== undefined) {
    const ext: NonNullable<SpawnOpts["extensions"]> = {};
    if (rawOpts.extensions.enable !== undefined) ext.enable = rawOpts.extensions.enable;
    if (rawOpts.extensions.disable !== undefined) ext.disable = rawOpts.extensions.disable;
    if (rawOpts.extensions.only !== undefined) ext.only = rawOpts.extensions.only;
    spawnOpts.extensions = ext;
  }
  return spawnOpts;
}

// ─────────────────────────────────────────────────────────────────
// Tool handlers factory
//
// Separated from MCP server wiring so tests can call handlers directly
// without binding a real transport.

export type ToolHandlers = {
  qwen_spawn: (args: { task: string; opts?: Partial<SpawnOpts> }) => Promise<SpawnResult | { error: { code: string; message: string } }>;
  qwen_poll: (args: { task_id: string; opts?: PollOpts }) => Promise<PollResult | NotFoundPollResult>;
  qwen_send: (args: { task_id: string; message: string }) => Promise<{ ack: boolean }>;
  qwen_stop: (args: { task_id: string }) => Promise<{ ack: boolean }>;
  qwen_backends: (args: Record<string, never>) => Promise<BackendInfo[]>;
  /**
   * Read-only listing of installed extensions, with version / path /
   * source / enabled-state and declared commands/skills/agents/MCP
   * servers. Shells out to `qwen extensions list` per call (no cache);
   * cost is one process spawn — fine for an interactive listing and
   * keeps results fresh.
   */
  qwen_extensions: (args: Record<string, never>) => Promise<ExtensionInfo[]>;
  /**
   * Triggers a fresh shell-out to `qwen extensions list` and replaces
   * the in-process cache contents. Affects future spawns only —
   * running sessions see no change (RDR-002 §drain semantics).
   *
   * Available iff a cache was wired into createToolHandlers (production
   * main() always wires one). The `QWEN_ADMIN_TOOLS` env var no longer
   * gates this — RDR-002 amendment 2026-05-09: in a single-operator
   * stdio supervisor talking to a local Claude Code there is no
   * untrusted-client surface to protect against.
   */
  qwen_reload_extensions?: (args: Record<string, never>) => Promise<{ size: number; names: string[] }>;
  /** Test-only: flip the shutting_down flag. */
  __setShuttingDown: (v: boolean) => void;
};

export function createToolHandlers(
  existingPool?: SessionPool,
  installedExtensionsCache?: InstalledExtensionsCache,
): ToolHandlers {
  const pool = existingPool ?? createPool();
  let shuttingDown = false;

  // ── qwen_spawn ─────────────────────────────────────────────

  const qwen_spawn: ToolHandlers["qwen_spawn"] = async ({ task, opts = {} }) => {
    if (shuttingDown) {
      log.warn({ event_type: "spawn_rejected" }, "qwen_spawn rejected: server shutting down");
      return {
        error: { code: "shutting_down", message: "server is shutting down; cannot spawn new sessions" },
      };
    }

    // RDR-002 step 6 — pre-spawn validation. Only run when an installed-
    // extensions cache is wired (production main()). Tests that don't
    // supply a cache skip resolution and fall through to default SDK
    // behaviour. Mirrors the shutting_down envelope shape (server.ts
    // lines just above) — caller never sees an McpError throw for
    // caller-supplied invalid input.
    let resolvedExtensions: import("./extensions.js").ResolveExtensionsResult | undefined;
    if (installedExtensionsCache !== undefined) {
      try {
        const sessionDefault = getSessionDefaultExtensions(process.env);
        resolvedExtensions = resolveExtensions(
          opts.extensions,
          sessionDefault,
          installedExtensionsCache.get(),
        );
      } catch (err) {
        if (err instanceof ExtensionResolutionError) {
          log.warn(
            { event_type: "spawn_rejected", reason: "extension_resolution", err: err.message },
            "qwen_spawn rejected: extension resolution",
          );
          return {
            error: { code: "spawn_error", message: err.message },
          };
        }
        throw err;
      }
    }

    // Hot-reload the backend list from env / config file before each
    // spawn so operator edits via `/qwen-backends add|remove` apply
    // without restarting the supervisor. Existing sessions stay pinned
    // to their backend (RDR-001 §Q3) — only this fresh spawn sees the
    // new list.
    refreshPoolBackends(pool);

    let session;
    try {
      session = await spawnSession(pool, task, opts, resolvedExtensions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ event_type: "spawn_no_backend", err: message }, "spawnSession failed");
      throw new McpError(ErrorCode.InternalError, message);
    }

    return { task_id: session.task_id, chosen_backend: session.backend.id };
  };

  // ── qwen_poll ──────────────────────────────────────────────

  const qwen_poll: ToolHandlers["qwen_poll"] = async ({ task_id, opts }) => {
    const session = pool.sessions.get(task_id);
    if (!session) {
      return {
        state: "error",
        recent_events: [],
        more_events_available: false,
        latest_event_id: "",
        error: { code: "task_id_not_found" as const, message: `task_id ${task_id} not found; session may have been evicted` },
      } satisfies NotFoundPollResult;
    }

    session.last_polled_at = Date.now();

    // Build PollOpts, omitting undefined fields to satisfy exactOptionalPropertyTypes
    const pollOpts: PollOpts = {};
    if (opts?.since !== undefined) pollOpts.since = opts.since;
    if (opts?.max_events !== undefined) pollOpts.max_events = opts.max_events;

    const realSession = session as unknown as QwenSession;
    return realSession.poll(pollOpts);
  };

  // ── qwen_send ──────────────────────────────────────────────

  const qwen_send: ToolHandlers["qwen_send"] = async ({ task_id, message }) => {
    const session = pool.sessions.get(task_id);
    if (!session) {
      throw new McpError(ErrorCode.InvalidParams, `task_id ${task_id} not found`);
    }

    const realSession = session as unknown as QwenSession;
    realSession.send(message);
    return { ack: true };
  };

  // ── qwen_stop ──────────────────────────────────────────────

  const qwen_stop: ToolHandlers["qwen_stop"] = async ({ task_id }) => {
    const session = pool.sessions.get(task_id);
    if (!session) {
      // Idempotent: stopping a non-existent session is fine
      return { ack: false };
    }

    session.stop();
    removeSession(pool, task_id);

    log.info(
      { task_id, event_type: "stop", state: session.state },
      "session stopped via qwen_stop",
    );

    return { ack: true };
  };

  // ── qwen_backends ─────────────────────────────────────────

  const qwen_backends: ToolHandlers["qwen_backends"] = async () => {
    // Hot-reload from env / config file so operator edits surface in
    // the next list call without restarting the supervisor.
    refreshPoolBackends(pool);
    const results = await Promise.all(
      pool.backends.map(async (b) => {
        const healthy = await getCachedHealth(b);
        const info: BackendInfo = {
          id: b.id,
          url: b.url,
          model: b.model,
          tier: b.tier,
          capacity: b.capacity,
          healthy,
        };
        return info;
      }),
    );
    return results;
  };

  // ── qwen_extensions (read-only listing) ────────────────────

  const qwen_extensions: ToolHandlers["qwen_extensions"] = async () => {
    if (!pool.qwenRealBin) {
      log.warn(
        { event_type: "qwen_extensions_no_bin" },
        "qwen_extensions called but pool.qwenRealBin is unset; returning empty list",
      );
      return [];
    }
    try {
      return await listInstalledExtensions(pool.qwenRealBin);
    } catch (err) {
      log.warn(
        { event_type: "qwen_extensions_exec_failed", err: err instanceof Error ? err.message : String(err) },
        "qwen extensions list shell-out failed",
      );
      return [];
    }
  };

  // ── qwen_reload_extensions ─────────────────────────────────
  //
  // RDR-002 amendment 2026-05-09: ungated. Single-operator stdio
  // supervisor; the prior QWEN_ADMIN_TOOLS gate solved a
  // multi-tenant-untrusted-client problem we don't have. Available
  // whenever a cache was wired into createToolHandlers (production
  // main() always wires one).

  let qwen_reload_extensions: ToolHandlers["qwen_reload_extensions"] | undefined;
  if (installedExtensionsCache !== undefined) {
    qwen_reload_extensions = async () => {
      const newSet = await installedExtensionsCache.reload();
      const names = Array.from(newSet);
      log.info(
        { event_type: "extensions_reloaded", size: names.length },
        "installed-extensions cache reloaded",
      );
      return { size: names.length, names };
    };
  }

  return {
    qwen_spawn,
    qwen_poll,
    qwen_send,
    qwen_stop,
    qwen_backends,
    qwen_extensions,
    ...(qwen_reload_extensions !== undefined ? { qwen_reload_extensions } : {}),
    __setShuttingDown: (v: boolean) => { shuttingDown = v; },
  };
}

// ─────────────────────────────────────────────────────────────────
// MCP server wiring (production entrypoint)

async function main(): Promise<void> {
  log.info("qwen-agent-server starting");

  // RDR-002 §The wrapper-script bridge — fail-fast at startup if the
  // real qwen binary cannot be located. An operator who hasn't installed
  // Qwen Code can't recover later by registering more sessions; only
  // by fixing the install. Resolve once here and stash on the pool.
  const qwenRealBin = resolveQwenRealBin(process.env);
  const wrapperPath = resolveWrapperPath();
  log.info(
    { qwen_real_bin: qwenRealBin, wrapper_path: wrapperPath },
    "extension bridge resolved",
  );

  // Prime the installed-extensions cache once at startup. Exec errors
  // propagate; unparseable output degrades to an empty cache + warn
  // (RDR-002 audit-note #4 — no hard-brick on routine SDK output drift).
  const installedExtensionsCache = await createInstalledExtensionsCache(qwenRealBin);
  log.info(
    { event_type: "extensions_cache_loaded", size: installedExtensionsCache.size() },
    "installed-extensions cache primed",
  );

  const pool = createPool({ qwenRealBin, wrapperPath });
  const handlers = createToolHandlers(pool, installedExtensionsCache);

  const mcpServer = new McpServer({
    name: "qwen-agent-server",
    version: "0.0.1",
  });

  // ── Register tools with Zod schemas ───────────────────────

  mcpServer.tool(
    "qwen_spawn",
    "Spawn a new Qwen Code session. Returns task_id and chosen_backend immediately; inference runs async.",
    {
      task: z.string().describe("The task/prompt to run"),
      opts: qwenSpawnOptsSchema,
    },
    async (args) => {
      const spawnOpts = buildSpawnOptsFromRaw(args.opts);
      const result = await handlers.qwen_spawn({ task: args.task, opts: spawnOpts });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_poll",
    "Poll a session for events and current state. Pass opts.since as the previous latest_event_id for incremental reads.",
    {
      task_id: z.string().describe("Session task ID returned by qwen_spawn"),
      opts: z.object({
        since: z.string().optional().describe("Event cursor: only return events with id > since"),
        max_events: z.number().int().positive().optional().describe("Cap on events per call (default 16)"),
      }).optional(),
    },
    async (args) => {
      const pollOpts: PollOpts = {};
      if (args.opts?.since !== undefined) pollOpts.since = args.opts.since;
      if (args.opts?.max_events !== undefined) pollOpts.max_events = args.opts.max_events;
      const result = await handlers.qwen_poll({
        task_id: args.task_id,
        opts: pollOpts,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_send",
    "Push the next user message into a running or idle session. Wakes idle sessions for the next turn.",
    {
      task_id: z.string().describe("Session task ID"),
      message: z.string().describe("The answer or message to deliver"),
    },
    async (args) => {
      const result = await handlers.qwen_send(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_stop",
    "Stop and remove a session. Idempotent — stopping an unknown task_id returns { ack: false }.",
    {
      task_id: z.string().describe("Session task ID to stop"),
    },
    async (args) => {
      const result = await handlers.qwen_stop(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_backends",
    "List configured backends and their cached health status.",
    {},
    async (_args) => {
      const result = await handlers.qwen_backends({});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_extensions",
    "List installed Qwen Code extensions with version, path, source, enabled state, and declared commands/skills/agents/MCP servers. Read-only.",
    {},
    async (_args) => {
      const result = await handlers.qwen_extensions({});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // RDR-002 amendment 2026-05-09: ungated. Available whenever a cache
  // was wired into createToolHandlers (production main() always wires
  // one). Single-operator stdio supervisor; no untrusted-client surface
  // to protect against.
  if (handlers.qwen_reload_extensions !== undefined) {
    const reloadHandler = handlers.qwen_reload_extensions;
    mcpServer.tool(
      "qwen_reload_extensions",
      "Reload the supervisor's installed-extensions cache from `qwen extensions list`. Affects future spawns; running sessions are unaffected.",
      {},
      async (_args) => {
        const result = await reloadHandler({});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
    log.info("qwen_reload_extensions tool registered");
  }

  // ── Reaper interval ─────────────────────────────────────────
  const reaperInterval = setInterval(() => {
    reapSweep(pool);
  }, 5 * 60 * 1000);
  // CRITICAL: unref() so the interval doesn't keep the process alive
  reaperInterval.unref();

  // ── Signal handlers ─────────────────────────────────────────
  const { handleSignal } = setupShutdown(
    mcpServer,
    pool,
    process.exit,
  );

  process.on("SIGTERM", () => {
    clearInterval(reaperInterval);
    void handleSignal("SIGTERM");
  });
  process.on("SIGINT", () => {
    clearInterval(reaperInterval);
    void handleSignal("SIGINT");
  });

  // ── Connect transport ───────────────────────────────────────
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log.info("qwen-agent-server ready on stdio");
}

// Only run main when executed directly (not when imported for testing).
const isMain = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  main().catch((err) => {
    log.error({ err }, "fatal startup error");
    process.exit(1);
  });
}
