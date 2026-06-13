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
  /**
   * Operator-declared context window of the underlying llama-server, in
   * tokens (matches `--ctx-size` on the launch command). When set and
   * no per-spawn / env / config tier resolves `max_context_tokens`,
   * the supervisor uses `floor(0.85 * ctx_size)` as the default cap
   * for spawns that route to this backend (RDR-002 v0.7 amendment).
   *
   * Optional. When unset, the resolution chain falls through to the
   * hardcoded 111000 default. The supervisor does not probe — operator
   * declares.
   */
  ctx_size?: number;
  /**
   * Operator-declared modality of the loaded model on this backend.
   *
   * - `'text'` (default when unset) — text completion via /v1/chat/completions.
   * - `'multimodal'` — text + vision; backend is running llama-server
   *   with `--mmproj` and accepts image content arrays.
   * - `'embedding'` — backend loads an embedding model (e.g. bge-m3,
   *   qwen3-embedding-0.6b) and serves /v1/embeddings. Selected by
   *   `qwen_embed`.
   * - `'rerank'` — backend loads a reranker model (e.g. qwen3-reranker,
   *   bge-reranker) and serves /v1/rerank. Selected by `qwen_rerank`.
   *
   * Vision callers should pin via `opts.backend`. Embed/rerank callers
   * are auto-routed to the first healthy backend with matching modality.
   * The tokenizer is colocated with any loaded model — `qwen_tokenize`
   * accepts any text/multimodal backend.
   */
  modality?: "text" | "multimodal" | "embedding" | "rerank";
  /**
   * Operator-declared role labels for EXPLICIT routing (bead k8j). Free-form
   * strings (e.g. "code", "general", "reasoning"); a backend may advertise
   * several. Callers select a role explicitly — `qwen_chat`'s `opts.role`
   * resolves to a healthy backend whose `roles` includes it (weighted
   * round-robin), letting operator dispatch pick "general"/"reasoning"
   * vs "code" without hardcoding backend ids. Distinct from `modality`
   * (a hard capability: text/vision/embed/rerank); `roles` is a soft
   * routing hint the operator assigns. Unset = matches no role query
   * (the backend stays reachable by id pin or modality routing).
   */
  roles?: string[];
  /**
   * When true on a `'multimodal'` backend, exclude it from the TEXT
   * chat pool (`chooseBackend`) — it serves only `qwen_oneshot_vision`
   * (and any explicit pin). Use this to dedicate a vision/OCR model to
   * vision tasks while a separate text model (e.g. a coding model that
   * has no vision) handles `qwen_spawn` / `qwen_oneshot`. Without it,
   * a multimodal backend also serves text chat (the default, since a
   * multimodal model can do text). Ignored on non-multimodal backends.
   */
  vision_only?: boolean;
  /**
   * When true, exclude this backend from the AGENTIC text pool
   * (`chooseBackend`, used by `qwen_spawn` / `qwen_oneshot`) while
   * keeping it available for DIRECT dispatch (`qwen_chat` via modality
   * /role) and `qwen_tokenize`.
   *
   * Motivation (bead 081): Coder-Next on the box (qwen3_next / Gated
   * Delta Net, llama.cpp Vulkan) reliably CRASHES on the qwen-code
   * agentic request shape (large system preamble + tool schemas) —
   * confirmed across cache-reuse/kv-unified/reboot and the b9611 build
   * upgrade. But a DIRECT /v1/chat/completions to the same backend is
   * fine. So mark coder-box `no_agentic` → agentic coding routes only
   * to backends that survive it (coder-mac/MLX), while coder-box still
   * serves fast direct `qwen_chat` (role="code") and tokenize. An
   * explicit `opts.backend` pin still overrides (caller authority).
   */
  no_agentic?: boolean;
  /**
   * When true, exclude this backend from UNPINNED `qwen_tokenize` routing
   * (bead id7). llama.cpp serves `/tokenize`; MLX (mlx_lm.server) and other
   * non-llama.cpp backends do NOT, so unpinned tokenize that lands on them
   * 404s. Tag such backends `no_tokenize` so tokenize routes only to a
   * backend whose server implements `/tokenize`. An explicit `opts.backend`
   * pin still reaches it (and will surface the backend's own 404). Tokenizers
   * are model-specific, so we never silently re-route a pinned request.
   */
  no_tokenize?: boolean;
  /**
   * When true, exclude this backend from UNPINNED routing of `schemaSynth`
   * tasks — calls carrying a `json_schema` (RDR-007 P2 / bead azf.5). MLX
   * servers (`mlx_lm.server` / `mlx_vlm`) silently IGNORE
   * `response_format.json_schema`, so a json_schema request that lands on one
   * returns unconstrained text — the schema is dropped with no error. Tag such
   * backends `no_schema` so the dispatch contract routes json_schema requests
   * only to a backend that enforces it (llama.cpp). This is the operator
   * source for `AgentProvider.excludes = ["schemaSynth"]` (see
   * `backendToAgentProvider`).
   *
   * Net-new enforcement: before RDR-007 the MLX-no-schema rule was operator
   * convention only (`chat.ts` emitted `response_format` unconditionally;
   * nothing guarded it). Coverage matches the other exclusion flags: the guard
   * fires on the UNPINNED model-endpoint paths (`chooseBackend` agentic +
   * `chooseBackendByModality` chat — INCLUDING `qwen_chat`'s multimodal
   * fallback, which threads `taskKind=schemaSynth`, so a multimodal `no_schema`
   * backend like vision-mac IS excluded there).
   *
   * NOT enforced on: an explicit `opts.backend` pin; the role path
   * (`chooseBackendByRole`, a soft hint — passes `kind=null`); and the
   * DEDICATED vision path (`qwen_oneshot_vision`), which calls
   * `chooseBackendByModality` WITHOUT a `taskKind` by design (M2=NO — the sole
   * multimodal backend has no alternative; excluding it would fail the request
   * rather than degrade it, and vision callers are expected to pin). On that
   * path a `json_schema` is silently dropped by MLX, as it was pre-RDR-007.
   */
  no_schema?: boolean;
  /**
   * Optional bearer-token credential for remote OpenAI-compatible
   * endpoints (OpenRouter, Together, Fireworks, etc.). The supervisor
   * sends `Authorization: Bearer <key>` on every request to this backend.
   *
   * Resolution priority: `api_key` literal > `api_key_env` (read from
   * process env at request time, NOT at config-load time, so rotations
   * apply on next request).
   *
   * Prefer `api_key_env` over `api_key`. Literal keys in the config file
   * make accidental commits more likely; env-var indirection keeps the
   * secret out of any tree the supervisor reads.
   *
   * Auth values are never logged. Failure messages from this backend
   * are excerpted to ≤300 chars and may still leak short-lived
   * provider-side error text, but never the request Authorization header.
   */
  api_key?: string;
  api_key_env?: string;
  /**
   * Additional headers to send on every request to this backend. Useful
   * for provider-required attribution headers (OpenRouter's
   * `HTTP-Referer` / `X-Title`) or custom routing tags. Merged after the
   * supervisor's built-in headers (Content-Type, Authorization), so
   * caller-supplied entries can override defaults.
   */
  headers?: Record<string, string>;
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
  /**
   * Per-spawn working directory for the inner Qwen Code process. Threaded
   * to `QueryOptions.cwd`; defaults to `process.cwd()` when unset. Lets a
   * caller point a session at a per-instance throwaway worktree (RDR-006
   * Arm A enabler). Must be an absolute path — the MCP schema rejects
   * relative paths at the boundary (see `qwenSpawnOptsSchema`).
   */
  cwd?: string;
  /**
   * Per-turn output-token cap for the inner Qwen Code process, forwarded as
   * the `QWEN_CODE_MAX_OUTPUT_TOKENS` env var. Distinct from
   * `max_context_tokens` (the accumulated-context abort ceiling): this bounds
   * a single turn's generation. Lets a caller pin the reasoning-clearing floor
   * (>=16K) so the inner model isn't output-starved — Arm A/Arm B parity in
   * the RDR-006 eval (4yx). Omit to use the qwen-code default. Values <= 0 are
   * ignored.
   */
  max_output_tokens?: number;
  /**
   * HOME for the inner Qwen Code process only (forwarded as `env.HOME` on the
   * SDK query). Lets a caller point the inner model at a clean, throwaway
   * config home so it neither reads nor mutates the operator's real `~/.qwen`,
   * and shares a fixed config baseline across runs — Arm A/Arm B config parity
   * in the RDR-006 eval (40v.13). Distinct from the SUPERVISOR's own HOME,
   * which must stay intact (the supervisor resolves its backend registry from
   * it). Must be an absolute path. Omit to inherit the supervisor's HOME.
   */
  home?: string;
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
  /**
   * When false (default), the supervisor prepends a `/no_think`
   * directive to every user message so the inner Qwen3.6 model skips
   * its chain-of-thought "thinking mode." Disabling is load-bearing
   * for dispatch / RAG workloads — Artificial Analysis measured ~6×
   * output token bloat with thinking ON. Set true if you actually
   * want the reasoning trace surfaced (debugging, novel problems).
   * RDR-002 v0.8 amendment.
   */
  thinking_mode?: boolean;
  /**
   * Optional JSON schema describing the desired output shape. When
   * set, a directive describing the schema is appended to the inner
   * Qwen's system prompt asking for JSON-only output. The supervisor
   * does not run a full Ajv-style validator — that lands in v0.9 with
   * llama.cpp grammar enforcement. For now, callers should treat this
   * as best-effort guidance and validate themselves; `qwen_oneshot`
   * is the schema-aware single-turn dispatch surface that wraps
   * spawn + wait + JSON.parse + optional retry.
   */
  json_schema?: Record<string, unknown>;
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
  /**
   * Mirrors `Backend.modality`. Values: `'text'` (default when unset),
   * `'multimodal'`, `'embedding'`, `'rerank'`. Lets callers see which
   * roles each configured backend serves without trial-and-error
   * dispatch (no `backend_no_mmproj` / `wrong_modality` at request time).
   */
  modality?: "text" | "multimodal" | "embedding" | "rerank";
  /**
   * Number of sessions currently in the supervisor's pool for this
   * backend (includes `complete`/`error` sessions that have not yet
   * been reaped). Read-only.
   *
   * Semantic note: the supervisor removes sessions from the pool on
   * explicit `qwen_stop`, LRU eviction at cap, or the 5-minute reap
   * sweep (which skips `running` state). For `qwen_oneshot` callers
   * this is accurate — `qwen_stop` runs before return. For long-lived
   * multi-turn sessions that completed but were never explicitly
   * stopped, the count remains until the next reap.
   */
  active_sessions: number;
}

