// SPDX-License-Identifier: MIT
//
// tokenize.ts — direct-HTTP dispatch for `qwen_tokenize`.
//
// llama-server exposes /tokenize (NOT /v1/tokenize — sits outside the
// OpenAI-compat namespace). Returns the model's exact token IDs and
// count. Useful for budget arithmetic, chunk sizing, and pre-flight
// context-window math.
//
// The tokenizer is colocated with whatever model is loaded — any
// text or multimodal backend can serve this call. No new modality.

import { createLogger } from "./log.js";
import { dispatchOpenAIPost } from "./openai-compat.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-tokenize");

export interface TokenizeOpts {
  /** Per-request timeout (ms). Default 30_000 — tokenize is cheap. */
  timeout_ms?: number;
  /**
   * Whether to add the model's special tokens (BOS etc). Default
   * false — callers usually want a "natural" count for budget math.
   */
  add_special?: boolean;
  /**
   * Include token *pieces* (string form) alongside ids. Adds payload
   * size; default false.
   */
  with_pieces?: boolean;
}

export interface TokenizeResult {
  ok: boolean;
  tokens?: number[];
  /** Length of `tokens`. Convenience for callers doing budget math. */
  count?: number;
  /** Present iff opts.with_pieces=true. */
  pieces?: string[];
  elapsed_ms: number;
  backend_id: string;
  error?: {
    code: "timeout" | "backend_error" | "no_tokens";
    message: string;
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function dispatchTokenize(
  backend: Backend,
  content: string,
  opts: TokenizeOpts = {},
): Promise<TokenizeResult> {
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const body: Record<string, unknown> = { content };
  if (opts.add_special !== undefined) body.add_special = opts.add_special;
  if (opts.with_pieces !== undefined) body.with_pieces = opts.with_pieces;

  // `/tokenize` sits at server root, not under /v1. The shared
  // buildRequestUrl helper strips `/v1` from backend.url when the
  // endpoint is non-/v1 root-relative.
  const outcome = await dispatchOpenAIPost(backend, "/tokenize", body, {
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
        "tokenize dispatch HTTP failure",
      );
    }
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: outcome.error,
    };
  }

  let parsed: {
    tokens?: Array<number | { id?: number; piece?: string }>;
  };
  try {
    parsed = JSON.parse(outcome.body_text);
  } catch (err) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: {
        code: "backend_error",
        message: `non-JSON response: ${(err as Error).message}`,
      },
    };
  }

  if (!Array.isArray(parsed.tokens)) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: { code: "no_tokens", message: "backend returned no tokens field" },
    };
  }

  // With with_pieces=true, llama-server emits [{id, piece}, …]; without,
  // it emits a flat number[]. Normalize both shapes.
  const ids: number[] = [];
  const pieces: string[] = [];
  for (const t of parsed.tokens) {
    if (typeof t === "number") {
      ids.push(t);
    } else if (t && typeof t === "object" && typeof t.id === "number") {
      ids.push(t.id);
      if (typeof t.piece === "string") pieces.push(t.piece);
    }
  }

  return {
    ok: true,
    tokens: ids,
    count: ids.length,
    ...(pieces.length > 0 ? { pieces } : {}),
    elapsed_ms: outcome.elapsed_ms,
    backend_id: backend.id,
  };
}
