// SPDX-License-Identifier: MIT
//
// SDK pin integration tests — lock @qwen-code/sdk@0.1.7 behavior in place.
//
// Four load-bearing assertions:
//   1. (RDR-001 §C1) KV-cache locality: turn-2 cache_read_input_tokens > 0
//   2. (RDR-001 §C2) ask_user_question (when not excluded) is emitted as a
//      ToolUseBlock with structured input.questions[] — pins SDK message shape.
//   3. (RDR-001 §Q1) streamInput multi-turn answer delivery: a follow-up
//      SDKUserMessage pushed after turn 1's result is consumed by the model
//      in turn 2. The mechanism the supervisor relies on (post-spike rework).
//   4. (RDR-002 Layer 2) pathToQwenExecutable wrapper bridge: the SDK exec's
//      a script-path executable, passes QueryOptions.env into its environment,
//      and constructs an argv that's compatible with prepending --extensions.
//      Required for per-spawn extension loadout (RDR-002 §Decision).
//
// Pins 1-3 REQUIRE llama-server on localhost:8080. Pin 4 does NOT — its
// wrapper exits before any HTTP call.
//
// Empirical references:
//   /tmp/qwen-sdk-probe/probe.mjs (Spike A) and
//   /tmp/qwen-sdk-probe/probe-tool-result.mjs (post-spike falsification of
//   the original deny-with-message path; see RDR-001 §Q1).
//   /tmp/qwen-bridge-spike/spike.mjs (wrapper bridge proof; RDR-002).

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { query } from "@qwen-code/sdk";
import type { SDKMessage } from "@qwen-code/sdk";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────
// Backend availability check

const BASE_URL = process.env["OPENAI_BASE_URL"] ?? "http://localhost:8080/v1";
const HEALTH_URL = "http://localhost:8080/health";
const MODEL = process.env["QWEN_MODEL"] ?? "qwen3.6-27b-instruct";

/** True if llama-server responded to health check within 2 s. */
async function isBackendReachable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

let backendAvailable = false;

// ─────────────────────────────────────────────────────────────────
// Benign-EPIPE guard (file-scoped)
//
// Pin 4 deliberately spawns a wrapper that exits 42 immediately. When the
// SDK's lazy initialize() writes its control request to the subprocess
// stdin AFTER the wrapper has already exited, the write hits a closed pipe
// and Node emits `write EPIPE`. That surfaces on the socket's async error
// path as an UNCAUGHT exception — NOT as the iterator rejection Pin 4's
// try/catch handles — so vitest records it as an unhandled error and fails
// the run. The race is timing-dependent: fast machines see the iterator's
// exit-42 first and never EPIPE; slower CI runners lose the race and fail
// intermittently. The EPIPE may also land a tick after the test body
// resolves, so the guard is file-scoped (installed for the whole file, not
// just Pin 4's lifecycle) to catch it whenever it fires. It swallows ONLY
// EPIPE and re-throws everything else, so real faults still fail the run.
const epipeGuard = (err: NodeJS.ErrnoException): void => {
  if (err?.code === "EPIPE") return; // benign: SDK wrote to a dead subprocess stdin
  throw err;
};

beforeAll(async () => {
  process.on("uncaughtException", epipeGuard);
  backendAvailable = await isBackendReachable();
  if (!backendAvailable) {
    console.warn(
      "\n[sdk-behavior] llama-server unreachable on :8080 — " +
      "all SDK pin tests will SKIP.\n" +
      "To exercise them: run ./scripts/start-stack.sh and retry with:\n" +
      "  npm run test:integration\n",
    );
  }
}, 10_000);

afterAll(() => {
  process.off("uncaughtException", epipeGuard);
});

// ─────────────────────────────────────────────────────────────────
// Common query options factory

function baseOptions(extras: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    model: MODEL,
    permissionMode: "default" as const,
    excludeTools: ["agent", "write_file", "edit", "run_shell_command"],
    env: {
      OPENAI_BASE_URL: BASE_URL,
      OPENAI_API_KEY: "sk-local-llama",
      QWEN_MODEL: MODEL,
    },
    authType: "openai" as const,
    ...extras,
  };
}

