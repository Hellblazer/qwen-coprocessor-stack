// SPDX-License-Identifier: MIT
//
// serialize.ts — per-key serial execution queue.
//
// Some backends cannot process concurrent requests correctly. mlx_vlm.server
// (vision-mac, Qwen2.5-VL) has no per-request KV isolation: simultaneous
// requests interleave decode state and return CORRUPTED output — silent wrong
// answers, not errors or crashes. Confirmed deterministically 2026-06-13
// (bead qwen-coprocessor-stack-6vl): 4 concurrent OCR requests -> 2 garbage +
// 2 correct; 4 sequential -> 4/4 correct. mlx_lm (reason-mac) is NOT affected
// (it queues correctly). The vision dispatch path serializes per backend id so
// at most one request is in flight to such a backend at a time. Vision is
// low-QPS (OCR / scene description), so the serialization cost is negligible
// versus the cost of silently wrong results.

import type { Backend } from "./types.js";

const tails = new Map<string, Promise<unknown>>();

/**
 * Run `task` such that, for a given `key`, tasks execute strictly one at a
 * time in submission order. Tasks submitted under different keys run
 * concurrently.
 *
 * The returned promise settles with `task`'s own result or rejection. A
 * task's rejection does NOT break the chain — the next queued task for that
 * key still runs.
 */
export function runSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Chain after `prev` settles, running `task` whether prev resolved OR
  // rejected (both handlers are `task`), so one failure can't stall the queue.
  const run = prev.then(task, task);
  // Keep an error-swallowed tail as the chain anchor so a rejection in `run`
  // never propagates into the next submission's `prev`.
  const tail = run.then(
    () => {},
    () => {},
  );
  tails.set(key, tail);
  // Prune the map entry once this tail settles AND no newer task replaced it,
  // so a workload using many distinct keys doesn't grow the map unbounded.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

/**
 * Serialize `fn` per backend id IFF the backend is corruption-prone under
 * concurrency, otherwise run it immediately (full concurrency).
 *
 * The corruption-prone class is multimodal backends (mlx_vlm.server has no
 * per-request KV isolation — bead qwen-coprocessor-stack-6vl). Text backends
 * (coder-box, reason-mac) handle concurrency correctly and MUST stay parallel
 * for throughput, so for them this is a zero-overhead pass-through.
 *
 * Gating on `backend.modality` (not the call path) closes every route to a
 * vision backend's /v1/chat/completions — `qwen_oneshot_vision` AND the
 * `qwen_chat` multimodal-fallback / explicit-pin path — and auto-covers any
 * future multimodal backend without further wiring.
 */
export function maybeSerialize<T>(backend: Backend, fn: () => Promise<T>): Promise<T> {
  return backend.modality === "multimodal" ? runSerial(backend.id, fn) : fn();
}

/** Test-only: clear all queues. */
export function _resetSerialQueues(): void {
  tails.clear();
}
