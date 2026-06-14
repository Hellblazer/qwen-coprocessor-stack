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

import { selectAgentProvider } from "./backends.js";
import { createLogger } from "./log.js";
import { callerSuppliedWorktree, type WorktreeStrategy } from "./worktree.js";
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
    .optional()
    .describe("Absolute path to a caller-supplied worktree the agent edits and that extractPatch diffs. Mutually exclusive with `repo`; supply exactly one."),
  base_commit: z
    .string()
    .min(1)
    .describe("Caller-supplied base commit. extractPatch ALWAYS diffs against this, never HEAD."),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe("`owner/name` slug — selects the EXECUTOR-MANAGED worktree strategy (mutually exclusive with `worktree`). The executor materializes a per-instance detached worktree at base_commit and cleans it up."),
  repo_url: z
    .string()
    .min(1)
    .optional()
    .describe("Override clone source for repo-mode (local path / non-github URL). Defaults to https://github.com/<repo>.git."),
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
  /**
   * Pick the worktree strategy for this run (RDR-008 1gl). Defaults to the
   * caller-supplied strategy over `input.worktree` (P2 behaviour). A host that
   * wants isolation handled injects one that returns `executorManagedWorktree`
   * (the materialize.py port). `runQwenDispatch` runs `prepare()` before the
   * dispatch and `cleanup()` in a `finally`, so the executor owns the worktree
   * lifecycle for whichever strategy is chosen.
   */
  resolveWorktree?: (input: QwenDispatchInput) => WorktreeStrategy;
}

/**
 * The `QwenDispatchError` code set — the runtime witness the conformance fixture
 * asserts against (a TS union can't be enumerated at runtime). The tool's
 * `shutting_down` envelope is NOT here: it is emitted at the server boundary
 * (server.ts), not by this class. Keep `qwen-dispatch-shapes.json`'s
 * `error.codes` = these three + `"shutting_down"`.
 *  - `no_provider` — no declared agent-cli provider matches the selector.
 *  - `missing_agent_kind` — the selected provider declares no `agentKind`
 *    (config fix: add `agentKind`), distinct from `unregistered_kind` so the
 *    caller isn't misdirected to register a dispatcher.
 *  - `unregistered_kind` — the provider's `agentKind` has no registered
 *    dispatcher.
 *  - `invalid_worktree_spec` — the request did not supply exactly one of
 *    `worktree` (caller-supplied) or `repo` (executor-managed).
 */
export const DISPATCH_ERROR_CODES = [
  "no_provider",
  "missing_agent_kind",
  "unregistered_kind",
  "invalid_worktree_spec",
] as const;
export type QwenDispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

/** Structured error surfaced to the caller when dispatch can't proceed. */
export class QwenDispatchError extends Error {
  constructor(
    readonly code: QwenDispatchErrorCode,
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
  // Single selection spine (shared with selectAgentProvider so behaviour can't
  // diverge): pin by id, else the default/declared agentKind family.
  const by =
    input.provider_id !== undefined
      ? { id: input.provider_id }
      : { agentKind: (input.agent_kind ?? DEFAULT_AGENT_KIND) as DispatcherKind };
  const provider = selectAgentProvider(providers, by);

  if (provider === undefined) {
    const sel = "id" in by ? `id="${by.id}"` : `agentKind="${by.agentKind}"`;
    throw new QwenDispatchError(
      "no_provider",
      `qwen_dispatch: no agent-cli provider matches ${sel}. ` +
        `Declared: [${providers.map((p) => p.id).join(", ")}]. ` +
        `Add one to config.agent_providers (or QWEN_AGENT_PROVIDERS).`,
    );
  }

  // A provider matched (likely an id pin) but declares no dispatcher family:
  // surface a distinct code so the caller fixes config, not the registry.
  if (provider.agentKind === undefined) {
    throw new QwenDispatchError(
      "missing_agent_kind",
      `qwen_dispatch: provider "${provider.id}" declares no agentKind; ` +
        `add agentKind to its config.agent_providers entry.`,
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

  // Exactly one worktree spec (RDR-008 dps): caller-supplied `worktree` XOR
  // executor-managed `repo`. Validated here so both the default and any injected
  // resolver see a well-formed request.
  const hasWorktree = input.worktree !== undefined;
  const hasRepo = input.repo !== undefined;
  if (hasWorktree === hasRepo) {
    throw new QwenDispatchError(
      "invalid_worktree_spec",
      `qwen_dispatch requires exactly one of "worktree" (caller-supplied) or "repo" ` +
        `(executor-managed); got ${hasWorktree ? "both" : "neither"}.`,
    );
  }

  // Prepare the worktree via the selected strategy; the executor owns its
  // lifecycle (cleanup runs in finally) for whichever strategy is chosen. The
  // host's `resolveWorktree` builds the executor-managed strategy for repo-mode;
  // without one, only caller-supplied `worktree` is serviceable.
  let strategy: WorktreeStrategy;
  if (deps.resolveWorktree !== undefined) {
    strategy = deps.resolveWorktree(input);
  } else if (input.worktree !== undefined) {
    strategy = callerSuppliedWorktree(input.worktree);
  } else {
    throw new QwenDispatchError(
      "invalid_worktree_spec",
      `qwen_dispatch repo-mode requires a host-provided worktree resolver.`,
    );
  }
  const prep = await strategy.prepare();
  try {
    const task: AgentTask = {
      prompt: input.prompt,
      worktree: prep.worktree,
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
  } finally {
    // A cleanup failure must NOT mask the dispatch result (or a dispatch error):
    // worktree teardown is best-effort (removeWorktreeUnlocked already rmSyncs as
    // a fallback). Log and continue.
    try {
      await prep.cleanup();
    } catch (err) {
      log.warn(
        { event_type: "worktree_cleanup_error", error: err instanceof Error ? err.message : String(err) },
        "qwen_dispatch worktree cleanup failed — continuing",
      );
    }
  }
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
 * Turn/cost fidelity: `turnsUsed` maps from `PollResult.turns_completed` — the
 * always-present live counter (RDR-008 j2r) — so a normally-completed qwen-local
 * run reports its real turn count (it falls back to `last_known.turns_completed`
 * for a pre-j2r supervisor). Local Qwen is free (`cost = 0`).
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
      // Session evicted from the pool (LRU/reap) — an INFRASTRUCTURE failure,
      // not a dispatch outcome. Throw so it propagates as an untyped error the
      // tool rethrows, instead of masquerading as a clean `outcome:"error"`
      // with an empty patch (indistinguishable from a genuine agent failure).
      if ("error" in r && r.error?.code === "task_id_not_found") {
        throw new Error(`qwen_dispatch poll: session ${taskId} evicted (${r.error.message})`);
      }
      const snap: QwenPollSnapshot = { state: r.state };
      // Prefer the always-present live counter (j2r); fall back to last_known
      // (error-path only) for a pre-j2r supervisor.
      const turns = r.turns_completed ?? r.last_known?.turns_completed;
      if (turns !== undefined) snap.turnsUsed = turns;
      return snap;
    },
    extractPatch,
    sleep: clock.sleep,
    now: clock.now,
  };
}
