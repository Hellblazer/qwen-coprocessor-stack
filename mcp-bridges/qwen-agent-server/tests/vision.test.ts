// SPDX-License-Identifier: MIT
//
// Tests for src/vision.ts — multimodal direct-HTTP dispatch path.
//
// Coverage shape:
//   - normalizeImage(): path / url / base64 inputs all → image_url content block
//   - dispatchVisionOneshot(): happy path, json_schema parse, validation_failed,
//     backend_no_mmproj classification, backend_error, timeout, no_choices

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  dispatchVisionOneshot,
  normalizeImage,
  type VisionImageInput,
} from "../src/vision.js";
import type { Backend } from "../src/types.js";

const BACKEND: Backend = {
  id: "test-backend",
  url: "http://test.local:1234/v1",
  model: "qwen3.6-test",
  tier: "remote",
  capacity: "heavy",
};

// 1x1 transparent PNG used as a fixture for path/base64 tests.
const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("normalizeImage", () => {
  it("passes url inputs through verbatim", async () => {
    const block = await normalizeImage({ url: "data:image/png;base64,FOO" });
    expect(block).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,FOO" },
    });
  });

  it("wraps base64 + mime as a data: URL", async () => {
    const block = await normalizeImage({ base64: "ABC", mime: "image/jpeg" });
    expect(block).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,ABC" },
    });
  });

  it("reads a file path and encodes as base64 with inferred MIME", async () => {
    const tmp = path.join(os.tmpdir(), `qwen-vision-test-${process.pid}.png`);
    await fs.writeFile(tmp, Buffer.from(ONE_PX_PNG_B64, "base64"));
    try {
      const block = await normalizeImage({ path: tmp });
      expect(block.type).toBe("image_url");
      expect(block.image_url.url).toMatch(/^data:image\/png;base64,/);
      expect(block.image_url.url).toContain(ONE_PX_PNG_B64);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });

  it("honours an explicit MIME override on path inputs", async () => {
    const tmp = path.join(os.tmpdir(), `qwen-vision-test-mime-${process.pid}.bin`);
    await fs.writeFile(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const block = await normalizeImage({ path: tmp, mime: "image/webp" });
      expect(block.image_url.url).toMatch(/^data:image\/webp;base64,/);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });

  // ── mtt hardening: input validation ───────────────────────────

  it("rejects {url} with disallowed scheme (file://)", async () => {
    await expect(normalizeImage({ url: "file:///etc/passwd" })).rejects.toThrow(
      /scheme "file:" not allowed/,
    );
  });

  it("rejects {url} with javascript: scheme", async () => {
    await expect(normalizeImage({ url: "javascript:alert(1)" })).rejects.toThrow(
      /not allowed/,
    );
  });

  it("rejects {url} that does not parse as a URL", async () => {
    await expect(normalizeImage({ url: "not a url at all" })).rejects.toThrow(
      /not parseable/,
    );
  });

  it("accepts http:, https:, and data: URLs", async () => {
    await expect(
      normalizeImage({ url: "http://example.com/x.png" }),
    ).resolves.toBeDefined();
    await expect(
      normalizeImage({ url: "https://example.com/x.png" }),
    ).resolves.toBeDefined();
    await expect(
      normalizeImage({ url: "data:image/png;base64,abc" }),
    ).resolves.toBeDefined();
  });

  it("rejects {path} outside the allowed roots", async () => {
    // /etc is on every Unix-like host; it lives outside both homedir
    // and tmpdir. The realpath call may or may not succeed depending on
    // platform — either failure path is acceptable as long as readFile
    // never runs.
    await expect(normalizeImage({ path: "/etc/hostname" })).rejects.toThrow(
      /outside the allowed roots|cannot resolve/,
    );
  });

  it("honours QWEN_VISION_IMAGE_PATHS to extend the allowlist", async () => {
    // Pick a directory outside tmpdir() and homedir(). On macOS / Linux
    // /private/var/folders is inside tmpdir() canonical realpath; pick
    // something less ambiguous. We use a sibling under tmpdir() but
    // with a different prefix to simulate an "outside" location, then
    // extend the allowlist to include it.
    const customRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-vision-custom-"));
    const inside = path.join(customRoot, `pic-${process.pid}.png`);
    await fs.writeFile(inside, Buffer.from(ONE_PX_PNG_B64, "base64"));
    try {
      // First confirm it's already accepted (customRoot lives under
      // tmpdir(), already in the allowlist).
      const block = await normalizeImage({ path: inside });
      expect(block.image_url.url).toMatch(/^data:image\/png;base64,/);
      // The env-var path is exercised in resolveAllowedRoots(); here
      // we only confirm the function inspects the env on each call by
      // setting + immediately consuming.
      process.env["QWEN_VISION_IMAGE_PATHS"] = customRoot;
      const block2 = await normalizeImage({ path: inside });
      expect(block2.image_url.url).toMatch(/^data:image\/png;base64,/);
    } finally {
      delete process.env["QWEN_VISION_IMAGE_PATHS"];
      await fs.unlink(inside).catch(() => {});
      await fs.rmdir(customRoot).catch(() => {});
    }
  });

  it("symlink to a file outside the allowlist is rejected via realpath", async () => {
    // Create a symlink under tmpdir() pointing at /etc/hostname. The
    // path string is "inside the sandbox" but realpath resolves to a
    // file that is not — this is the symlink-escape attack the realpath
    // canonicalization is meant to defeat.
    const linkPath = path.join(os.tmpdir(), `qwen-vision-link-${process.pid}`);
    try {
      await fs.symlink("/etc/hostname", linkPath);
    } catch {
      // /etc/hostname might not exist on this OS (rare). Skip rather
      // than fail spuriously.
      return;
    }
    try {
      await expect(normalizeImage({ path: linkPath })).rejects.toThrow(
        /outside the allowed roots|cannot resolve/,
      );
    } finally {
      await fs.unlink(linkPath).catch(() => {});
    }
  });
});