// ─────────────────────────────────────────────────────────────────
// Helper: drain SDK stream up to a message budget. Does NOT short-
// circuit on the first `result` message — multi-turn streamInput
// produces one `result` per turn, so breaking on the first would
// truncate the second turn entirely (a real bug we hit in Spike A).

async function drainStream(iter: AsyncIterable<SDKMessage>, maxMessages = 60): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  let count = 0;
  for await (const msg of iter) {
    messages.push(msg);
    count++;
    if (count >= maxMessages) break;
  }
  return messages;
}

/** Single-turn drain: stops after the first `result` message. Use for
 *  tests that only run one user turn. */
async function drainSingleTurn(iter: AsyncIterable<SDKMessage>, maxMessages = 60): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  let count = 0;
  for await (const msg of iter) {
    messages.push(msg);
    count++;
    if (count >= maxMessages) break;
    if (msg.type === "result") break;
  }
  return messages;
}

// ─────────────────────────────────────────────────────────────────
// Pin 1: KV-cache locality
//
// Mirrors probe.mjs Spike A: run a 2-turn conversation sharing a large
// common prefix. Turn 2 should show cache_read_input_tokens > 0,
// proving the llama-server KV cache is active and the SDK preserves
// context across turns within one query() session.
//
// The test uses a smaller preamble than the spike (20 facts instead of 50)
// to keep wall-time reasonable. cache_read_input_tokens > 0 is sufficient
// to detect a regression; the exact value is not asserted.

describe("Pin 1 — KV-cache locality", () => {
  it(
    "turn-2 result carries cache_read_input_tokens > 0",
    { timeout: 600_000 },
    async () => {
      if (!backendAvailable) {
        console.log("  [SKIP] llama-server unreachable");
        return;
      }

      // Build a medium-length preamble to populate the KV cache on turn 1.
      const preamble =
        "Here is background context for this session.\n" +
        Array.from(
          { length: 20 },
          (_, i) =>
            `Fact ${i + 1}: Arbitrary context entry ${i + 1} — included solely to prime the prompt cache.`,
        ).join("\n");

      const turn1Prompt = preamble + "\n\nReply with exactly the word: TURN1";
      const turn2Prompt = "Reply with exactly the word: TURN2";

      // Use the streamInput (async generator) form so both turns share one
      // SDK session — matching Spike A's structure in probe.mjs.
      const iter = query({
        prompt: (async function* () {
          yield {
            type: "user" as const,
            session_id: "pin1-cache",
            parent_tool_use_id: null,
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: turn1Prompt }],
            },
          };
          yield {
            type: "user" as const,
            session_id: "pin1-cache",
            parent_tool_use_id: null,
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: turn2Prompt }],
            },
          };
        })(),
        options: baseOptions({ permissionMode: "yolo" }),
      });

      const messages = await drainStream(iter, 80);

      // Collect all result messages (one per turn in the multi-turn stream).
      const results = messages.filter((m) => m.type === "result");

      expect(results.length, "should receive at least two result messages (one per turn)").toBeGreaterThanOrEqual(2);

      // Turn 2 is the second result message. Its cache_read_input_tokens
      // must be > 0 — the preamble should be cached from turn 1.
      const turn2Result = results[1]!;
      expect(turn2Result.type).toBe("result");

      // The usage field lives on the result message.
      const usage = (turn2Result as { type: "result"; usage?: { cache_read_input_tokens?: number } }).usage;
      expect(
        usage?.cache_read_input_tokens,
        "turn-2 cache_read_input_tokens must be > 0 — KV-cache locality regression if this fires",
      ).toBeGreaterThan(0);
    },
  );
});

// ─────────────────────────────────────────────────────────────────
// Pin 2: ask_user_question ToolUseBlock shape
//
// Mirrors probe.mjs Spike B. Prompt the model with an ambiguous task
// that forces clarification. Assert that the stream emits at least one
// assistant message containing a ToolUseBlock with name === "ask_user_question"
// and structured input.questions[] (each entry has a "question" string field).
//
// If this assertion fails it means either:
//   (a) The model stopped emitting ask_user_question, or
//   (b) The SDK changed the block type / field shape.

