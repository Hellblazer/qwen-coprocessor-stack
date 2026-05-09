// SPDX-License-Identifier: MIT
//
// Shared type surface for the qwen-agent-server supervisor.
// See docs/rdr/RDR-001 for rationale; types here are the implementation
// contract. Changes here ripple through session.ts / backends.ts /
// permissions.ts / server.ts.

/**
 * One Qwen inference backend the supervisor can route to.
 *
 * `id` is the stable handle used in session affinity and `qwen_backends`
 * discovery. `tier` and `capacity` are routing labels; the heuristic in
 * `backends.ts` filters by these. `weight` biases round-robin selection
 * among equally-eligible candidates (omit = 1).
 */
export interface Backend {
  id: string;
  url: string;
  model: string;
  tier: "local" | "remote";
  capacity: "fast" | "heavy";
  weight?: number;
}

/**
 * Caller-supplied context for a fresh session that's resuming a
 * conversation that started elsewhere — typically a re-spawn after the
 * prior session's backend died (see RDR §S2 backend failure recovery).
 *
 * Lossy for prior tool calls (which can't be replayed against a new
 * backend), faithful for text content.
 */
export interface PriorContext {
  conversation_summary: string;
  last_user_message?: string;
  /** Originating session_id, if available, for traceability. */
  prior_session_id?: string;
}

/**
 * Options accepted by `qwen_spawn`. All fields optional; defaults
 * documented per-field.
 */
export interface SpawnOpts {
  /** Pin to a specific backend.id; bypasses the heuristic router. */
  backend?: string;
  /** Narrow the candidate pool to one tier. */
  tier?: Backend["tier"];
  /** Override the heuristic capacity classification. */
  capacity?: Backend["capacity"];
  /**
   * Grant the inner Qwen mutating-tool authority. Defaults to false:
   * permissionMode='default' with a denying canUseTool callback, so
   * writes return visible permission_denied events instead of running.
   * true → permissionMode='yolo' (full automation).
   */
  write_authority?: boolean;
  /**
   * Allow the inner Qwen to spawn its own sub-agents via the `agent`
   * tool. Defaults to false; supervisor IS the orchestration layer and
   * recursive nesting is invisible to it.
   */
  allow_subagents?: boolean;
  /** Resume context from a prior failed/evicted session. */
  prior_context?: PriorContext;
  /** Override or augment the inner Qwen's system prompt. */
  system?: string;
  /**
   * Per-spawn Qwen Code extension loadout (RDR-002 §Decision Layer 2).
   *
   * Resolution semantics: if `only` is set, that is the active set for
   * this spawn (other fields ignored). Otherwise the supervisor starts
   * from the session-default set (`QWEN_DEFAULT_EXTENSIONS` env var,
   * else CLI-default of all enabled per `extension-enablement.json`),
   * applies `enable` additively, then `disable` subtractively.
   *
   * Names match `config.name` from each extension's
   * `qwen-extension.json`, case-insensitive.
   *
   * Bridges to the CLI via the `QWEN_AGENT_EXTENSIONS` env var read by
   * the wrapper script set as `QueryOptions.pathToQwenExecutable`. The
   * SDK does not expose `extensions` in `QueryOptions` directly.
   */
  extensions?: {
    enable?: string[];
    disable?: string[];
    only?: string[];
  };
  /**
   * Hard cap on accumulated tool_result token estimate (chars / 4). When
   * exceeded the session terminates with state="error" and
   * error.code="context_exceeded" instead of crashing at the HTTP layer.
   *
   * Wiring layer default (server.ts/config): 0.85 * ctx_size; with the
   * operator's qwentescence ctx_size=131072 that is 111000. Pass 0 here
   * to disable; QwenSession itself treats undefined or 0 as "no cap".
   *
   * RDR-002 §Session budget (2026-05-09 amendment).
   */
  max_context_tokens?: number;
  /**
   * Hard cap on tool_call count per session. Pass 0 (the default) for
   * unlimited. Same abort contract as max_context_tokens.
   */
  max_tool_calls?: number;
}

/**
 * Options for `qwen_poll`. Cursor-based pagination keeps payloads small.
 */
export interface PollOpts {
  /** Event id cursor; only events with id > since are returned. */
  since?: string;
  /** Cap on events per call. Default 16. */
  max_events?: number;
}

/**
 * Categorical event types emitted into a session's log. The supervisor
 * never surfaces raw SDK messages — they're translated into one of
 * these. Keeps poll payloads predictable and small.
 */
export type EventType =
  | "tool_call"
  | "tool_result"
  | "permission_denied"
  | "model_message_summary"
  | "turn_complete"
  | "error"
  | "extensions_loaded"
  /**
   * Budget-pressure warning emitted at 50% / 75% / 90% of
   * max_context_tokens. Fires at most once per threshold per session.
   * data shape: { level: "warn"|"high"|"critical", est_tokens, max_tokens,
   * tool_calls, max_tool_calls }. RDR-002 §Session budget.
   */
  | "context_pressure";

