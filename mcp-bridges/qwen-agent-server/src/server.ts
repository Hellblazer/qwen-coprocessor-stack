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

import { createLogger } from "./log.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type {
  BackendInfo,
  OneshotResult,
  PollOpts,
  PollResult,
  SessionInfo,
  SpawnOpts,
  SpawnResult,
} from "./types.js";
import {
  chooseBackendByModality,
  getCachedHealth,
  refreshPoolBackends,
} from "./backends.js";
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
import {
  dispatchVisionOneshot,
  type VisionImageInput,
  type VisionOneshotOpts,
  type VisionOneshotResult,
} from "./vision.js";
import {
  formatChatPrelude,
  formatTextPrelude,
  ThreadStore,
} from "./threads.js";
import { dispatchEmbed, type EmbedOpts, type EmbedResult } from "./embed.js";
import { dispatchRerank, type RerankOpts, type RerankResult } from "./rerank.js";
import {
  dispatchTokenize,
  type TokenizeOpts,
  type TokenizeResult,
} from "./tokenize.js";

/**
 * Progress emitter passed as second arg to long-running tool handlers.
 * Tool registrations construct one per call from the MCP request's
 * `_meta.progressToken` (when present); handlers call `emit(...)` at
 * meaningful checkpoints. No-op when the client didn't supply a token.
 *
 * Keeping this as a plain callback rather than threading the entire
 * MCP `extra` object into pure handler code keeps the createToolHandlers
 * surface testable without an MCP transport (tests inject a vi.fn()).
 */
export type ProgressEmitter = (event: {
  progress: number;
  total?: number;
  message?: string;
}) => void;

const NOOP_PROGRESS: ProgressEmitter = () => {};

