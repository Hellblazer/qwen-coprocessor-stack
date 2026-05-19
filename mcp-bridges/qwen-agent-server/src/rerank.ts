// SPDX-License-Identifier: MIT
//
// rerank.ts — direct-HTTP dispatch for `qwen_rerank`.
//
// llama-server exposes /v1/rerank (with aliases /rerank, /reranking,
// /v1/reranking) when started with `--reranking` and a reranker model
// (e.g. qwen3-reranker, bge-reranker). Returns relevance scores for
// each document against the query.

import { createLogger } from "./log.js";
import { dispatchOpenAIPost } from "./openai-compat.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-rerank");

export interface RerankOpts {
  /** Per-request timeout (ms). Default 60_000. */
  timeout_ms?: number;
  /** Return only the top-N results by score. Server-side prune. */
  top_n?: number;
  /** Include the document text in each result. Default false. */
  return_documents?: boolean;
}

export interface RerankResult {
  ok: boolean;
  /**
   * Reranked results, sorted by `relevance_score` descending. `index`
   * refers to position in the *input* `documents` array. `document`
   * present iff `opts.return_documents=true`.
   */
  results?: Array<{
    index: number;
    relevance_score: number;
    document?: string;
  }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  elapsed_ms: number;
  backend_id: string;
  model?: string;
  error?: {
    code: "timeout" | "backend_error" | "no_results" | "wrong_modality";
    message: string;
  };
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function dispatchRerank(
  backend: Backend,
  query: string,
  documents: string[],
  opts: RerankOpts = {},
): Promise<RerankResult> {
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const body: Record<string, unknown> = {
    model: backend.model,
    query,
    documents,
  };
  if (opts.top_n !== undefined) body.top_n = opts.top_n;
  if (opts.return_documents !== undefined) {
    body.return_documents = opts.return_documents;
  }

  const outcome = await dispatchOpenAIPost(backend, "/v1/rerank", body, {
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
        "rerank dispatch HTTP failure",
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
    results?: Array<{
      index?: number;
      relevance_score?: number;
      document?: string | { text?: string };
    }>;
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

  if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: { code: "no_results", message: "backend returned empty results" },
    };
  }

  // Normalize: ensure index + relevance_score present; flatten
  // document.{text} shape that some servers emit.
  const results = parsed.results
    .filter(
      (r) =>
        typeof r.index === "number" && typeof r.relevance_score === "number",
    )
    .map((r) => {
      const out: { index: number; relevance_score: number; document?: string } = {
        index: r.index as number,
        relevance_score: r.relevance_score as number,
      };
      if (typeof r.document === "string") {
        out.document = r.document;
      } else if (r.document && typeof r.document === "object" && typeof r.document.text === "string") {
        out.document = r.document.text;
      }
      return out;
    })
    .sort((a, b) => b.relevance_score - a.relevance_score);

  return {
    ok: true,
    results,
    ...(parsed.usage !== undefined ? { usage: parsed.usage } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    elapsed_ms: outcome.elapsed_ms,
    backend_id: backend.id,
  };
}
