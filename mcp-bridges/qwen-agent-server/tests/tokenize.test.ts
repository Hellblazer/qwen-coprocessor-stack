// SPDX-License-Identifier: MIT
//
// Tests for src/tokenize.ts — direct-HTTP /tokenize dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTokenize } from "../src/tokenize.js";
import type { Backend } from "../src/types.js";

const BACKEND: Backend = {
  id: "text-test",
  url: "http://test.local:8080/v1",
  model: "qwen3.6-test",
  tier: "local",
  capacity: "heavy",
};

describe("dispatchTokenize", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockJson(status: number, body: unknown): void {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("strips /v1 from URL when hitting /tokenize", async () => {
    mockJson(200, { tokens: [1, 2, 3] });
    await dispatchTokenize(BACKEND, "hello");
    const call = fetchSpy.mock.calls[0];
    expect(call?.[0]).toBe("http://test.local:8080/tokenize");
  });

  it("returns flat token array with count", async () => {
    mockJson(200, { tokens: [10, 20, 30, 40] });
    const result = await dispatchTokenize(BACKEND, "hi there");
    expect(result.ok).toBe(true);
    expect(result.tokens).toEqual([10, 20, 30, 40]);
    expect(result.count).toBe(4);
    expect(result.pieces).toBeUndefined();
  });

  it("flattens {id, piece} shape and populates pieces when with_pieces=true", async () => {
    mockJson(200, {
      tokens: [
        { id: 100, piece: "Hello" },
        { id: 200, piece: " world" },
      ],
    });
    const result = await dispatchTokenize(BACKEND, "Hello world", {
      with_pieces: true,
    });
    expect(result.tokens).toEqual([100, 200]);
    expect(result.pieces).toEqual(["Hello", " world"]);
    expect(result.count).toBe(2);
  });

  it("propagates add_special and with_pieces to body", async () => {
    mockJson(200, { tokens: [1] });
    await dispatchTokenize(BACKEND, "x", {
      add_special: true,
      with_pieces: true,
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.add_special).toBe(true);
    expect(body.with_pieces).toBe(true);
    expect(body.content).toBe("x");
  });

  it("returns no_tokens when response lacks tokens field", async () => {
    mockJson(200, { foo: "bar" });
    const result = await dispatchTokenize(BACKEND, "x");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_tokens");
  });

  it("HTTP 500 classifies as backend_error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const result = await dispatchTokenize(BACKEND, "x");
    expect(result.error?.code).toBe("backend_error");
  });

  it("handles a backend URL without /v1 suffix", async () => {
    const plain: Backend = { ...BACKEND, url: "http://test.local:9000" };
    mockJson(200, { tokens: [1] });
    await dispatchTokenize(plain, "x");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://test.local:9000/tokenize");
  });
});
