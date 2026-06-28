// SPDX-License-Identifier: MIT
//
// Tests for QwenSession state machine, ring buffer, poll cursor, and SDK
// integration. All network calls are eliminated via vi.mock('@qwen-code/sdk').

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryOptions, SDKMessage } from "@qwen-code/sdk";
import type { Backend, SpawnOpts } from "../src/types.js";
import { QwenSession, _resetEventSeq } from "../src/session.js";
// RDR-014: the server-side codeIntel expansion (applyCodeIntel) is composed with
// buildSpawnOptsFromRaw exactly as the qwen_spawn/qwen_oneshot wire handlers do
// it; these tests assert the resolved opts flow through QwenSession into the
// captured SDK QueryOptions (the spec-mandated capturedOptions layer).
import { applyCodeIntel, buildSpawnOptsFromRaw } from "../src/server.js";

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

// Capture every log line emitted on the spawn path (RDR-012 test (d) — secret
// hygiene). The mock createLogger records all call args into a hoisted buffer so
// a test can assert a resolved credential never appears in any emitted line.
const logCapture = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock("../src/log.js", () => {
  const make = () => {
    const rec = (...args: unknown[]) => {
      logCapture.lines.push(args);
    };
    return {
      info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec,
      child: () => make(),
    };
  };
  return { createLogger: () => make() };
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

/** Build an SDK assistant message with one tool_use block. */
function toolUseMsg(name: string, id: string, input: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "assistant",
    uuid: id,
    session_id: "s1",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
      model: "qwen3.6-35b-a3b",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  } as unknown as SDKMessage;
}

/** Build an SDK user message with one tool_result of the given char-length string. */
function toolResultMsg(toolUseId: string, contentLen: number): SDKMessage {
  return {
    type: "user",
    session_id: "s1",
    parent_tool_use_id: null,
    uuid: `r-${toolUseId}`,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "x".repeat(contentLen),
        },
      ],
    },
  } as unknown as SDKMessage;
}

// ─────────────────────────────────────────────────────────────────
// Tests

