// SPDX-License-Identifier: MIT
//
// Tests for src/openai-compat.ts — shared dispatch primitives:
//   - resolveAuthHeaders (api_key literal / api_key_env / extra headers)
//   - buildRequestUrl (URL joining with /v1 handling)
//   - dispatchOpenAIPost (fetch + abort + HTTP error envelope)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRequestUrl,
  dispatchOpenAIPost,
  resolveAgenticApiKey,
  resolveAuthHeaders,
  resolveBackendKey,
} from "../src/openai-compat.js";
import type { Backend } from "../src/types.js";

const LOCAL_BACKEND: Backend = {
  id: "local",
  url: "http://localhost:8080/v1",
  model: "qwen3.6",
  tier: "local",
  capacity: "fast",
};

describe("resolveAuthHeaders", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty object for backend with no auth fields", () => {
    expect(resolveAuthHeaders(LOCAL_BACKEND)).toEqual({});
  });

  it("uses api_key literal when set", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key: "sk-test-1234" };
    expect(resolveAuthHeaders(b)).toEqual({
      Authorization: "Bearer sk-test-1234",
    });
  });

  it("reads api_key_env from process.env at call time", () => {
    vi.stubEnv("MY_PROVIDER_KEY", "sk-env-5678");
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "MY_PROVIDER_KEY" };
    expect(resolveAuthHeaders(b)).toEqual({
      Authorization: "Bearer sk-env-5678",
    });
  });

  it("api_key literal wins over api_key_env when both set", () => {
    vi.stubEnv("MY_PROVIDER_KEY", "env-value");
    const b: Backend = {
      ...LOCAL_BACKEND,
      api_key: "literal-value",
      api_key_env: "MY_PROVIDER_KEY",
    };
    expect(resolveAuthHeaders(b).Authorization).toBe("Bearer literal-value");
  });

  it("api_key_env pointing at unset env yields no auth header", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "DEFINITELY_NOT_SET_xyz" };
    expect(resolveAuthHeaders(b)).toEqual({});
  });

  it("empty-string api_key is treated as unset", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key: "" };
    expect(resolveAuthHeaders(b)).toEqual({});
  });

  it("merges backend.headers after auth (caller can override)", () => {
    const b: Backend = {
      ...LOCAL_BACKEND,
      api_key: "k",
      headers: { "HTTP-Referer": "https://example.com", "X-Title": "MyApp" },
    };
    expect(resolveAuthHeaders(b)).toEqual({
      Authorization: "Bearer k",
      "HTTP-Referer": "https://example.com",
      "X-Title": "MyApp",
    });
  });

  it("backend.headers can override Authorization if caller insists", () => {
    const b: Backend = {
      ...LOCAL_BACKEND,
      api_key: "k",
      headers: { Authorization: "Custom override" },
    };
    expect(resolveAuthHeaders(b).Authorization).toBe("Custom override");
  });
});

describe("resolveBackendKey (RDR-012 shared precedence)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("none when backend declares no credential", () => {
    expect(resolveBackendKey(LOCAL_BACKEND)).toEqual({ kind: "none" });
  });

  it("resolved from api_key literal", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key: "sk-lit" };
    expect(resolveBackendKey(b)).toEqual({ kind: "resolved", key: "sk-lit" });
  });

  it("resolved from api_key_env at call time", () => {
    vi.stubEnv("PROV_KEY", "sk-env");
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "PROV_KEY" };
    expect(resolveBackendKey(b)).toEqual({ kind: "resolved", key: "sk-env" });
  });

  it("literal wins over api_key_env", () => {
    vi.stubEnv("PROV_KEY", "sk-env");
    const b: Backend = { ...LOCAL_BACKEND, api_key: "sk-lit", api_key_env: "PROV_KEY" };
    expect(resolveBackendKey(b)).toEqual({ kind: "resolved", key: "sk-lit" });
  });

  it("declared_unset when api_key_env names an unset var", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "DEFINITELY_NOT_SET_xyz" };
    expect(resolveBackendKey(b)).toEqual({ kind: "declared_unset", envVar: "DEFINITELY_NOT_SET_xyz" });
  });

  it("declared_unset when api_key_env names an empty var", () => {
    vi.stubEnv("PROV_KEY", "");
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "PROV_KEY" };
    expect(resolveBackendKey(b)).toEqual({ kind: "declared_unset", envVar: "PROV_KEY" });
  });

  it("empty-string api_key / api_key_env are treated as not declared", () => {
    expect(resolveBackendKey({ ...LOCAL_BACKEND, api_key: "" })).toEqual({ kind: "none" });
    expect(resolveBackendKey({ ...LOCAL_BACKEND, api_key_env: "" })).toEqual({ kind: "none" });
  });
});

