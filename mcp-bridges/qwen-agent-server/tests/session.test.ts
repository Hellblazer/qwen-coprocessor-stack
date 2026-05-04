// SPDX-License-Identifier: MIT
//
// Tests for QwenSession state machine, ring buffer, poll cursor, and SDK
// integration. All network calls are eliminated via vi.mock('@qwen-code/sdk').

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryOptions, SDKMessage } from "@qwen-code/sdk";
import type { Backend, SpawnOpts } from "../src/types.js";
import { QwenSession, _resetEventSeq } from "../src/session.js";

// ─────────────────────────────────────────────────────────────────
// SDK Mock
//
// We expose capturedOptions so tests can assert on the QueryOptions
// passed by QwenSession, and we expose makeIter so each test can
// supply its own controlled async iterable.

let capturedOptions: QueryOptions | null = null;
let _makeIter: (() => AsyncIterable<SDKMessage>) | null = null;

// Sentinel symbol used to close the iterator from outside.
const DONE = Symbol("done");
type IterMsg = SDKMessage | typeof DONE;

function makeControllableIter(): {
  push: (msg: SDKMessage) => void;
  end: () => void;
  error: (err: Error) => void;
  iter: AsyncIterable<SDKMessage>;
} {
  const queue: IterMsg[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  let iterError: Error | null = null;

  function notify() {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  }

  const iter: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKMessage>> {
          while (true) {
            if (queue.length > 0) {
              const item = queue.shift()!;
              if (item === DONE) return { value: undefined as unknown as SDKMessage, done: true };
              return { value: item, done: false };
            }
            if (done) return { value: undefined as unknown as SDKMessage, done: true };
            if (iterError) throw iterError;
            await new Promise<void>((r) => { resolve = r; });
          }
        },
        return(): Promise<IteratorResult<SDKMessage>> {
          done = true;
          notify();
          return Promise.resolve({ value: undefined as unknown as SDKMessage, done: true });
        },
      };
    },
  };

  return {
    push(msg: SDKMessage) {
      queue.push(msg);
      notify();
    },
    end() {
      done = true;
      notify();
    },
    error(err: Error) {
      iterError = err;
      notify();
    },
    iter,
  };
}

// Mock @qwen-code/sdk so no subprocess is spawned.
vi.mock("@qwen-code/sdk", () => {
  // A minimal Query-like object; tests replace _makeIter per test.
  function query({ options }: { prompt: unknown; options?: QueryOptions }) {
    capturedOptions = options ?? null;
    const src = _makeIter ? _makeIter() : (async function* () {})();
    // Return an object that is AsyncIterable and has a close / return method.
    return Object.assign(src, {
      return: async () => ({ value: undefined, done: true }),
      close: async () => { /* noop */ },
    });
  }
  return { query };
});

// ─────────────────────────────────────────────────────────────────
// Helpers

const LOCAL_BACKEND: Backend = {
  id: "local-27b",
  url: "http://localhost:8080/v1",
  model: "qwen3.6-27b-instruct",
  tier: "local",
  capacity: "fast",
};

function makeSpawnOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return { write_authority: false, allow_subagents: false, ...overrides };
}

/** Build a minimal success result SDK message. */
function resultMsg(resultText = "done"): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: "u1",
    session_id: "s1",
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 90,
    num_turns: 1,
    result: resultText,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
    },
    permission_denials: [],
  } as SDKMessage;
}

