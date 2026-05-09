// SPDX-License-Identifier: MIT
//
// Session pool: cap enforcement, LRU eviction, idle reaper.
//
// Pool semantics (per RDR-001 §Q4):
//   - Hard cap: QWEN_SUPERVISOR_MAX_SESSIONS (default 3)
//   - Idle TTL: QWEN_SUPERVISOR_IDLE_TTL_MS (default 30 min)
//   - Eviction pass 1: terminal (complete/error) sessions first
//   - Eviction pass 2: least-recently-polled by last_polled_at
//   - Reaper: sweeps idle sessions every 5 min (interval.unref()d)

import pino from "pino";
import type { Backend, SpawnOpts } from "./types.js";
import { QwenSession } from "./session.js";
import { chooseBackend, getSessionBudgetDefaults, loadBackends } from "./backends.js";
import type { ResolveExtensionsResult } from "./extensions.js";

const log = pino({ name: "qwen-pool" });

// ─────────────────────────────────────────────────────────────────
// Types

/** Minimal session interface consumed by the pool. */
export interface PooledSession {
  readonly task_id: string;
  readonly backend: Backend;
  last_polled_at: number;
  readonly state: string;
  stop(): void;
}

/**
 * Per-spawn extension-bridge infrastructure resolved once at supervisor
 * startup (RDR-002 §The wrapper-script bridge):
 *   - qwenRealBin — absolute path to the real Qwen Code binary the
 *     wrapper will `exec`.
 *   - wrapperPath — absolute path to the bash wrapper shipped in this
 *     package; passed to the SDK as `pathToQwenExecutable`.
 *
 * Both default to empty strings to keep test pools (which mock the
 * QwenSession constructor) and existing call sites green. When either
 * is empty, QwenSession falls back to default SDK behaviour (no
 * extension bridging). Production main() always provides both.
 */
export interface SessionPool {
  sessions: Map<string, PooledSession>;
  maxSessions: number;
  idleTtlMs: number;
  backends: Backend[];
  qwenRealBin: string;
  wrapperPath: string;
}

export interface CreatePoolOpts {
  qwenRealBin?: string;
  wrapperPath?: string;
}

// ─────────────────────────────────────────────────────────────────
// Factory