describe("Pin 2 — ask_user_question ToolUseBlock shape", () => {
  it(
    "stream contains ToolUseBlock name=ask_user_question with input.questions[]",
    { timeout: 600_000 },
    async () => {
      if (!backendAvailable) {
        console.log("  [SKIP] llama-server unreachable");
        return;
      }

      // Ambiguous task designed to force a clarifying question.
      // Mirrors probe.mjs Spike B prompt.
      const ambiguousTask =
        "I want to refactor a function. The function is called `process`.\n" +
        "There are two functions named `process` in this codebase, in different\n" +
        "files. Which one should I refactor? Use ask_user_question if you need\n" +
        "clarification — do not just pick one. After getting an answer, simply\n" +
        "reply with the chosen file name. Do not actually do anything to the filesystem.";

      const messages = await drainSingleTurn(
        query({ prompt: ambiguousTask, options: baseOptions() }),
        40,
      );

      // Find any assistant message that contains a ToolUseBlock named ask_user_question.
      type ToolUseBlock = { type: "tool_use"; name: string; id: string; input: Record<string, unknown> };
      type AssistantMsg = { type: "assistant"; message: { role: string; content: Array<{ type: string } & Partial<ToolUseBlock>> } };

      const toolUseBlock = messages
        .filter((m): m is AssistantMsg => m.type === "assistant")
        .flatMap((m) => m.message.content)
        .find(
          (b): b is ToolUseBlock =>
            b.type === "tool_use" && (b as ToolUseBlock).name === "ask_user_question",
        );

      expect(
        toolUseBlock,
        "no ToolUseBlock with name=ask_user_question found in stream — shape regression or model changed behavior",
      ).toBeDefined();

      // The input must have a questions array with at least one entry,
      // each entry having a non-empty "question" string field.
      const questions = toolUseBlock!.input["questions"];
      expect(
        Array.isArray(questions),
        "ask_user_question input.questions must be an array",
      ).toBe(true);

      const qs = questions as Array<{ question?: unknown }>;
      expect(qs.length, "questions[] must have at least one entry").toBeGreaterThan(0);
      expect(
        typeof qs[0]!.question,
        "questions[0].question must be a string",
      ).toBe("string");
    },
  );
});

// ─────────────────────────────────────────────────────────────────
// Pin 3: streamInput multi-turn answer delivery
//
// Proves the architecture the supervisor depends on (RDR-001 §Q1, post
// 2026-05-04 spike): when `ask_user_question` is excluded from the
// inner Qwen's tool surface and the model is told via system prompt
// to ask in plain text, a follow-up user message pushed via the
// streamInput async generator is consumed by the model and influences
// turn 2's response.
//
// The original Pin 3 design (deny-with-message via canUseTool) was
// empirically falsified — the model interprets canUseTool deny as
// "user cancelled with reason X" rather than "user answered X". See
// /tmp/qwen-sdk-probe/probe-tool-result.mjs (2026-05-04) for the
// invalidating probe. The supervisor now uses this multi-turn path
// instead (src/session.ts).
//
// If this assertion fails it means either:
//   (a) The SDK stopped honoring streamInput follow-up messages, OR
//   (b) The model changed how it treats post-result user input
// Either is a hard block on upgrading @qwen-code/sdk.