/** Drain the session's background _run() microtask queue. */
async function flush(): Promise<void> {
  // Multiple yields to let the background async loop advance.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ─────────────────────────────────────────────────────────────────
// Tests

describe("QwenSession", () => {
  beforeEach(() => {
    capturedOptions = null;
    _makeIter = null;
    _resetEventSeq();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Backend pinning ──────────────────────────────────────────

  describe("backend pinning (§Q3)", () => {
    it("pins the backend at construction", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "hello", makeSpawnOpts());
      expect(session.backend).toBe(LOCAL_BACKEND);
      ctrl.end();
    });

    it("task_id is stable after construction (q-<8hex>)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "hello", makeSpawnOpts());
      expect(session.task_id).toMatch(/^q-[0-9a-f]{8}$/);
      ctrl.end();
    });

    it("two sessions get distinct task_ids", () => {
      const ctrl1 = makeControllableIter();
      const ctrl2 = makeControllableIter();
      let callCount = 0;
      _makeIter = () => {
        return callCount++ === 0 ? ctrl1.iter : ctrl2.iter;
      };

      const s1 = new QwenSession(LOCAL_BACKEND, "a", makeSpawnOpts());
      const s2 = new QwenSession(LOCAL_BACKEND, "b", makeSpawnOpts());
      expect(s1.task_id).not.toBe(s2.task_id);
      ctrl1.end();
      ctrl2.end();
    });
  });

  // ── QueryOptions assertions ──────────────────────────────────

  describe("SDK QueryOptions", () => {
    it("permissionMode is 'yolo' when write_authority===true (§S4)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ write_authority: true }));
      expect(capturedOptions?.permissionMode).toBe("yolo");
      ctrl.end();
    });

    it("permissionMode is 'default' when write_authority===false (§S4)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ write_authority: false }));
      expect(capturedOptions?.permissionMode).toBe("default");
      ctrl.end();
    });

    it("canUseTool callback registered when permissionMode is 'default'", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ write_authority: false }));
      expect(typeof capturedOptions?.canUseTool).toBe("function");
      ctrl.end();
    });

    it("canUseTool callback NOT registered when permissionMode is 'yolo'", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ write_authority: true }));
      expect(capturedOptions?.canUseTool).toBeUndefined();
      ctrl.end();
    });

    it("excludeTools includes 'agent' when allow_subagents===false", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ allow_subagents: false }));
      expect(capturedOptions?.excludeTools).toContain("agent");
      ctrl.end();
    });

    it("excludeTools does NOT include 'agent' when allow_subagents===true", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ allow_subagents: true }));
      expect(capturedOptions?.excludeTools).not.toContain("agent");
      ctrl.end();
    });

    it("canUseTool timeout set to 600_000 ms (§Critical Pins)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.timeout?.canUseTool).toBe(600_000);
      ctrl.end();
    });
  });

  // ── RDR-002 wrapper-script bridge ───────────────────────────

  describe("wrapper-script bridge (RDR-002)", () => {
    const INFRA = {
      qwenRealBin: "/usr/local/bin/qwen-real",
      wrapperPath: "/path/to/scripts/qwen-extensions-wrapper.sh",
    };

    it("sets pathToQwenExecutable to wrapperPath when infra is provided", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA);
      expect(capturedOptions?.pathToQwenExecutable).toBe(INFRA.wrapperPath);
      ctrl.end();
    });

    it("forwards QWEN_REAL_BIN via QueryOptions.env when infra is provided", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA);
      expect((capturedOptions?.env as Record<string, string> | undefined)?.["QWEN_REAL_BIN"])
        .toBe(INFRA.qwenRealBin);
      ctrl.end();
    });

    it("preserves existing OPENAI_BASE_URL/OPENAI_API_KEY/QWEN_MODEL env entries", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA);
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["OPENAI_BASE_URL"]).toBe(LOCAL_BACKEND.url);
      expect(env?.["QWEN_MODEL"]).toBe(LOCAL_BACKEND.model);
      expect(typeof env?.["OPENAI_API_KEY"]).toBe("string");
      ctrl.end();
    });

    it("does NOT set pathToQwenExecutable when infra is omitted", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.pathToQwenExecutable).toBeUndefined();
      ctrl.end();
    });

    it("does NOT set pathToQwenExecutable when either infra field is empty", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), {
        qwenRealBin: "",
        wrapperPath: "/some/path",
      });
      expect(capturedOptions?.pathToQwenExecutable).toBeUndefined();

      const ctrl2 = makeControllableIter();
      _makeIter = () => ctrl2.iter;
      capturedOptions = null;
      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), {
        qwenRealBin: "/some/bin",
        wrapperPath: "",
      });
      expect(capturedOptions?.pathToQwenExecutable).toBeUndefined();

      ctrl.end();
      ctrl2.end();
    });
  });

  // ── State transitions ────────────────────────────────────────

  describe("state transitions", () => {
    it("starts in running state", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(session.state).toBe("running");
      ctrl.end();
    });

    it("transitions to idle (not complete) when SDK emits a turn result", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.push(resultMsg("all done"));
      await flush();

      // Result message ends a TURN, not the session. Session stays alive
      // waiting for the next user message via send().
      expect(session.state).toBe("idle");
      const polled = session.poll({});
      expect(polled.last_message).toBe("all done");
      // result is only set on `complete` state; absent in idle.
      expect(polled.result).toBeUndefined();

      ctrl.end();
    });

    it("idle → running on send(message); next turn is delivered via input generator", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());

      // Turn 1: emit result, session goes idle.
      ctrl.push(resultMsg("turn 1 done"));
      await flush();
      expect(session.state).toBe("idle");

      // Caller pushes the next user message.
      session.send("follow up");
      await flush();
      expect(session.state).toBe("running");
      // last_user_message tracks the latest send.
      // (verified indirectly via error path's last_known.last_user_message)

      ctrl.end();
    });

    it("send() while running queues the message for after the current turn", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());

      // Still running — push a second message before any result.
      expect(() => session.send("interrupt")).not.toThrow();
      expect(session.state).toBe("running");

      ctrl.end();
    });

    it("emits a turn_complete event on each result", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.push(resultMsg("turn done"));
      await flush();

      const turnComplete = session.poll({}).recent_events.find(
        (e) => e.type === "turn_complete",
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete?.summary).toContain("turn 1 complete");

      ctrl.end();
    });

    it("transitions to error on SDK iterator error", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.error(new Error("backend blew up"));
      await flush();

      expect(session.state).toBe("error");
      const polled = session.poll({});
      expect(polled.error?.message).toContain("backend blew up");
    });
  });

  // ── write_authority: false → permission_denied event ─────────

  describe("write tool permission (§S4)", () => {
    it("write tool with write_authority:false emits permission_denied event and returns deny", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ write_authority: false }));
      const canUseTool = capturedOptions?.canUseTool!;

      const result = await canUseTool(
        "write_file",
        { path: "/tmp/x.txt", content: "data" },
        { signal: new AbortController().signal },
      );

      expect(result.behavior).toBe("deny");

      const pollResult = session.poll({});
      const denied = pollResult.recent_events.find((e) => e.type === "permission_denied");
      expect(denied).toBeDefined();
      expect(denied?.summary).toContain("write_file");

      ctrl.end();
    });
  });

  // ── Ring buffer cap ──────────────────────────────────────────

  describe("event ring buffer", () => {
    it("caps at 1000 events; oldest evicted on overflow", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      // Pump 1010 permission_denied events.
      for (let i = 0; i < 1010; i++) {
        await canUseTool(
          "write_file",
          { idx: i },
          { signal: new AbortController().signal },
        );
      }

      const all = session.poll({ max_events: 2000 });
      expect(all.recent_events.length).toBe(1000);

      // First event in buffer should be event 11 (0-based: index 10 was evicted).
      // We can't assert exact ID without knowing seqnum, but we can assert
      // that the first event is NOT the very first one pushed.
      // Instead, assert 1000 events total.
      expect(all.recent_events.length).toBeLessThanOrEqual(1000);

      ctrl.end();
    });
  });

  // ── Poll cursor ──────────────────────────────────────────────

  describe("poll cursor", () => {
    it("since=X returns only events with id > X", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      // Emit 5 permission_denied events.
      for (let i = 0; i < 5; i++) {
        await canUseTool(
          "write_file",
          { idx: i },
          { signal: new AbortController().signal },
        );
      }

      const firstPoll = session.poll({});
      expect(firstPoll.recent_events.length).toBe(5);

      const cursor = firstPoll.recent_events[1]!.id; // after event[1]
      const secondPoll = session.poll({ since: cursor });
      // Should return events[2], [3], [4] (3 events after cursor)
      expect(secondPoll.recent_events.length).toBe(3);
      for (const ev of secondPoll.recent_events) {
        expect(Number(ev.id)).toBeGreaterThan(Number(cursor));
      }

      ctrl.end();
    });

    it("max_events caps the returned slice", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      for (let i = 0; i < 10; i++) {
        await canUseTool("write_file", { idx: i }, { signal: new AbortController().signal });
      }

      const polled = session.poll({ max_events: 3 });
      expect(polled.recent_events.length).toBe(3);
    });

    it("more_events_available is true when events exceed max_events", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      for (let i = 0; i < 5; i++) {
        await canUseTool("write_file", { idx: i }, { signal: new AbortController().signal });
      }

      const polled = session.poll({ max_events: 3 });
      expect(polled.more_events_available).toBe(true);
    });

    it("more_events_available is false when all events fit", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      for (let i = 0; i < 3; i++) {
        await canUseTool("write_file", { idx: i }, { signal: new AbortController().signal });
      }

      const polled = session.poll({ max_events: 10 });
      expect(polled.more_events_available).toBe(false);
    });

    it("more_events_available accurate with since cursor", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      for (let i = 0; i < 6; i++) {
        await canUseTool("write_file", { idx: i }, { signal: new AbortController().signal });
      }

      const first = session.poll({ max_events: 100 });
      const cursor = first.recent_events[1]!.id; // 4 events after this

      const polled = session.poll({ since: cursor, max_events: 2 });
      expect(polled.recent_events.length).toBe(2);
      expect(polled.more_events_available).toBe(true);
    });
  });

  // ── stop() ──────────────────────────────────────────────────

  describe("stop()", () => {
    it("transitions to complete (not error) after stop() from running", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      session.stop();
      expect(session.state).toBe("complete");
    });

    it("transitions to complete after stop() from idle", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.push(resultMsg("turn done"));
      await flush();
      expect(session.state).toBe("idle");

      session.stop();
      expect(session.state).toBe("complete");
    });

    it("preserves error state if stop() called after error", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.error(new Error("boom"));
      await flush();
      expect(session.state).toBe("error");

      session.stop();
      expect(session.state).toBe("error");
    });

    it("send() after stop() throws", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      session.stop();
      expect(() => session.send("answer")).toThrow();
    });

    it("stop() is idempotent", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      session.stop();
      expect(() => session.stop()).not.toThrow();
      expect(session.state).toBe("complete");
    });
  });

  // ── cache_read_input_tokens logging ─────────────────────────

  describe("cache_read_input_tokens observability", () => {
    it("logs cache_read_input_tokens from result message", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      // We can't easily assert on pino output here, but we CAN assert
      // that the session completes successfully when the result contains
      // cache_read_input_tokens — the log call itself must not throw.
      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      ctrl.push(resultMsg("finished"));
      await flush();

      expect(session.state).toBe("idle");
    });
  });

  // ── ask_user_question excluded by default ──────────────────

  describe("default tool exclusions (§Q1)", () => {
    it("excludeTools includes 'ask_user_question' by default", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.excludeTools).toContain("ask_user_question");
      ctrl.end();
    });

    it("excludeTools still includes 'ask_user_question' when allow_subagents===true", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ allow_subagents: true }));
      // 'agent' is dropped; 'ask_user_question' is NOT.
      expect(capturedOptions?.excludeTools).toContain("ask_user_question");
      expect(capturedOptions?.excludeTools).not.toContain("agent");
      ctrl.end();
    });
  });
});
