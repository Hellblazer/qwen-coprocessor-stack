// SPDX-License-Identifier: MIT
//
// Backend pool, routing heuristic, and cached health probe.
//
// Pure-logic-plus-fetch — NO @qwen-code/sdk dependency. The supervisor
// (session.ts) consumes Backend objects from chooseBackend() and uses
// them to configure SDK queries; this module never imports the SDK or
// touches session state.
//
// See RDR-001 §Routing for the 6-step algorithm and §Q4 for cap/idle
// rationale (cap/idle live in server.ts; this module only routes).

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./log.js";
import type { AgentProvider, Backend, SpawnOpts, TaskKind } from "./types.js";
import { backendToAgentProvider, classifyTask } from "./types.js";

const log = createLogger("qwen-backends");

/**
 * On-disk config file resolved at `~/.qwen-coprocessor-stack/config.json`.
 *
 * Supports a hot-reload pattern: callers re-invoke their reader on each
 * spawn / health probe; we cache the parsed object by mtime and re-parse
 * only when the file changes. Existing sessions stay pinned to their
 * backend (RDR-001 §Q3) — only future spawns see the updated list.
 *
 * Schema (object form, forward-extensible):
 *
 *   {
 *     "backends": [
 *       { "id": "...", "url": "...", "model": "...",
 *         "tier": "local" | "remote",
 *         "capacity": "fast" | "heavy",
 *         "weight": 1 }
 *     ],
 *     "default_extensions": ["serena", "context7"]
 *   }
 *
 * Resolution priorities (highest first):
 *   - backends:           QWEN_BACKENDS env → config.backends → DEFAULT_BACKEND
 *   - default extensions: QWEN_DEFAULT_EXTENSIONS env → config.default_extensions → "leave-defaults"
 */
/** Default config dir; tests and operators can override via QWEN_CONFIG_DIR env var. */
const DEFAULT_CONFIG_DIR = join(homedir(), ".qwen-coprocessor-stack");

export function getConfigDir(): string {
  const override = process.env["QWEN_CONFIG_DIR"];
  return override && override.trim() !== "" ? override : DEFAULT_CONFIG_DIR;
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export interface ConfigFileShape {
  backends?: Backend[];
  default_extensions?: string[];
  /**
   * Per-spawn budget caps (RDR-002 §Session budget, 2026-05-09
   * amendment). Both fields are optional; unset/missing falls through
   * to the wired-in defaults in `getSessionBudgetDefaults()`.
   */
  session_budget?: {
    max_context_tokens?: number;
    max_tool_calls?: number;
  };
}

interface ConfigCache {
  mtimeMs: number;
  parsed: ConfigFileShape | null;
}

let _configCache: ConfigCache | null = null;

/** Test-only: drop the cached config so the next read re-parses. */
export function _resetConfigCache(): void {
  _configCache = null;
}

/**
 * Read the full config file, mtime-cached. Returns the parsed object on
 * success, or null when the file doesn't exist / is unreadable / fails
 * to parse. A non-null return doesn't imply any field is populated;
 * consumers check the field they need.
 */
export function readConfig(): ConfigFileShape | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (_configCache && _configCache.mtimeMs === mtimeMs) {
    return _configCache.parsed;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape;
    _configCache = { mtimeMs, parsed };
    return parsed;
  } catch (err) {
    log.warn(
      { event_type: "config_invalid", path, err: err instanceof Error ? err.message : String(err) },
      "config.json present but unreadable; falling through to env / default",
    );
    _configCache = { mtimeMs, parsed: null };
    return null;
  }
}

function readConfigBackends(): Backend[] | null {
  const cfg = readConfig();
  if (!cfg || !Array.isArray(cfg.backends) || cfg.backends.length === 0) return null;
  return cfg.backends;
}

