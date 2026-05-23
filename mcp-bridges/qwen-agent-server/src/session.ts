// SPDX-License-Identifier: MIT
//
// QwenSession — per-task state machine wrapping one @qwen-code/sdk query().
//
// Conversation model: multi-turn via an async-generator prompt that the
// supervisor controls. The generator yields each user message as it
// arrives via send(); when the queue is empty, it awaits a resolver
// that send() / stop() flip. After each turn the SDK emits a `result`
// message; we transition state running → idle and stay there until the
// caller calls send() (push the next user message) or stop() (terminate).
//
// Critical pins (RDR-001):
//   §Q1  ask_user_question is EXCLUDED from the inner Qwen's tool surface
//        by default. Answer delivery happens via streamInput user turns,
//        not via canUseTool. The original deny-with-message and
//        deny-then-streamInput-tool_result patterns were both empirically
//        confirmed to fail (probe-tool-result.mjs, 2026-05-04).
//   §Q3  KV-cache affinity: session.backend is pinned at construction and
//        NEVER reassigned (phase-6 review gate greps for re-assignment).
//   §S4  permissionMode='yolo' only when write_authority===true; otherwise
//        'default' with canUseTool callback emitting permission_denied
//        events for write-tool denials (visible to the caller via poll).

import { randomBytes } from "node:crypto";
import type { Query } from "@qwen-code/sdk";
import { query } from "@qwen-code/sdk";
import { createLogger } from "./log.js";

import type {
  Backend,
  Event,
  EventType,
  PollOpts,
  PollResult,
  PriorContext,
  SessionState,
  SpawnOpts,
} from "./types.js";
import { makeCanUseTool } from "./permissions.js";
import type { ResolveExtensionsResult } from "./extensions.js";

/**
 * Per-spawn bridge infrastructure (RDR-002).
 *
 *   - qwenRealBin: absolute path to the real Qwen Code binary; forwarded
 *     to the wrapper subprocess via `QueryOptions.env.QWEN_REAL_BIN`.
 *   - wrapperPath: absolute path to the bash wrapper script set as
 *     `QueryOptions.pathToQwenExecutable`. The wrapper reads
 *     `QWEN_AGENT_EXTENSIONS` from env at exec time and prepends
 *     `--extensions <list>` to the CLI argv.
 *
 * Both fields are required when a caller wants extension bridging; an
 * empty string for either signals "skip the bridge" and the session
 * falls back to default SDK behaviour. This keeps existing tests that
 * construct QwenSession without infrastructure context unaffected.
 */
export interface SpawnInfra {
  qwenRealBin: string;
  wrapperPath: string;
}

const log = createLogger("qwen-session");

// ─────────────────────────────────────────────────────────────────
// Constants

/** Maximum events kept in the ring buffer; oldest evicted on overflow. */
const RING_BUFFER_CAP = 1_000;

/** Default max events returned per poll call. */
const DEFAULT_MAX_EVENTS = 16;

/** Timeout for canUseTool callback (ms). 10 min — RDR §Critical Pins.
 *  The SDK default of 60 s is too tight for human-in-the-loop. */
const CAN_USE_TOOL_TIMEOUT_MS = 600_000;

/** Tools always excluded from the inner Qwen's surface.
 *  - 'agent': prevents recursive sub-agent spawning (the supervisor IS
 *    the orchestration layer; nested Qwen sub-agents would be invisible
 *    to it). Override via opts.allow_subagents.
 *  - 'ask_user_question': RDR §Q1. The supervisor exposes `qwen_send`
 *    for multi-turn input; tool-based asks don't have a working
 *    answer-delivery channel given the SDK's deny semantics. The model
 *    is told via system prompt to ask in plain text and wait. */
const DEFAULT_EXCLUDED_TOOLS = ["agent", "ask_user_question"];

/** System prompt fragment instructing the inner Qwen on the
 *  multi-turn / no-ask_user_question contract. Always prepended. */
