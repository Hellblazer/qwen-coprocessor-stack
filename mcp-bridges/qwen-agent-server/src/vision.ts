// SPDX-License-Identifier: MIT
//
// vision.ts — direct-HTTP multimodal dispatch path for `qwen_oneshot_vision`.
//
// @qwen-code/sdk's ContentBlock union is {TextBlock | ThinkingBlock |
// ToolUseBlock | ToolResultBlock} — there is no ImageBlock. The whole
// SDK pipeline (qwen_spawn → query() → CLI subprocess) is text-only.
// To pass images we bypass the SDK entirely and POST directly to the
// backend's OpenAI-compat /v1/chat/completions endpoint, matching the
// shape llama-server expects when its --mmproj projector is loaded.
//
// Prerequisite: the chosen backend must be running with --mmproj.
// Without it, llama-server returns:
//   "image input is not supported - hint: if this is unexpected, you
//   may need to provide the mmproj"
// at HTTP 500. The supervisor surfaces this as `error.code="backend_no_mmproj"`
// so callers can route around or fail cleanly.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createLogger } from "./log.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-vision");

/**
 * One image input. Discriminated union over the three normal shapes a
 * caller might present:
 *
 *   - {path}: filesystem path readable by the supervisor process.
 *     Encoded to a base64 data: URL.
 *   - {url}: pre-formed http(s):// or data: URL passed through verbatim.
 *     The backend may or may not be able to fetch http(s):// itself;
 *     llama-server with --mmproj typically accepts data: URLs reliably
 *     and may not implement remote fetch.
 *   - {base64, mime}: raw base64 + MIME type, assembled into a data: URL.
 *
 * The supervisor normalizes all three shapes to a single data:-URL
 * "image_url" content block before POSTing.
 */
export type VisionImageInput =
  | { path: string; mime?: string }
  | { url: string }
  | { base64: string; mime: string };

/** Caller-facing options for `qwen_oneshot_vision`. */
export interface VisionOneshotOpts {
  /** JSON Schema constraint passed as response_format. Optional. */
  json_schema?: Record<string, unknown>;
  /** Per-request timeout (ms). Default 300_000. */
  timeout_ms?: number;
  /** Max tokens to generate. Default 2048 — vision tasks often need
   *  more headroom than text dispatch because thinking-mode reasoning
   *  can be lengthy. */
  max_tokens?: number;
  /** Sampling temperature. Default 0.3 (closer to deterministic for
   *  structured-output workloads). */
  temperature?: number;
  /** System prompt prepended as a system-role message. */
  system?: string;
  /** Disable Qwen's thinking mode by prepending /no_think to the user
   *  message. Default true (multimodal dispatch is typically
   *  task-shaped, not chain-of-thought). */
  no_think?: boolean;
  /**
   * GBNF grammar string passed through to llama-server's `grammar`
   * request field. Forces token-by-token output conformance at
   * decode time — strictly stronger than the post-hoc validation
   * `json_schema` performs. Use when the caller needs guaranteed
   * conformance to a non-JSON pattern, or when JSON-schema
   * validation has been observed to fail under thinking-mode
   * reasoning (the model emits prose that doesn't parse).
   *
   * When BOTH `grammar` and `json_schema` are set, the supervisor
   * emits both fields; llama-server picks one (typically grammar
   * takes precedence). Most callers will use one or the other.
   *
   * The string must be a valid GBNF grammar — see llama.cpp
   * grammar docs. No supervisor-side validation; malformed grammars
   * are rejected by the backend at request time and surface as
   * `error.code='backend_error'`.
   */
  grammar?: string;
}