/**
 * Resolved session-budget defaults. Both fields are zero-disabled; a
 * value of 0 means "no cap" (matches QwenSession's internal contract).
 *
 * Resolution priority for `max_context_tokens`:
 *   1. QWEN_MAX_CONTEXT_TOKENS env (numeric)
 *   2. config.session_budget.max_context_tokens
 *   3. floor(0.85 * backend.ctx_size) when a backend is supplied and
 *      its operator-declared ctx_size is positive (RDR-002 v0.7
 *      amendment — closes the gap where a small-ctx local backend got
 *      the same 111000 default as qwentescence)
 *   4. Hardcoded default 111000.
 *
 * Resolution priority for `max_tool_calls`:
 *   1. QWEN_MAX_TOOL_CALLS env
 *   2. config.session_budget.max_tool_calls
 *   3. Hardcoded default 0 (unlimited; not a function of ctx_size).
 *
 * The 0.85 fraction matches the original v0.4 default rationale: the
 * chars/4 token estimate runs ~25–30 % hot vs tiktoken on prose, so the
 * 15 % headroom is precisely the slack that crudeness costs. Caller
 * should supply the chosen backend so spawns that route to a small
 * local backend get a cap that fits, not the qwentescence-shaped one.
 */
export interface ResolvedSessionBudget {
  max_context_tokens: number;
  max_tool_calls: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 111_000;
const DEFAULT_MAX_TOOL_CALLS = 0;
const CTX_SIZE_HEADROOM = 0.85;

function parseNumericEnv(name: string, env: NodeJS.ProcessEnv): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    log.warn(
      { event_type: "config_invalid", source: "env", var: name, raw },
      "env var ignored: not a non-negative integer",
    );
    return null;
  }
  return n;
}

export function getSessionBudgetDefaults(
  env: NodeJS.ProcessEnv = process.env,
  backend?: Backend,
): ResolvedSessionBudget {
  const cfg = readConfig();
  const cfgBudget = cfg?.session_budget;

  const envMaxCtx = parseNumericEnv("QWEN_MAX_CONTEXT_TOKENS", env);
  const cfgMaxCtx =
    typeof cfgBudget?.max_context_tokens === "number" && cfgBudget.max_context_tokens >= 0
      ? cfgBudget.max_context_tokens
      : null;
  const backendDerivedCtx =
    backend !== undefined && typeof backend.ctx_size === "number" && backend.ctx_size > 0
      ? Math.floor(backend.ctx_size * CTX_SIZE_HEADROOM)
      : null;

  const envMaxCalls = parseNumericEnv("QWEN_MAX_TOOL_CALLS", env);
  const cfgMaxCalls =
    typeof cfgBudget?.max_tool_calls === "number" && cfgBudget.max_tool_calls >= 0
      ? cfgBudget.max_tool_calls
      : null;

  return {
    max_context_tokens:
      envMaxCtx ?? cfgMaxCtx ?? backendDerivedCtx ?? DEFAULT_MAX_CONTEXT_TOKENS,
    max_tool_calls: envMaxCalls ?? cfgMaxCalls ?? DEFAULT_MAX_TOOL_CALLS,
  };
}

/**
 * Read `default_extensions` from the config file. Returns null when the
 * field is unset or empty so callers can fall through to the next
 * resolution tier.
 */
export function readConfigDefaultExtensions(): string[] | null {
  const cfg = readConfig();
  if (!cfg || !Array.isArray(cfg.default_extensions) || cfg.default_extensions.length === 0) {
    return null;
  }
  return cfg.default_extensions;
}

// ─────────────────────────────────────────────────────────────────
// Configuration

const DEFAULT_BACKEND: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

const HEALTH_TTL_MS = 30_000;
const COLD_PROBE_TIMEOUT_MS = 2_000;

const HEAVY_KEYWORDS_DEFAULT = "prove,derive,architect,design";
const HEAVY_THRESHOLD_DEFAULT = 2_000;

/**
 * Refresh `pool.backends` in-place from `loadBackends()`. Mutates the
 * existing array reference (splice) so any callers that captured a
 * reference at pool construction time see the new list.
 *
 * Safe to call on every spawn / health probe — the env read is cheap
 * and the file read is mtime-cached. Existing sessions stay pinned to
 * their backend (RDR-001 §Q3); only future spawns and health listings
 * see the updated list.
 */
export function refreshPoolBackends(pool: { backends: Backend[] }): void {
  const fresh = loadBackends();
  pool.backends.splice(0, pool.backends.length, ...fresh);
}

/**
 * Read the active backend list, with hot-reload semantics.
 *
 * Resolution priority:
 *   1. QWEN_BACKENDS env var — back-compat / shell override
 *   2. ~/.qwen-coprocessor-stack/config.json `backends` array
 *   3. DEFAULT_BACKEND fallback
 *
 * Invalid JSON at either source is logged as a warning and the next
 * tier is consulted. The config file is mtime-cached so re-invocation
 * on every spawn is cheap (one stat + maybe one parse).
 */
