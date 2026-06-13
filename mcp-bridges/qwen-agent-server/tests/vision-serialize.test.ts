// SPDX-License-Identifier: MIT
//
// Integration test: dispatchVisionOneshot must serialize concurrent requests
// to a multimodal backend (bead qwen-coprocessor-stack-6vl). This guards the
// WIRING (vision.ts -> maybeSerialize), not just the runSerial primitive — a
// refactor that drops the maybeSerialize wrap would fail here even though the
// serialize.ts unit tests still pass. dispatchOpenAIPost is mocked so no real
// backend is needed; the stub tracks max-in-flight.

import { afterEach, describe, expect, it, vi } from "vitest";

let inFlight = 0;
let maxInFlight = 0;

vi.mock("../src/openai-compat.js", () => ({
  dispatchOpenAIPost: vi.fn(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return {
      ok: true,
      status: 200,
      elapsed_ms: 15,
      body_text: JSON.stringify({
        choices: [{ message: { content: "VOLTAIC-7Q-MARMOSET" } }],
      }),
    };
  }),
}));

import { dispatchVisionOneshot } from "../src/vision.js";
import { _resetSerialQueues } from "../src/serialize.js";
import type { Backend } from "../src/types.js";

afterEach(() => {
  _resetSerialQueues();
  inFlight = 0;
  maxInFlight = 0;
});

const visionBackend: Backend = {
  id: "vision-mac",
  url: "http://localhost:8083/v1",
  model: "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
  modality: "multimodal",
} as Backend;

// tiny valid base64 (1x1 px placeholder); content is irrelevant — POST is mocked
const img = { base64: "aGVsbG8=", mime: "image/png" } as const;

describe("dispatchVisionOneshot serialization (wiring guard)", () => {
  it("never has more than one POST in flight per multimodal backend under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        dispatchVisionOneshot(visionBackend, "read the code", [img], { max_tokens: 64 }),
      ),
    );
    expect(maxInFlight).toBe(1); // serialized — the whole point
    expect(results.every((r) => r.ok && r.result === "VOLTAIC-7Q-MARMOSET")).toBe(true);
  });
});