/** Result shape. Mirrors `OneshotResult` for caller parity. */
export interface VisionOneshotResult {
  ok: boolean;
  /** Raw text content from the model's first choice. */
  result?: string;
  /** Parsed JSON, when json_schema was set and result parsed cleanly. */
  parsed?: unknown;
  /** Token usage from the backend's `usage` field, when present. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** Wall-clock elapsed in ms (supervisor-side). */
  elapsed_ms: number;
  /** Backend that served the request. */
  backend_id: string;
  error?: {
    code:
      | "timeout"
      | "validation_failed"
      | "backend_no_mmproj"
      | "backend_error"
      | "no_choices"
      | "image_read_failed";
    message: string;
  };
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;

// MIME inference from common extensions. Restricted to formats
// llama-server's mmproj reliably accepts; everything else gets
// passed as application/octet-stream and may fail at the backend.
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function inferMimeFromPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/**
 * Normalize one image input to an OpenAI-compat content block.
 * Returns either {image_url} ready to drop into the chat-completions
 * messages array, or throws on a filesystem read failure.
 */
export async function normalizeImage(
  input: VisionImageInput,
): Promise<{ type: "image_url"; image_url: { url: string } }> {
  if ("url" in input) {
    return { type: "image_url", image_url: { url: input.url } };
  }
  if ("base64" in input) {
    return {
      type: "image_url",
      image_url: { url: `data:${input.mime};base64,${input.base64}` },
    };
  }
  // path
  const buf = await fs.readFile(input.path);
  const mime = input.mime ?? inferMimeFromPath(input.path);
  const b64 = buf.toString("base64");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } };
}

/**
 * POST to a backend's /v1/chat/completions with multimodal content.
 * Returns a VisionOneshotResult shape; never throws — all failures are
 * encoded in result.error.
 */
export async function dispatchVisionOneshot(
  backend: Backend,
  task: string,
  images: VisionImageInput[],
  opts: VisionOneshotOpts = {},
): Promise<VisionOneshotResult> {
  const start = Date.now();
  const timeout_ms = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const max_tokens = opts.max_tokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const no_think = opts.no_think ?? true;

  let imageBlocks;
  try {
    imageBlocks = await Promise.all(images.map(normalizeImage));
  } catch (err) {
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      backend_id: backend.id,
      error: {
        code: "image_read_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const userText = no_think ? `/no_think ${task}` : task;
  const messages: Array<Record<string, unknown>> = [];
  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: userText }, ...imageBlocks],
  });

  const body: Record<string, unknown> = {
    model: backend.model,
    messages,
    max_tokens,
    temperature,
    stream: false,
  };
  if (opts.json_schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema: opts.json_schema },
    };
  }
  if (opts.grammar) {
    // GBNF passthrough. llama-server reads this from the top-level
    // `grammar` field on the chat-completions request body.
    body.grammar = opts.grammar;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  let resp: Response;
  try {
    resp = await fetch(`${backend.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      backend_id: backend.id,
      error: aborted
        ? { code: "timeout", message: `request aborted after ${timeout_ms}ms` }
        : {
            code: "backend_error",
            message: err instanceof Error ? err.message : String(err),
          },
    };
  }
  clearTimeout(timer);

  const text = await resp.text();
  if (!resp.ok) {
    // llama-server returns the "image input is not supported" hint with
    // HTTP 500; classify that case specifically so callers can route.
    const noMmproj =
      resp.status === 500 && /image input is not supported/i.test(text);
    log.warn(
      {
        backend_id: backend.id,
        status: resp.status,
        no_mmproj: noMmproj,
        body_excerpt: text.slice(0, 200),
      },
      "vision dispatch HTTP failure",
    );
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      backend_id: backend.id,
      error: {
        code: noMmproj ? "backend_no_mmproj" : "backend_error",
        message: `HTTP ${resp.status}: ${text.slice(0, 300)}`,
      },
    };
  }

  let body_parsed: {
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    body_parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      backend_id: backend.id,
      error: {
        code: "backend_error",
        message: `non-JSON response from backend: ${(err as Error).message}`,
      },
    };
  }

  const choice = body_parsed.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    return {
      ok: false,
      elapsed_ms: Date.now() - start,
      backend_id: backend.id,
      ...(body_parsed.usage !== undefined ? { usage: body_parsed.usage } : {}),
      error: {
        code: "no_choices",
        message: "backend returned no choices or empty content",
      },
    };
  }

  let parsed: unknown | undefined;
  if (opts.json_schema) {
    try {
      parsed = JSON.parse(content);
    } catch {
      return {
        ok: false,
        result: content,
        elapsed_ms: Date.now() - start,
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
    elapsed_ms: Date.now() - start,
    backend_id: backend.id,
  };
}