export function loadBackends(): Backend[] {
  // 1. env override
  const raw = process.env["QWEN_BACKENDS"];
  if (raw && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as Backend[];
      }
    } catch {
      log.warn(
        { event_type: "config_invalid", source: "env" },
        "QWEN_BACKENDS is not valid JSON; falling through to config file / default",
      );
    }
  }

  // 2. config file
  const fromFile = readConfigBackends();
  if (fromFile) return fromFile;

  // 3. default
  return [DEFAULT_BACKEND];
}

// ─────────────────────────────────────────────────────────────────
// Capacity classification

/**
 * Approx token count via a 1.3× word-count heuristic, floored by a
 * chars/4 estimate so whitespace-poor inputs (base64 blobs, minified
 * code, packed JSON) don't silently classify as fast when they're
 * actually heavy. The chars/4 floor matches the budget enforcer's
 * estimate so routing and budgeting agree on input size.
 * NOT tiktoken — the threshold is a routing hint, not a billing
 * number. (Round-2 critique bead 1m4.)
 */
export function approxTokens(text: string): number {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return 0;
  const wordEstimate = trimmed.split(/\s+/).length * 1.3;
  const charEstimate = trimmed.length / 4;
  return Math.round(Math.max(wordEstimate, charEstimate));
}

/**
 * Classify a prompt into 'fast' or 'heavy'. Heavy if either:
 *  - approx token count ≥ ROUTER_HEAVY_THRESHOLD_TOKENS (default 2000), or
 *  - prompt matches any keyword in ROUTER_HEAVY_KEYWORDS (default
 *    "prove,derive,architect,design"); whole-word case-insensitive.
 */
export function classifyCapacity(prompt: string): Backend["capacity"] {
  const threshold = parseInt(
    process.env["ROUTER_HEAVY_THRESHOLD_TOKENS"] ?? String(HEAVY_THRESHOLD_DEFAULT),
    10,
  );
  if (approxTokens(prompt) >= threshold) return "heavy";

  const kwRaw = process.env["ROUTER_HEAVY_KEYWORDS"] ?? HEAVY_KEYWORDS_DEFAULT;
  const keywords = kwRaw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return "fast";
  const lower = prompt.toLowerCase();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) return "heavy";
  }
  return "fast";
}

// ─────────────────────────────────────────────────────────────────
// Health cache

interface HealthEntry {
  healthy: boolean | null;
  probed_at: number;
}

const healthCache = new Map<string, HealthEntry>();
const refreshInFlight = new Set<string>();

/** Test-only helper to clear all health state. */
export function resetHealthCache(): void {
  healthCache.clear();
  refreshInFlight.clear();
  rrCounters.clear();
}

/** Fire one /health probe (or /v1/models fallback) with a hard timeout.
 *
 *  llama-server exposes /health at the host root (NOT under /v1), so we
 *  derive a host base by stripping the /v1 suffix. The OpenAI-compat
 *  /v1/models endpoint is the secondary probe — works across more
 *  backends but is heavier than /health.
 */
export async function probeHealth(backend: Backend): Promise<boolean> {
  const probeUrl = async (url: string, timeoutMs: number): Promise<boolean> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "GET", signal: ac.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };

  const baseUrl = stripTrailingSlash(backend.url);
  const hostBase = baseUrl.replace(/\/v1$/, "");

  // Prefer llama-server /health at the host root.
  if (await probeUrl(`${hostBase}/health`, COLD_PROBE_TIMEOUT_MS)) return true;
  // Fall back to OpenAI-compat /v1/models — universally available on any
  // OpenAI-shaped backend.
  if (await probeUrl(`${baseUrl}/models`, COLD_PROBE_TIMEOUT_MS)) return true;
  return false;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Cache-aware health lookup.
 *
 * - Fresh cache (within TTL): return synchronously.
 * - Stale cache: return cached value, kick off a background refresh.
 * - No cache: SYNC PROBE with 2s timeout, store result. On timeout, store
 *   `null` so the next call re-probes (rather than caching false and
 *   refusing to ever try again).
 *
 * "null" is treated as healthy by chooseBackend (optimistic) so unprobed
 * backends aren't permanently excluded.
 */