describe("resolveAgenticApiKey (RDR-012 Item1 — agentic OPENAI_API_KEY, gate S1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("(a) returns the api_key literal verbatim", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key: "sk-lit" };
    expect(resolveAgenticApiKey(b, {})).toBe("sk-lit");
  });

  it("(b) returns the api_key_env value, read at call time", () => {
    const b: Backend = { ...LOCAL_BACKEND, api_key_env: "PROV_KEY" };
    expect(resolveAgenticApiKey(b, { PROV_KEY: "sk-env" })).toBe("sk-env");
  });

  it("(c) no credential declared → process-global OPENAI_API_KEY", () => {
    expect(resolveAgenticApiKey(LOCAL_BACKEND, { OPENAI_API_KEY: "sk-global" })).toBe("sk-global");
  });

  it("(c) no credential declared and no global → sk-local fallback (unchanged local behavior)", () => {
    expect(resolveAgenticApiKey(LOCAL_BACKEND, {})).toBe("sk-local");
  });

  it("(e) declared-but-unset api_key_env → '' (NOT sk-local, NOT the leaked global) + WARN", () => {
    const warn = vi.fn();
    // The global IS set, to prove S1: we must NOT fall through to it (would leak
    // an unrelated key to a remote provider) and must NOT use sk-local.
    const got = resolveAgenticApiKey(
      { ...LOCAL_BACKEND, api_key_env: "PROV_KEY" },
      { OPENAI_API_KEY: "sk-global" },
      warn,
    );
    expect(got).toBe("");
    expect(got).not.toBe("sk-local");
    expect(got).not.toBe("sk-global");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("PROV_KEY");
  });

  it("(e) the WARN callback receives only the var NAME, never the value (secret hygiene)", () => {
    const warn = vi.fn();
    resolveAgenticApiKey({ ...LOCAL_BACKEND, api_key_env: "PROV_KEY" }, { PROV_KEY: "" }, warn);
    // PROV_KEY was empty here; assert no value (even empty) leaks — only the name.
    expect(warn).toHaveBeenCalledExactlyOnceWith("PROV_KEY");
  });
});

describe("buildRequestUrl", () => {
  it("joins /v1/ endpoint without duplicating /v1", () => {
    expect(buildRequestUrl("http://h:8080/v1", "/v1/chat/completions")).toBe(
      "http://h:8080/v1/chat/completions",
    );
  });

  it("strips /v1 for root-relative non-v1 endpoint (/tokenize)", () => {
    expect(buildRequestUrl("http://h:8080/v1", "/tokenize")).toBe(
      "http://h:8080/tokenize",
    );
  });

  it("handles backend.url without /v1 suffix", () => {
    expect(buildRequestUrl("http://h:9000", "/tokenize")).toBe(
      "http://h:9000/tokenize",
    );
  });

  it("strips trailing slash from backend.url", () => {
    expect(buildRequestUrl("http://h:8080/v1/", "/v1/embeddings")).toBe(
      "http://h:8080/v1/embeddings",
    );
  });

  it("handles relative endpoint (no leading slash)", () => {
    expect(buildRequestUrl("http://h:8080/v1", "embeddings")).toBe(
      "http://h:8080/v1/embeddings",
    );
  });
});

describe("dispatchOpenAIPost", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("attaches Authorization when api_key is set", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const b: Backend = { ...LOCAL_BACKEND, api_key: "secret" };
    await dispatchOpenAIPost(b, "/v1/embeddings", { input: "x" }, { timeout_ms: 5000 });

    const call = fetchSpy.mock.calls[0];
    const init = call?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer secret",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("includes extra headers from backend.headers", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const b: Backend = {
      ...LOCAL_BACKEND,
      headers: { "X-Custom": "yes", "HTTP-Referer": "https://app" },
    };
    await dispatchOpenAIPost(b, "/v1/embeddings", {}, { timeout_ms: 5000 });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h["X-Custom"]).toBe("yes");
    expect(h["HTTP-Referer"]).toBe("https://app");
  });

  it("omits Authorization when no auth configured", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await dispatchOpenAIPost(LOCAL_BACKEND, "/v1/embeddings", {}, {
      timeout_ms: 5000,
    });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  it("returns body_text and status on HTTP failure for caller classification", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("image input is not supported - hint", { status: 500 }),
    );
    const outcome = await dispatchOpenAIPost(
      LOCAL_BACKEND,
      "/v1/chat/completions",
      {},
      { timeout_ms: 5000 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(500);
      expect(outcome.body_text).toContain("image input is not supported");
      expect(outcome.error.code).toBe("backend_error");
    }
  });

  it("classifies AbortError as timeout", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(err);
    const outcome = await dispatchOpenAIPost(LOCAL_BACKEND, "/v1/x", {}, {
      timeout_ms: 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("timeout");
      expect(outcome.status).toBeUndefined();
    }
  });

  it("classifies network error (non-AbortError) as backend_error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const outcome = await dispatchOpenAIPost(LOCAL_BACKEND, "/v1/x", {}, {
      timeout_ms: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("backend_error");
      expect(outcome.error.message).toContain("ECONNREFUSED");
    }
  });

  it("returns body_text on success for caller to JSON.parse", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"data":[1,2,3]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const outcome = await dispatchOpenAIPost(LOCAL_BACKEND, "/v1/x", {}, {
      timeout_ms: 5000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(JSON.parse(outcome.body_text)).toEqual({ data: [1, 2, 3] });
      expect(typeof outcome.elapsed_ms).toBe("number");
    }
  });

  it("builds the correct URL for /tokenize against a /v1 backend.url", async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{"tokens":[]}', { status: 200 }));
    await dispatchOpenAIPost(LOCAL_BACKEND, "/tokenize", { content: "x" }, {
      timeout_ms: 5000,
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:8080/tokenize");
  });
});