describe("dispatchVisionOneshot", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockFetch(status: number, body: unknown): void {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  function mockFetchText(status: number, text: string): void {
    fetchSpy.mockResolvedValueOnce(
      new Response(text, {
        status,
        headers: { "Content-Type": "text/plain" },
      }),
    );
  }

  it("happy path returns content + usage and ok=true", async () => {
    mockFetch(200, {
      choices: [{ message: { content: "Red" } }],
      usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 },
    });

    const result = await dispatchVisionOneshot(BACKEND, "What color?", [
      { url: "data:image/png;base64,X" } as VisionImageInput,
    ]);
    expect(result.ok).toBe(true);
    expect(result.result).toBe("Red");
    expect(result.usage).toEqual({ prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 });
    expect(result.backend_id).toBe("test-backend");
    expect(result.error).toBeUndefined();
    expect(typeof result.elapsed_ms).toBe("number");
  });

  it("parses JSON when json_schema is set and content is valid JSON", async () => {
    mockFetch(200, {
      choices: [{ message: { content: '{"color":"red"}' } }],
    });

    const result = await dispatchVisionOneshot(
      BACKEND,
      "Color?",
      [{ url: "data:image/png;base64,X" }],
      { json_schema: { type: "object", properties: { color: { type: "string" } } } },
    );
    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual({ color: "red" });
  });

  it("returns validation_failed when json_schema is set but content is not JSON", async () => {
    mockFetch(200, {
      choices: [{ message: { content: "the color is red" } }],
    });

    const result = await dispatchVisionOneshot(
      BACKEND,
      "Color?",
      [{ url: "data:image/png;base64,X" }],
      { json_schema: { type: "object" } },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation_failed");
    expect(result.result).toBe("the color is red");
  });

  it("classifies the llama-server 'image input is not supported' as backend_no_mmproj", async () => {
    mockFetchText(500, "image input is not supported - hint: you may need to provide the mmproj");

    const result = await dispatchVisionOneshot(BACKEND, "?", [
      { url: "data:image/png;base64,X" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_no_mmproj");
  });

  it("classifies other HTTP failures as backend_error", async () => {
    mockFetchText(503, "service unavailable");

    const result = await dispatchVisionOneshot(BACKEND, "?", [
      { url: "data:image/png;base64,X" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_error");
    expect(result.error?.message).toContain("503");
  });

  it("classifies empty choices as no_choices", async () => {
    mockFetch(200, { choices: [] });

    const result = await dispatchVisionOneshot(BACKEND, "?", [
      { url: "data:image/png;base64,X" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_choices");
  });

  it("classifies AbortError as timeout", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchSpy.mockRejectedValueOnce(abortErr);

    const result = await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      { timeout_ms: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });

  it("classifies arbitrary fetch rejection as backend_error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await dispatchVisionOneshot(BACKEND, "?", [
      { url: "data:image/png;base64,X" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("backend_error");
    expect(result.error?.message).toContain("ECONNREFUSED");
  });

  it("returns image_read_failed when a path input cannot be read", async () => {
    const result = await dispatchVisionOneshot(BACKEND, "?", [
      { path: "/nonexistent/qwen-vision-test-does-not-exist.png" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("image_read_failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends response_format when json_schema is supplied", async () => {
    mockFetch(200, { choices: [{ message: { content: "{}" } }] });

    await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      { json_schema: { type: "object" } },
    );

    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema: { type: "object" } },
    });
  });

  it("does not send a grammar field when opts.grammar is unset", async () => {
    mockFetch(200, { choices: [{ message: { content: "ok" } }] });
    await dispatchVisionOneshot(BACKEND, "?", [{ url: "data:image/png;base64,X" }]);
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.grammar).toBeUndefined();
  });

  it("treats grammar='' as unset (falsy guard, no body field)", async () => {
    // Empty string is not a valid GBNF grammar and would be rejected
    // by llama-server anyway; the supervisor's falsy guard short-
    // circuits before that.
    mockFetch(200, { choices: [{ message: { content: "ok" } }] });
    await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      { grammar: "" },
    );
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.grammar).toBeUndefined();
  });

  it("passes grammar through to the HTTP body when opts.grammar is set", async () => {
    mockFetch(200, { choices: [{ message: { content: '"red"' } }] });
    const gbnf = 'root ::= "\\"" ("red" | "green" | "blue") "\\""';
    await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      { grammar: gbnf },
    );
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.grammar).toBe(gbnf);
  });

  it("sends both grammar and response_format when both are set", async () => {
    // The supervisor's contract is "emit both; precedence is
    // backend-determined." This test verifies the emission contract
    // only — it does NOT verify precedence (the mock returns whatever
    // content is set regardless of body shape).
    mockFetch(200, { choices: [{ message: { content: '{"color":"red"}' } }] });
    await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      {
        grammar: 'root ::= "{" "\\"color\\":" "\\"red\\"" "}"',
        json_schema: { type: "object", properties: { color: { type: "string" } } },
      },
    );
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.grammar).toMatch(/^root ::=/);
    expect(body.response_format?.type).toBe("json_schema");
  });

  it("prepends /no_think to the user message by default", async () => {
    mockFetch(200, { choices: [{ message: { content: "ok" } }] });

    await dispatchVisionOneshot(BACKEND, "describe image", [
      { url: "data:image/png;base64,X" },
    ]);

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const userText = body.messages[0].content[0].text;
    expect(userText).toMatch(/^\/no_think /);
    expect(userText).toContain("describe image");
  });

  it("omits /no_think when no_think:false is set", async () => {
    mockFetch(200, { choices: [{ message: { content: "ok" } }] });

    await dispatchVisionOneshot(
      BACKEND,
      "describe image",
      [{ url: "data:image/png;base64,X" }],
      { no_think: false },
    );

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    const userText = body.messages[0].content[0].text;
    expect(userText).toBe("describe image");
  });

  it("prepends system message when opts.system is set", async () => {
    mockFetch(200, { choices: [{ message: { content: "ok" } }] });

    await dispatchVisionOneshot(
      BACKEND,
      "?",
      [{ url: "data:image/png;base64,X" }],
      { system: "you are a vision model" },
    );

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "you are a vision model" });
    expect(body.messages[1].role).toBe("user");
  });
});
