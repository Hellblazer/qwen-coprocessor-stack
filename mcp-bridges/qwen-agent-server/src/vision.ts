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

import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./log.js";
import { dispatchOpenAIPost } from "./openai-compat.js";
import { maybeSerialize } from "./serialize.js";
import type { Backend } from "./types.js";

const log = createLogger("qwen-vision");

// ─────────────────────────────────────────────────────────────────
// Input validation (bead qwen-coprocessor-stack-mtt)
//
// Pre-mtt: normalizeImage did fs.readFile(input.path) on caller-
// supplied paths with zero sandboxing, and forwarded {url} inputs
// to the backend with zero scheme validation. Single-operator local
// use is self-harm only, but the moment the plugin runs in a shared
// or non-trusting MCP-client setting, both surfaces become arbitrary
// file read / SSRF assist. This module enforces an allowlist on both.

/** Schemes acceptable for {url} inputs. http(s) and data: are what
 *  llama-server's mmproj path is actually known to accept; file:,
 *  javascript:, etc. should never reach the backend. */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "data:"]);

/** Default path roots for {path} inputs. Operators can extend this set
 *  via the QWEN_VISION_IMAGE_PATHS env var (colon-separated absolute
 *  paths). The defaults cover the two common drop-zones — the user's
 *  home directory (screenshots, downloads, image collections) and
 *  os.tmpdir() (clipboard / pasted-image pipelines). */
function resolveAllowedRoots(): string[] {
  const roots = new Set<string>();
  const tmp = fs_realpathSync(os.tmpdir());
  const home = fs_realpathSync(os.homedir());
  if (tmp) roots.add(tmp);
  if (home) roots.add(home);

  const extra = process.env["QWEN_VISION_IMAGE_PATHS"];
  if (extra && extra.trim() !== "") {
    for (const p of extra.split(":")) {
      const trimmed = p.trim();
      if (trimmed === "") continue;
      const real = fs_realpathSync(trimmed);
      if (real) roots.add(real);
    }
  }
  return [...roots];
}

/** Synchronously realpath a directory, returning undefined on any
 *  error (path doesn't exist, permission denied, etc.). Used at root-
 *  resolution time so we never include a non-canonicalized prefix in
 *  the allowlist (which would let symlink trickery escape the sandbox). */
function fs_realpathSync(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** True if `child` (already realpath'd) is inside `parent` (already
 *  realpath'd). Uses path.relative so we get cross-platform separator
 *  handling without manual slicing. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

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
   * GBNF grammar string for token-by-token output enforcement (llama-server
   * `grammar` field). Strictly stronger than json_schema (which is
   * post-hoc validated). Use for non-JSON constrained output or when
   * json_schema validation has been observed to fail.
   *
   * The string must be a valid GBNF grammar — see llama.cpp
   * grammar docs. No supervisor-side validation; malformed grammars
   * are rejected by the backend at request time and surface as
   * `error.code='backend_error'`.
   *
   * **Vision-only.** Not available on `qwen_oneshot`: the text
   * dispatch path goes through `@qwen-code/sdk` → Qwen CLI
   * subprocess, which does not surface llama.cpp's `grammar`
   * parameter. Architectural constraint, not a gap.
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
  /** Thread id for cross-call context continuity; see OneshotResult. */
  continuation_id?: string;
  error?: {
    code:
      | "timeout"
      | "validation_failed"
      | "backend_no_mmproj"
      | "backend_error"
      | "no_choices"
      | "image_read_failed"
      | "wrong_modality";
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
    // Reject anything outside the http(s)/data: allowlist. Past `file:`,
    // `javascript:`, custom schemes etc. would be forwarded to llama-
    // server, which might not handle them cleanly — and `file:` in
    // particular invites local-file disclosure if the backend ever
    // implements remote-fetch.
    let scheme: string;
    try {
      scheme = new URL(input.url).protocol;
    } catch {
      throw new Error(`invalid image URL (not parseable): ${input.url.slice(0, 80)}`);
    }
    if (!ALLOWED_URL_SCHEMES.has(scheme)) {
      throw new Error(
        `image URL scheme "${scheme}" not allowed (permitted: http, https, data)`,
      );
    }
    return { type: "image_url", image_url: { url: input.url } };
  }
  if ("base64" in input) {
    return {
      type: "image_url",
      image_url: { url: `data:${input.mime};base64,${input.base64}` },
    };
  }
  // {path}: resolve via realpath (defeats symlink escape) then verify
  // the canonical path lives under at least one allowlisted root.
  // Operators can extend the root set via QWEN_VISION_IMAGE_PATHS;
  // anything outside is rejected before fs.readFile runs.
  let realPath: string;
  try {
    realPath = await fs.realpath(input.path);
  } catch (err) {
    throw new Error(
      `cannot resolve image path "${input.path}": ${(err as Error).message}`,
    );
  }
  const roots = resolveAllowedRoots();
  if (!roots.some((r) => isInside(realPath, r))) {
    throw new Error(
      `image path "${input.path}" resolves to "${realPath}" which is outside the allowed roots (${roots.join(", ") || "<none configured>"}); set QWEN_VISION_IMAGE_PATHS to extend`,
    );
  }
  const buf = await fs.readFile(realPath);
  const mime = input.mime ?? inferMimeFromPath(realPath);
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
  prior_messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = [],
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
  // Prior turns from a continuation thread, oldest-first. v1 carries
  // only text; images from prior vision turns get a placeholder in the
  // formatter.
  for (const m of prior_messages) {
    messages.push({ role: m.role, content: m.content });
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
  if (opts.grammar !== undefined && opts.grammar !== "") {
    body.grammar = opts.grammar;
  }

  // Serialize per backend id for multimodal backends: mlx_vlm.server has no
  // per-request isolation, so concurrent requests corrupt each other's output
  // (bead qwen-coprocessor-stack-6vl). Only the backend POST is inside the
  // queue — image normalization above runs concurrently. maybeSerialize is a
  // no-op for non-multimodal backends. Vision is low-QPS, so the wait is
  // negligible versus the cost of silently-wrong OCR/scene results.
  const outcome = await maybeSerialize(backend, () =>
    dispatchOpenAIPost(backend, "/v1/chat/completions", body, {
      timeout_ms,
    }),
  );

  if (!outcome.ok) {
    // llama-server returns the "image input is not supported" hint with
    // HTTP 500; classify that case specifically so callers can route.
    const noMmproj =
      outcome.status === 500 &&
      typeof outcome.body_text === "string" &&
      /image input is not supported/i.test(outcome.body_text);
    if (outcome.status !== undefined) {
      log.warn(
        {
          backend_id: backend.id,
          status: outcome.status,
          no_mmproj: noMmproj,
          body_excerpt: outcome.body_text?.slice(0, 200),
        },
        "vision dispatch HTTP failure",
      );
    }
    return {
      ok: false,
      elapsed_ms: outcome.elapsed_ms,
      backend_id: backend.id,
      error: noMmproj
        ? {
            code: "backend_no_mmproj",
            message: outcome.error.message,
          }
        : outcome.error,
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

  const choice = body_parsed.choices?.[0];
  const content = choice?.message?.content;
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
  if (opts.json_schema) {
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
