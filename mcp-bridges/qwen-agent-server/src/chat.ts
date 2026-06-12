// SPDX-License-Identifier: MIT
//
// chat.ts — direct-HTTP dispatch for `qwen_chat` (bead 5h5).
//
// Operator/general dispatch (extract / summarize / classify / judge /
// answer) that POSTs straight to a backend's /v1/chat/completions,
// bypassing `@qwen-code/sdk` and the Qwen-CLI agentic harness entirely.
//
// Why a separate path from qwen_oneshot: routing simple operator tasks
// through the qwen-code agentic harness (huge coding-agent system
// preamble + tool schemas) was the root cause of three problems
// observed 2026-06-12 (beads 081 / k8j / 5h5):
//   1. SLOW — the 35B took ~20s for a one-token answer (all prefill of
//      the preamble); a direct chat completion to the same model is ~3s.
//   2. PROMPT-ECHO — Coder-Next echoed terse prompts via the agentic
//      path but answers correctly via direct chat.
//   3. CRASH (081) — the agentic request crashes coder-box; a direct
//      chat completion does not.
//
// This is the text twin of dispatchVisionOneshot: same direct POST, same
// json_schema / grammar passthrough, same thread-continuation shape —
// just text content, no images. qwen_oneshot / qwen_spawn remain the
// agentic path for real coding-agent work (file edits, multi-step tools).

import { createLogger } from "./log.js";
import { dispatchOpenAIPost } from "./openai-compat.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-chat");

export interface ChatOpts {
  /** Per-request timeout (ms). Default 120_000. */
  timeout_ms?: number;
  /** Max tokens to generate. Default 2048. */
  max_tokens?: number;
  /** Sampling temperature. Default 0.3. */
  temperature?: number;
  /** Optional system-role prefix. */
  system?: string;
  /**
   * Prepend `/no_think` to suppress Qwen reasoning-mode thinking blocks
   * (qwen3.x reasoning models otherwise spend the token budget thinking
   * before emitting content). Default true.
   */
  no_think?: boolean;
  /** JSON Schema constraint, emitted as response_format.json_schema. */
  json_schema?: Record<string, unknown>;
  /**
   * GBNF grammar for token-by-token output enforcement (llama-server
   * `grammar` field). Strictly stronger than json_schema (post-hoc
   * validated). Like the vision path, this direct dispatch can pass it;
   * the SDK/agentic qwen_oneshot cannot.
   */
  grammar?: string;
}

/** Result shape. Mirrors OneshotResult / VisionOneshotResult for parity. */
export interface ChatResult {
  ok: boolean;
  /** Raw text content from the model's first choice. */
  result?: string;
  /** Parsed JSON, when json_schema was set and the content parsed cleanly. */
  parsed?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  elapsed_ms: number;
  backend_id: string;
  /** Thread id for cross-call context continuity. Always present. */
  continuation_id?: string;
  error?: {
    code:
      | "timeout"
      | "validation_failed"
      | "backend_error"
      | "no_choices";
    message: string;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;

/**
 * POST a text chat completion to a backend's /v1/chat/completions.
 * Returns a ChatResult; never throws — all failures land in result.error.
 *
 * `prior_messages` carries earlier turns from a continuation thread
 * (oldest-first), injected before the current user turn.
 */
export async function dispatchChat(
  backend: Backend,
  task: string,
  opts: ChatOpts = {},
  prior_messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [],
): Promise<ChatResult> {
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const max_tokens = opts.max_tokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const no_think = opts.no_think ?? true;

  const userText = no_think ? `/no_think ${task}` : task;
  const messages: Array<Record<string, unknown>> = [];
  if (opts.system !== undefined && opts.system !== "") {
    messages.push({ role: "system", content: opts.system });
  }
  for (const m of prior_messages) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: userText });

  const body: Record<string, unknown> = {
    model: backend.model,
    messages,
    max_tokens,
    temperature,
    stream: false,
  };
  if (opts.json_schema !== undefined) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema: opts.json_schema },
    };
  }
  if (opts.grammar !== undefined && opts.grammar !== "") {
    body.grammar = opts.grammar;
  }

  const outcome = await dispatchOpenAIPost(backend, "/v1/chat/completions", body, {
    timeout_ms,
  });

  if (!outcome.ok) {
    if (outcome.status !== undefined) {
      log.warn(
        {
          backend_id: backend.id,
          status: outcome.status,
          body_excerpt: outcome.body_text?.slice(0, 200),
        },
        "chat dispatch HTTP failure",
      );
    }
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: outcome.error,
    };
  }

  let body_parsed: {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    body_parsed = JSON.parse(outcome.body_text);
  } catch (err) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: {
        code: "backend_error",
        message: `non-JSON response from backend: ${(err as Error).message}`,
      },
    };
  }

  const content = body_parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      ...(body_parsed.usage !== undefined ? { usage: body_parsed.usage } : {}),
      error: {
        code: "no_choices",
        message: "backend returned no choices or empty content",
      },
    };
  }

  let parsed: unknown | undefined;
  if (opts.json_schema !== undefined) {
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        result: content,
        elapsed_ms: outcome.elapsed_ms,
        backend_id: backend.id,
        ...(body_parsed.usage !== undefined ? { usage: body_parsed.usage } : {}),
        error: {
          code: "validation_failed",
          message: "response did not parse as JSON despite json_schema",
        },
      };
    }
  }

  return {
    ok: true,
    result: content,
    ...(parsed !== undefined ? { parsed } : {}),
    ...(body_parsed.usage !== undefined ? { usage: body_parsed.usage } : {}),
    elapsed_ms: outcome.elapsed_ms,
    backend_id: backend.id,
  };
}