const log = createLogger("qwen-agent-server");

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
  max_context_tokens: z.number().int().nonnegative().optional(),
  max_tool_calls: z.number().int().nonnegative().optional(),
  thinking_mode: z.boolean().optional(),
  json_schema: z.record(z.string(), z.unknown()).optional(),
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
  if (rawOpts.max_context_tokens !== undefined) spawnOpts.max_context_tokens = rawOpts.max_context_tokens;
  if (rawOpts.max_tool_calls !== undefined) spawnOpts.max_tool_calls = rawOpts.max_tool_calls;
  if (rawOpts.thinking_mode !== undefined) spawnOpts.thinking_mode = rawOpts.thinking_mode;
  if (rawOpts.json_schema !== undefined) spawnOpts.json_schema = rawOpts.json_schema;
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
   * Read-only listing of live sessions in the pool with their state,
   * last-polled timestamp, turns completed, and live budget counters.
   * Operator overview surface (also consumed by `/qwen-stack:status`).
   * RDR-002 v0.7 amendment.
   */
  qwen_sessions: (args: Record<string, never>) => Promise<SessionInfo[]>;
  /**
   * Stateless single-turn dispatch: spawn → wait until idle/complete →
   * optional JSON parse + retry → stop → return. Schema-aware where
   * `opts.json_schema` is supplied. Designed as the supervisor-side
   * shape that drop-in-replaces `claude -p --json-schema` for nexus
   * operator dispatch (RDR-002 v0.8 amendment).
   */
  qwen_oneshot: (
    args: {
      task: string;
      opts?: Partial<SpawnOpts> & {
        timeout_ms?: number;
        max_attempts?: number;
        continuation_id?: string;
      };
    },
    progress?: ProgressEmitter,
  ) => Promise<OneshotResult>;
  /**
   * Stateless multimodal dispatch: POST directly to a backend's
   * /v1/chat/completions with mixed text + image content, bypassing
   * the @qwen-code/sdk path (which has no ImageBlock and is text-only).
   *
   * Prerequisite: the chosen backend must be running llama-server with
   * `--mmproj <projector>.gguf`. Without it the backend returns an
   * "image input is not supported" error which the supervisor surfaces
   * as `error.code="backend_no_mmproj"`.
   *
   * Backend selection mirrors qwen_spawn's chooseBackend logic; pass
   * `opts.backend` to pin to a specific backend id.
   */
  qwen_oneshot_vision: (
    args: {
      task: string;
      images: VisionImageInput[];
      opts?: VisionOneshotOpts & { backend?: string; continuation_id?: string };
    },
    progress?: ProgressEmitter,
  ) => Promise<VisionOneshotResult>;
  /**
   * Stateless embeddings dispatch. POSTs to a backend's /v1/embeddings
   * (OpenAI-compat). Requires a backend declared with
   * `modality: 'embedding'` or pinned via `opts.backend`.
   */
  qwen_embed: (args: {
    texts: string[];
    opts?: EmbedOpts & { backend?: string };
  }) => Promise<EmbedResult>;
  /**
   * Stateless reranking dispatch. POSTs to a backend's /v1/rerank.
   * Requires a backend declared with `modality: 'rerank'` or pinned
   * via `opts.backend`.
   */
  qwen_rerank: (args: {
    query: string;
    documents: string[];
    opts?: RerankOpts & { backend?: string };
  }) => Promise<RerankResult>;
  /**
   * Exact token-count for any text/multimodal backend's loaded model.
   * Hits llama-server's /tokenize (NOT under /v1). Used for pre-flight
   * budget arithmetic and chunk sizing.
   */
  qwen_tokenize: (args: {
    content: string;
    opts?: TokenizeOpts & { backend?: string };
  }) => Promise<TokenizeResult>;
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
  threadStore?: ThreadStore,
): ToolHandlers {
  const pool = existingPool ?? createPool();
  // One thread store per handler set. In production main() one is wired
  // explicitly; tests omit the arg to get a default (no-reaper) instance.
  const threads = threadStore ?? new ThreadStore({ reap_interval_ms: 0 });
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

    // Note: budget defaults (env / config / backend.ctx_size /
    // hardcoded) are filled inside pool.spawnSession after the backend
    // is chosen, so the per-backend ctx_size tier can apply
    // (RDR-002 v0.7 amendment).

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
    // One pass over the live session map to count routed sessions
    // per backend — load visibility for operator dashboards. O(n)
    // in pool.sessions; cheap relative to the per-backend health
    // probes below.
    const sessionsByBackend = new Map<string, number>();
    for (const pooled of pool.sessions.values()) {
      const id = pooled.backend.id;
      sessionsByBackend.set(id, (sessionsByBackend.get(id) ?? 0) + 1);
    }
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
          active_sessions: sessionsByBackend.get(b.id) ?? 0,
          ...(b.modality !== undefined ? { modality: b.modality } : {}),
        };
        return info;
      }),
    );
    return results;
  };

  // ── qwen_sessions (live overview) ──────────────────────────

  const qwen_sessions: ToolHandlers["qwen_sessions"] = async () => {
    const out: SessionInfo[] = [];
    for (const [task_id, pooled] of pool.sessions) {
      const real = pooled as unknown as QwenSession;
      out.push({
        task_id,
        backend_id: pooled.backend.id,
        state: real.state,
        last_polled_at: pooled.last_polled_at,
        turns_completed: real.turns_completed,
        budget: real.budgetStats(),
      });
    }
    return out;
  };

  // ── qwen_oneshot (stateless dispatch, RDR-002 v0.8 amendment) ──
  //
  // Single-turn wrapper around spawn + poll-until-done + optional
  // JSON.parse + stop. The schema-aware return shape exists to drop
  // into nexus operator dispatch as a Qwen alternative to `claude -p
  // --json-schema`. The supervisor itself does not run a full Ajv
  // validator; callers either rely on Qwen3.6's instruction-following
  // (system-prompt directive in session.ts) or post-validate.
  // Validation-failure retry is bounded by `max_attempts` so a model
  // that consistently emits prose doesn't burn budget infinitely.

  const ONESHOT_POLL_INTERVAL_MS = 250;

  const qwen_oneshot: ToolHandlers["qwen_oneshot"] = async (
    { task, opts },
    progress = NOOP_PROGRESS,
  ) => {
    const oneshot_start = Date.now();
    const timeout_ms = opts?.timeout_ms ?? 300_000;
    const max_attempts = Math.max(1, opts?.max_attempts ?? 1);
    // Strip the oneshot-specific fields before forwarding to qwen_spawn.
    const spawnOpts: Partial<SpawnOpts> = { ...opts };
    delete (spawnOpts as Record<string, unknown>)["timeout_ms"];
    delete (spawnOpts as Record<string, unknown>)["max_attempts"];
    delete (spawnOpts as Record<string, unknown>)["continuation_id"];

    // Thread resolution. If continuation_id is supplied, fetch prior
    // turns and prepend as a text prelude to the task. Always allocate
    // a thread id (new or existing) so the caller can chain on success.
    const thread = threads.resolve(opts?.continuation_id);
    const prelude = formatTextPrelude(thread.turns);
    const effective_task = prelude.length > 0 ? `${prelude}${task}` : task;
    const continuation_id = thread.id;

    let attempts = 0;
    let last_task_id = "";
    let last_state: import("./types.js").SessionState = "error";
    let last_result: string | undefined;
    let last_budget: import("./types.js").SessionBudgetStats | undefined;
    let last_error: OneshotResult["error"];

    while (attempts < max_attempts) {
      attempts++;
      progress({
        progress: attempts - 1,
        total: max_attempts,
        message: `attempt ${attempts}/${max_attempts}: spawning`,
      });

      const spawn = await qwen_spawn({ task: effective_task, opts: spawnOpts });
      if ("error" in spawn) {
        last_error = { code: "session_error", message: spawn.error.message };
        break;
      }
      last_task_id = spawn.task_id;

      // Per-attempt timeout origin. NOT to be confused with
      // `oneshot_start` (function-scope, total wall-clock for elapsed_ms).
      const attempt_start = Date.now();
      // Poll until idle/complete/error/timeout.
      let polled: PollResult;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        polled = await qwen_poll({ task_id: last_task_id, opts: {} }) as PollResult;
        last_state = polled.state;
        last_budget = polled.budget;

        if (polled.state === "idle" || polled.state === "complete") {
          last_result = polled.last_message;
          break;
        }
        if (polled.state === "error") {
          last_error = {
            code: "session_error",
            message: polled.error?.message ?? "session aborted without message",
          };
          break;
        }
        if (Date.now() - attempt_start > timeout_ms) {
          last_error = {
            code: "timeout",
            message: `oneshot timed out after ${timeout_ms}ms (state=${polled.state})`,
          };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, ONESHOT_POLL_INTERVAL_MS));
      }

      // Always stop the session — oneshot is stateless by contract.
      await qwen_stop({ task_id: last_task_id });

      if (last_error?.code === "session_error" || last_error?.code === "timeout") {
        // Don't retry on session errors / timeouts; those are real failures
        // and retrying is expensive.
        break;
      }

      // Idle/complete reached. If schema requested, try to parse.
      if (last_result === undefined || last_result === "") {
        last_error = { code: "no_result", message: "session ended with no assistant message" };
        break; // retrying won't help if model produced nothing
      }
      // Qwen CLI passes upstream HTTP failures through to stdout as
      // "[API Error: ...]" / "[Stream Error: ...]" / "[Tool Error: ...]"
      // and exits 0. Without detecting these we'd report ok:true with an
      // error string as the answer. Don't retry — upstream failures
      // (auth, model not loaded, server-side config) won't self-heal in
      // the next 30 s and retrying burns tokens.
      const upstream = matchUpstreamCliError(last_result);
      if (upstream !== undefined) {
        last_error = { code: "upstream_api_error", message: upstream };
        break;
      }
      if (spawnOpts.json_schema === undefined) {
        // No schema requested → success on first reach.
        threads.append(continuation_id, { role: "user", content: task });
        threads.append(continuation_id, { role: "assistant", content: last_result });
        return {
          ok: true,
          task_id: last_task_id,
          attempts,
          state: last_state,
          result: last_result,
          ...(last_budget !== undefined ? { budget: last_budget } : {}),
          elapsed_ms: Date.now() - oneshot_start,
          continuation_id,
        };
      }
      // Defensive: Qwen3.6 frequently wraps schema-conforming JSON in
      // markdown code fences (```json ... ```) despite the system-prompt
      // directive. Strip them before JSON.parse — the content is right;
      // it's just wearing a jacket. Observed in v0.8.0 bench (5/5 cases).
      const stripped = stripCodeFences(last_result);
      try {
        const parsed = JSON.parse(stripped);
        threads.append(continuation_id, { role: "user", content: task });
        threads.append(continuation_id, { role: "assistant", content: last_result });
        return {
          ok: true,
          task_id: last_task_id,
          attempts,
          state: last_state,
          result: last_result,
          parsed,
          ...(last_budget !== undefined ? { budget: last_budget } : {}),
          elapsed_ms: Date.now() - oneshot_start,
          continuation_id,
        };
      } catch (err) {
        last_error = {
          code: "validation_failed",
          message: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
        };
        // fall through to retry (if attempts remain)
      }
    }

    // Exhausted attempts or hit a terminal error. We do NOT append
    // failed turns to the thread — there's no useful "assistant" turn
    // to carry forward — but we still emit the continuation_id so the
    // caller can chain another attempt or recover the thread.
    return {
      ok: false,
      task_id: last_task_id,
      attempts,
      state: last_state,
      ...(last_result !== undefined ? { result: last_result } : {}),
      ...(last_error !== undefined ? { error: last_error } : {}),
      ...(last_budget !== undefined ? { budget: last_budget } : {}),
      elapsed_ms: Date.now() - oneshot_start,
      continuation_id,
    };
  };

  // ── qwen_oneshot_vision (multimodal direct-HTTP dispatch) ──
  //
  // Bypasses the SDK / Qwen CLI subprocess entirely. POSTs OpenAI-compat
  // multimodal content arrays directly to a backend's /v1/chat/completions.
  // The chosen backend must be running llama-server with --mmproj loaded
  // or the call fails with backend_no_mmproj.

  const qwen_oneshot_vision: ToolHandlers["qwen_oneshot_vision"] = async (
    { task, images, opts },
    progress = NOOP_PROGRESS,
  ) => {
    if (shuttingDown) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: { code: "backend_error", message: "supervisor shutting down" },
      };
    }
    if (!Array.isArray(images) || images.length === 0) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: {
          code: "backend_error",
          message: "qwen_oneshot_vision requires at least one image",
        },
      };
    }

    // Vision requires a backend whose loaded model can accept image
    // inputs (llama-server with --mmproj). Route by modality directly
    // rather than through chooseBackend (which targets text chat).
    // See bead qwen-coprocessor-stack-w63.
    const backend = await chooseBackendByModality(
      pool.backends,
      "multimodal",
      opts?.backend,
    );
    if (!backend) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: {
          code: "backend_error",
          message: opts?.backend
            ? `no backend matches pin "${opts.backend}"`
            : "no multimodal backends configured (need modality:'multimodal')",
        },
      };
    }

    const dispatchOpts: VisionOneshotOpts = { ...opts };
    delete (dispatchOpts as { backend?: unknown }).backend;
    delete (dispatchOpts as { continuation_id?: unknown }).continuation_id;

    // Thread resolution. continuation_id is optional; either way we
    // allocate one and return it on success.
    const thread = threads.resolve(opts?.continuation_id);
    const prior_messages = formatChatPrelude(thread.turns);
    const continuation_id = thread.id;

    progress({ progress: 0, total: 1, message: `dispatching to ${backend.id}` });
    const result = await dispatchVisionOneshot(
      backend,
      task,
      images,
      dispatchOpts,
      prior_messages,
    );
    progress({
      progress: 1,
      total: 1,
      message: result.ok ? "done" : `error: ${result.error?.code}`,
    });

    if (result.ok && typeof result.result === "string") {
      threads.append(continuation_id, {
        role: "user",
        content: task,
        had_images: true,
      });
      threads.append(continuation_id, {
        role: "assistant",
        content: result.result,
      });
    }
    return { ...result, continuation_id };
  };

  // ── qwen_embed / qwen_rerank / qwen_tokenize ────────────────
  //
  // All three bypass the SDK and POST directly to llama-server
  // endpoints. Embed and rerank require backends declared with the
  // corresponding modality; tokenize accepts any text/multimodal
  // backend (the tokenizer is colocated with the loaded model).

  const qwen_embed: ToolHandlers["qwen_embed"] = async ({ texts, opts }) => {
    const elapsed_start = Date.now();
    if (!Array.isArray(texts) || texts.length === 0) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: { code: "backend_error", message: "texts must be a non-empty array" },
      };
    }
    refreshPoolBackends(pool);
    const backend = await chooseBackendByModality(
      pool.backends,
      "embedding",
      opts?.backend,
    );
    if (!backend) {
      return {
        ok: false,
        elapsed_ms: Date.now() - elapsed_start,
        backend_id: "",
        error: {
          code: "backend_error",
          message: opts?.backend
            ? `no backend matches pin "${opts.backend}"`
            : "no backend declared with modality='embedding'",
        },
      };
    }
    if (opts?.backend !== undefined && (backend.modality ?? "text") !== "embedding") {
      return {
        ok: false,
        elapsed_ms: Date.now() - elapsed_start,
        backend_id: backend.id,
        error: {
          code: "wrong_modality",
          message: `backend "${backend.id}" has modality=${backend.modality ?? "text"}, not 'embedding'`,
        },
      };
    }
    const dispatchOpts: EmbedOpts = { ...opts };
    delete (dispatchOpts as { backend?: unknown }).backend;
    return dispatchEmbed(backend, texts, dispatchOpts);
  };

  const qwen_rerank: ToolHandlers["qwen_rerank"] = async ({
    query,
    documents,
    opts,
  }) => {
    const elapsed_start = Date.now();
    if (typeof query !== "string" || query.length === 0) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: { code: "backend_error", message: "query must be a non-empty string" },
      };
    }
    if (!Array.isArray(documents) || documents.length === 0) {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: {
          code: "backend_error",
          message: "documents must be a non-empty array",
        },
      };
    }
    refreshPoolBackends(pool);
    const backend = await chooseBackendByModality(
      pool.backends,
      "rerank",
      opts?.backend,
    );
    if (!backend) {
      return {
        ok: false,
        elapsed_ms: Date.now() - elapsed_start,
        backend_id: "",
        error: {
          code: "backend_error",
          message: opts?.backend
            ? `no backend matches pin "${opts.backend}"`
            : "no backend declared with modality='rerank'",
        },
      };
    }
    if (opts?.backend !== undefined && (backend.modality ?? "text") !== "rerank") {
      return {
        ok: false,
        elapsed_ms: Date.now() - elapsed_start,
        backend_id: backend.id,
        error: {
          code: "wrong_modality",
          message: `backend "${backend.id}" has modality=${backend.modality ?? "text"}, not 'rerank'`,
        },
      };
    }
    const dispatchOpts: RerankOpts = { ...opts };
    delete (dispatchOpts as { backend?: unknown }).backend;
    return dispatchRerank(backend, query, documents, dispatchOpts);
  };

  const qwen_tokenize: ToolHandlers["qwen_tokenize"] = async ({ content, opts }) => {
    const elapsed_start = Date.now();
    if (typeof content !== "string") {
      return {
        ok: false,
        elapsed_ms: 0,
        backend_id: "",
        error: { code: "backend_error", message: "content must be a string" },
      };
    }
    refreshPoolBackends(pool);
    // Tokenize accepts any text/multimodal backend. Honour pin; otherwise
    // try 'text', then 'multimodal'. We do NOT route to embedding /
    // rerank backends — their tokenizer endpoint may be disabled
    // depending on llama-server build flags.
    let backend: import("./types.js").Backend | null = null;
    if (opts?.backend !== undefined) {
      backend = pool.backends.find((b) => b.id === opts.backend) ?? null;
    } else {
      backend =
        (await chooseBackendByModality(pool.backends, "text")) ??
        (await chooseBackendByModality(pool.backends, "multimodal"));
    }
    if (!backend) {
      return {
        ok: false,
        elapsed_ms: Date.now() - elapsed_start,
        backend_id: "",
        error: {
          code: "backend_error",
          message: opts?.backend
            ? `no backend matches pin "${opts.backend}"`
            : "no healthy text/multimodal backend available",
        },
      };
    }
    const dispatchOpts: TokenizeOpts = { ...opts };
    delete (dispatchOpts as { backend?: unknown }).backend;
    return dispatchTokenize(backend, content, dispatchOpts);
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
    qwen_sessions,
    qwen_oneshot,
    qwen_oneshot_vision,
    qwen_embed,
    qwen_rerank,
    qwen_tokenize,
    qwen_extensions,
    ...(qwen_reload_extensions !== undefined ? { qwen_reload_extensions } : {}),
    __setShuttingDown: (v: boolean) => { shuttingDown = v; },
  };
}

