// SPDX-License-Identifier: MIT
//
// threads.ts — in-memory conversation threading for stateless oneshot tools.
//
// `qwen_oneshot` and `qwen_oneshot_vision` are stateless by contract:
// each call spawns / connects to a backend, runs one round-trip, and
// returns. Pool sessions handle multi-turn within a single conversation,
// but they cost a process per session and don't cross tool boundaries.
//
// This module is the lightweight alternative: a process-local Map of
// thread_id → ordered turns. Callers pass `continuation_id` on the next
// call; the supervisor prepends prior turns into the prompt (oneshot)
// or the messages array (vision) and returns the same id so the caller
// can chain.
//
// What this is NOT:
//   - Cross-process. Threads live in this process only; restart wipes
//     them. Operator-owned local supervisor; "I want durable threads"
//     is a separate feature (and v1 doesn't ship it).
//   - A session pool. No backend pinning, no budget tracking, no LRU
//     eviction. Threads just remember text.
//   - Image-aware in v1. Vision turns lose their image attachments in
//     the prelude — a `[image attached]` placeholder is emitted instead.

import { randomUUID } from "node:crypto";

/** One conversation turn, role-keyed in OpenAI-style. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Unix ms when the turn was appended. */
  ts: number;
  /** True iff the originating call carried image attachments. v1 does
   *  not store the images themselves; this flag lets the prelude format
   *  emit a `[image attached]` placeholder so the downstream model
   *  knows context is missing. */
  had_images?: boolean;
}

/** Stored thread payload. */
interface Thread {
  id: string;
  turns: Turn[];
  /** Unix ms when the thread expires (last-write + TTL). */
  expires_at: number;
}

export interface ThreadStoreOpts {
  /** Thread TTL in ms. Default 3h (matches industry convention for
   *  short-lived dev conversations). */
  ttl_ms?: number;
  /** Hard cap on turns per thread (oldest dropped on overflow). */
  max_turns?: number;
  /** Reap-sweep interval in ms. Default 10 min. */
  reap_interval_ms?: number;
}

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_REAP_INTERVAL_MS = 10 * 60 * 1000;

export class ThreadStore {
  private readonly threads = new Map<string, Thread>();
  private readonly ttl_ms: number;
  private readonly max_turns: number;
  private reaper: NodeJS.Timeout | null = null;

  constructor(opts: ThreadStoreOpts = {}) {
    this.ttl_ms = opts.ttl_ms ?? DEFAULT_TTL_MS;
    this.max_turns = opts.max_turns ?? DEFAULT_MAX_TURNS;

    const interval = opts.reap_interval_ms ?? DEFAULT_REAP_INTERVAL_MS;
    // Don't start the reaper in tests (set interval to 0 to disable).
    if (interval > 0) {
      this.reaper = setInterval(() => this.reap(), interval);
      // unref() so the interval doesn't keep the process alive on exit.
      this.reaper.unref();
    }
  }

  /**
   * Get or create the thread for `id`. When `id` is undefined or
   * unknown, a fresh thread is created; when known, its expiry is
   * refreshed.
   *
   * Returns the canonical id (caller-supplied or newly minted) plus
   * the current turns in chronological order.
   */
  resolve(id: string | undefined): { id: string; turns: Turn[] } {
    if (id !== undefined && id !== "") {
      const existing = this.threads.get(id);
      if (existing !== undefined && existing.expires_at > Date.now()) {
        existing.expires_at = Date.now() + this.ttl_ms;
        return { id, turns: [...existing.turns] };
      }
      // Honour caller-supplied id even if unknown — they may be
      // restarting a thread after a process bounce. v1 starts a fresh
      // thread under the supplied id rather than rejecting; this is
      // the more useful default.
      const fresh: Thread = {
        id,
        turns: [],
        expires_at: Date.now() + this.ttl_ms,
      };
      this.threads.set(id, fresh);
      return { id, turns: [] };
    }
    const newId = randomUUID();
    const fresh: Thread = {
      id: newId,
      turns: [],
      expires_at: Date.now() + this.ttl_ms,
    };
    this.threads.set(newId, fresh);
    return { id: newId, turns: [] };
  }