/**
 * Result of `qwen_oneshot` (RDR-002 v0.8 amendment) — stateless
 * single-turn dispatch wrapping spawn → wait-for-idle → optional JSON
 * parse → stop. Designed as a drop-in shape for nexus-style operator
 * dispatch where the caller wants schema-bounded synthesis without
 * managing a multi-turn session.
 *
 * `ok` mirrors the typical Result shape; on success, `result` carries
 * the assistant text and `parsed` carries `JSON.parse(result)` when
 * `json_schema` was supplied AND the parse succeeded. On failure,
 * `error.code` distinguishes timeout / session-aborted / parse-fail.
 */
export interface OneshotResult {
  ok: boolean;
  task_id: string;
  /** Number of attempts taken; 1 + retries on JSON parse failure. */
  attempts: number;
  state: SessionState;
  /** Last assistant message, when present. */
  result?: string;
  /** Parsed result, when json_schema was set and result was valid JSON. */
  parsed?: unknown;
  error?: {
    code: "timeout" | "validation_failed" | "session_error" | "no_result" | "upstream_api_error";
    message: string;
  };
  /** Live budget at the time of return. */
  budget?: SessionBudgetStats;
  /**
   * Wall-clock elapsed in milliseconds, measured from the start of
   * `qwen_oneshot`'s first spawn through the final return (across
   * all retry attempts). Parity with `VisionOneshotResult.elapsed_ms`.
   * Lets callers do latency telemetry on the text-dispatch path
   * without having to time the call themselves.
   */
  elapsed_ms: number;
  /**
   * Thread id for cross-call context continuity. Present when the
   * caller passed `opts.continuation_id` OR when the supervisor minted
   * a new id (always emitted so the caller can chain). Pass this back
   * as `opts.continuation_id` on the next `qwen_oneshot` or
   * `qwen_oneshot_vision` call to prepend prior turns.
   *
   * Threads live in-process only (3h TTL, 20-turn cap). Restart-safe is
   * not v1.
   */
  continuation_id?: string;
}

