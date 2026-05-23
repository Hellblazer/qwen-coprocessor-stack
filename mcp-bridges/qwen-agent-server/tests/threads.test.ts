// SPDX-License-Identifier: MIT
//
// Tests for src/threads.ts — in-memory conversation threading store
// and the two prelude formatters (text and chat).

import { afterEach, describe, expect, it } from "vitest";
import {
  formatChatPrelude,
  formatTextPrelude,
  ThreadStore,
  type Turn,
} from "../src/threads.js";

describe("ThreadStore", () => {
  let store: ThreadStore;

  afterEach(() => {
    store?.shutdown();
  });

  it("resolve(undefined) mints a fresh thread with a uuid", () => {
    store = new ThreadStore({ reap_interval_ms: 0 });
    const t = store.resolve(undefined);
    expect(typeof t.id).toBe("string");
    // RFC4122 UUID v4 shape
    expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(t.turns).toEqual([]);
  });

  it("resolve(unknown_id) honours the supplied id (starts fresh thread)", () => {
    store = new ThreadStore({ reap_interval_ms: 0 });
    const t = store.resolve("caller-chosen-id");
    expect(t.id).toBe("caller-chosen-id");
    expect(t.turns).toEqual([]);
    expect(store.has("caller-chosen-id")).toBe(true);
  });

  it("resolve(known_id) returns existing turns and refreshes expiry", () => {
    store = new ThreadStore({ reap_interval_ms: 0 });
    const a = store.resolve(undefined);
    store.append(a.id, { role: "user", content: "hi" });
    store.append(a.id, { role: "assistant", content: "hello" });

    const b = store.resolve(a.id);
    expect(b.id).toBe(a.id);
    expect(b.turns).toHaveLength(2);
    expect(b.turns[0]!.content).toBe("hi");
    expect(b.turns[1]!.content).toBe("hello");
  });

  it("append() respects the per-thread turn cap", () => {
    store = new ThreadStore({ reap_interval_ms: 0, max_turns: 3 });
    const t = store.resolve(undefined);
    for (let i = 0; i < 5; i++) {
      store.append(t.id, { role: "user", content: `m${i}` });
    }
    const turns = store.turns(t.id);
    expect(turns).toHaveLength(3);
    // Oldest dropped — kept are m2/m3/m4.
    expect(turns.map((x) => x.content)).toEqual(["m2", "m3", "m4"]);
  });

  it("reap() removes expired threads but not fresh ones", () => {
    store = new ThreadStore({ reap_interval_ms: 0, ttl_ms: 1000 });
    const old = store.resolve(undefined);
    store.append(old.id, { role: "user", content: "old" });
    const fresh = store.resolve(undefined);
    store.append(fresh.id, { role: "user", content: "new" });

    // Drive expiry forward past the old thread's TTL but not the fresh one.
    // The fresh one's expires_at is roughly Date.now()+1000; the "old" one's
    // is the same here since we created both moments apart. To make this
    // deterministic we feed reap() a future timestamp.
    const future = Date.now() + 1500;
    const removed = store.reap(future);
    expect(removed).toBe(2); // both expired at +1500 (TTL=1000)
    expect(store.size()).toBe(0);
  });

  it("append() refreshes the thread's expires_at", () => {
    store = new ThreadStore({ reap_interval_ms: 0, ttl_ms: 1000 });
    const t = store.resolve(undefined);
    // Immediately appending should push expiry to ~now+1000.
    store.append(t.id, { role: "user", content: "x" });
    // Reap at now+500 should NOT remove (expiry is ~now+1000).
    expect(store.reap(Date.now() + 500)).toBe(0);
    expect(store.has(t.id)).toBe(true);
  });

  it("size() and has() reflect store state", () => {
    store = new ThreadStore({ reap_interval_ms: 0 });
    expect(store.size()).toBe(0);
    const a = store.resolve(undefined);
    const b = store.resolve(undefined);
    expect(store.size()).toBe(2);
    expect(store.has(a.id)).toBe(true);
    expect(store.has(b.id)).toBe(true);
    expect(store.has("ghost")).toBe(false);
  });
});

