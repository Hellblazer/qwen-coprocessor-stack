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
  | "awaiting_input"
  | "error";

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
 * `running`         — actively generating or executing tools
 * `awaiting_input`  — paused on canUseTool (write-tool permission OR
 *                     ask_user_question); supervisor needs qwen_send
 *                     to unblock
 * `complete`        — final SDK result received successfully
 * `error`           — backend failure or SDK-level error; check error field
 */
export type SessionState =
  | "running"
  | "awaiting_input"
  | "complete"
  | "error";

/**
 * Pending awaiting-input details. When a session is `awaiting_input`,
 * this carries the question(s) Qwen wants answered. For
 * `ask_user_question` calls there are typically multiple questions
 * with options; for write-tool denials there's a single tool-name
 * prompt.
 */
export interface AwaitingInput {
  /** The tool name that triggered the pause (e.g. "ask_user_question"). */
  tool_name: string;
  /** Captured tool_use_id; used to thread the answer back to the SDK. */
  tool_use_id: string;
  /** Structured questions, when applicable. */
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

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
 * Result of `qwen_poll`. Always includes state and the recent slice of
 * events; other fields appear conditionally per state.
 */
export interface PollResult {
  state: SessionState;
  recent_events: Event[];
  more_events_available: boolean;
  /** Cursor to pass back as opts.since on the next poll. */
  latest_event_id: string;
  awaiting_input?: AwaitingInput;
  result?: string;
  error?: { code: "backend_offline" | "backend_internal" | "timeout"; message: string };
  last_known?: LastKnown;
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