/**
 * Live overview of one session in the pool. Returned by `qwen_sessions`
 * (RDR-002 v0.7 amendment). Read-only — the operator (or
 * `/qwen-stack:status`) uses this to spot runaway tool_call counts or
 * tokens accumulating before a session aborts.
 */
export interface SessionInfo {
  task_id: string;
  backend_id: string;
  state: SessionState;
  /** Last `qwen_poll` timestamp (ms epoch). Useful for spotting stalled
   *  sessions a caller has stopped polling. */
  last_polled_at: number;
  turns_completed: number;
  budget: SessionBudgetStats;
}

// ── Agent dispatch contract (RDR-007) ──────────────────────────────────────
//
// One provider-agnostic capability descriptor + one task classifier, so the
// in-repo routers (chooseBackend* and the run_arm spine) select over a single
// shape and Claude and Qwen are interchangeable providers. This module
// contributes the type surface and two PURE functions only; the `select()`
// refactor (P1) and `excludes` enforcement (P2) land in backends.ts.

/**
 * Closed set of task kinds the dispatch contract routes over (RDR-007 RF-2).
 *
 * Modeled as a CLOSED union — mirroring `Backend.modality` (a hard capability)
 * — and deliberately NOT an open string set like `Backend.roles` (a soft
 * hint). `AgentProvider.excludes` is a hard safety constraint, and the
 * excludes-parity test (P2) must assert exhaustively over this set; an open
 * set would make that assertion impossible.
 *
 * - `schemaSynth` — JSON-schema / GBNF grammar synthesis. Works only on
 *   llama.cpp backends; MLX backends ignore `response_format.json_schema`.
 *   The MLX exclusion is enforced in P2 (azf.5), not here.
 * - `agenticLoop` — multi-turn agentic coding (`qwen_spawn` / `qwen_oneshot`).
 * - `embed` — embedding generation (`qwen_embed`).
 * - `rerank` — reranking (`qwen_rerank`).
 * - `chat` — plain single/multi-turn text chat.
 *
 * SCOPE NOTE (RDR-007): tokenization is deliberately NOT a member. The
 * `Backend.no_tokenize` exclusion stays a call-site filter in `server.ts`
 * (tokenize routes by modality, not through this dispatch contract). Folding
 * `no_tokenize` into the `excludes` model is out of scope for RDR-007 and
 * tracked as a follow-up; adding a member to this CLOSED union later forces a
 * matching update to the P2 exhaustive parity test, so it is a deliberate
 * decision, not an oversight.
 */