const COPROCESSOR_PREAMBLE = `You are operating as a coprocessor under a supervisor that runs you in
multi-turn mode. Important contract:

- The 'ask_user_question' tool is NOT available to you. If you need
  clarification from the user, ask in plain text in your response and
  stop generating. The user will see your question and reply in their
  next message. Do not loop indefinitely on hypotheticals — when you
  need input, ask and wait.
- Each user message you receive may be a fresh task or a follow-up to
  a prior turn. Treat the conversation as continuous.
- If you have completed the user's request, simply say so and stop.`;

// ─────────────────────────────────────────────────────────────────
// Event ID counter (monotonic per process)

let _eventSeq = 0;
function nextEventId(): string {
  return String(++_eventSeq);
}

/** Test-only: reset the event sequence counter. */
export function _resetEventSeq(): void {
  _eventSeq = 0;
}

// ─────────────────────────────────────────────────────────────────
// SDK message types we use (re-imported here for clarity)

interface SDKUserMessage {
  type: "user";
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    role: "user";
    content: Array<{ type: "text"; text: string }>;
  };
}

// ─────────────────────────────────────────────────────────────────
// QwenSession

export class QwenSession {
  readonly task_id: string;
  // §Q3 KV-cache affinity: backend pinned at construction; NEVER reassigned.
  readonly backend: Backend; // eslint-disable-line -- single assignment; phase-6 grep gate

  private _state: SessionState = "running";
  private _events: Event[] = [];
  private _last_message: string | undefined;
  private _last_user_message: string | undefined;
  private _last_assistant_summary: string | undefined;
  private _result: string | undefined;
  private _error: PollResult["error"] | undefined;
  private _turns_completed = 0;
  private _sdkIter: Query | null = null;
  private _abortController: AbortController;

  // ── Session budget (RDR-002 §Session budget, 2026-05-09 amendment) ─
  // Caps are zero-disabled; defaults are applied in the wiring layer
  // (server.ts / config), not here. The budget tracks accumulated
  // tool_result content and tool_call count — the two knobs that
  // actually correlate with the Prime-Mover-style ECONNRESET crash we
  // saw in the 2026-05-09 shakeout.
  private readonly _maxContextTokens: number;
  private readonly _maxToolCalls: number;
  private _accumulatedToolResultChars = 0;
  private _toolCallCount = 0;
  private _emittedPressure = new Set<"warn" | "high" | "critical">();
  // v0.8: thinking-mode and JSON-schema controls. See SpawnOpts.
  private readonly _thinkingMode: boolean;

  // Multi-turn input queue + waker for the async-generator prompt.
  private _inputQueue: SDKUserMessage[] = [];
  private _inputResolver: (() => void) | null = null;
  private _inputClosed = false;