// ─────────────────────────────────────────────────────────────────
// MCP server wiring (production entrypoint)

/**
 * Build a ProgressEmitter bound to the current MCP request. When the
 * client supplied a `_meta.progressToken`, emitted events are forwarded
 * as `notifications/progress`. When no token is present (the common
 * case for non-streaming clients), every call is a no-op.
 *
 * The MCP SDK's `extra.sendNotification` is shaped to accept the
 * `notifications/progress` schema; we widen `extra` to `unknown` and
 * narrow inside to keep this helper agnostic of the SDK's exact
 * RequestHandlerExtra type (which changes across minor versions).
 */
function makeProgressEmitter(extra: unknown): ProgressEmitter {
  const x = extra as {
    _meta?: { progressToken?: string | number };
    sendNotification?: (n: unknown) => Promise<void> | void;
  } | undefined;
  const token = x?._meta?.progressToken;
  if (token === undefined || typeof x?.sendNotification !== "function") {
    return NOOP_PROGRESS;
  }
  const send = x.sendNotification.bind(x);
  return ({ progress, total, message }) => {
    try {
      void send({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      });
    } catch {
      // Progress notifications are best-effort; never let an emission
      // failure abort the underlying tool call.
    }
  };
}

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

  mcpServer.tool(
    "qwen_sessions",
    "List live sessions in the pool with state, last-polled timestamp, turns completed, and live budget counters. Read-only operator overview.",
    {},
    async (_args) => {
      const result = await handlers.qwen_sessions({});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_oneshot",
    "Stateless single-turn dispatch: spawn → wait until idle → optional JSON parse + retry → stop → return. Schema-aware where opts.json_schema is supplied. Drop-in shape for nexus operator dispatch as a Qwen alternative to `claude -p --json-schema`.",
    {
      task: z.string().describe("Prompt for the inner Qwen"),
      opts: qwenSpawnOptsSchema.unwrap().extend({
        timeout_ms: z.number().int().positive().optional().describe("Per-attempt hard limit in ms; default 300000. Note: with max_attempts > 1 the returned OneshotResult.elapsed_ms (total wall-clock across all attempts) can exceed this; do not use elapsed_ms > timeout_ms as a timeout signal."),
        max_attempts: z.number().int().positive().optional().describe("Retry on JSON-parse failure; default 1"),
        continuation_id: z.string().optional().describe("Thread id returned by a prior call's OneshotResult.continuation_id; the supervisor prepends prior turns to this task. Omit for a fresh thread. Threads live in-process only (3h TTL, 20-turn cap, no cross-process persistence). The returned continuation_id is always present so callers can chain — even on failure."),
      }).optional(),
    },
    async (args, extra) => {
      const baseOpts = buildSpawnOptsFromRaw(args.opts);
      const oneshotOpts: Partial<SpawnOpts> & { timeout_ms?: number; max_attempts?: number; continuation_id?: string } = { ...baseOpts };
      if (args.opts?.timeout_ms !== undefined) oneshotOpts.timeout_ms = args.opts.timeout_ms;
      if (args.opts?.max_attempts !== undefined) oneshotOpts.max_attempts = args.opts.max_attempts;
      if (args.opts?.continuation_id !== undefined) oneshotOpts.continuation_id = args.opts.continuation_id;
      const progress = makeProgressEmitter(extra);
      const result = await handlers.qwen_oneshot(
        { task: args.task, opts: oneshotOpts },
        progress,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ── qwen_oneshot_vision MCP wire ──
  //
  // Direct-HTTP multimodal dispatch; bypasses the SDK because the SDK's
  // ContentBlock union has no ImageBlock. Backend must be running with
  // --mmproj loaded (see scripts/start-stack.sh and
  // scripts/launch-llama-vulkan.cmd in this repo for the launch shape).
  const visionImageInputSchema = z.union([
    z.object({
      path: z.string().describe("Filesystem path readable by the supervisor process."),
      mime: z.string().optional().describe("MIME type override; inferred from extension if omitted."),
    }),
    z.object({
      url: z.string().describe("http(s):// or data: URL passed through verbatim."),
    }),
    z.object({
      base64: z.string().describe("Raw base64-encoded image bytes (no data: prefix)."),
      mime: z.string().describe("MIME type, e.g. image/png, image/jpeg, image/webp."),
    }),
  ]);

  mcpServer.tool(
    "qwen_oneshot_vision",
    "Stateless multimodal dispatch: image(s) + text → JSON-or-text response. Bypasses the SDK (which is text-only) and POSTs OpenAI-compat content arrays directly to a backend's /v1/chat/completions. The chosen backend must be running llama-server with --mmproj loaded; otherwise the call fails with error.code='backend_no_mmproj'.",
    {
      task: z.string().describe("Text prompt accompanying the image(s)."),
      images: z.array(visionImageInputSchema).min(1).describe("One or more images. Discriminated union of {path}, {url}, or {base64,mime}."),
      opts: z.object({
        json_schema: z.record(z.string(), z.unknown()).optional().describe("JSON Schema constraint; emitted as response_format.json_schema."),
        timeout_ms: z.number().int().positive().optional().describe("Per-request timeout in ms; default 300000."),
        max_tokens: z.number().int().positive().optional().describe("Max tokens to generate; default 2048."),
        temperature: z.number().min(0).max(2).optional().describe("Sampling temperature; default 0.3."),
        system: z.string().optional().describe("Optional system-role prefix."),
        no_think: z.boolean().optional().describe("Prepend /no_think to suppress Qwen thinking-mode reasoning; default true."),
        grammar: z.string().optional().describe("GBNF grammar string for token-by-token output enforcement (llama-server `grammar` field). Strictly stronger than json_schema (which is post-hoc validated). Use for non-JSON constrained output or when json_schema validation has been observed to fail. Vision-only — qwen_oneshot's SDK path cannot accept GBNF; this is an architectural constraint, not a gap."),
        backend: z.string().optional().describe("Pin to a specific backend by id; defaults to chooseBackend selection."),
        continuation_id: z.string().optional().describe("Thread id from a prior qwen_oneshot or qwen_oneshot_vision call. Prior turns are injected as messages[] entries before the current user turn; images from prior turns are NOT carried forward in v1 (a `[image attached]` placeholder is emitted). Same thread store as qwen_oneshot — cross-tool threading works."),
      }).optional(),
    },
    async (args, extra) => {
      const progress = makeProgressEmitter(extra);
      const result = await handlers.qwen_oneshot_vision(
        {
          task: args.task,
          images: args.images as VisionImageInput[],
          ...(args.opts !== undefined ? { opts: args.opts as VisionOneshotOpts & { backend?: string; continuation_id?: string } } : {}),
        },
        progress,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ── qwen_embed / qwen_rerank / qwen_tokenize MCP wires ──
  //
  // Surface llama-server's /v1/embeddings, /v1/rerank, /tokenize as
  // first-class MCP tools. Each bypasses the SDK because the SDK is
  // text-chat only. Backend selection is modality-based — operator
  // declares which loaded model serves which role.

  mcpServer.tool(
    "qwen_embed",
    "Generate embeddings for one or many text inputs via /v1/embeddings. Routes to a backend declared with modality='embedding' (e.g. bge-m3, qwen3-embedding-0.6b). Order of returned embeddings matches the input order.",
    {
      texts: z.array(z.string()).min(1).describe("One or more text inputs to embed."),
      opts: z.object({
        timeout_ms: z.number().int().positive().optional().describe("Per-request timeout in ms; default 60000."),
        encoding_format: z.enum(["float", "base64"]).optional().describe("'float' (default) returns number[]; 'base64' is a llama-server passthrough."),
        backend: z.string().optional().describe("Pin to a specific backend by id; bypasses modality routing."),
      }).optional(),
    },
    async (args) => {
      const result = await handlers.qwen_embed({
        texts: args.texts,
        ...(args.opts !== undefined ? { opts: args.opts as EmbedOpts & { backend?: string } } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_rerank",
    "Rerank documents by relevance to a query via /v1/rerank. Routes to a backend declared with modality='rerank' (e.g. qwen3-reranker, bge-reranker). Results are sorted by relevance_score descending; the original input index is preserved on each result.",
    {
      query: z.string().describe("Query against which documents will be scored."),
      documents: z.array(z.string()).min(1).describe("Documents to rerank."),
      opts: z.object({
        timeout_ms: z.number().int().positive().optional().describe("Per-request timeout in ms; default 60000."),
        top_n: z.number().int().positive().optional().describe("Return only the top-N results server-side."),
        return_documents: z.boolean().optional().describe("If true, include each document's text in its result entry; default false."),
        backend: z.string().optional().describe("Pin to a specific backend by id."),
      }).optional(),
    },
    async (args) => {
      const result = await handlers.qwen_rerank({
        query: args.query,
        documents: args.documents,
        ...(args.opts !== undefined ? { opts: args.opts as RerankOpts & { backend?: string } } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  mcpServer.tool(
    "qwen_tokenize",
    "Return exact token IDs and count for `content` against a backend's loaded model. Hits llama-server's /tokenize endpoint (sits outside /v1). Used for pre-flight budget arithmetic and chunk sizing. Routes to any healthy text/multimodal backend (embedding/rerank backends are excluded).",
    {
      content: z.string().describe("Text to tokenize."),
      opts: z.object({
        timeout_ms: z.number().int().positive().optional().describe("Per-request timeout in ms; default 30000."),
        add_special: z.boolean().optional().describe("Include the model's special tokens (BOS etc) in the output; default false."),
        with_pieces: z.boolean().optional().describe("Also return token pieces (string form) under result.pieces; default false."),
        backend: z.string().optional().describe("Pin to a specific backend by id."),
      }).optional(),
    },
    async (args) => {
      const result = await handlers.qwen_tokenize({
        content: args.content,
        ...(args.opts !== undefined ? { opts: args.opts as TokenizeOpts & { backend?: string } } : {}),
      });
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

/**
 * Strip surrounding markdown code fences from a candidate JSON string.
 * Qwen3.6 frequently wraps schema-conforming output in ```json ... ```
 * (or plain ```) despite system-prompt directives forbidding it. The
 * content is right; defending against the jacket is cheaper than
 * fighting the model. Returns the input unchanged if no fences are
 * detected — `JSON.parse` then runs on the original.
 *
 * Recognises:
 *   - ```json\n{...}\n```
 *   - ```\n{...}\n```
 *   - leading/trailing whitespace around the fence
 *   - a single trailing newline before the closing fence
 *
 * Does NOT attempt heroics: if the input has prose before/after the
 * fences, or multiple fenced blocks, or unbalanced fences, returns
 * the original. The retry loop in qwen_oneshot is the safety net.
 */
// The Qwen CLI surfaces upstream HTTP / streaming / tool failures by
// writing a bracketed sentinel to stdout and exiting 0. Without
// recognising the shape, the supervisor would forward the error string
// as the assistant's answer with ok:true. Match an exact-prefix sentinel
// at the start of the trimmed message; if a model legitimately wraps
// its own answer in a `[API Error: ...]` quote it won't be at the head
// of the message.
const UPSTREAM_CLI_ERROR_PREFIXES = ["[API Error:", "[Stream Error:", "[Tool Error:"] as const;
export function matchUpstreamCliError(raw: string): string | undefined {
  const trimmed = raw.trimStart();
  for (const prefix of UPSTREAM_CLI_ERROR_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      const end = trimmed.indexOf("]");
      const inner = end > prefix.length ? trimmed.slice(prefix.length, end).trim() : trimmed;
      return `${prefix.slice(1, -1)}: ${inner}`.trim();
    }
  }
  return undefined;
}

export function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  // Match: optional language tag, body, closing fence. Anchored at
  // both ends to refuse mid-prose stripping.
  const m = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (m && m[1] !== undefined) return m[1].trim();
  return raw;
}

// Only run main when executed directly (not when imported for testing).
const isMain = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (isMain) {
  main().catch((err) => {
    log.error({ err }, "fatal startup error");
    process.exit(1);
  });
}
