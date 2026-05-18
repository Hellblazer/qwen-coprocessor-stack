// SPDX-License-Identifier: MIT
//
// Tests for src/embed.ts — direct-HTTP /v1/embeddings dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchEmbed } from "../src/embed.js";
import type { Backend } from "../src/types.js";

const BACKEND: Backend = {
  id: "embed-test",
  url: "http://test.local:1234/v1",
  model: "bge-m3",
  tier: "remote",
  capacity: "heavy",
  modality: "embedding",
};

describe("dispatchEmbed", () => {
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

  it("returns embeddings in input order from single-input request", async () => {
    mockJson(200, {
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: "bge-m3",
      usage: { prompt_tokens: 5, total_tokens: 5 },
    });

    const result = await dispatchEmbed(BACKEND, ["hello"]);
    expect(result.ok).toBe(true);
    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.model).toBe("bge-m3");
    expect(result.usage?.prompt_tokens).toBe(5);
    expect(result.backend_id).toBe("embed-test");
  });

  it("preserves input order when data[].index is shuffled", async () => {
    mockJson(200, {
      data: [
        { index: 2, embedding: [3] },
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    });
    const result = await dispatchEmbed(BACKEND, ["a", "b", "c"]);
    expect(result.embeddings).toEqual([[1], [2], [3]]);
  });

  it("sends single string when texts.length === 1, array otherwise", async () => {
    mockJson(200, { data: [{ index: 0, embedding: [1] }] });
    await dispatchEmbed(BACKEND, ["solo"]);
    const body1 = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body1.input).toBe("solo");

    mockJson(200, { data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [2] }] });
    await dispatchEmbed(BACKEND, ["a", "b"]);
    const body2 = JSON.parse(
      (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
    );
    expect(body2.input).toEqual(["a", "b"]);
  });

  it("returns no_data when backend response is empty", async () => {
    mockJson(200, { data: [] });
    const result = await dispatchEmbed(BACKEND, ["x"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_data");
  });

  it("returns no_data when count mismatch (3 in, 2 out)", async () => {
    mockJson(200, {
      data: [
        { index: 0, embedding: [1] },
        { index: 1, embedding: [2] },
      ],
    });
    const result = await dispatchEmbed(BACKEND, ["a", "b", "c"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_data");
    expect(result.error?.message).toContain("expected 3");
  });

  it("classifies HTTP failure as backend_error", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("oops", { status: 503 }));
    const result = await dispatchEmbed(BACKEND, ["x"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_error");
    expect(result.error?.message).toContain("503");
  });

  it("classifies AbortError as timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(err);
    const result = await dispatchEmbed(BACKEND, ["x"], { timeout_ms: 1 });
    expect(result.error?.code).toBe("timeout");
  });

  it("propagates encoding_format opt to body", async () => {
    mockJson(200, { data: [{ index: 0, embedding: [1] }] });
    await dispatchEmbed(BACKEND, ["x"], { encoding_format: "base64" });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.encoding_format).toBe("base64");
  });
});