export type TaskKind =
  | "schemaSynth"
  | "agenticLoop"
  | "embed"
  | "rerank"
  | "chat";

/**
 * The hard-capability modality of a provider. Alias over `Backend.modality`'s
 * value set so the element type of `AgentProvider.modalities` stays in lockstep
 * with `Backend` (a future modality added there flows here automatically).
 */
export type Modality = NonNullable<Backend["modality"]>;

/**
 * Provider cost class — a closed union, not an open string. `free-local` is a
 * model served on owned hardware (no per-token cost); `metered` is a billed
 * remote API (e.g. `claude -p`).
 */
export type CostClass = "free-local" | "metered";

/**
 * Provider-agnostic capability descriptor (RDR-007). A superset of `Backend`:
 * a `Backend` is the `kind:"model-endpoint"` projection of this shape (see
 * `backendToAgentProvider`). `kind:"agent-cli"` providers (`claude -p`,
 * `qwen_spawn`) are NOT in the backend registry and carry none of the
 * endpoint-only fields.
 *
 * NOTE the plurality shift: `Backend.modality` is singular/optional, but
 * `AgentProvider.modalities` is a NON-EMPTY array (tuple-typed). The projection
 * normalizes `undefined → ["text"]`.
 */
export interface AgentProvider {
  id: string;
  /** Which selection/dispatch family this provider belongs to. */
  kind: "model-endpoint" | "agent-cli";
  /** Hard capabilities. Non-empty by type (`[Modality, ...Modality[]]`) so a
   *  provider can never be silently un-selectable. `Backend.modality`
   *  (singular) maps to a single-element array via `backendToAgentProvider`. */
  modalities: [Modality, ...Modality[]];
  /** Advisory/soft hint — what this provider is good at. NOT used for hard
   *  filtering (that is `excludes`). */
  strengths?: TaskKind[];
  /** HARD exclusions: a provider is never routed a `TaskKind` in this list.
   *  REQUIRED (matches RDR-007 Decision §1) so P2's exhaustive parity check is
   *  `excludes.includes(kind)` with no `undefined` handling. P0 projects `[]`
   *  for every model-endpoint (behavior-neutral); P2 (azf.5) populates it. */
  excludes: TaskKind[];
  /** Relative decode latency vs the Claude baseline (1.0). Advisory. */
  latencyMult?: number;
  costClass?: CostClass;
  // ── endpoint-only fields (kind:"model-endpoint"), carried from Backend ──
  url?: string;
  model?: string;
  tier?: Backend["tier"];
  capacity?: Backend["capacity"];
  ctx_size?: number;
  weight?: number;
}

