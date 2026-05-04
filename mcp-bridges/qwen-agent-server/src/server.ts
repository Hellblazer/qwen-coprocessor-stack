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
//   qwen_send     — deliver an answer to awaiting_input
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
import { loadBackends, getCachedHealth, chooseBackend } from "./backends.js";
import { QwenSession } from "./session.js";
import {
  createPool,
  reapSweep,
  lruEvict,
  removeSession,
  type SessionPool,
  type PooledSession,
} from "./pool.js";
import { setupShutdown } from "./shutdown.js";

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
  /** Test-only: flip the shutting_down flag. */
  __setShuttingDown: (v: boolean) => void;
};

export function createToolHandlers(existingPool?: SessionPool): ToolHandlers {
  const pool = existingPool ?? createPool();
  const backends = loadBackends();
  let shuttingDown = false;

  // ── qwen_spawn ─────────────────────────────────────────────

  const qwen_spawn: ToolHandlers["qwen_spawn"] = async ({ task, opts = {} }) => {
    if (shuttingDown) {
      log.warn({ event_type: "spawn_rejected" }, "qwen_spawn rejected: server shutting down");
      return {
        error: { code: "shutting_down", message: "server is shutting down; cannot spawn new sessions" },
      };
    }

    const spawnOpts: SpawnOpts = {
      write_authority: opts.write_authority ?? false,
      allow_subagents: opts.allow_subagents ?? false,
      ...opts,
    };

    // Evict before adding — ensures we never exceed cap
    while (pool.sessions.size >= pool.maxSessions) {
      lruEvict(pool);
    }

    const backend = await chooseBackend(backends, spawnOpts, task);
    if (!backend) {
      log.warn({ event_type: "spawn_no_backend" }, "chooseBackend returned null — no candidates");
      throw new McpError(ErrorCode.InternalError, "no backend available to handle spawn");
    }

    const session = new QwenSession(backend, task, spawnOpts);
    const pooledSession: PooledSession = Object.assign(session, { last_polled_at: Date.now() });
    pool.sessions.set(session.task_id, pooledSession);

    log.info(
      {
        task_id: session.task_id,
        backend_id: backend.id,
        event_type: "spawn",
        state: "running",
      },
      "session spawned",
    );

    return { task_id: session.task_id, chosen_backend: backend.id };
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
    const results = await Promise.all(
      backends.map(async (b) => {
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

  return {
    qwen_spawn,
    qwen_poll,
    qwen_send,
    qwen_stop,
    qwen_backends,
    __setShuttingDown: (v: boolean) => { shuttingDown = v; },
  };
}

// ─────────────────────────────────────────────────────────────────
// MCP server wiring (production entrypoint)

async function main(): Promise<void> {
  log.info("qwen-agent-server starting");

  const pool = createPool();
  const handlers = createToolHandlers(pool);

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
      opts: z.object({
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
      }).optional(),
    },
    async (args) => {
      // Build opts stripping undefined fields (exactOptionalPropertyTypes)
      const rawOpts = args.opts;
      const spawnOpts: Partial<SpawnOpts> = {};
      if (rawOpts !== undefined) {
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
      }
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
    "Send a message/answer to a session awaiting_input.",
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