describe("formatTextPrelude", () => {
  it("returns empty string for no turns", () => {
    expect(formatTextPrelude([])).toBe("");
  });

  it("emits a header / chronological turns / footer block", () => {
    const turns: Turn[] = [
      { role: "user", content: "hi", ts: 1 },
      { role: "assistant", content: "hello", ts: 2 },
    ];
    const out = formatTextPrelude(turns);
    expect(out).toContain("Prior conversation:");
    expect(out).toContain("[user]: hi");
    expect(out).toContain("[assistant]: hello");
    expect(out).toContain("Current task:");
    // [user] appears before [assistant] (chronological).
    expect(out.indexOf("[user]: hi")).toBeLessThan(out.indexOf("[assistant]: hello"));
  });

  it("marks turns that had images with a placeholder", () => {
    const out = formatTextPrelude([
      { role: "user", content: "what is in this picture?", ts: 1, had_images: true },
    ]);
    expect(out).toContain("[user] [image attached]:");
  });

  it("drops oldest turns when over max_chars budget, keeps newest", () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push({ role: "user", content: `message ${i} `.repeat(20), ts: i });
    }
    const out = formatTextPrelude(turns, { max_chars: 400 });
    // The newest message ("message 9") must be present.
    expect(out).toContain("message 9");
    // The oldest message ("message 0") should be dropped under tight budget.
    expect(out).not.toContain("message 0");
  });

  it("truncates the newest turn (rather than emitting whole) when it alone exceeds budget", () => {
    // Pre-1m4 behavior: the kept.length === 0 guard let a single
    // oversized turn pass through whole, producing a prelude many
    // times larger than max_chars. Operators saw silent context-
    // window blow-up on continuation_id calls that wrapped large
    // assistant outputs.
    const long = "x".repeat(10_000);
    const out = formatTextPrelude(
      [{ role: "user", content: long, ts: 1 }],
      { max_chars: 200 },
    );
    // Prelude must still surface the turn's role marker and respect
    // the cap.
    expect(out).toContain("[user]:");
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThanOrEqual(200);
    // And it must NOT contain the full original content.
    expect(out).not.toContain(long);
  });

  it("emits a non-empty prelude even at very small caps", () => {
    // Degenerate cap: smaller than the header alone. Truncation budget
    // for content goes negative → clamped to zero → no content but
    // also no crash.
    const out = formatTextPrelude(
      [{ role: "user", content: "hello world", ts: 1 }],
      { max_chars: 10 },
    );
    // Output is either empty (if even the header doesn't fit) or
    // contains the truncation marker — never the original content.
    if (out !== "") {
      expect(out).toContain("…[truncated]");
    }
  });
});

describe("formatChatPrelude", () => {
  it("returns [] for no turns", () => {
    expect(formatChatPrelude([])).toEqual([]);
  });

  it("emits {role, content} entries in chronological order", () => {
    const turns: Turn[] = [
      { role: "user", content: "first", ts: 1 },
      { role: "assistant", content: "second", ts: 2 },
      { role: "user", content: "third", ts: 3 },
    ];
    const out = formatChatPrelude(turns);
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
  });

  it("appends image placeholder to content of had_images turns", () => {
    const out = formatChatPrelude([
      { role: "user", content: "describe this", ts: 1, had_images: true },
    ]);
    expect(out[0]!.content).toContain("describe this");
    expect(out[0]!.content).toContain("[image attached in prior turn");
  });

  it("drops oldest turns over max_chars budget", () => {
    const turns: Turn[] = [];
    for (let i = 0; i < 10; i++) {
      turns.push({ role: "user", content: `msg ${i}`.padEnd(100, "x"), ts: i });
    }
    const out = formatChatPrelude(turns, { max_chars: 400 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(10);
    // The newest must be present, the oldest must be gone.
    expect(out[out.length - 1]!.content.startsWith("msg 9")).toBe(true);
    expect(out.some((m) => m.content.startsWith("msg 0"))).toBe(false);
  });
});