/**
 * Signals available at a dispatch call site, used to classify the call into a
 * `TaskKind` (RDR-007 Decision §2).
 *
 * Each call site carries only the signals it actually has. There is NO single
 * `SpawnOpts.modality` field — embed/rerank route through `qwen_embed` /
 * `qwen_rerank` (which know their modality), while the agentic surface
 * (`qwen_spawn` / `qwen_oneshot`) passes `SpawnOpts`. This input unifies the
 * heterogeneous signals rather than assuming a field that does not exist.
 */
export interface TaskSignals {
  /** The agentic-surface opts (`qwen_spawn` / `qwen_oneshot`). Presence of
   *  this field marks the call as the agentic path; `json_schema` within it
   *  upgrades the kind to `schemaSynth`. */
  opts?: Pick<SpawnOpts, "json_schema">;
  /** Modality at modality-routed surfaces (`qwen_embed` / `qwen_rerank`, or a
   *  direct `chooseBackendByModality` call). */
  modality?: Backend["modality"];
}

/**
 * Classify a dispatch call into its `TaskKind` (RDR-007 Decision §2). Pure.
 *
 * Precedence follows the RDR-007 Decision §2 table top-to-bottom verbatim (a
 * single call site supplies one signal class, so the rows are disjoint at every
 * real call site; the order only disambiguates the degenerate case of an input
 * carrying several, and matching the accepted spec avoids silent divergence):
 *   1. `opts.json_schema` present  → `schemaSynth`
 *   2. `opts` present (agentic)    → `agenticLoop`
 *   3. `modality` embedding/rerank → `embed` / `rerank`
 *   4. otherwise                   → `chat`
 */
export function classifyTask(sig: TaskSignals): TaskKind {
  if (sig.opts?.json_schema !== undefined) return "schemaSynth";
  if (sig.opts !== undefined) return "agenticLoop";
  if (sig.modality === "embedding") return "embed";
  if (sig.modality === "rerank") return "rerank";
  return "chat";
}

/**
 * Project a `Backend` (model endpoint) into the `AgentProvider` superset
 * (RDR-007). Read-side only — this does NOT migrate `config.json`; the on-disk
 * `Backend` shape is unchanged. Normalizes the singular/optional `modality`
 * (default `"text"`, per `Backend.modality`) into the plural `modalities`.
 *
 * Exclusions (P2 / azf.5): only the `no_schema` flag folds into `excludes`
 * (→ `["schemaSynth"]`). `no_agentic` / `vision_only` deliberately stay inline
 * `Backend`-level filters in `chooseBackend` — the RDR-007 P2 scope is the MLX
 * schemaSynth guard, not a migration of the other two flags.
 */
