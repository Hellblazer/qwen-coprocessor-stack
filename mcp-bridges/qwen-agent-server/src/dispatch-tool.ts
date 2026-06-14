// SPDX-License-Identifier: MIT
//
// `qwen_dispatch` MCP tool (RDR-008 P2, bead qwen-coprocessor-stack-exn). The
// operator surface nexus (or any orchestrator) calls: resolve a dispatcher from
// the registry, run a one-shot agentic task in a caller-supplied worktree,
// return `{patch, turns, outcome, cost}` (= `AgentResult`).
//
// base_commit is EXPLICIT at this boundary (RDR-008 §Decision item 4): the tool
// input carries `base_commit`; it is threaded into the dispatcher and to
// `extractPatch`, which ALWAYS diffs against the base (never `HEAD`) and returns
// the SOURCE-ONLY patch. It is NOT carried on the fixture-locked `AgentTask`.
//
// Worktree handling is the caller-supplied strategy (RF-5 default): the caller
// passes a ready worktree + base_commit; the executor runs + extracts and leaves
// worktree lifecycle (create/cleanup) to the caller. The executor-managed
// strategy (the materialize.py port) is a fast-follow, not P2.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import { createLogger } from "./log.js";
import type { Dispatch, QwenPollSnapshot, QwenSpawnEffects } from "./dispatch.js";
import type {
  AgentProvider,
  AgentResult,
  AgentTask,
  DispatcherKind,
  PollOpts,
  PollResult,
  SpawnOpts,
  SpawnResult,
} from "./types.js";

const execFileP = promisify(execFile);
const log = createLogger("qwen-dispatch");

/**
 * Test-file pathspecs stripped from the source-only patch — a verbatim port of
 * `run_arm.TEST_PATTERNS` (scripts/coding-eval/run_arm.py:88) so the TS host and
 * the Python eval host produce identical patch semantics. Contamination
 * detection (whether the agent touched a test file) stays HOST-INTERNAL per
 * RDR-007 P4b — it is NOT a field of `AgentResult`.
 */
export const TEST_PATHSPECS: readonly string[] = [
  "test/**",
  "tests/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/conftest.py",
  "conftest.py",
];

/**
 * The real host `ExtractPatch` effect: `git -C <worktree> diff <baseCommit> --
 * :(exclude)<test paths>`. Mirrors `run_arm._git_diff` (run_arm.py:179):
 *
 *  - diffs against `baseCommit`, NOT `HEAD` — so a change the agent COMMITTED is
 *    still captured (a bare `HEAD` diff would miss it and score a silent zero);
 *  - exclude-only pathspecs (no positive `.`) yield the source-only patch.
 *
 * `extraTestPaths` are per-instance test globs (e.g. SWE-bench `gold_test_globs`)
 * stripped in addition to the generic patterns.
 */