  constructor(
    backend: Backend,
    prompt: string,
    opts: SpawnOpts,
    infra?: SpawnInfra,
    resolvedExtensions?: ResolveExtensionsResult,
  ) {
    this.task_id = `q-${randomBytes(4).toString("hex")}`;
    this.backend = backend;
    this.write_authority = opts.write_authority === true;
    this._abortController = new AbortController();
    this._last_user_message = prompt;
    // Zero/undefined disables the cap; defaults flow in from server.ts.
    this._maxContextTokens = opts.max_context_tokens ?? 0;
    this._maxToolCalls = opts.max_tool_calls ?? 0;
    // Default thinking_mode to false (RDR-002 v0.8 amendment) — Qwen3.6
    // ships with thinking ON which causes ~6× output bloat in dispatch
    // workloads (Artificial Analysis 2026-04). Caller can opt back in.
    this._thinkingMode = opts.thinking_mode === true;

    // RDR-002 step 11: extensions_loaded is the first event in the
    // session's log when a resolution is provided. Populating before
    // _run() means qwen_poll surfaces it immediately, even before the
    // SDK emits its first message.
    if (resolvedExtensions !== undefined) {
      this.pushEvent(
        "extensions_loaded",
        describeResolvedExtensions(resolvedExtensions.resolved),
        { resolved: resolvedExtensions.resolved },
      );
    }

    // Seed the queue with the initial user message. _mkUserMessage
    // applies the /no_think prefix when thinking_mode is disabled.
    this._inputQueue.push(this._mkUserMessage(prompt));

    // Build excludeTools list. allow_subagents removes 'agent' from the
    // default exclude list; ask_user_question is always excluded.
    const excludeTools: string[] = opts.allow_subagents === true
      ? DEFAULT_EXCLUDED_TOOLS.filter((t) => t !== "agent")
      : [...DEFAULT_EXCLUDED_TOOLS];

    // Build system prompt: coprocessor preamble + caller's system +
    // prior_context + optional JSON-schema directive when opts.json_schema
    // is supplied (RDR-002 v0.8 amendment).
    const systemPrompt = buildSystemPrompt(opts.system, opts.prior_context, opts.json_schema);

    // §S4 Permission mode: yolo only when write_authority===true.
    const permissionMode = opts.write_authority === true ? "yolo" : "default";

    // RDR-002 wrapper bridge: when both fields are populated, route the
    // SDK's qwen invocation through the wrapper script and forward the
    // resolved real-binary path via env. Empty strings fall through to
    // default SDK behaviour so existing tests that don't configure
    // infra (and unit-test constructions in general) stay unaffected.
    const bridgeActive =
      infra !== undefined && infra.qwenRealBin !== "" && infra.wrapperPath !== "";

    const env: Record<string, string> = {
      OPENAI_BASE_URL: backend.url,
      OPENAI_API_KEY: process.env["OPENAI_API_KEY"] ?? "sk-local",
      QWEN_MODEL: backend.model,
    };
    if (bridgeActive) {
      env["QWEN_REAL_BIN"] = infra.qwenRealBin;
    }
    // RDR-002 step 8: render the resolved extension set into the env
    // var the wrapper reads. envValue===null means "leave-defaults"
    // (wrapper drops --extensions). Setting QWEN_AGENT_EXTENSIONS only
    // when bridgeActive avoids leaking it to non-bridged tests.
    if (bridgeActive && resolvedExtensions?.envValue !== undefined && resolvedExtensions.envValue !== null) {
      env["QWEN_AGENT_EXTENSIONS"] = resolvedExtensions.envValue;
    }

    const queryOptions: import("@qwen-code/sdk").QueryOptions = {
      cwd: process.cwd(),
      model: backend.model,
      env,
      authType: "openai",
      permissionMode,
      excludeTools,
      abortController: this._abortController,
      timeout: { canUseTool: CAN_USE_TOOL_TIMEOUT_MS },
      // canUseTool only registered in 'default' mode; yolo ignores it.
      ...(permissionMode === "default"
        ? { canUseTool: makeCanUseTool(this) }
        : {}),
      systemPrompt,
      ...(bridgeActive ? { pathToQwenExecutable: infra.wrapperPath } : {}),
    };

    this._sdkIter = query({
      prompt: this._inputGenerator() as AsyncIterable<SDKUserMessage>,
      options: queryOptions,
    });

    void this._run();
  }

  // ── Public accessors ──────────────────────────────────────────

  get state(): SessionState {
    return this._state;
  }

  /** Bound at construction; mirrors the permissionMode decision. */
  readonly write_authority: boolean;

  /** Number of fully completed turns. Read by `qwen_sessions` for
   *  operator overviews; the same counter appears in `last_known` on
   *  error PollResults. */
  get turns_completed(): number {
    return this._turns_completed;
  }

  /** Live budget snapshot — same shape that `poll()` embeds in its
   *  result. Exposed independently so `qwen_sessions` can build a
   *  multi-session overview without producing a full PollResult per
   *  session. */
  budgetStats(): import("./types.js").SessionBudgetStats {
    return {
      est_tokens: this._estTokens(),
      max_tokens: this._maxContextTokens,
      tool_calls: this._toolCallCount,
      max_tool_calls: this._maxToolCalls,
    };
  }