export function backendToAgentProvider(b: Backend): AgentProvider {
  // `ctx_size` / `weight` are optional on both sides; under
  // exactOptionalPropertyTypes we must OMIT them when absent rather than
  // assign `undefined`, so the projection round-trips "field unset" exactly.
  return {
    id: b.id,
    kind: "model-endpoint",
    modalities: [b.modality ?? "text"],
    // RDR-007 P2 (azf.5): the operator-declared `no_schema` flag folds into the
    // hard-exclusion model — MLX backends ignore response_format.json_schema, so
    // they are excluded from `schemaSynth` routing. This is the ONLY flag folded
    // in P2 by design: `no_agentic` / `vision_only` stay inline Backend-level
    // filters in chooseBackend (the bead is the MLX schemaSynth guard, not a
    // migration of the other two flags). A backend without `no_schema` projects
    // an empty (but present) exclusion list.
    excludes: b.no_schema === true ? ["schemaSynth"] : [],
    url: b.url,
    model: b.model,
    tier: b.tier,
    capacity: b.capacity,
    ...(b.ctx_size !== undefined ? { ctx_size: b.ctx_size } : {}),
    ...(b.weight !== undefined ? { weight: b.weight } : {}),
  };
}

// ── Agentic dispatch contract (RDR-007 §4 / P3) ────────────────────────────
//
// The agentic-altitude interface: `dispatch(task, provider)` for
// `kind:"agent-cli"` providers (claude -p, qwen_spawn poll-to-completion). It
// is the `run_arm` spine (scripts/coding-eval/run_arm.py) generalized onto the
// TS side. `kind:"model-endpoint"` providers (chat/schemaSynth/embed/rerank)
// are SELECTED via `select()` but INVOKED through their existing tool paths
// (qwen_oneshot/embed/rerank) — they do NOT implement dispatch() (gate
// Critical-3: don't force a patch/worktree shape onto a JSON object or vector).

/**
 * Terminal state of an agentic run, independent of resolved/unresolved (which
 * a downstream scoring harness decides). Mirrors `run_arm.Outcome` verbatim so
 * the TS spine and the Python eval spine classify identically (RF-1).
 *
 * - `completed`  — the agent finished on its own.
 * - `timeout`    — the wall-clock cutoff fired (spine-owned).
 * - `turn_limit` — the agent hit `maxTurns` (driver-classified).
 * - `error`      — non-zero exit / invocation failure.
 */
export type AgentOutcome = "completed" | "timeout" | "turn_limit" | "error";

/**
 * One unit of agentic work (RDR-007 §4). Host-agnostic: the same shape is
 * handed to a `claude -p` provider or a `qwen_spawn` provider.
 *
 * - `prompt`    — the task/problem statement given to the agent.
 * - `worktree`  — absolute path to the isolated working tree the agent edits;
 *                 also the target the host's `extractPatch` effect diffs.
 * - `maxTurns`  — turn budget; `turns >= maxTurns` classifies as `turn_limit`.
 * - `minTokens` — per-turn output-token floor (the reasoning-clearing floor;
 *                 run_arm 4yx). Forwarded to the qwen spawn's
 *                 `max_output_tokens`. The claude provider self-manages
 *                 generation and does NOT consume this.
 * - `timeout`   — wall-clock cutoff in milliseconds; firing yields `timeout`.
 */
export interface AgentTask {
  prompt: string;
  worktree: string;
  maxTurns: number;
  minTokens: number;
  timeout: number;
}

/**
 * Result of an agentic run (RDR-007 §4).
 *
 * - `patch`   — the source diff, produced by the HOST's `extractPatch` effect
 *               off `worktree` (a `git diff <base>`), NEVER the agent's own
 *               self-reported patch field (run_arm's locked invariant: the
 *               `claude -p --output-format json` `model_patch` is telemetry
 *               only). RF-1 keeps git-diff a host effect, not centralized.
 * - `turns`   — turns the agent used (driver-specific signal: claude's
 *               `num_turns`, qwen's poll-reported turn count).
 * - `outcome` — see {@link AgentOutcome}.
 * - `cost`    — USD cost (metered providers; `0` for free-local).
 */
export interface AgentResult {
  patch: string;
  turns: number;
  outcome: AgentOutcome;
  cost: number;
}
