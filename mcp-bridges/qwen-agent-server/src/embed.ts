// SPDX-License-Identifier: MIT
//
// embed.ts — direct-HTTP dispatch for `qwen_embed`.
//
// llama-server exposes /v1/embeddings (OpenAI-compat) when started with
// `--embedding` and an embedding-capable model (e.g. bge-m3,
// qwen3-embedding-0.6b). The SDK is text-chat only and doesn't surface
// this endpoint; we POST directly via the shared OpenAI-compat helper.

import { createLogger } from "./log.js";
import { dispatchOpenAIPost } from "./openai-compat.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-embed");

export interface EmbedOpts {
  /** Per-request timeout (ms). Default 60_000 — embeddings are fast. */
  timeout_ms?: number;
  /**
   * Encoding format. llama-server accepts "float" (default).
   * "base64" is a llama-server extension; pass through verbatim.
   */
  encoding_format?: "float" | "base64";
}

export interface EmbedResult {
  ok: boolean;
  /**
   * Embeddings in the same order as input texts. Each vector is the
   * pooled last-layer hidden state (or model-specific projection).
   */
  embeddings?: number[][];
  /** Token usage from the backend. */
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
  /** Wall-clock elapsed in ms (supervisor-side). */
  elapsed_ms: number;
  backend_id: string;
  /** Model name as reported by the backend. */
  model?: string;
  error?: {
    code:
      | "timeout"
      | "backend_error"
      | "no_data"
      | "wrong_modality";
    message: string;
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * POST to a backend's /v1/embeddings with one-or-many text inputs.
 * Never throws; failures encoded in result.error.
 */
export async function dispatchEmbed(
  backend: Backend,
  texts: string[],
  opts: EmbedOpts = {},
): Promise<EmbedResult> {
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const body: Record<string, unknown> = {
    model: backend.model,
    input: texts.length === 1 ? texts[0] : texts,
  };
  if (opts.encoding_format !== undefined) {
    body.encoding_format = opts.encoding_format;
  }

  const outcome = await dispatchOpenAIPost(backend, "/v1/embeddings", body, {
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
        "embed dispatch HTTP failure",
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
    data?: Array<{ embedding?: number[]; index?: number }>;
    model?: string;
    usage?: { prompt_tokens?: number; total_tokens?: number };
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

  if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: { code: "no_data", message: "backend returned empty data array" },
    };
  }

  // Reassemble in input order (data[].index can be sparse on some servers).
  const ordered = [...parsed.data].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const embeddings = ordered
    .map((d) => d.embedding)
    .filter((e): e is number[] => Array.isArray(e));

  if (embeddings.length !== texts.length) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: {
        code: "no_data",
        message: `expected ${texts.length} embeddings, got ${embeddings.length}`,
      },
    };
  }

  return {
    ok: true,
    embeddings,
    ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    elapsed_ms: outcome.elapsed_ms,
    backend_id: backend.id,
  };
}
