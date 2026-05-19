// SPDX-License-Identifier: MIT
//
// openai-compat.ts — shared OpenAI-compatible dispatch primitives.
//
// All the direct-HTTP tools (qwen_oneshot_vision, qwen_embed, qwen_rerank,
// qwen_tokenize) bypass `@qwen-code/sdk` (which is Qwen-CLI/text-chat
// only) and POST directly to the backend. Before this module, each tool
// duplicated the fetch/abort/HTTP-error-classification/JSON-parse logic.
//
// This module centralises that pattern. Each module supplies:
//   - the endpoint suffix to hit (relative to backend.url, with /v1
//     handling per-endpoint as needed)
//   - the request body
//   - per-module response normalization and specialized error codes
//     (no_data / no_results / no_tokens / wrong_modality / etc.)
//
// What's centralised here:
//   - auth header resolution (api_key literal / api_key_env / extra headers)
//   - timeout via AbortController
//   - HTTP error envelope { timeout | backend_error }
//   - JSON parse error envelope
//   - status code + raw response text passthrough so callers can
//     classify specific provider error shapes (e.g. vision's "image
//     input is not supported" -> backend_no_mmproj)
//
// What's NOT centralised:
//   - response normalization (each endpoint has its own shape)
//   - module-specific error codes (kept in each caller for type-safety
//     of the public error union)

import type { Backend } from "./types.js";

/**
 * Outcome of a dispatch attempt. Discriminated by `ok`.
 *
 * On success the caller can `JSON.parse` `body_text` itself or, when
 * the parsed value's shape is known statically, request a typed parse
 * via `dispatchJSON<T>` (below) which centralises the JSON.parse error.
 */
export type DispatchOutcome =
  | {
      ok: true;
      status: number;
      body_text: string;
      elapsed_ms: number;
    }
  | {
      ok: false;
      elapsed_ms: number;
      /** HTTP status, when the request reached the server. */
      status?: number;
      /** Response body (≤300 chars), when status was non-2xx. Used by
       *  callers that need to classify specific provider error shapes. */
      body_text?: string;
      error: {
        code: "timeout" | "backend_error";
        message: string;
      };
    };

/**
 * Resolve the Authorization + extra headers to send to this backend.
 *
 * - If `backend.api_key` is set, use it directly.
 * - Else if `backend.api_key_env` is set, read `process.env[that]` at
 *   request time (rotations apply on next call, no supervisor reload).
 * - Then merge `backend.headers` (caller overrides built-ins).
 *
 * Returns an empty object for backends with no auth (the common local
 * llama-server case).
 */
export function resolveAuthHeaders(backend: Backend): Record<string, string> {
  const headers: Record<string, string> = {};

  let key: string | undefined;
  if (backend.api_key !== undefined && backend.api_key !== "") {
    key = backend.api_key;
  } else if (backend.api_key_env !== undefined && backend.api_key_env !== "") {
    key = process.env[backend.api_key_env];
  }
  if (key !== undefined && key !== "") {
    headers["Authorization"] = `Bearer ${key}`;
  }

  if (backend.headers !== undefined) {
    Object.assign(headers, backend.headers);
  }

  return headers;
}

/**
 * Compose a request URL from a backend's base + an endpoint suffix.
 *
 * Three cases:
 *   - `endpoint` starts with `/v1/` and backend.url ends in `/v1` →
 *     trim one /v1 to avoid duplication.
 *   - `endpoint` starts with `/` and is non-/v1 (e.g. `/tokenize`) →
 *     strip the `/v1` suffix from backend.url so the request lands at
 *     the server root.
 *   - Otherwise just join.
 *
 * Trailing slashes on backend.url are normalised away.
 */
export function buildRequestUrl(backendUrl: string, endpoint: string): string {
  const base = backendUrl.replace(/\/$/, "");
  if (endpoint.startsWith("/v1/")) {
    // Backend URL likely ends in /v1; strip it so we don't double up.
    return `${base.replace(/\/v1$/, "")}${endpoint}`;
  }
  if (endpoint.startsWith("/") && !endpoint.startsWith("/v1")) {
    // Root-relative non-v1 (e.g. /tokenize) — strip /v1 from base.
    return `${base.replace(/\/v1$/, "")}${endpoint}`;
  }
  // Default: append as a path under the configured base.
  return `${base}/${endpoint.replace(/^\//, "")}`;
}

/**
 * POST a JSON body to an OpenAI-compatible endpoint on a backend.
 *
 * Resolves auth + custom headers, manages the AbortController timeout,
 * classifies network / HTTP failures into the shared envelope, and
 * returns the raw response text on success so each caller can do its
 * own typed parse (the JSON shape is endpoint-specific).
 *
 * Never throws.
 */
export async function dispatchOpenAIPost(
  backend: Backend,
  endpoint: string,
  body: unknown,
  opts: { timeout_ms: number },
): Promise<DispatchOutcome> {
  const start = Date.now();
  const url = buildRequestUrl(backend.url, endpoint);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...resolveAuthHeaders(backend),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout_ms);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      error: aborted
        ? { code: "timeout", message: `request aborted after ${opts.timeout_ms}ms` }
        : {
            code: "backend_error",
            message: err instanceof Error ? err.message : String(err),
          },
    };
  }
  clearTimeout(timer);

  const text = await resp.text();
  if (!resp.ok) {
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      status: resp.status,
      body_text: text,
      error: {
        code: "backend_error",
        message: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
      },
    };
  }

  return {
    ok: true,
    status: resp.status,
    body_text: text,
    elapsed_ms: Date.now() - start,
  };
}
