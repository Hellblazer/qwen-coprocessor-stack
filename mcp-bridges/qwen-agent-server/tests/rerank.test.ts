// SPDX-License-Identifier: MIT
//
// Tests for src/rerank.ts — direct-HTTP /v1/rerank dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRerank } from "../src/rerank.js";
import type { Backend } from "../src/types.js";

const BACKEND: Backend = {
  id: "rerank-test",
  url: "http://test.local:1234/v1",
  model: "qwen3-reranker",
  tier: "remote",
  capacity: "heavy",
  modality: "rerank",
};

describe("dispatchRerank", () => {
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

  it("returns results sorted by relevance_score descending", async () => {
    mockJson(200, {
      results: [
        { index: 0, relevance_score: 0.1 },
        { index: 1, relevance_score: 0.9 },
        { index: 2, relevance_score: 0.5 },
      ],
    });

    const result = await dispatchRerank(BACKEND, "q", ["a", "b", "c"]);
    expect(result.ok).toBe(true);
    expect(result.results?.map((r) => r.index)).toEqual([1, 2, 0]);
    expect(result.results?.[0]!.relevance_score).toBe(0.9);
  });

  it("flattens document.{text} shape when server returns nested", async () => {
    mockJson(200, {
      results: [
        { index: 0, relevance_score: 0.5, document: { text: "hello" } },
      ],
    });
    const result = await dispatchRerank(BACKEND, "q", ["hello"], {
      return_documents: true,
    });
    expect(result.results?.[0]!.document).toBe("hello");
  });

  it("preserves flat document string shape", async () => {
    mockJson(200, {
      results: [{ index: 0, relevance_score: 0.5, document: "plain" }],
    });
    const result = await dispatchRerank(BACKEND, "q", ["plain"]);
    expect(result.results?.[0]!.document).toBe("plain");
  });

  it("propagates top_n and return_documents to body", async () => {
    mockJson(200, { results: [{ index: 0, relevance_score: 0.5 }] });
    await dispatchRerank(BACKEND, "q", ["a"], {
      top_n: 5,
      return_documents: true,
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.top_n).toBe(5);
    expect(body.return_documents).toBe(true);
  });

  it("returns no_results on empty results array", async () => {
    mockJson(200, { results: [] });
    const result = await dispatchRerank(BACKEND, "q", ["a"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_results");
  });

  it("HTTP 500 classifies as backend_error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const result = await dispatchRerank(BACKEND, "q", ["a"]);
    expect(result.error?.code).toBe("backend_error");
  });

  it("AbortError classifies as timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(err);
    const result = await dispatchRerank(BACKEND, "q", ["a"], { timeout_ms: 1 });
    expect(result.error?.code).toBe("timeout");
  });
});
