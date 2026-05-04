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

import type { Backend, SpawnOpts } from "./types.js";

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
 * Read backends from QWEN_BACKENDS env var (JSON array of Backend) or
 * fall back to a single local backend at port 8080. Invalid JSON is
 * treated as "no override" — log on stderr and use default.
 */
export function loadBackends(): Backend[] {
  const raw = process.env["QWEN_BACKENDS"];
  if (!raw) return [DEFAULT_BACKEND];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [DEFAULT_BACKEND];
    }
    return parsed as Backend[];
  } catch {
    process.stderr.write(
      "qwen-agent-server: QWEN_BACKENDS is not valid JSON; using default local backend\n",
    );
    return [DEFAULT_BACKEND];
  }
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

/** Fire one /health probe (or /v1/models fallback) with a hard timeout. */
export async function probeHealth(backend: Backend): Promise<boolean> {
  const probeOne = async (path: string, timeoutMs: number): Promise<boolean> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${stripTrailingSlash(backend.url)}${path}`, {
        method: "GET",
        signal: ac.signal,
      });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };

  // Prefer /health (llama-server-style), fall back to /v1/models on 404
  // or any non-OK. The 2s ceiling applies independently to each attempt.
  const healthBase = backend.url.replace(/\/v1\/?$/, "");
  if (await probeOne(`${healthBase.replace(backend.url, "")}/health`, COLD_PROBE_TIMEOUT_MS)) {
    return true;
  }
  // healthBase computation above is fragile if url doesn't end in /v1; retry on absolute path
  if (await probeOne("/health", COLD_PROBE_TIMEOUT_MS)) return true;
  if (await probeOne("/models", COLD_PROBE_TIMEOUT_MS)) return true;
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
