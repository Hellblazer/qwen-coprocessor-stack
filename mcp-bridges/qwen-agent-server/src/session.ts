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
import pino from "pino";

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

const log = pino({ name: "qwen-session" });

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

  // Multi-turn input queue + waker for the async-generator prompt.
  private _inputQueue: SDKUserMessage[] = [];
  private _inputResolver: (() => void) | null = null;
  private _inputClosed = false;

  constructor(backend: Backend, prompt: string, opts: SpawnOpts) {
    this.task_id = `q-${randomBytes(4).toString("hex")}`;
    this.backend = backend;
    this.write_authority = opts.write_authority === true;
    this._abortController = new AbortController();
    this._last_user_message = prompt;

    // Seed the queue with the initial user message.
    this._inputQueue.push(this._mkUserMessage(prompt));

    // Build excludeTools list. allow_subagents removes 'agent' from the
    // default exclude list; ask_user_question is always excluded.
    const excludeTools: string[] = opts.allow_subagents === true
      ? DEFAULT_EXCLUDED_TOOLS.filter((t) => t !== "agent")
      : [...DEFAULT_EXCLUDED_TOOLS];

    // Build system prompt: coprocessor preamble + caller's system + prior_context.
    const systemPrompt = buildSystemPrompt(opts.system, opts.prior_context);

    // §S4 Permission mode: yolo only when write_authority===true.
    const permissionMode = opts.write_authority === true ? "yolo" : "default";

    const queryOptions: import("@qwen-code/sdk").QueryOptions = {
      cwd: process.cwd(),
      model: backend.model,
      env: {
        OPENAI_BASE_URL: backend.url,
        OPENAI_API_KEY: process.env["OPENAI_API_KEY"] ?? "sk-local",
        QWEN_MODEL: backend.model,
      },
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
      void this._sdkIter.return?.();
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

    // Find events after the cursor.
    let slice: Event[];
    if (since === undefined) {
      slice = this._events.slice(-maxEvents);
    } else {
      const startIdx = this._events.findIndex((e) => e.id > since);
      if (startIdx === -1) {
        slice = [];
      } else {
        const available = this._events.slice(startIdx);
        slice = available.slice(0, maxEvents);
      }
    }

    const hasMore =
      since !== undefined
        ? (() => {
            const startIdx = this._events.findIndex((e) => e.id > since);
            return startIdx !== -1 && this._events.slice(startIdx).length > maxEvents;
          })()
        : this._events.length > maxEvents;

    const latestId = this._events.length > 0 ? (this._events[this._events.length - 1]!.id) : "0";

    const result: PollResult = {
      state: this._state,
      recent_events: slice,
      more_events_available: hasMore,
      latest_event_id: latestId,
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
    return {
      type: "user",
      session_id: this.task_id,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    };
  }

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

  return parts.join("\n\n");
}