export async function gitExtractPatch(
  worktree: string,
  baseCommit: string,
  opts: { extraTestPaths?: readonly string[] } = {},
): Promise<string> {
  const excludes = [...TEST_PATHSPECS, ...(opts.extraTestPaths ?? [])].map(
    (p) => `:(exclude)${p}`,
  );
  const args = ["-C", worktree, "diff", baseCommit, "--", ...excludes];
  const { stdout } = await execFileP("git", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Zod shape for the `qwen_dispatch` MCP tool input. Kept as a raw shape object
 *  so it plugs into `mcpServer.tool(name, desc, shape, cb)` like the other
 *  qwen_* tools. */
export const qwenDispatchInputShape = {
  prompt: z.string().min(1).describe("The task/problem statement for the agent."),
  worktree: z
    .string()
    .min(1)
    .describe("Absolute path to the caller-supplied worktree the agent edits and that extractPatch diffs."),
  base_commit: z
    .string()
    .min(1)
    .describe("Caller-supplied base commit. extractPatch ALWAYS diffs against this, never HEAD."),
  max_turns: z.number().int().positive().optional().describe("Turn budget (default 50)."),
  min_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Per-turn output-token floor forwarded to the spawn (default 16384)."),
  timeout_ms: z.number().int().positive().optional().describe("Wall-clock cutoff in ms (default 1800000)."),
  provider_id: z
    .string()
    .optional()
    .describe("Pin a specific agent-cli provider by id. Overrides agent_kind selection."),
  agent_kind: z
    .string()
    .optional()
    .describe('Dispatcher family to select (default "qwen-local").'),
} as const;

const qwenDispatchInputSchema = z.object(qwenDispatchInputShape);
export type QwenDispatchInput = z.infer<typeof qwenDispatchInputSchema>;

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_MIN_TOKENS = 16384;
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_AGENT_KIND: DispatcherKind = "qwen-local";

/**
 * Injected dependencies for `runQwenDispatch` (constructor injection — server.ts
 * wires the real ones; tests inject fakes / the real git path with a fake
 * spawn/poll). Keeping these injected keeps this module free of the supervisor
 * pool and child_process at the orchestration layer.
 *
 * - `loadProviders` — the declared agent-cli providers (`loadAgentProviders`).
 * - `resolveDispatch` — resolve a `Dispatch` for a provider bound to THIS run's
 *   `baseCommit`. Production wiring builds a per-call registry via
 *   `createDefaultDispatcherRegistry({qwenSpawn, baseCommit}).resolve(provider)`
 *   so the registry stays on the execution path (RDR-008 §Decision item 3).
 */
export interface QwenDispatchDeps {
  loadProviders: () => AgentProvider[];
  resolveDispatch: (provider: AgentProvider, baseCommit: string) => Dispatch;
}

/** Structured error surfaced to the caller when dispatch can't proceed. */
export class QwenDispatchError extends Error {
  constructor(
    readonly code: "no_provider" | "unregistered_kind",
    message: string,
  ) {
    super(message);
    this.name = "QwenDispatchError";
  }
}

/**
 * Run one `qwen_dispatch` call. Selects the agent-cli provider (by `provider_id`
 * pin, else by `agent_kind`/default `qwen-local`), resolves its dispatcher from
 * the registry bound to `base_commit`, runs the one-shot task, and returns the
 * `AgentResult`. AgentTask is constructed here from the tool input WITHOUT a
 * base_commit field (the base rides the dispatcher/effect boundary instead).
 */
export async function runQwenDispatch(
  input: QwenDispatchInput,
  deps: QwenDispatchDeps,
): Promise<AgentResult> {
  const providers = deps.loadProviders();
  const provider =
    input.provider_id !== undefined
      ? providers.find((p) => p.id === input.provider_id)
      : providers.find((p) => p.agentKind === (input.agent_kind ?? DEFAULT_AGENT_KIND));

  if (provider === undefined) {
    const sel = input.provider_id !== undefined ? `id="${input.provider_id}"` : `agentKind="${input.agent_kind ?? DEFAULT_AGENT_KIND}"`;
    throw new QwenDispatchError(
      "no_provider",
      `qwen_dispatch: no agent-cli provider matches ${sel}. ` +
        `Declared: [${providers.map((p) => p.id).join(", ")}]. ` +
        `Add one to config.agent_providers (or QWEN_AGENT_PROVIDERS).`,
    );
  }

  // resolveDispatch throws (via registry.resolve) on an unregistered agentKind /
  // a model-endpoint provider; surface it as a typed error.
  let dispatch: Dispatch;
  try {
    dispatch = deps.resolveDispatch(provider, input.base_commit);
  } catch (err) {
    throw new QwenDispatchError(
      "unregistered_kind",
      err instanceof Error ? err.message : String(err),
    );
  }

  const task: AgentTask = {
    prompt: input.prompt,
    worktree: input.worktree,
    maxTurns: input.max_turns ?? DEFAULT_MAX_TURNS,
    minTokens: input.min_tokens ?? DEFAULT_MIN_TOKENS,
    timeout: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };

  log.info(
    {
      event_type: "dispatch_start",
      provider: provider.id,
      agent_kind: provider.agentKind,
      worktree: task.worktree,
    },
    "qwen_dispatch run starting",
  );
  const result = await dispatch(task, provider);
  log.info(
    { event_type: "dispatch_done", provider: provider.id, outcome: result.outcome, turns: result.turns },
    "qwen_dispatch run complete",
  );
  return result;
}

// ── supervisor adapter (production wiring) ──────────────────────────────────

/** Minimal view of the supervisor's spawn/poll handlers the dispatcher needs.
 *  Declared locally (not imported from server.ts) to keep this module free of
 *  an import cycle — server.ts imports this module, not the reverse. */
export interface SupervisorSpawnPoll {
  qwen_spawn: (
    args: { task: string; opts?: Partial<SpawnOpts> },
  ) => Promise<SpawnResult | { error: { code: string; message: string } }>;
  qwen_poll: (
    args: { task_id: string; opts?: PollOpts },
  ) => Promise<PollResult | (Omit<PollResult, "error"> & { error: { code: string; message: string } })>;
}

/**
 * Adapt the supervisor's `qwen_spawn` / `qwen_poll` handlers into the injected
 * `QwenSpawnEffects` the qwen-local dispatcher consumes. The agent runs in the
 * caller-supplied worktree (`task.worktree` → spawn `opts.cwd`); the per-turn
 * output floor (`task.minTokens`) maps to `max_output_tokens`.
 *
 * `extractPatch` is supplied separately (the real `gitExtractPatch` in
 * production) so the worktree/base_commit strategy stays pluggable.
 *
 * Turn/cost fidelity note: the supervisor's `PollResult` does not surface a
 * per-turn count on the success path (only `last_known.turns_completed` on the
 * error-continuity path), and local Qwen is free (`cost = 0`). The dispatcher
 * therefore reports `turns` best-effort from `last_known`; refining the
 * supervisor's turn telemetry is out of P2 scope (bright line: no new
 * AgentResult fields).
 */
export function makeSupervisorQwenSpawnEffects(
  handlers: SupervisorSpawnPoll,
  extractPatch: (worktree: string, baseCommit: string) => Promise<string>,
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  },
): QwenSpawnEffects {
  return {
    spawn: async (task) => {
      const opts: Partial<SpawnOpts> = { cwd: task.worktree };
      if (task.minTokens > 0) opts.max_output_tokens = task.minTokens;
      const r = await handlers.qwen_spawn({ task: task.prompt, opts });
      if ("error" in r) {
        throw new Error(`qwen_dispatch spawn failed (${r.error.code}): ${r.error.message}`);
      }
      return r.task_id;
    },
    poll: async (taskId) => {
      const r = await handlers.qwen_poll({ task_id: taskId, opts: {} });
      const snap: QwenPollSnapshot = { state: r.state };
      if (r.last_known?.turns_completed !== undefined) {
        snap.turnsUsed = r.last_known.turns_completed;
      }
      return snap;
    },
    extractPatch,
    sleep: clock.sleep,
    now: clock.now,
  };
}