export async function getCachedHealth(backend: Backend): Promise<boolean | null> {
  const now = Date.now();
  const cached = healthCache.get(backend.id);

  if (cached && now - cached.probed_at < HEALTH_TTL_MS) {
    return cached.healthy;
  }

  if (cached) {
    // Stale — return current value, refresh in background
    if (!refreshInFlight.has(backend.id)) {
      refreshInFlight.add(backend.id);
      void (async () => {
        try {
          const fresh = await probeHealth(backend);
          healthCache.set(backend.id, { healthy: fresh, probed_at: Date.now() });
        } finally {
          refreshInFlight.delete(backend.id);
        }
      })();
    }
    return cached.healthy;
  }

  // Cold — probe inline with timeout
  try {
    const fresh = await probeHealth(backend);
    healthCache.set(backend.id, { healthy: fresh, probed_at: now });
    return fresh;
  } catch {
    // Treat unexpected probe failure as "unknown" — allow re-probe next call
    healthCache.set(backend.id, { healthy: null, probed_at: now });
    return null;
  }
}

/** Test-only helper: pre-seed the health cache. */
export function _seedHealth(backend_id: string, healthy: boolean | null): void {
  healthCache.set(backend_id, { healthy, probed_at: Date.now() });
}

// ─────────────────────────────────────────────────────────────────
// Round-robin / weighted selection

const rrCounters = new Map<string, number>();

function roundRobin<T extends { weight?: number }>(key: string, candidates: T[]): T {
  if (candidates.length === 0) {
    throw new Error("roundRobin called with empty candidates");
  }
  // Weighted? Expand into a virtual list; otherwise plain RR.
  const totalWeight = candidates.reduce((s, b) => s + (b.weight ?? 1), 0);
  if (candidates.some((b) => b.weight !== undefined)) {
    const i = (rrCounters.get(key) ?? 0) % totalWeight;
    rrCounters.set(key, i + 1);
    let cum = 0;
    for (const b of candidates) {
      cum += b.weight ?? 1;
      if (i < cum) return b;
    }
    return candidates[candidates.length - 1]!;
  }
  const i = (rrCounters.get(key) ?? 0) % candidates.length;
  rrCounters.set(key, i + 1);
  return candidates[i]!;
}

// ─────────────────────────────────────────────────────────────────
// Shared selection spine (RDR-007 P1)

/**
 * Build the `id → Backend` index used by `select()` to map a chosen
 * `AgentProvider` back to its `Backend` and to run the injected health lookup
 * on the original object.
 *
 * Warns (does NOT throw) on duplicate ids: they collapse in the Map, so a
 * colliding id would make `select()` return the last-seen `Backend` rather than
 * the one that produced the chosen provider. Backend ids are expected unique;
 * surfacing the misconfig beats silently mis-routing. The pre-refactor code was
 * immune (it threaded `Backend` objects directly, no id round-trip) — this
 * guard restores that safety on the new path (RDR-007 P1 review, finding M1).
 */
function indexById(pool: Backend[]): Map<string, Backend> {
  const byId = new Map(pool.map((b) => [b.id, b] as const));
  if (byId.size !== pool.length) {
    log.warn(
      { event_type: "duplicate_backend_id", pool_size: pool.length, unique_ids: byId.size },
      "duplicate backend ids in pool; selection may return the wrong backend for a colliding id",
    );
  }
  return byId;
}

/**
 * The provider-agnostic selection spine shared by all three public selectors
 * (RDR-007 P1, bead azf.3). Operates over the `AgentProvider` registry
 * projection of an already-capability-filtered candidate list, then:
 *
 *   1. `excludes` filter — drop any provider whose `excludes` contains `kind`.
 *      This is the RDR-007 hard-exclusion slot. It is BEHAVIOR-NEUTRAL in P1:
 *      `backendToAgentProvider` emits `excludes: []` for every backend, so the
 *      filter removes nothing. P2 (azf.5) is the sole phase that populates it.
 *      Pass `kind === null` to skip the slot entirely (the role selector — a
 *      soft hint, NOT a capability gate; see `chooseBackendByRole`).
 *   2. Health filter — optimistic: `null` (unprobed/timeout) is treated as
 *      healthy, only an explicit `false` is excluded.
 *   3. Weighted round-robin keyed by `rrKey` (the pooling mechanism).
 *
 * `healthy_lookup` receives the ORIGINAL `Backend` (via `byId`), preserving the
 * injected-lookup contract the callers depend on. The chosen provider is mapped
 * back to its `Backend` so the public return type is unchanged.
 *
 * Returns the selected `Backend`, or `null` when the candidate list is empty,
 * fully excluded, or has no live members.
 */