describe("Pin 3 — streamInput multi-turn answer delivery", () => {
  it(
    "model treats a follow-up streamInput user message as the answer to a plain-text question",
    { timeout: 600_000 },
    async () => {
      if (!backendAvailable) {
        console.log("  [SKIP] llama-server unreachable");
        return;
      }

      const SENTINEL = "BLUE-FOX";

      // System prompt mirroring the supervisor's COPROCESSOR_PREAMBLE.
      // Tells the model: ask_user_question is unavailable; ask in plain
      // text and the user will reply on the next turn.
      const systemPrompt =
        "You are operating in a multi-turn conversation. The 'ask_user_question' " +
        "tool is NOT available. If you need clarification, ask in plain text in your " +
        "response and stop. The user will reply on the next turn.";

      // An ambiguous task that reliably forces a clarification on turn 1.
      const turn1Prompt =
        "I want to refactor a function. The function is called `process`.\n" +
        "There are two functions named `process` in this codebase, in different files.\n" +
        "Which one should I refactor? Ask me in plain text — do not pick one yourself.";

      // Turn 2: deliver the sentinel as the answer.
      const turn2Prompt =
        `${SENTINEL}\n\n` +
        `Now reply with exactly: "I will refactor ${SENTINEL}".`;

      // Build a streamInput async generator that yields turn 1 immediately
      // and turn 2 after a manual signal — the test waits for turn 1's
      // result message before releasing turn 2.
      let releaseTurn2: () => void = () => {};
      const turn2Gate = new Promise<void>((resolve) => {
        releaseTurn2 = resolve;
      });

      async function* promptStream() {
        yield {
          type: "user" as const,
          session_id: "pin3-multiturn",
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: turn1Prompt }],
          },
        };
        await turn2Gate;
        yield {
          type: "user" as const,
          session_id: "pin3-multiturn",
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: turn2Prompt }],
          },
        };
      }

      // Exclude ask_user_question to mirror the supervisor's runtime.
      const iter = query({
        prompt: promptStream(),
        options: baseOptions({
          permissionMode: "yolo",
          excludeTools: ["agent", "ask_user_question", "write_file", "edit", "run_shell_command"],
          systemPrompt,
        }),
      });

      // Drain stream. After turn 1's result arrives, release turn 2.
      // Cap total messages so a runaway test can't hang forever.
      const messages: SDKMessage[] = [];
      let resultCount = 0;
      const MAX_MESSAGES = 80;

      for await (const msg of iter) {
        messages.push(msg);
        if (msg.type === "result") {
          resultCount++;
          if (resultCount === 1) {
            // Turn 1 complete — push the answer for turn 2.
            releaseTurn2();
          }
          if (resultCount >= 2) break; // turn 2 done
        }
        if (messages.length >= MAX_MESSAGES) break;
      }

      // Ensure both turns ran.
      expect(
        resultCount,
        "expected two result messages (one per turn) — turn 2 may not have been delivered",
      ).toBeGreaterThanOrEqual(2);

      // Slice out turn-2 assistant text + result text (everything after
      // the first result message).
      const firstResultIdx = messages.findIndex((m) => m.type === "result");
      const turn2Messages = messages.slice(firstResultIdx + 1);

      type AssistantMsg = {
        type: "assistant";
        message: { content: Array<{ type: string; text?: string }> };
      };
      type ResultMsg = { type: "result"; result?: string };

      const turn2AssistantText = turn2Messages
        .filter((m): m is AssistantMsg => m.type === "assistant")
        .flatMap((m) => m.message.content)
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join(" ");

      const turn2ResultText = turn2Messages
        .filter((m): m is ResultMsg => m.type === "result")
        .map((m) => m.result ?? "")
        .join(" ");

      const combined = `${turn2AssistantText} ${turn2ResultText}`;

      expect(
        combined,
        `turn-2 response must reference '${SENTINEL}' — streamInput multi-turn delivery regression`,
      ).toContain(SENTINEL);
    },
  );
});

// ─────────────────────────────────────────────────────────────────
// Pin 4: pathToQwenExecutable wrapper bridge (RDR-002 Layer 2)
//
// The supervisor's per-spawn extension loadout depends on three SDK
// behaviors, none of them documented as a public contract:
//
//   (a) `QueryOptions.pathToQwenExecutable` accepts a SCRIPT path — not
//       just a real binary. The SDK exec's whatever we point at without
//       additional validation.
//   (b) `QueryOptions.env` reaches the subprocess's environment. The
//       wrapper reads QWEN_AGENT_EXTENSIONS from there and prepends
//       `--extensions <list>` to the CLI's argv.
//   (c) The SDK constructs argv that's compatible with PREPENDING
//       additional flags. (Yargs is order-insensitive for these flags
//       in the bundled CLI, but a future SDK change to positional
//       arguments could break this.)
//
// If any of these assumptions break, RDR-002 Layer 2 falls apart and
// the supervisor must fall back to per-session symlinked extension
// directories under <cwd>/.qwen/extensions/ (heavier, not designed).
//
// This pin does NOT require llama-server. The wrapper exits before any
// HTTP call. Always runs.

