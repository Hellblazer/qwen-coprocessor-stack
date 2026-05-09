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
import pino from "pino";
import type { Backend, SpawnOpts } from "./types.js";

const log = pino({ name: "qwen-backends" });

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
 * Approx token count via a 1.3× word-count heuristic. NOT tiktoken —
 * the threshold is a routing hint, not a billing number.
 */
export function approxTokens(text: string): number {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return 0;
  return Math.round(trimmed.split(/\s+/).length * 1.3);
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

function roundRobin(key: string, candidates: Backend[]): Backend {
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

  // 1. Explicit pin
  if (opts.backend) {
    const pinned = pool.find((b) => b.id === opts.backend);
    return pinned ?? null;
  }

  // 2. Tier filter
  let candidates = opts.tier ? pool.filter((b) => b.tier === opts.tier) : [...pool];
  if (candidates.length === 0) candidates = [...pool]; // tier mismatch: fall back

  // 3. Capacity classification + filter
  const capacity = opts.capacity ?? classifyCapacity(prompt);
  const capFiltered = candidates.filter((b) => b.capacity === capacity);
  // If no backend has the desired capacity, allow any — better to serve
  // sub-optimally than to fail.
  if (capFiltered.length > 0) candidates = capFiltered;

  // 4. Health filter
  const healthChecks = await Promise.all(
    candidates.map(async (b) => ({ b, healthy: await healthy_lookup(b) })),
  );
  // Treat null (unprobed/timeout) as healthy — optimistic; first real
  // call will mark it false if the backend's actually down.
  const live = healthChecks.filter((h) => h.healthy !== false).map((h) => h.b);

  if (live.length > 0) {
    // 5. Round-robin / weighted
    return roundRobin(`${opts.tier ?? "any"}:${capacity}`, live);
  }

  // 6. No survivors after health: fall back to local
  const local = pool.filter((b) => b.tier === "local");
  const localHealthy = await Promise.all(
    local.map(async (b) => ({ b, healthy: await healthy_lookup(b) })),
  );
  const localLive = localHealthy.filter((h) => h.healthy !== false).map((h) => h.b);
  if (localLive.length > 0) return roundRobin("fallback:local", localLive);

  return null;
}
