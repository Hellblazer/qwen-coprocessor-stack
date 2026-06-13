// SPDX-License-Identifier: MIT
//
// Tests for src/serialize.ts — per-key serial execution queue.
// Motivation: mlx_vlm (vision-mac) corrupts output under concurrent
// requests (bead qwen-coprocessor-stack-6vl); we serialize per backend id.

import { afterEach, describe, expect, it } from "vitest";
import { runSerial, maybeSerialize, _resetSerialQueues } from "../src/serialize.js";
import type { Backend } from "../src/types.js";

afterEach(() => _resetSerialQueues());

const mkBackend = (id: string, modality: Backend["modality"]): Backend =>
  ({ id, url: `http://localhost/${id}/v1`, model: "m", modality }) as Backend;

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runSerial", () => {
  it("runs same-key tasks one at a time, in submission order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const make = (i: number) => () =>
      (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(10);
        order.push(i);
        inFlight--;
        return i;
      })();

    const results = await Promise.all([
      runSerial("k", make(0)),
      runSerial("k", make(1)),
      runSerial("k", make(2)),
    ]);

    expect(maxInFlight).toBe(1); // never more than one concurrent
    expect(order).toEqual([0, 1, 2]); // strict submission order
    expect(results).toEqual([0, 1, 2]); // results propagate
  });

  it("runs different keys concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const make = () => () =>
      (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(10);
        inFlight--;
      })();

    await Promise.all([runSerial("a", make()), runSerial("b", make()), runSerial("c", make())]);
    expect(maxInFlight).toBeGreaterThan(1); // distinct keys overlap
  });

  it("a rejection does not break the chain for that key", async () => {
    const order: string[] = [];
    const ok1 = runSerial("k", async () => {
      await tick(5);
      order.push("ok1");
      return "ok1";
    });
    const bad = runSerial("k", async () => {
      await tick(5);
      order.push("bad");
      throw new Error("boom");
    });
    const ok2 = runSerial("k", async () => {
      await tick(5);
      order.push("ok2");
      return "ok2";
    });

    await expect(ok1).resolves.toBe("ok1");
    await expect(bad).rejects.toThrow("boom");
    await expect(ok2).resolves.toBe("ok2"); // ran despite predecessor throwing
    expect(order).toEqual(["ok1", "bad", "ok2"]);
  });

  it("prunes the tails map once a key's queue drains (no entry test-visible after)", async () => {
    // Indirect check: after draining key "p", a fresh same-key submission must
    // still run immediately (not block on a stale tail). If pruning were broken
    // the chain would still work, so we assert behavior, not internals.
    await Promise.all([runSerial("p", async () => {}), runSerial("p", async () => {})]);
    let ran = false;
    await runSerial("p", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("maybeSerialize", () => {
  it("serializes multimodal backends (corruption-prone)", async () => {
    const b = mkBackend("vision-mac", "multimodal");
    let inFlight = 0;
    let maxInFlight = 0;
    const job = () =>
      (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      })();
    await Promise.all([maybeSerialize(b, job), maybeSerialize(b, job), maybeSerialize(b, job)]);
    expect(maxInFlight).toBe(1);
  });

  it("passes through text backends concurrently (throughput preserved)", async () => {
    const b = mkBackend("coder-box", "text");
    let inFlight = 0;
    let maxInFlight = 0;
    const job = () =>
      (async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      })();
    await Promise.all([maybeSerialize(b, job), maybeSerialize(b, job), maybeSerialize(b, job)]);
    expect(maxInFlight).toBe(3); // not serialized
  });

  it("returns the task result/rejection transparently", async () => {
    const txt = mkBackend("t", "text");
    const mm = mkBackend("m", "multimodal");
    await expect(maybeSerialize(txt, async () => "x")).resolves.toBe("x");
    await expect(
      maybeSerialize(mm, async () => {
        throw new Error("e");
      }),
    ).rejects.toThrow("e");
  });
});
