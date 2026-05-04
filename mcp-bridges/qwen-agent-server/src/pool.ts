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
import { chooseBackend, loadBackends } from "./backends.js";

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

export interface SessionPool {
  sessions: Map<string, PooledSession>;
  maxSessions: number;
  idleTtlMs: number;
  backends: Backend[];
}

// ─────────────────────────────────────────────────────────────────
// Factory

export function createPool(): SessionPool {
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
 */
export function reapSweep(pool: SessionPool): void {
  const now = Date.now();
  const toReap: string[] = [];
  for (const [id, session] of pool.sessions) {
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
        { task_id: id, event_type: "reap" },
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
 */
export async function spawnSession(
  pool: SessionPool,
  task: string,
  opts: Partial<SpawnOpts>,
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

  const session = new QwenSession(backend, task, spawnOpts);
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
