// SPDX-License-Identifier: MIT
//
// QwenSession — per-task state machine wrapping one @qwen-code/sdk query().
//
// Critical pins (all must be preserved — see RDR-001):
//   §Q1  ask_user_question answered via deny-with-message (see permissions.ts)
//   §Q3  KV-cache affinity: session.backend is pinned at construction and
//        NEVER reassigned (phase-6 review gate greps for re-assignment).
//   §S4  permissionMode='yolo' only when write_authority===true; otherwise
//        'default' with canUseTool callback emitting permission_denied events.

import { randomBytes } from "node:crypto";
import type { Query } from "@qwen-code/sdk";
import { query } from "@qwen-code/sdk";
import pino from "pino";

import type { Backend, Event, EventType, PollOpts, PollResult, PriorContext, SessionState, SpawnOpts } from "./types.js";
import { makeCanUseTool } from "./permissions.js";

const log = pino({ name: "qwen-session" });

// ─────────────────────────────────────────────────────────────────
// Constants

/** Maximum events kept in the ring buffer; oldest evicted on overflow. */
const RING_BUFFER_CAP = 1_000;

/** Default max events returned per poll call. */
const DEFAULT_MAX_EVENTS = 16;

/** Timeout for canUseTool callback (ms). 10 min to allow human-in-the-loop.
 *  See RDR-001 §Critical Pins — the SDK default of 60 s is too tight. */
const CAN_USE_TOOL_TIMEOUT_MS = 600_000;

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
// Pending question handle

/** Holds the resolve function for an in-flight ask_user_question canUseTool
 *  Promise plus metadata so qwen_send can thread the answer back. */
export interface PendingQuestion {
  tool_use_id: string;
  tool_name: string;
  resolve: (answer: string) => void;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────
// QwenSession

export class QwenSession {
  readonly task_id: string;
  // §Q3 KV-cache affinity: backend pinned at construction; NEVER reassigned.
  readonly backend: Backend; // eslint-disable-line -- single assignment; phase-6 grep gate

  private _state: SessionState = "running";
  private _events: Event[] = [];
  private _pending_question: PendingQuestion | null = null;
  private _result: string | undefined;
  private _error: PollResult["error"] | undefined;
  private _turns_completed = 0;
  private _last_user_message: string | undefined;
  private _last_assistant_summary: string | undefined;
  private _sdkIter: Query | null = null;
  private _abortController: AbortController;

  constructor(backend: Backend, prompt: string, opts: SpawnOpts) {
    this.task_id = `q-${randomBytes(4).toString("hex")}`;
    this.backend = backend;

    this._abortController = new AbortController();
    this._last_user_message = prompt;

    // Build excludeTools list; default excludes 'agent' unless allow_subagents.
    const excludeTools: string[] = opts.allow_subagents === true ? [] : ["agent"];

    // Build system prompt, incorporating prior_context if provided.
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
      // §Critical Pins: canUseTool timeout = 600 000 ms (10 min).
      timeout: {
        canUseTool: CAN_USE_TOOL_TIMEOUT_MS,
      },
      // canUseTool only registered in 'default' mode; yolo ignores it.
      ...(permissionMode === "default"
        ? { canUseTool: makeCanUseTool(this) }
        : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    };

    this._sdkIter = query({ prompt, options: queryOptions });

    // Drive the SDK iterator in the background.
    void this._run();
  }

  // ── Public accessors ──────────────────────────────────────────

  get state(): SessionState {
    return this._state;
  }

  get pending_question(): PendingQuestion | null {
    return this._pending_question;
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

  /** Called by makeCanUseTool when ask_user_question is intercepted. */
  setAwaitingInput(pending: PendingQuestion): void {
    this._pending_question = pending;
    this._state = "awaiting_input";
    this.pushEvent("awaiting_input", `waiting for answer to: ${pending.tool_name}`, {
      tool_name: pending.tool_name,
      tool_use_id: pending.tool_use_id,
    });
  }

  /** Called by the server when qwen_send delivers an answer. */
  send(answer: string): void {
    if (this._state === "complete" || this._state === "error") {
      throw new Error(`session ${this.task_id} is ${this._state}; cannot send`);
    }
    if (this._state !== "awaiting_input" || !this._pending_question) {
      throw new Error(`session ${this.task_id} is not awaiting_input`);
    }
    const pending = this._pending_question;
    this._pending_question = null;
    this._state = "running";
    pending.resolve(answer);
  }

  /** Cancel the running SDK iterator. */
  stop(): void {
    this._abortController.abort();
    if (this._sdkIter) {
      void this._sdkIter.return?.();
    }
    if (this._state === "running" || this._state === "awaiting_input") {
      this._state = "error";
      this._error = { code: "timeout", message: "session stopped by caller" };
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

    if (this._state === "awaiting_input" && this._pending_question) {
      const pq = this._pending_question;
      result.awaiting_input = {
        tool_name: pq.tool_name,
        tool_use_id: pq.tool_use_id,
        ...(pq.questions !== undefined ? { questions: pq.questions } : {}),
      };
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

  // ── SDK event loop ────────────────────────────────────────────

  private async _run(): Promise<void> {
    if (!this._sdkIter) return;
    try {
      for await (const msg of this._sdkIter) {
        if (msg.type === "assistant") {
          // Summarise text content for model_message_summary events.
          const textBlocks = msg.message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join(" ");
          if (textBlocks.trim()) {
            const summary = textBlocks.slice(0, 120);
            this.pushEvent("model_message_summary", summary);
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
          // Tool results coming back.
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
          this._turns_completed++;
        } else if (msg.type === "result") {
          // §Observability: log cache_read_input_tokens per RDR §Observability.
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

          if (msg.is_error) {
            this._state = "error";
            const errMsg = msg.error?.message ?? msg.subtype;
            this._error = { code: "backend_internal", message: errMsg };
            this.pushEvent("error", `sdk error: ${errMsg}`);
          } else {
            this._state = "complete";
            this._result = (msg as { result?: string }).result ?? "";
          }
          return;
        }
      }
      // Iterator exhausted without result message — treat as complete with empty result.
      if (this._state === "running") {
        this._state = "complete";
        this._result = "";
      }
    } catch (err: unknown) {
      if (this._state === "running" || this._state === "awaiting_input") {
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
 * Build a system-prompt string from opts.system and optional prior_context.
 *
 * Prior context synthesis is text-faithful but lossy for prior tool calls
 * (tool call history cannot be replayed against a new backend — see RDR §S2).
 */
function buildSystemPrompt(
  system: string | undefined,
  priorContext: PriorContext | undefined,
): string | undefined {
  const parts: string[] = [];

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

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