  /**
   * Append a turn to thread `id`. Enforces the per-thread turn cap by
   * dropping the oldest turn when full. Idempotent for unknown ids:
   * creates the thread under the supplied id.
   */
  append(id: string, turn: Omit<Turn, "ts">): void {
    const now = Date.now();
    let thread = this.threads.get(id);
    if (thread === undefined) {
      thread = { id, turns: [], expires_at: now + this.ttl_ms };
      this.threads.set(id, thread);
    }
    thread.turns.push({ ...turn, ts: now });
    if (thread.turns.length > this.max_turns) {
      // Drop oldest. This is a simple cap; callers wanting precise
      // token budgeting should also use formatTextPrelude's
      // max_chars knob to cap *serialized* length.
      thread.turns.splice(0, thread.turns.length - this.max_turns);
    }
    thread.expires_at = now + this.ttl_ms;
  }

  /** Number of currently-stored threads (test surface). */
  size(): number {
    return this.threads.size;
  }

  /** True if `id` has any stored turns (test surface). */
  has(id: string): boolean {
    return this.threads.has(id);
  }

  /** Get the turn list for `id`, or [] if unknown. Test surface. */
  turns(id: string): Turn[] {
    return [...(this.threads.get(id)?.turns ?? [])];
  }

  /**
   * Remove expired threads. Called automatically on a timer; exposed
   * for tests that want to drive expiry deterministically without
   * waiting on real time.
   */
  reap(now: number = Date.now()): number {
    let removed = 0;
    for (const [id, t] of this.threads) {
      if (t.expires_at <= now) {
        this.threads.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Stop the reap interval. Test cleanup. */
  shutdown(): void {
    if (this.reaper !== null) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }
}

/**
 * Format a list of prior turns as a text prelude prepended to the
 * current task on `qwen_oneshot` calls (the SDK / Qwen-CLI dispatch
 * path doesn't accept a messages array — only a single prompt string).
 *
 * Drops oldest turns until the serialised prelude fits within
 * `max_chars`. Returns the prelude as a plain string (empty when no
 * turns), suitable for concatenation with the current task.
 */
export function formatTextPrelude(
  turns: Turn[],
  opts: { max_chars?: number } = {},
): string {
  const max = opts.max_chars ?? 50_000;
  if (turns.length === 0) return "";

  // Build newest-first, dropping when over budget. Then reverse for
  // chronological presentation to the model.
  const kept: string[] = [];
  let total = 0;
  const header = "Prior conversation:\n";
  const footer = "\n\nCurrent task:\n";

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const tag = turn.role === "user" ? "[user]" : "[assistant]";
    const attach = turn.had_images ? " [image attached]" : "";
    const block = `${tag}${attach}: ${turn.content}\n`;
    if (total + block.length > max && kept.length > 0) {
      // Budget exceeded; stop including older turns. Keep at least the
      // most recent one even when over budget so the prelude is
      // non-empty.
      break;
    }
    kept.push(block);
    total += block.length;
  }
  if (kept.length === 0) return "";
  // Reverse to chronological order (oldest first).
  kept.reverse();
  return header + kept.join("") + footer;
}

/**
 * Format prior turns as an array of OpenAI-style chat messages for
 * `qwen_oneshot_vision`'s direct-HTTP path. Drops oldest turns until
 * serialised JSON length is under `max_chars`. Images from prior turns
 * are NOT carried forward in v1 — `had_images` turns get a marker
 * appended to their content.
 */
export function formatChatPrelude(
  turns: Turn[],
  opts: { max_chars?: number } = {},
): Array<{ role: "user" | "assistant"; content: string }> {
  const max = opts.max_chars ?? 50_000;
  if (turns.length === 0) return [];

  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  let total = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const content = turn.had_images
      ? `${turn.content}\n[image attached in prior turn — not carried forward]`
      : turn.content;
    const entrySize = content.length + 32; // rough overhead for JSON shape
    if (total + entrySize > max && out.length > 0) break;
    out.unshift({ role: turn.role, content });
    total += entrySize;
  }
  return out;
}