  // ── Event ring buffer ─────────────────────────────────────────

  /** Push an event into the ring; evict oldest when over cap. */
  pushEvent(type: EventType, summary: string, data?: unknown): Event {
    const ev: Event = {
      id: nextEventId(),
      type,
      ts: Date.now(),
      summary,
      data,
    };
    this._events.push(ev);
    if (this._events.length > RING_BUFFER_CAP) {
      this._events.shift();
    }
    return ev;
  }

  // ── State transitions ─────────────────────────────────────────

  /** Push a new user message into the conversation.
   *  Wakes the input generator so the SDK pulls the message and starts
   *  the next turn.
   *
   *  Throws if the session is `complete` or `error` (terminal).
   *  Permitted in `running` (queues for after current turn) or `idle`
   *  (immediate next turn). */
  send(answer: string): void {
    if (this._state === "complete" || this._state === "error") {
      throw new Error(`session ${this.task_id} is ${this._state}; cannot send`);
    }
    this._inputQueue.push(this._mkUserMessage(answer));
    this._last_user_message = answer;
    this._state = "running";
    this._wakeInput();
  }

  /** Cancel the running SDK iterator and close the input stream.
   *  Idempotent — safe to call repeatedly. */
  stop(): void {
    this._inputClosed = true;
    this._abortController.abort();
    if (this._sdkIter) {
      // AbortController.abort() is the real cancel signal; this
      // return() is belt-and-suspenders. If the SDK ever makes it
      // async-and-failable, surface the rejection in the structured
      // log instead of letting it bubble to unhandledRejection (which
      // can terminate the process in newer Node versions).
      this._sdkIter.return?.().catch((err: unknown) => {
        log.warn(
          { task_id: this.task_id, err: err instanceof Error ? err.message : String(err) },
          "sdkIter.return() rejected during stop()",
        );
      });
    }
    this._wakeInput();
    if (this._state !== "error") {
      this._state = "complete";
      if (this._result === undefined) {
        this._result = this._last_message ?? "";
      }
    }
  }

  // ── Poll ──────────────────────────────────────────────────────

  poll(opts: PollOpts): PollResult {
    const maxEvents = opts.max_events ?? DEFAULT_MAX_EVENTS;
    const since = opts.since;

    // Find events after the cursor. Event IDs are numeric strings
    // (String(++_eventSeq)) — compare numerically to avoid the lexicographic
    // 9→10 boundary trap where "10" < "9" silently breaks incremental polling.
    const sinceNum = since !== undefined ? Number(since) : undefined;
    let slice: Event[];
    if (sinceNum === undefined) {
      slice = this._events.slice(-maxEvents);
    } else {
      const startIdx = this._events.findIndex((e) => Number(e.id) > sinceNum);
      if (startIdx === -1) {
        slice = [];
      } else {
        const available = this._events.slice(startIdx);
        slice = available.slice(0, maxEvents);
      }
    }

    const hasMore =
      sinceNum !== undefined
        ? (() => {
            const startIdx = this._events.findIndex((e) => Number(e.id) > sinceNum);
            return startIdx !== -1 && this._events.slice(startIdx).length > maxEvents;
          })()
        : this._events.length > maxEvents;

    const latestId = this._events.length > 0 ? (this._events[this._events.length - 1]!.id) : "0";

    const result: PollResult = {
      state: this._state,
      recent_events: slice,
      more_events_available: hasMore,
      latest_event_id: latestId,
      // Live budget counters (RDR-002 v0.6 amendment). Always set so
      // pollers don't have to special-case post-abort sessions; both
      // caps are zero-disabled per the SessionBudgetStats contract.
      budget: {
        est_tokens: this._estTokens(),
        max_tokens: this._maxContextTokens,
        tool_calls: this._toolCallCount,
        max_tool_calls: this._maxToolCalls,
      },
    };

    if ((this._state === "idle" || this._state === "complete") && this._last_message !== undefined) {
      result.last_message = this._last_message;
    }

    if (this._state === "complete" && this._result !== undefined) {
      result.result = this._result;
    }

    if (this._state === "error") {
      if (this._error !== undefined) {
        result.error = this._error;
      }
      const lastKnown: import("./types.js").LastKnown = {
        turns_completed: this._turns_completed,
      };
      if (this._last_user_message !== undefined) {
        lastKnown.last_user_message = this._last_user_message;
      }
      if (this._last_assistant_summary !== undefined) {
        lastKnown.last_assistant_summary = this._last_assistant_summary;
      }
      result.last_known = lastKnown;
    }

    return result;
  }