async function select(
  registry: AgentProvider[],
  kind: TaskKind | null,
  rrKey: string,
  healthy_lookup: (b: Backend) => Promise<boolean | null>,
  byId: Map<string, Backend>,
): Promise<Backend | null> {
  if (registry.length === 0) return null;

  // 1. Hard-exclusion slot (behavior-neutral in P1; skipped when kind === null).
  const afterExcludes =
    kind === null ? registry : registry.filter((p) => !p.excludes.includes(kind));
  if (afterExcludes.length === 0) return null;

  // 2. Health filter — treat null (unprobed/timeout) as healthy (optimistic).
  const healthChecks = await Promise.all(
    afterExcludes.map(async (p) => ({ p, healthy: await healthy_lookup(byId.get(p.id)!) })),
  );
  const live = healthChecks.filter((h) => h.healthy !== false).map((h) => h.p);
  if (live.length === 0) return null;

  // 3. Weighted round-robin (pooling).
  const chosen = roundRobin(rrKey, live);
  return byId.get(chosen.id)!;
}

// ─────────────────────────────────────────────────────────────────
// Routing

/**
 * Apply the 6-step routing algorithm. Returns a Backend or null if no
 * candidate is available (caller surfaces this as state: "error").
 *
 * `healthy_lookup` is injectable for tests; production passes
 * `getCachedHealth`. The function is async because health may need
 * a sync probe on first call.
 */
export async function chooseBackend(
  pool: Backend[],
  opts: SpawnOpts,
  prompt: string,
  healthy_lookup: (b: Backend) => Promise<boolean | null> = getCachedHealth,
): Promise<Backend | null> {
  if (pool.length === 0) return null;

  // 1. Explicit pin — caller knows best, bypass all filters
  if (opts.backend) {
    const pinned = pool.find((b) => b.id === opts.backend);
    return pinned ?? null;
  }

  // RDR-007 P1: project the pool to the provider registry once (one-registry
  // pass) and classify the task. The capability filters below stay on `Backend`
  // (they read backend-only fields: vision_only / no_agentic), then survivors
  // are projected per-step and the shared `select()` spine runs excludes (P1:
  // empty) + health + weighted round-robin. `kind` is `agenticLoop` here, or
  // `schemaSynth` when the agentic call carries a json_schema.
  const byId = indexById(pool);
  // The conditional spread is REQUIRED, not over-defensive: under
  // exactOptionalPropertyTypes, `{ json_schema: opts.json_schema }` fails tsc
  // (TS2375) when `opts.json_schema` is `undefined` — an optional prop may be
  // omitted but not explicitly assigned `undefined`. classifyTask still does
  // the `!== undefined` check internally; this only keeps the literal legal.
  const kind = classifyTask({
    opts: opts.json_schema !== undefined ? { json_schema: opts.json_schema } : {},
  });

  // 1b. Chat-compatibility filter — qwen_spawn / qwen_oneshot go
  // through /v1/chat/completions, which embedding/rerank backends
  // do not implement. Unset modality is treated as 'text'; both
  // 'text' and 'multimodal' are accepted (multimodal models can
  // serve text-only chat). See bead qwen-coprocessor-stack-w63.
  const chatPool = pool.filter((b) => {
    const m = b.modality ?? "text";
    // vision_only multimodal backends are dedicated to qwen_oneshot_vision
    // and excluded from text chat (so a vision model doesn't absorb coding
    // traffic meant for the text pool). See Backend.vision_only.
    if (m === "multimodal" && b.vision_only === true) return false;
    // no_agentic backends are excluded from the AGENTIC pool (this selector
    // serves qwen_spawn/qwen_oneshot). They crash on the qwen-code agentic
    // request shape but serve direct qwen_chat / tokenize fine. See bead 081.
    if (b.no_agentic === true) return false;
    return m === "text" || m === "multimodal";
  });
  if (chatPool.length === 0) return null;

  // 2. Tier filter
  let candidates = opts.tier ? chatPool.filter((b) => b.tier === opts.tier) : [...chatPool];
  if (candidates.length === 0) candidates = [...chatPool]; // tier mismatch: fall back

  // 3. Capacity classification + filter
  const capacity = opts.capacity ?? classifyCapacity(prompt);
  const capFiltered = candidates.filter((b) => b.capacity === capacity);
  // If no backend has the desired capacity, allow any — better to serve
  // sub-optimally than to fail.
  if (capFiltered.length > 0) candidates = capFiltered;

  // 4–5. excludes (P1: empty) + health + weighted round-robin, via the shared
  // spine. Returns null when no candidate survives health.
  const main = await select(
    candidates.map(backendToAgentProvider),
    kind,
    `${opts.tier ?? "any"}:${capacity}`,
    healthy_lookup,
    byId,
  );
  if (main) return main;

  // 6. No survivors after health: fall back to local (chat-compatible only).
  const local = chatPool.filter((b) => b.tier === "local");
  return select(local.map(backendToAgentProvider), kind, "fallback:local", healthy_lookup, byId);
}