/**
 * One event in a session's event log. `summary` is a one-sentence
 * human-readable hint; `data` carries the full structured payload for
 * the few callers that want it (most won't).
 */
export interface Event {
  id: string;
  type: EventType;
  ts: number;
  summary: string;
  data?: unknown;
}

/**
 * State machine values for a session.
 *
 * `running`   — SDK is actively generating or executing tools
 * `idle`      — current turn complete; supervisor is waiting for the
 *               caller to push the next user message via `qwen_send`,
 *               or to terminate via `qwen_stop`. The model's last
 *               assistant text is available in PollResult.last_message.
 * `complete`  — caller has stopped the session, or the SDK closed its
 *               iterator without expectation of further input
 * `error`     — backend failure or SDK-level error; check error field
 *
 * Empirical note (RDR-001 §Q1, post-2026-05-04 spike): the original
 * design used an `awaiting_input` state triggered by `canUseTool` when
 * Qwen called `ask_user_question`. That model fails because:
 *  (a) `canUseTool` deny closes the tool's lifecycle so a follow-up
 *      tool_result is treated as orphaned by the model;
 *  (b) `canUseTool` deny-with-message is interpreted by the model as
 *      "user cancelled with reason X", not "user answered X".
 * The supervisor now excludes `ask_user_question` from the inner
 * Qwen's tool surface and relies on plain multi-turn streamInput for
 * answer delivery. The state machine flattens to running/idle/etc.
 */
export type SessionState =
  | "running"
  | "idle"
  | "complete"
  | "error";

/**
 * Snapshot of session state surfaced when a session ends in `error`.
 * Caller uses this as `qwen_spawn(opts.prior_context)` to re-spawn
 * with continuity.
 */
export interface LastKnown {
  turns_completed: number;
  last_user_message?: string;
  last_assistant_summary?: string;
}

/**
 * Live budget counters surfaced on every `qwen_poll` (RDR-002 §Session
 * budget, 2026-05-09 v0.6 amendment).
 *
 * The v0.4 amendment deferred a `qwen_session_stats` MCP tool with the
 * rationale "pollers can already infer from emitted events." The v0.5
 * smoke test (commit aa0546c) showed why that rationale is wrong in
 * practice: a single oversized tool_result (one /etc/passwd read,
 * 9.6 KB → 2400 est tokens) blew past 50 / 75 / 90 % of a tight cap in
 * a single iteration, firing all three `context_pressure` events on
 * the same timestamp with the abort right behind them. Discrete
 * thresholds give pollers no early-warning window when the input is
 * one big payload.
 *
 * Folding the live counters into every poll lets the orchestrator
 * make per-poll decisions ("est_tokens passed 30K, finish the current
 * sub-task and re-spawn with prior_context") independently of whether
 * a discrete pressure event has fired yet.
 *
 * Both cap fields are zero-disabled (matching `SpawnOpts`):
 * `max_tokens=0` means the token cap is disabled; `max_tool_calls=0`
 * means unlimited. Pollers should treat zero as "no cap" rather than
 * "100 % full."
 */
export interface SessionBudgetStats {
  /** Accumulated tool_result chars / 4 estimate. */
  est_tokens: number;
  /** The session's max_context_tokens at construction; 0 = disabled. */
  max_tokens: number;
  /** Tool-call count observed so far. */
  tool_calls: number;
  /** The session's max_tool_calls at construction; 0 = unlimited. */
  max_tool_calls: number;
}

/**
 * Result of `qwen_poll`. Always includes state and the recent slice of
 * events; other fields appear conditionally per state.
 */
export interface PollResult {
  state: SessionState;
  recent_events: Event[];
  more_events_available: boolean;
  /** Cursor to pass back as opts.since on the next poll. */
  latest_event_id: string;
  /** Model's last assistant text. Present in `idle` and `complete` states. */
  last_message?: string;
  /** Final result text when state is `complete`. */
  result?: string;
  error?: {
    code: "backend_offline" | "backend_internal" | "timeout" | "context_exceeded";
    message: string;
  };
  last_known?: LastKnown;
  /**
   * Live budget counters. Always present for sessions constructed with
   * the v0.6+ supervisor; optional in the type for back-compat with
   * destructuring callers and prior PollResult consumers.
   */
  budget?: SessionBudgetStats;
}

/**
 * Result of `qwen_spawn`. The supervisor returns immediately; actual
 * inference happens in the SDK loop running async.
 */
export interface SpawnResult {
  task_id: string;
  chosen_backend: string;
}

/**
 * Discovery result for `qwen_backends`. `healthy` is null when the
 * health cache hasn't been populated yet for that backend.
 */
export interface BackendInfo {
  id: string;
  url: string;
  model: string;
  tier: Backend["tier"];
  capacity: Backend["capacity"];
  healthy: boolean | null;
}