describe("Pin 4 — pathToQwenExecutable wrapper bridge", () => {
  let tmpDir: string;
  let wrapperPath: string;
  let logPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "qwen-bridge-pin-"));
    wrapperPath = join(tmpDir, "wrapper.sh");
    logPath = join(tmpDir, "wrapper-invoked.log");
    const wrapper = `#!/usr/bin/env bash
# Pin-4 wrapper: capture argv + env, exit non-zero so the SDK's subprocess
# error is the signal we observe. No real qwen exec.
{
  echo "ARGV[$#]:"
  for a in "$@"; do printf '  [%s]\\n' "$a"; done
  echo "ENV.QWEN_AGENT_EXTENSIONS=[\${QWEN_AGENT_EXTENSIONS:-<unset>}]"
  echo "ENV.OPENAI_BASE_URL=[\${OPENAI_BASE_URL:-<unset>}]"
  echo "PATHTYPE=[script]"
} > "${logPath}" 2>&1
exit 42
`;
    writeFileSync(wrapperPath, wrapper, { encoding: "utf8" });
    chmodSync(wrapperPath, 0o755);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "exec's a wrapper script set as pathToQwenExecutable; QueryOptions.env reaches the subprocess",
    { timeout: 60_000 },
    async () => {
      const sentinel = "ext-foo,ext-bar";

      let observedError: unknown = null;
      try {
        const iter = query({
          prompt: "hello",
          options: {
            cwd: "/tmp",
            model: "any-model-id",
            pathToQwenExecutable: wrapperPath,
            env: {
              QWEN_AGENT_EXTENSIONS: sentinel,
              OPENAI_BASE_URL: "http://localhost:8080/v1",
              OPENAI_API_KEY: "sk-pin",
            },
            authType: "openai",
            permissionMode: "yolo",
            excludeTools: ["agent", "ask_user_question"],
          },
        });
        for await (const _msg of iter) {
          // wrapper exits 42 before producing any stream-json, so the iter
          // throws. We catch below.
        }
      } catch (err) {
        observedError = err;
      }

      // (a) The wrapper file must have been exec'd by the SDK.
      expect(
        existsSync(logPath),
        "wrapper log absent — pathToQwenExecutable did not exec the script (regression of assumption a)",
      ).toBe(true);

      const log = readFileSync(logPath, "utf8");

      // (b) QueryOptions.env reaches the wrapper's environment.
      expect(
        log,
        "QWEN_AGENT_EXTENSIONS env did not reach the wrapper subprocess (regression of assumption b)",
      ).toMatch(/ENV\.QWEN_AGENT_EXTENSIONS=\[ext-foo,ext-bar\]/);
      expect(
        log,
        "OPENAI_BASE_URL env did not reach the wrapper subprocess",
      ).toMatch(/ENV\.OPENAI_BASE_URL=\[http:\/\/localhost:8080\/v1\]/);

      // (c) The SDK's argv is structured (key/value pairs and flag/value
      //     pairs) such that prepending `--extensions <list>` ahead of it
      //     produces a valid yargs invocation. We assert the SDK uses the
      //     well-known stream-json arg shape rather than arbitrary
      //     positional args, which would break prepending.
      expect(
        log,
        "SDK argv missing --input-format stream-json — argv shape changed; prepending may be unsafe",
      ).toMatch(/\[--input-format\][\s\S]*\[stream-json\]/);
      expect(
        log,
        "SDK argv missing --output-format stream-json",
      ).toMatch(/\[--output-format\][\s\S]*\[stream-json\]/);

      // The SDK should also pass excludeTools through; spot-check.
      expect(log).toMatch(/\[--exclude-tools\][\s\S]*\[agent,ask_user_question\]/);

      // The SDK's subprocess error is expected (wrapper exited 42). We
      // just confirm we got an error, so future SDK changes that
      // somehow make exit-42 succeed would be flagged.
      expect(observedError).not.toBeNull();
    },
  );
});
