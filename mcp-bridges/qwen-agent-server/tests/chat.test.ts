// SPDX-License-Identifier: MIT
//
// Tests for src/chat.ts — direct-HTTP /v1/chat/completions dispatch (bead 5h5).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchChat } from "../src/chat.js";
import type { Backend } from "../src/types.js";

const BACKEND: Backend = {
  id: "general-test",
  url: "http://test.local:1234/v1",
  model: "qwen3.6-35b-a3b",
  tier: "remote",
  capacity: "fast",
  modality: "text",
};

function chatResponse(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

describe("dispatchChat", () => {
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

  it("POSTs to /v1/chat/completions and returns the content", async () => {
    mockJson(200, chatResponse("Tokyo"));
    const r = await dispatchChat(BACKEND, "capital of Japan?");
    expect(r.ok).toBe(true);
    expect(r.result).toBe("Tokyo");
    expect(r.backend_id).toBe("general-test");
    expect(r.usage?.total_tokens).toBe(13);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local:1234/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("qwen3.6-35b-a3b");
    expect(sent.stream).toBe(false);
    // no_think defaults true → user content is prefixed.
    const userMsg = sent.messages.find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toBe("/no_think capital of Japan?");
    // No tools / no agentic harness in the body — this is the whole point.
    expect(sent.tools).toBeUndefined();
  });

  it("includes a system message and respects no_think=false", async () => {
    mockJson(200, chatResponse("ok"));
    await dispatchChat(BACKEND, "hi", { system: "You are terse.", no_think: false });
    const sent = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.messages[0]).toEqual({ role: "system", content: "You are terse." });
    expect(sent.messages[1].content).toBe("hi"); // no /no_think prefix
  });

  it("prepends prior_messages (continuation turns) before the user turn", async () => {
    mockJson(200, chatResponse("42"));
    await dispatchChat(
      BACKEND,
      "and double it",
      {},
      [
        { role: "user", content: "what is 21?" },
        { role: "assistant", content: "21" },
      ],
    );
    const sent = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    const roles = sent.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("emits response_format and parses content when json_schema is set", async () => {
    mockJson(200, chatResponse('{"city":"Paris"}'));
    const schema = { type: "object", properties: { city: { type: "string" } } };
    const r = await dispatchChat(BACKEND, "extract city", { json_schema: schema });
    expect(r.ok).toBe(true);
    expect(r.parsed).toEqual({ city: "Paris" });
    const sent = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.response_format.json_schema.schema).toEqual(schema);
  });

  it("returns validation_failed when json_schema set but content is not JSON", async () => {
    mockJson(200, chatResponse("not json"));
    const r = await dispatchChat(BACKEND, "x", { json_schema: { type: "object" } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("validation_failed");
    expect(r.result).toBe("not json"); // raw content preserved
  });

  it("passes a grammar string through to the backend body", async () => {
    mockJson(200, chatResponse("y"));
    await dispatchChat(BACKEND, "x", { grammar: "root ::= \"yes\" | \"no\"" });
    const sent = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.grammar).toBe("root ::= \"yes\" | \"no\"");
  });

  it("classifies a non-2xx as backend_error", async () => {
    mockJson(500, { error: "boom" });
    const r = await dispatchChat(BACKEND, "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("backend_error");
  });

  it("returns no_choices when the backend yields no content", async () => {
    mockJson(200, { choices: [], usage: { total_tokens: 1 } });
    const r = await dispatchChat(BACKEND, "x");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("no_choices");
  });
});