/**
 * Select a backend by declared modality. Used by `qwen_embed`,
 * `qwen_rerank`, and `qwen_tokenize` — none of which go through the
 * SDK / chat-completions path, so tier+capacity routing doesn't apply.
 *
 * - If `pinned_id` is supplied, return that backend iff it exists; the
 *   caller validates the modality match and surfaces `wrong_modality`.
 * - Otherwise filter by `wanted` (treating unset modality as `'text'`),
 *   then round-robin across healthy candidates. `null` → no match.
 */
export async function chooseBackendByModality(
  pool: Backend[],
  wanted: NonNullable<Backend["modality"]>,
  pinned_id?: string,
  healthy_lookup: (b: Backend) => Promise<boolean | null> = getCachedHealth,
): Promise<Backend | null> {
  if (pool.length === 0) return null;

  if (pinned_id !== undefined) {
    return pool.find((b) => b.id === pinned_id) ?? null;
  }

  // RDR-007 P1: modality is a Backend-only field, so the capability filter
  // stays on Backend; survivors go through the shared spine (excludes empty in
  // P1, health, RR). `kind` follows from the wanted modality (embed/rerank/chat).
  const byId = indexById(pool);
  const candidates = pool.filter((b) => (b.modality ?? "text") === wanted);
  const kind = classifyTask({ modality: wanted });

  return select(candidates.map(backendToAgentProvider), kind, `modality:${wanted}`, healthy_lookup, byId);
}

/**
 * Resolve a healthy backend by an EXPLICIT operator-assigned role (bead k8j).
 *
 * Filters to backends whose `roles` array includes `wanted`, drops
 * unhealthy ones, and picks via weighted round-robin (same pooling as
 * the modality/chat selectors). Returns null if no healthy backend
 * advertises the role.
 *
 * `pinned_id` short-circuits to that backend verbatim (caller authority
 * over the role hint), mirroring chooseBackendByModality.
 *
 * This is a soft routing hint, NOT a capability gate: it does not check
 * modality. A caller asking for role "general" gets whatever backend the
 * operator tagged "general"; if that backend can't actually serve the
 * request the downstream dispatch surfaces the error as usual.
 */
export async function chooseBackendByRole(
  pool: Backend[],
  wanted: string,
  pinned_id?: string,
  healthy_lookup: (b: Backend) => Promise<boolean | null> = getCachedHealth,
): Promise<Backend | null> {
  if (pool.length === 0) return null;

  if (pinned_id !== undefined) {
    return pool.find((b) => b.id === pinned_id) ?? null;
  }

  // RDR-007 P1: role is a SOFT hint, explicitly NOT a capability gate (it does
  // not check modality), so the shared spine runs with `kind = null` — the
  // `excludes` slot is skipped here by design. This keeps role selection a soft
  // hint when `excludes` becomes non-empty in P2. Health + RR are shared.
  const byId = indexById(pool);
  const candidates = pool.filter((b) => b.roles?.includes(wanted) ?? false);

  return select(candidates.map(backendToAgentProvider), null, `role:${wanted}`, healthy_lookup, byId);
}