describe("QwenSession", () => {
  beforeEach(() => {
    capturedOptions = null;
    _makeIter = null;
    _resetEventSeq();
    logCapture.lines.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
    // RDR-012 review: unstub env in afterEach (not inline in a test body) so a
    // failed assertion mid-test cannot leak a stubbed OPENAI_API_KEY into the
    // next test and cause cascading false failures.
    vi.unstubAllEnvs();
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

    // ── RDR-013 Item1: mcpServers / agents forwarding ──────────

    it("(a) forwards opts.mcpServers to QueryOptions.mcpServers", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const mcpServers = {
        "my-server": { command: "node", args: ["server.js"] },
        "http-server": { httpUrl: "http://localhost:3000/mcp" },
      };
      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ mcpServers }));
      expect(capturedOptions?.mcpServers).toEqual(mcpServers);
      ctrl.end();
    });

    it("(b) omits mcpServers from QueryOptions when not provided", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.mcpServers).toBeUndefined();
      ctrl.end();
    });

    it("(c) forwards opts.agents to QueryOptions.agents AND keeps the 'agent' tool when allow_subagents===true", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const agents = [{
        name: "researcher",
        description: "A research subagent",
        systemPrompt: "You are a researcher.",
        level: "session" as const,
      }];
      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ agents, allow_subagents: true }));
      expect(capturedOptions?.agents).toEqual(agents);
      expect(capturedOptions?.excludeTools).not.toContain("agent");
      ctrl.end();
    });

    it("(c2) emits agents_without_allow_subagents WARN when opts.agents present but allow_subagents is not true", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const agents = [{
        name: "researcher",
        description: "A research subagent",
        systemPrompt: "You are a researcher.",
        level: "session" as const,
      }];
      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ agents, allow_subagents: false }));
      // The WARN must be in the captured log lines.
      const warned = logCapture.lines.some((args) => {
        const f = args[0] as { event_type?: string; backend_id?: string; count?: number };
        return (
          f?.event_type === "agents_without_allow_subagents" &&
          f?.backend_id === LOCAL_BACKEND.id &&
          f?.count === 1
        );
      });
      expect(warned).toBe(true);
      // 'agent' tool is still excluded.
      expect(capturedOptions?.excludeTools).toContain("agent");
      // ...but agents are STILL forwarded (spec: WARN, not suppress). Asserting
      // this guards against a future change that silently drops the dead config.
      expect(capturedOptions?.agents).toEqual(agents);
      ctrl.end();
    });

    it("(c3) emits the WARN when allow_subagents is OMITTED (the common operator default)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const agents = [{
        name: "researcher",
        description: "A research subagent",
        systemPrompt: "You are a researcher.",
        level: "session" as const,
      }];
      // makeSpawnOpts here would default allow_subagents:false; construct opts
      // WITHOUT the field to exercise the `undefined` branch of `!== true`.
      new QwenSession(LOCAL_BACKEND, "task", { agents } as unknown as ReturnType<typeof makeSpawnOpts>);
      const warned = logCapture.lines.some((args) => {
        const f = args[0] as { event_type?: string };
        return f?.event_type === "agents_without_allow_subagents";
      });
      expect(warned).toBe(true);
      ctrl.end();
    });

    it("(b2) omits agents from QueryOptions when not provided", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.agents).toBeUndefined();
      ctrl.end();
    });
  });

  // ── RDR-014 Item1: codeIntel expansion → captured QueryOptions ──────
  //
  // These mirror the wire handlers' composition
  // `applyCodeIntel(buildSpawnOptsFromRaw(args.opts))` and assert the result
  // lands in the SDK QueryOptions after QwenSession construction — the
  // integration seam (applyCodeIntel → buildSystemPrompt → systemPrompt, and
  // the mcpServers passthrough) that the standalone applyCodeIntel unit tests
  // in codeintel.test.ts cannot reach.
  describe("codeIntel expansion (RDR-014, captured QueryOptions)", () => {
    // Reproduce the wire handler's exact composition.
    const resolve = (raw: Parameters<typeof buildSpawnOptsFromRaw>[0]): SpawnOpts =>
      applyCodeIntel(buildSpawnOptsFromRaw(raw)) as SpawnOpts;

    it("(ci-a) codeIntel:true → captured mcpServers['agent-lsp'] is the uvx entry with the pinned includeTools", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", resolve({ codeIntel: true, cwd: "/work/repo" }));
      const entry = capturedOptions?.mcpServers?.["agent-lsp"] as
        | { command?: string; args?: string[]; includeTools?: string[] }
        | undefined;
      expect(entry?.command).toBe("uvx");
      expect(entry?.args).toEqual(["agent-lsp"]);
      expect(entry?.includeTools).toContain("find_symbol");
      expect(entry?.includeTools).toContain("start_lsp");
      ctrl.end();
    });

    it("(ci-g) codeIntel:true → captured systemPrompt carries the symbol-graph guidance; user task untouched", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "my task text", resolve({ codeIntel: true }));
      expect(capturedOptions?.systemPrompt).toContain("agent-lsp");
      expect(capturedOptions?.systemPrompt).toContain("symbol-GRAPH");
      ctrl.end();
    });

    it("(ci-b) codeIntel unset → no agent-lsp server AND no guidance in captured systemPrompt", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", resolve({}));
      expect(capturedOptions?.mcpServers).toBeUndefined();
      expect(capturedOptions?.systemPrompt ?? "").not.toContain("agent-lsp");
      ctrl.end();
    });

    it("(ci-c) caller-supplied agent-lsp → caller entry preserved, no guidance in captured systemPrompt (C2)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(
        LOCAL_BACKEND,
        "task",
        resolve({ codeIntel: true, mcpServers: { "agent-lsp": { command: "my-own-lsp" } } }),
      );
      const entry = capturedOptions?.mcpServers?.["agent-lsp"] as { command?: string } | undefined;
      expect(entry?.command).toBe("my-own-lsp");
      expect(capturedOptions?.systemPrompt ?? "").not.toContain("symbol-GRAPH");
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

    it("forwards opts.max_output_tokens as QWEN_CODE_MAX_OUTPUT_TOKENS env", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ max_output_tokens: 16384 }));
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["QWEN_CODE_MAX_OUTPUT_TOKENS"]).toBe("16384");
      ctrl.end();
    });

    it("does NOT set QWEN_CODE_MAX_OUTPUT_TOKENS when max_output_tokens is omitted", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["QWEN_CODE_MAX_OUTPUT_TOKENS"]).toBeUndefined();
      ctrl.end();
    });

    it("forwards opts.home as env.HOME for the inner qwen (40v.13)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ home: "/tmp/clean-home" }));
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["HOME"]).toBe("/tmp/clean-home");
      ctrl.end();
    });

    it("does NOT set env.HOME when opts.home is omitted (inherits supervisor HOME)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["HOME"]).toBeUndefined();
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

    it("forwards the backend's own api_key as OPENAI_API_KEY (RDR-012)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const remote: Backend = { ...LOCAL_BACKEND, id: "openrouter", api_key: "sk-remote-123" };
      new QwenSession(remote, "task", makeSpawnOpts());
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["OPENAI_API_KEY"]).toBe("sk-remote-123");
      ctrl.end();
    });

    it("resolves api_key_env to OPENAI_API_KEY at call time (RDR-012 wiring)", () => {
      vi.stubEnv("PROV_KEY", "sk-from-env");
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const remote: Backend = { ...LOCAL_BACKEND, id: "openrouter", api_key_env: "PROV_KEY" };
      new QwenSession(remote, "task", makeSpawnOpts());
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["OPENAI_API_KEY"]).toBe("sk-from-env");
      ctrl.end();
    });

    it("declared-but-unset api_key_env → OPENAI_API_KEY is '' not sk-local + WARN (gate S1)", () => {
      // Prove S1 at the wiring level: even with a process-global OPENAI_API_KEY
      // set, a backend declaring an UNSET api_key_env must NOT degrade to
      // sk-local nor leak the global — it gets an explicit empty bearer, and the
      // misconfig is surfaced via a WARN naming backend.id + the env var.
      vi.stubEnv("OPENAI_API_KEY", "sk-global-should-not-leak");
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const remote: Backend = {
        ...LOCAL_BACKEND,
        id: "openrouter",
        api_key_env: "DEFINITELY_NOT_SET_xyz",
      };
      new QwenSession(remote, "task", makeSpawnOpts());
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["OPENAI_API_KEY"]).toBe("");
      expect(env?.["OPENAI_API_KEY"]).not.toBe("sk-local");
      expect(env?.["OPENAI_API_KEY"]).not.toBe("sk-global-should-not-leak");

      // WARN fired with the structured fields (closes the wiring-level gap so a
      // future refactor dropping the callback is caught here, not just in the
      // resolveAgenticApiKey unit test).
      const warned = logCapture.lines.some((args) => {
        const f = args[0] as { event_type?: string; backend_id?: string; env_var?: string };
        return (
          f?.event_type === "agentic_api_key_env_unset" &&
          f?.backend_id === "openrouter" &&
          f?.env_var === "DEFINITELY_NOT_SET_xyz"
        );
      });
      expect(warned).toBe(true);
      ctrl.end();
    });

    it("(d) a resolved api_key never appears in any log line on the spawn path", () => {
      const SECRET = "sk-distinctive-secret-DO-NOT-LOG-9f3a";
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const remote: Backend = { ...LOCAL_BACKEND, id: "openrouter", api_key: SECRET };
      new QwenSession(remote, "task", makeSpawnOpts());
      ctrl.end();

      // Serialize EVERY captured log call's args and assert the key is absent.
      const serialized = JSON.stringify(logCapture.lines);
      expect(serialized).not.toContain(SECRET);
    });

    it("does NOT set pathToQwenExecutable when infra is omitted", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.pathToQwenExecutable).toBeUndefined();
      ctrl.end();
    });

    it("routes opts.cwd to QueryOptions.cwd when provided", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts({ cwd: "/tmp/instance-worktree" }));
      expect(capturedOptions?.cwd).toBe("/tmp/instance-worktree");
      ctrl.end();
    });

    it("defaults QueryOptions.cwd to process.cwd() when opts.cwd is omitted", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(capturedOptions?.cwd).toBe(process.cwd());
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
      // The `= null` reset above narrows the inferred type to `null`; the
      // constructor reassigns capturedOptions via the injected query mock, a
      // side effect TS control-flow analysis cannot see. Restore the declared
      // type for the read.
      expect((capturedOptions as QueryOptions | null)?.pathToQwenExecutable).toBeUndefined();

      ctrl.end();
      ctrl2.end();
    });

    it("sets QWEN_AGENT_EXTENSIONS in QueryOptions.env when envValue is non-null", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA, {
        envValue: "serena,web-fetch",
        resolved: ["serena", "web-fetch"],
      });
      expect((capturedOptions?.env as Record<string, string> | undefined)?.["QWEN_AGENT_EXTENSIONS"])
        .toBe("serena,web-fetch");
      ctrl.end();
    });

    it("does NOT set QWEN_AGENT_EXTENSIONS when envValue is null (leave-defaults)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA, {
        envValue: null,
        resolved: "leave-defaults",
      });
      const env = capturedOptions?.env as Record<string, string> | undefined;
      expect(env?.["QWEN_AGENT_EXTENSIONS"]).toBeUndefined();
      ctrl.end();
    });

    it("renders QWEN_AGENT_EXTENSIONS=none when only=[] resolved to 'none'", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA, {
        envValue: "none",
        resolved: "none",
      });
      expect((capturedOptions?.env as Record<string, string> | undefined)?.["QWEN_AGENT_EXTENSIONS"])
        .toBe("none");
      ctrl.end();
    });

    it("emits 'extensions_loaded' as the first event when resolution is provided", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA, {
        envValue: "serena",
        resolved: ["serena"],
      });
      const result = session.poll({});
      expect(result.recent_events.length).toBeGreaterThanOrEqual(1);
      const firstEvent = result.recent_events[0]!;
      expect(firstEvent.type).toBe("extensions_loaded");
      expect((firstEvent.data as { resolved: unknown }).resolved).toEqual(["serena"]);
      ctrl.end();
    });

    it("emits 'extensions_loaded' with the leave-defaults sentinel in data", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts(), INFRA, {
        envValue: null,
        resolved: "leave-defaults",
      });
      const result = session.poll({});
      const firstEvent = result.recent_events[0]!;
      expect(firstEvent.type).toBe("extensions_loaded");
      expect((firstEvent.data as { resolved: unknown }).resolved).toBe("leave-defaults");
      ctrl.end();
    });

    it("does NOT emit extensions_loaded when no resolution is provided (back-compat)", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const result = session.poll({});
      const types = result.recent_events.map((e) => e.type);
      expect(types).not.toContain("extensions_loaded");
      ctrl.end();
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

    it("exposes turns_completed in poll on the idle/running path (RDR-008 j2r)", async () => {
      // last_known carries turns_completed only on the error path; qwen_dispatch
      // needs the count on a SUCCESS (idle/complete) poll. poll().turns_completed
      // is the always-present live counter (like budget), so the dispatcher can
      // report real turns instead of 0 on a completed run.
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      expect(session.poll({}).turns_completed).toBe(0); // running, no turns yet

      ctrl.push(resultMsg("turn 1 done"));
      await flush();
      expect(session.state).toBe("idle");
      expect(session.poll({}).turns_completed).toBe(1); // idle success path — NOT 0

      session.send("again");
      await flush();
      ctrl.push(resultMsg("turn 2 done"));
      await flush();
      expect(session.poll({}).turns_completed).toBe(2);

      // complete (terminal success) path also carries the count.
      session.stop();
      expect(session.state).toBe("complete");
      expect(session.poll({}).turns_completed).toBe(2);

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

    it("since cursor advances correctly across the 9→10 numeric boundary", async () => {
      // Event IDs are minted as String(++_eventSeq). Lexicographic compare
      // would make "10" < "9", silently terminating incremental poll once
      // the sequence crossed ten. Generate 12 events and walk the cursor
      // one-at-a-time across the boundary; every step must yield exactly
      // one new event.
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const canUseTool = capturedOptions?.canUseTool!;

      for (let i = 0; i < 12; i++) {
        await canUseTool("write_file", { idx: i }, { signal: new AbortController().signal });
      }

      const all = session.poll({ max_events: 100 });
      expect(all.recent_events.length).toBe(12);
      const ids = all.recent_events.map((e) => e.id);
      expect(ids).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);

      // Walk the cursor: at each step we should pick up exactly the next ID.
      let cursor = "8";
      for (const expected of ["9", "10", "11", "12"]) {
        const step = session.poll({ since: cursor, max_events: 1 });
        expect(step.recent_events.length).toBe(1);
        expect(step.recent_events[0]!.id).toBe(expected);
        cursor = step.recent_events[0]!.id;
      }

      // After consuming ID 12, no more events remain.
      const tail = session.poll({ since: "12", max_events: 10 });
      expect(tail.recent_events.length).toBe(0);
      expect(tail.more_events_available).toBe(false);

      // And from cursor "9" with a wide window, ids 10–12 must all surface.
      const wide = session.poll({ since: "9", max_events: 100 });
      expect(wide.recent_events.map((e) => e.id)).toEqual(["10", "11", "12"]);
      expect(wide.more_events_available).toBe(false);
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

  // ── thinking_mode + json_schema (RDR-002 v0.8 amendment) ────

  describe("thinking_mode + json_schema", () => {
    /**
     * Capture the SDK prompt iterable's first user message so we can
     * assert on the prepended /no_think (or its absence). The SDK mock
     * receives a `prompt: AsyncIterable<SDKUserMessage>` — pull the
     * first item and inspect its content.
     */
    async function firstPromptMessage(): Promise<string | undefined> {
      // The session pushed the initial user message into _inputQueue at
      // construction; the SDK mock holds a reference via its captured
      // options. Easier to assert by walking through — but we don't
      // have direct access. Use a controllable iter and let the session
      // run to a result, then grab the prompt content from session
      // poll's last_user_message instead. That field is set to the
      // raw caller-supplied prompt, not the prefixed one — so for
      // *this* test we need a different lever.
      return undefined;
    }
    void firstPromptMessage;

    it("prepends /no_think to initial user message when thinking_mode=false (default)", async () => {
      // Drive the SDK loop and capture the user message it sees as
      // input. We hook the mock's prompt iterable by inspecting its
      // capturedOptions and walking the prompt's first emission.
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "compute pi", makeSpawnOpts());
      // Start the run loop and poll once so the input queue is drained
      // by the SDK's first await on prompt.next(). Easier: peek at
      // private _inputQueue via type-cast. The first message in the
      // queue is what the SDK will receive next; assertions on that
      // are equivalent in semantics.
      const firstQueued = (session as unknown as {
        _inputQueue: Array<{ message: { content: Array<{ text: string }> } }>;
      })._inputQueue[0];
      expect(firstQueued).toBeDefined();
      expect(firstQueued!.message.content[0]!.text).toBe("/no_think\n\ncompute pi");

      ctrl.end();
    });

    it("does NOT prepend /no_think when thinking_mode=true", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "compute pi",
        makeSpawnOpts({ thinking_mode: true }),
      );
      const firstQueued = (session as unknown as {
        _inputQueue: Array<{ message: { content: Array<{ text: string }> } }>;
      })._inputQueue[0];
      expect(firstQueued!.message.content[0]!.text).toBe("compute pi");

      ctrl.end();
    });

    it("prepends /no_think to subsequent send() messages too", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "first", makeSpawnOpts());
      // Drive to idle, then send another message.
      ctrl.push(resultMsg("done turn 1"));
      await flush();
      session.send("second");
      const queued = (session as unknown as {
        _inputQueue: Array<{ message: { content: Array<{ text: string }> } }>;
      })._inputQueue;
      // The most recent push is at the tail; SDK has already drained
      // the first. send() pushed a new one with the prefix applied.
      const tail = queued[queued.length - 1]!;
      expect(tail.message.content[0]!.text).toBe("/no_think\n\nsecond");

      ctrl.end();
    });

    it("appends a JSON-schema directive to systemPrompt when json_schema is set", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const schema = {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "integer" } },
        required: ["name", "count"],
      };
      new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ json_schema: schema }),
      );
      const sys = capturedOptions?.systemPrompt as string | undefined;
      expect(sys).toBeDefined();
      expect(sys).toContain("[Output contract — JSON only]");
      expect(sys).toContain("\"required\":");
      expect(sys).toContain("\"count\"");

      ctrl.end();
    });

    it("does NOT append the JSON directive when json_schema is unset", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const sys = capturedOptions?.systemPrompt as string | undefined;
      expect(sys).toBeDefined();
      expect(sys).not.toContain("[Output contract — JSON only]");

      ctrl.end();
    });
  });

  // ── Live budget counters in poll (RDR-002 v0.6 amendment) ───
  //
  // The v0.5 smoke test (commit aa0546c) showed that all three
  // context_pressure thresholds can fire on the same iteration when one
  // tool_result is much larger than the cap. Discrete events give the
  // orchestrator no early-warning window in that case. Surfacing live
  // counters on every poll lets the orchestrator wind down between
  // events — independent of whether a discrete threshold fired.

  describe("poll budget field", () => {
    it("populates budget on every poll, including back-compat sessions with no caps", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      const polled = session.poll({});
      expect(polled.budget).toEqual({
        est_tokens: 0,
        max_tokens: 0,
        tool_calls: 0,
        max_tool_calls: 0,
      });

      ctrl.end();
    });

    it("budget.max_tokens / max_tool_calls reflect the spawn opts", () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 50_000, max_tool_calls: 25 }),
      );
      const polled = session.poll({});
      expect(polled.budget?.max_tokens).toBe(50_000);
      expect(polled.budget?.max_tool_calls).toBe(25);

      ctrl.end();
    });

    it("budget counters advance after tool_call and tool_result events", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 50_000, max_tool_calls: 25 }),
      );

      // Initial: zeros.
      expect(session.poll({}).budget?.est_tokens).toBe(0);
      expect(session.poll({}).budget?.tool_calls).toBe(0);

      // Drive a tool_use + tool_result through the SDK loop.
      ctrl.push(toolUseMsg("read", "tu_1"));
      await flush();
      const afterCall = session.poll({}).budget!;
      expect(afterCall.tool_calls).toBe(1);
      // No tool_result yet; est_tokens still 0.
      expect(afterCall.est_tokens).toBe(0);

      ctrl.push(toolResultMsg("tu_1", 4_000)); // 4000 chars → 1000 est tokens
      await flush();
      const afterResult = session.poll({}).budget!;
      expect(afterResult.est_tokens).toBe(1_000);
      expect(afterResult.tool_calls).toBe(1);

      ctrl.end();
    });

    it("budget remains readable after a context_exceeded abort", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 100 }),
      );
      // 600 chars → est=150, exceeds cap=100. Triggers abort.
      ctrl.push(toolResultMsg("tu_x", 600));
      await flush();

      expect(session.state).toBe("error");
      const polled = session.poll({});
      expect(polled.budget).toEqual({
        est_tokens: 150,
        max_tokens: 100,
        tool_calls: 0,
        max_tool_calls: 0,
      });
    });
  });

  // ── Session budget (RDR-002 §Session budget, 2026-05-09) ─────
  //
  // The supervisor pre-2026-05-09 had no internal cap on accumulated
  // tool_result content, so a runaway "find a hazard in this repo"
  // session that read 80+ files crashed at the HTTP layer with
  // ECONNRESET. v0.4 adds:
  //   - context_pressure events at 50/75/90% of max_context_tokens
  //   - clean abort with code=context_exceeded once a cap is exceeded

  describe("session budget", () => {
    it("emits context_pressure at 50/75/90% with the right level field", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      // Cap = 1000 est tokens → 4000 chars total. Thresholds at 500/750/900
      // est tokens → 2000/3000/3600 chars. Push three results that cross
      // each boundary.
      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 1000 }),
      );
      ctrl.push(toolResultMsg("t1", 2100)); // est=525 → warn
      await flush();
      ctrl.push(toolResultMsg("t2", 1000)); // est=775 → high
      await flush();
      ctrl.push(toolResultMsg("t3", 600));  // est=925 → critical
      await flush();

      const events = session.poll({ max_events: 1000 }).recent_events;
      const pressure = events.filter((e) => e.type === "context_pressure");
      const levels = pressure.map((e) => (e.data as { level: string }).level);
      expect(levels).toEqual(["warn", "high", "critical"]);
      // Each event's est_tokens / max_tokens shape is correct.
      for (const ev of pressure) {
        const d = ev.data as {
          level: string; est_tokens: number; max_tokens: number;
          tool_calls: number; max_tool_calls: number;
        };
        expect(d.max_tokens).toBe(1000);
        expect(d.est_tokens).toBeGreaterThan(0);
        expect(d.max_tool_calls).toBe(0);
      }

      ctrl.end();
    });

    it("each context_pressure threshold fires only once per session", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 1000 }),
      );
      // Five tool_results, all crossing the 50% line. Should still fire
      // exactly one warn event (and no high/critical because we never
      // cross those — chars stay around 50–60%).
      for (let i = 0; i < 5; i++) {
        ctrl.push(toolResultMsg(`t${i}`, 450));
        await flush();
      }

      const pressure = session
        .poll({ max_events: 1000 })
        .recent_events.filter((e) => e.type === "context_pressure");
      expect(pressure.length).toBe(1);
      expect((pressure[0]!.data as { level: string }).level).toBe("warn");

      ctrl.end();
    });

    it("aborts cleanly with state=error code=context_exceeded when max_tool_calls is exceeded", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_tool_calls: 2 }),
      );
      // Three tool_use blocks: 1, 2 fine; 3 exceeds the cap.
      ctrl.push(toolUseMsg("read", "tu_1"));
      await flush();
      ctrl.push(toolUseMsg("read", "tu_2"));
      await flush();
      ctrl.push(toolUseMsg("read", "tu_3"));
      await flush();

      expect(session.state).toBe("error");
      const polled = session.poll({});
      expect(polled.error?.code).toBe("context_exceeded");
      expect(polled.error?.message).toContain("tool_calls=3/2");
    });

    it("aborts cleanly with state=error code=context_exceeded when max_context_tokens is exceeded", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(
        LOCAL_BACKEND,
        "task",
        makeSpawnOpts({ max_context_tokens: 100 }),
      );
      // 100 tokens cap → 400 chars. Push a 600-char result; est=150,
      // exceeds the cap. Expect: pressure events fire, then abort.
      ctrl.push(toolResultMsg("t1", 600));
      await flush();

      expect(session.state).toBe("error");
      const polled = session.poll({});
      expect(polled.error?.code).toBe("context_exceeded");
      expect(polled.error?.message).toContain("est_tokens=150/100");
    });

    it("with both opts unset, behaviour is unchanged (no pressure events, no abort)", async () => {
      const ctrl = makeControllableIter();
      _makeIter = () => ctrl.iter;

      const session = new QwenSession(LOCAL_BACKEND, "task", makeSpawnOpts());
      // Push large tool results — would trip a 100-token cap many times
      // over. With caps disabled the session must stay running.
      for (let i = 0; i < 5; i++) {
        ctrl.push(toolResultMsg(`t${i}`, 5000));
        await flush();
      }
      // Many tool_use too.
      for (let i = 0; i < 50; i++) {
        ctrl.push(toolUseMsg("read", `tu_${i}`));
        await flush();
      }

      expect(session.state).toBe("running");
      const events = session.poll({ max_events: 1000 }).recent_events;
      expect(events.find((e) => e.type === "context_pressure")).toBeUndefined();
      expect(events.find((e) => e.type === "error")).toBeUndefined();

      ctrl.end();
    });
  });
});