export function createPool(opts: CreatePoolOpts = {}): SessionPool {
  const maxSessions =
    parseInt(process.env["QWEN_SUPERVISOR_MAX_SESSIONS"] ?? "", 10) || 3;
  const idleTtlMs =
    parseInt(process.env["QWEN_SUPERVISOR_IDLE_TTL_MS"] ?? "", 10) || 30 * 60 * 1000;
  const backends = loadBackends();

  return {
    sessions: new Map(),
    maxSessions,
    idleTtlMs,
    backends,
    qwenRealBin: opts.qwenRealBin ?? "",
    wrapperPath: opts.wrapperPath ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────
// LRU eviction

/**
 * Evict one session when the pool is at or above cap.
 *
 * Pass 1: drop any complete/error session (they're done; cheap to evict).
 * Pass 2: evict the session with the smallest last_polled_at.
 */
export function lruEvict(pool: SessionPool): void {
  if (pool.sessions.size < pool.maxSessions) return;

  // Pass 1: terminal sessions
  for (const [id, session] of pool.sessions) {
    if (session.state === "complete" || session.state === "error") {
      session.stop();
      pool.sessions.delete(id);
      log.info(
        { task_id: id, state: session.state, event_type: "evict" },
        "evicted terminal session at cap",
      );
      return;
    }
  }

  // Pass 2: oldest by last_polled_at
  let oldest: PooledSession | undefined;
  let oldestId: string | undefined;
  for (const [id, session] of pool.sessions) {
    if (!oldest || session.last_polled_at < oldest.last_polled_at) {
      oldest = session;
      oldestId = id;
    }
  }
  if (oldest && oldestId !== undefined) {
    oldest.stop();
    pool.sessions.delete(oldestId);
    log.info(
      { task_id: oldestId, event_type: "evict" },
      "evicted LRU session at cap",
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Reaper

/**
 * Sweep sessions idle beyond idleTtlMs. Called periodically by the
 * server's setInterval reaper (every 5 min).
 *
 * Reaps `idle`, `complete`, and `error` sessions that haven't been
 * polled within idleTtlMs. Sessions in the `running` state are SKIPPED
 * regardless of poll age — the inner Qwen may be processing a long
 * tool call (codebase scan, web fetch, etc.) and killing it because
 * the caller hasn't polled would terminate active work. The cap
 * (lruEvict) is the backstop for runaway running sessions.
 */
export function reapSweep(pool: SessionPool): void {
  const now = Date.now();
  const toReap: string[] = [];
  for (const [id, session] of pool.sessions) {
    if (session.state === "running") continue;
    if (now - session.last_polled_at > pool.idleTtlMs) {
      toReap.push(id);
    }
  }
  for (const id of toReap) {
    const session = pool.sessions.get(id);
    if (session) {
      session.stop();
      pool.sessions.delete(id);
      log.info(
        { task_id: id, state: session.state, event_type: "reap" },
        "reaped idle session",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Spawn

/**
 * Spawn a new session, applying LRU eviction if at cap first.
 * Returns the new QwenSession.
 *
 * `resolvedExtensions` is the output of `resolveExtensions()` from the
 * qwen_spawn handler — pre-validated; spawnSession does not re-validate.
 * Pass undefined for code paths (notably tests) that don't supply a
 * resolution; the session will fall through to default SDK behaviour.
 */
export async function spawnSession(
  pool: SessionPool,
  task: string,
  opts: Partial<SpawnOpts>,
  resolvedExtensions?: ResolveExtensionsResult,
): Promise<QwenSession> {
  const spawnOpts: SpawnOpts = {
    write_authority: opts.write_authority ?? false,
    allow_subagents: opts.allow_subagents ?? false,
    ...opts,
  };

  // Evict before adding — ensures we never exceed cap
  while (pool.sessions.size >= pool.maxSessions) {
    lruEvict(pool);
  }

  const backend = await chooseBackend(pool.backends, spawnOpts, task);
  if (!backend) {
    throw new Error("no backend available");
  }

  // Fill in budget defaults now that the backend is known. Caller-set
  // opts win; otherwise env / config / floor(0.85 * backend.ctx_size) /
  // hardcoded fall through (RDR-002 v0.7 amendment). Done here rather
  // than in qwen_spawn so the resolution can reflect the chosen
  // backend's declared context window.
  if (spawnOpts.max_context_tokens === undefined || spawnOpts.max_tool_calls === undefined) {
    const defaults = getSessionBudgetDefaults(process.env, backend);
    if (spawnOpts.max_context_tokens === undefined) {
      spawnOpts.max_context_tokens = defaults.max_context_tokens;
    }
    if (spawnOpts.max_tool_calls === undefined) {
      spawnOpts.max_tool_calls = defaults.max_tool_calls;
    }
  }

  const session = new QwenSession(
    backend,
    task,
    spawnOpts,
    {
      qwenRealBin: pool.qwenRealBin,
      wrapperPath: pool.wrapperPath,
    },
    resolvedExtensions,
  );
  const pooledSession: PooledSession = Object.assign(session, { last_polled_at: Date.now() });
  pool.sessions.set(session.task_id, pooledSession);

  log.info(
    {
      task_id: session.task_id,
      backend_id: backend.id,
      event_type: "spawn",
      state: "running",
    },
    "session spawned",
  );

  return pooledSession as unknown as QwenSession;
}

// ─────────────────────────────────────────────────────────────────
// Remove

export function removeSession(pool: SessionPool, task_id: string): void {
  pool.sessions.delete(task_id);
}