  // ── Internals ─────────────────────────────────────────────────

  private _mkUserMessage(text: string): SDKUserMessage {
    // RDR-002 v0.8: Qwen3.6's documented mechanism for skipping
    // chain-of-thought is the `/no_think` directive on the user
    // message. Apply per-message rather than once-per-session because
    // the chat template renders directives on the message they
    // accompany; subsequent turns need their own prefix.
    const out = this._thinkingMode ? text : `/no_think\n\n${text}`;
    return {
      type: "user",
      session_id: this.task_id,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: out }],
      },
    };
  }

  // Single-slot resolver. The current send() → _wakeInput() →
  // _inputGenerator-resumes chain is race-free because JS micro-task
  // ordering guarantees the generator awakens (and drops the resolver
  // back to null) before any second send() can fire-and-set it.
  // If send() ever becomes async, or a message-batch API is added, this
  // single-slot design must become a queue of resolvers or a proper
  // semaphore — otherwise back-to-back wakes between yields silently
  // collapse to one.
  private _wakeInput(): void {
    if (this._inputResolver) {
      const resolve = this._inputResolver;
      this._inputResolver = null;
      resolve();
    }
  }

  /** Async generator that the SDK consumes as `prompt`. Yields queued
   *  messages, blocks on a resolver when empty, and returns when
   *  stop() flips _inputClosed. */
  private async *_inputGenerator(): AsyncGenerator<SDKUserMessage, void, unknown> {
    while (true) {
      // Drain queue first.
      while (this._inputQueue.length > 0) {
        const msg = this._inputQueue.shift();
        if (msg !== undefined) yield msg;
      }
      if (this._inputClosed) return;
      // Wait for someone to push a message or close the input.
      await new Promise<void>((resolve) => {
        this._inputResolver = resolve;
      });
    }
  }

  // ── Session budget ────────────────────────────────────────────
  //
  // The chars/4 token estimate is intentionally crude — the SDK doesn't
  // expose a tokenizer and we don't want to ship one. It runs ~25–30%
  // hot for English prose against tiktoken, so 0.85 * ctx_size as the
  // default cap leaves comfortable headroom even when the estimate is
  // optimistic. The point is to fire visibly before the HTTP layer
  // panics, not to be precise.

  /** Returns the current chars/4 token estimate. */
  private _estTokens(): number {
    return Math.floor(this._accumulatedToolResultChars / 4);
  }

  /** Emit a `context_pressure` event when the estimate first crosses
   *  50%, 75%, or 90% of max_context_tokens. Each level fires once. */
  private _maybeEmitPressure(): void {
    if (this._maxContextTokens <= 0) return;
    const est = this._estTokens();
    const thresholds: ReadonlyArray<readonly [number, "warn" | "high" | "critical"]> = [
      [0.5, "warn"],
      [0.75, "high"],
      [0.9, "critical"],
    ];
    for (const [pct, level] of thresholds) {
      if (this._emittedPressure.has(level)) continue;
      if (est >= this._maxContextTokens * pct) {
        this._emittedPressure.add(level);
        this.pushEvent(
          "context_pressure",
          `context_pressure ${level}: ${est}/${this._maxContextTokens} est tokens, ${this._toolCallCount} tool calls`,
          {
            level,
            est_tokens: est,
            max_tokens: this._maxContextTokens,
            tool_calls: this._toolCallCount,
            max_tool_calls: this._maxToolCalls,
          },
        );
      }
    }
  }

  /** If either cap is exceeded, transition to error and stop the SDK
   *  iterator. Returns true when an abort was triggered so callers in
   *  `_run` can break out of their loop. Idempotent. */
  private _enforceBudget(): boolean {
    if (this._state === "error") return true; // already aborted
    const est = this._estTokens();
    const overTokens = this._maxContextTokens > 0 && est > this._maxContextTokens;
    const overCalls = this._maxToolCalls > 0 && this._toolCallCount > this._maxToolCalls;
    if (!overTokens && !overCalls) return false;

    const message = `session exceeded budget: est_tokens=${est}/${this._maxContextTokens || "off"}, tool_calls=${this._toolCallCount}/${this._maxToolCalls || "off"}`;
    this._state = "error";
    this._error = { code: "context_exceeded", message };
    this.pushEvent("error", `context budget exceeded: ${message}`);
    log.warn(
      {
        task_id: this.task_id,
        event_type: "context_exceeded",
        est_tokens: est,
        max_tokens: this._maxContextTokens,
        tool_calls: this._toolCallCount,
        max_tool_calls: this._maxToolCalls,
      },
      "session aborted: budget exceeded",
    );
    // stop() preserves _state when it is already "error" — by design,
    // see the existing guard in stop().
    this.stop();
    return true;
  }

  // ── SDK event loop ────────────────────────────────────────────

  private async _run(): Promise<void> {
    if (!this._sdkIter) return;
    try {
      for await (const msg of this._sdkIter) {
        if (msg.type === "assistant") {
          // Capture & emit text content for model_message_summary.
          const textBlocks = msg.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join(" ");
          if (textBlocks.trim()) {
            const summary = textBlocks.slice(0, 120);
            this.pushEvent("model_message_summary", summary);
            this._last_message = textBlocks;
            this._last_assistant_summary = summary;
          }

          // Tool-use events.
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              this.pushEvent(
                "tool_call",
                `tool_call: ${block.name}`,
                { name: block.name, id: block.id, input: block.input },
              );
              this._toolCallCount++;
              if (this._enforceBudget()) return;
            }
          }
        } else if (msg.type === "user") {
          // Tool results coming back from the SDK's internal tool execution.
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                this.pushEvent(
                  "tool_result",
                  `tool_result: ${block.tool_use_id}`,
                  block,
                );
                this._accumulatedToolResultChars += measureToolResultChars(block);
                this._maybeEmitPressure();
                if (this._enforceBudget()) return;
              }
            }
          }
        } else if (msg.type === "result") {
          // §Observability — log cache_read_input_tokens (RDR §Observability).
          const usage = msg.usage;
          if (usage?.cache_read_input_tokens !== undefined) {
            log.info(
              {
                task_id: this.task_id,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
              },
              "sdk result usage",
            );
          }

          this._turns_completed++;

          if (msg.is_error) {
            this._state = "error";
            const errMsg = msg.error?.message ?? msg.subtype;
            this._error = { code: "backend_internal", message: errMsg };
            this.pushEvent("error", `sdk error: ${errMsg}`);
            return;
          }

          // Successful turn end — capture result text and transition to idle.
          // Don't return; the for-await continues, the SDK pulls the next
          // user message from our input generator (which blocks until
          // send() pushes one or stop() closes).
          const turnResult = (msg as { result?: string }).result;
          if (turnResult !== undefined && turnResult !== "") {
            this._last_message = turnResult;
            this._result = turnResult;
          }
          this.pushEvent("turn_complete", `turn ${this._turns_completed} complete`);
          this._state = "idle";
        }
      }
      // Iterator naturally exhausted (only happens after stop()).
      if (this._state === "running" || this._state === "idle") {
        this._state = "complete";
        if (this._result === undefined) {
          this._result = this._last_message ?? "";
        }
      }
    } catch (err: unknown) {
      if (this._state === "running" || this._state === "idle") {
        const message = err instanceof Error ? err.message : String(err);
        this._state = "error";
        this._error = { code: "backend_internal", message };
        this.pushEvent("error", `sdk exception: ${message}`);
        log.error({ task_id: this.task_id, err }, "sdk iterator error");
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Helpers

/**
 * Best-effort char count of a tool_result block's content. The SDK
 * permits either a plain string or an array of typed sub-blocks
 * (`{type:"text",text}` or other content blocks); we sum text length
 * across both shapes and fall back to the JSON string for anything
 * unexpected. Slight over-counting is fine — the budget is a guardrail,
 * not an accountant.
 */
function measureToolResultChars(block: unknown): number {
  const obj = block as { content?: unknown };
  const c = obj?.content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) {
    let total = 0;
    for (const part of c as unknown[]) {
      if (typeof part === "string") {
        total += part.length;
        continue;
      }
      const p = part as { type?: string; text?: string };
      if (p && typeof p.text === "string") {
        total += p.text.length;
      } else {
        total += JSON.stringify(part).length;
      }
    }
    return total;
  }
  if (c === undefined || c === null) return 0;
  try {
    return JSON.stringify(c).length;
  } catch {
    return 0;
  }
}

/**
 * Render the resolved extension set into a one-line summary suitable
 * for the extensions_loaded event's `summary` field. The full structured
 * payload still goes into `data.resolved` for callers that want it.
 */
function describeResolvedExtensions(
  resolved: ResolveExtensionsResult["resolved"],
): string {
  if (resolved === "leave-defaults") return "extensions: leave-defaults (CLI defaults apply)";
  if (resolved === "none") return "extensions: none (explicitly disabled)";
  if (resolved.length === 0) return "extensions: none";
  return `extensions: ${resolved.join(", ")}`;
}

/**
 * Build a system-prompt string from the coprocessor preamble, the
 * caller's system, and optional prior_context.
 *
 * Prior context synthesis is text-faithful but lossy for prior tool
 * calls (tool call history cannot be replayed against a new backend —
 * see RDR §S2).
 */
function buildSystemPrompt(
  system: string | undefined,
  priorContext: PriorContext | undefined,
  jsonSchema: Record<string, unknown> | undefined,
): string {
  const parts: string[] = [COPROCESSOR_PREAMBLE];

  if (priorContext) {
    parts.push(`[Resuming prior session context]`);
    parts.push(`Conversation summary:\n${priorContext.conversation_summary}`);
    if (priorContext.last_user_message) {
      parts.push(`Last user message:\n${priorContext.last_user_message}`);
    }
    if (priorContext.prior_session_id) {
      parts.push(`Prior session ID: ${priorContext.prior_session_id}`);
    }
  }

  if (system) {
    parts.push(system);
  }

  // RDR-002 v0.8: schema-as-system-prompt. The supervisor doesn't
  // grammar-enforce yet (v0.9 candidate); for now we instruct the
  // model and rely on Qwen3.6's well-documented JSON output reliability.
  // qwen_oneshot wraps spawn + JSON.parse + retry to round out the
  // surface for callers that want a Result-shaped return.
  if (jsonSchema !== undefined) {
    parts.push(
      "[Output contract — JSON only]\n" +
        "Your final assistant message must START with `{` or `[` and END\n" +
        "with `}` or `]`. No preamble, no closing remarks, no explanatory\n" +
        "text. ABSOLUTELY no markdown code fences (no triple backticks,\n" +
        "no ```json wrappers). The very first character of your response\n" +
        "must be `{` or `[`.\n\n" +
        "The JSON must conform to this JSON Schema:\n\n" +
        JSON.stringify(jsonSchema, null, 2) +
        "\n\nIf the task cannot be completed, return a JSON object with\n" +
        '`{"error": "<one-line explanation>"}` rather than free text.',
    );
  }

  return parts.join("\n\n");
}
