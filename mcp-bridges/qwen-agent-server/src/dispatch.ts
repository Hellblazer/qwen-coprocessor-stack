// SPDX-License-Identifier: MIT
//
// Agentic dispatch interface (RDR-007 §4 / P3, bead azf.7).
//
// `dispatch(task, provider)` for `kind:"agent-cli"` providers — the run_arm
// spine (scripts/coding-eval/run_arm.py) generalized onto the TS side. This
// module is PURE ORCHESTRATION: every side effect (launching `claude -p`,
// spawning/polling qwen, the git-diff patch extraction, killpg, sleeping,
// reading the clock) is INJECTED. dispatch.ts itself imports no child_process,
// runs no git, and touches no process group — RF-1 keeps those host-local so
// each host (eval harness, nexus) owns its own effects.
//
// `kind:"model-endpoint"` providers (chat/schemaSynth/embed/rerank) are
// SELECTED via backends.ts `select()` but INVOKED through their existing tool
// paths (qwen_oneshot/embed/rerank); they do NOT implement dispatch() and are
// rejected here at runtime (gate Critical-3).

import type {
  AgentOutcome,
  AgentProvider,
  AgentResult,
  AgentTask,
  Artifact,
  Harvest,
  RunContext,
  SessionState,
} from "./types.js";

/**
 * Shared, host-uniform classification of a COMPLETED (non-timeout) run — a
 * verbatim port of `run_arm.classify_outcome` so the TS spine and the Python
 * eval spine report identically (RF-1). The wall-clock `timeout` is owned by
 * the dispatch loop / runner, not by this rule.
 *
 * - non-zero (or unknown/`null`) returncode → `error`
 * - `turnsUsed >= maxTurns`                  → `turn_limit`
 * - otherwise                                → `completed`
 */
export function classifyOutcome(
  returncode: number | null,
  opts: { turnsUsed?: number; maxTurns: number },
): AgentOutcome {
  if (returncode !== 0) return "error";
  if (opts.turnsUsed !== undefined && opts.turnsUsed >= opts.maxTurns) return "turn_limit";
  return "completed";
}

/**
 * Runtime guard: `dispatch()` serves `kind:"agent-cli"` providers only. A
 * `kind:"model-endpoint"` provider has no agentic loop to drive and no
 * patch/worktree result shape — it is selected and invoked via its tool path
 * instead. Narrows the type for callers that proceed past the assertion.
 */
export function assertAgentCli(
  provider: AgentProvider,
): asserts provider is AgentProvider & { kind: "agent-cli" } {
  if (provider.kind !== "agent-cli") {
    throw new Error(
      `dispatch() requires a kind:"agent-cli" provider; got kind:"${provider.kind}" (${provider.id}). ` +
        `model-endpoint providers are invoked via their tool path (qwen_oneshot/embed/rerank), not dispatch().`,
    );
  }
}

/** The agentic dispatch signature, uniform across providers.
 *
 * PRECONDITION (RDR-007 §4): `dispatch()` drives a ONE-SHOT run to completion.
 * A session that goes `idle` is treated as terminal (the agent finished its
 * single self-contained task). It is NOT for multi-turn interactive sessions
 * (`qwen_send`) — there, `idle` means "awaiting the next turn", and dispatch()
 * would misclassify it as `completed` with a partial patch. */
export type Dispatch = (task: AgentTask, provider: AgentProvider) => Promise<AgentResult>;

// ── claude -p ───────────────────────────────────────────────────────────────

/** Outcome of the host's `claude -p` invocation (telemetry; the patch is
 *  produced separately by the `harvest` effect, never from claude's `model_patch`). */
export interface ClaudeRunResult {
  returncode: number | null;
  turnsUsed: number;
  cost: number;
  /** True when the host runner killed the process at the wall-clock cutoff. */
  timedOut: boolean;
}

/** Injected effects for the claude-cli dispatcher (constructor injection — the
 *  host owns the actual `claude -p --output-format json` invocation + killpg
 *  and the run harvest). */
export interface ClaudeCliEffects {
  run: (task: AgentTask, provider: AgentProvider) => Promise<ClaudeRunResult>;
  /** See {@link Harvest} — produces the run's `Artifact[]`; the git-diff
   *  harvester diffs against base_commit (not HEAD), source-only. */
  harvest: Harvest;
}

/** Per-construction options shared by the dispatchers (RDR-008 P2). `baseCommit`
 *  is REQUIRED: the git-diff harvester always diffs against it (never `HEAD`), and a
 *  required field makes the silent-`HEAD`-zero path unrepresentable. It is the
 *  caller-supplied base for THIS run's worktree (the `qwen_dispatch` tool-input
 *  value), threaded to the harvester (via `RunContext.environment`) rather than carried on the fixture-locked
 *  `AgentTask`. */
export interface DispatchBaseOpts {
  baseCommit: string;
}

/**
 * Build a `claude -p` dispatcher. Blocking: `run` resolves only when the host
 * process has terminated (or been killed at the cutoff). The patch is the
 * host's git-diff off the worktree (vs `opts.baseCommit`) — NEVER claude's
 * self-reported patch field (run_arm's locked invariant). `minTokens` is not
 * consumed here: claude self-manages generation.
 */
export function makeClaudeCliDispatch(effects: ClaudeCliEffects, opts: DispatchBaseOpts): Dispatch {
  return async (task, provider) => {
    assertAgentCli(provider);
    const res = await effects.run(task, provider);
    const outcome: AgentOutcome = res.timedOut
      ? "timeout"
      : classifyOutcome(res.returncode, { turnsUsed: res.turnsUsed, maxTurns: task.maxTurns });
    const artifacts = await effects.harvest(runContextFor(task, opts));
    return { artifacts, turns: res.turnsUsed, outcome, cost: res.cost };
  };
}

/** The one-shot {@link RunContext} a dispatcher hands its harvester (RDR-009).
 *  In P1 the PUSH channel (`emitted`/`finalMessage`) is empty — only the PULL
 *  channel (`environment`) is populated, so the git-diff harvester has the
 *  worktree + base it needs. The /accept harvester (Phase 2) fills the rest. */
function runContextFor(task: AgentTask, opts: DispatchBaseOpts): RunContext {
  return {
    // Phase 2 seam: the /accept harvester populates `emitted` (PUSH-channel
    // artifacts the host spine wrote during the run) + `finalMessage` (the
    // leaf's structured return) here. In P1 the only harvester is the git-diff
    // (PULL) one, which reads `environment` only — so `emitted` is [] by design.
    emitted: [],
    environment: { worktree: task.worktree, baseCommit: opts.baseCommit },
  };
}

// ── /accept harvester (RDR-009 Phase 2 — the PUSH path) ─────────────────────

/**
 * The `/accept` harvester: the PUSH-channel {@link Harvest}. Surfaces the
 * artifacts the run pushed WITHOUT touching git or the raw supervisor event log
 * (RF-1) —
 *
 *  - passes `run.emitted` through **verbatim** (every kind, unfiltered): the
 *    deterministic `/accept` spine is host code that KNOWS what it wrote and
 *    emits its `entity`/`tier` artifacts DIRECTLY at the time it creates the bead
 *    / writes the tier. (A spine could emit any kind; the harvester does not
 *    filter, so no legitimate spine emission is dropped.)
 *  - parses `run.finalMessage` (the leaf agent's structured return) into a single
 *    `{kind:"value"}` — JSON when it parses, else the raw string (never dropped).
 *
 * `finalMessage` ambiguity (accepted): a JSON-encoded string payload
 * (`"\"x\""` → `"x"`) is indistinguishable at the consumer from a bare
 * non-JSON `"x"`. For the real `/accept` case the leaf returns a JSON object /
 * array (no ambiguity); preserving the raw text alongside would need an extra
 * `value`-artifact field, disproportionate for the locked four-kind union.
 * Literal JSON `null` is treated as **no structured return** (a degenerate
 * answer is not a value); `false` / `0` / `""` are genuine values and ARE
 * surfaced.
 *
 * Reading neither source yields `[]` (no throw). It NEVER scrapes the raw event
 * log: that stream has no explicit "created" signal, no success confirmation,
 * and truncates the agent's structured output to 120 chars (RF-1, verified at
 * source). Pure — no I/O — so it composes with the git-diff (PULL) harvester
 * without ordering constraints.
 *
 * NOTE (seam, not yet wired): this is the harvester half of the PUSH path. The
 * producer — the `/accept` spine that populates `RunContext.emitted` /
 * `finalMessage` (and the dispatcher wiring that injects this as the `harvest`
 * effect) — is engine/host work outside RDR-009's one-shot executor scope. Until
 * that lands, `runContextFor` emits `[]`/no `finalMessage`, so a dispatched run
 * does not yet exercise this harvester end-to-end.
 */
export const acceptHarvester: Harvest = async (run) => {
  // Shallow copy: a fresh array (so `push` below never mutates the caller's
  // ReadonlyArray); the element objects are shared (Artifacts are immutable data).
  const artifacts: Artifact[] = [...run.emitted];
  const value = parseFinalMessageValue(run.finalMessage);
  if (value !== undefined) artifacts.push(value);
  return artifacts;
};

/** Parse the leaf's `finalMessage` into a `value` artifact, or `undefined` when
 *  there was no structured return (absent / whitespace-only / literal JSON
 *  `null`). JSON is parsed; non-JSON text is surfaced raw rather than discarded. */
function parseFinalMessageValue(
  finalMessage: string | undefined,
): Extract<Artifact, { kind: "value" }> | undefined {
  if (finalMessage === undefined || finalMessage.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(finalMessage);
  } catch {
    // Not JSON — surface the raw structured text rather than dropping it.
    return { kind: "value", value: finalMessage };
  }
  // Literal JSON `null` is a degenerate "no answer", not a value (false/0/""
  // are genuine values and fall through).
  if (value === null) return undefined;
  return { kind: "value", value };
}

// ── qwen_spawn (poll-to-completion) ─────────────────────────────────────────

/** A single poll snapshot from the qwen supervisor (subset of PollResult the
 *  dispatcher needs). `turnsUsed` / `cost` may be absent on non-terminal
 *  (`running`) snapshots; on timeout the dispatcher falls back to `0` for each
 *  (it returns the last, possibly-running, snapshot). */
export interface QwenPollSnapshot {
  state: SessionState;
  turnsUsed?: number;
  cost?: number;
}

/** Injected effects for the qwen_spawn dispatcher. The host owns the supervisor
 *  client (spawn/poll), the git-diff, the clock, and the sleep. */
export interface QwenSpawnEffects {
  spawn: (task: AgentTask, provider: AgentProvider) => Promise<string>;
  poll: (taskId: string) => Promise<QwenPollSnapshot>;
  /** See {@link Harvest} — produces the run's `Artifact[]`; the git-diff
   *  harvester diffs against base_commit (not HEAD), source-only. */
  harvest: Harvest;
  /** Delay between polls. Injected so tests resolve immediately. */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic clock in ms. Injected for deterministic deadline tests. */
  now: () => number;
}

/** Terminal session states for a one-shot agentic run: the agent has finished
 *  (`complete`), gone quiet awaiting input (`idle` — terminal for a one-shot),
 *  or failed (`error`). `running` keeps the loop polling. */
function isTerminal(state: SessionState): boolean {
  return state === "complete" || state === "idle" || state === "error";
}

/**
 * Build a `qwen_spawn` dispatcher. Spawns, then POLLS TO COMPLETION INTERNALLY
 * — it resolves only once the session reaches a terminal state or the
 * wall-clock deadline fires — matching the blocking semantics of `claude -p`
 * and run_arm. The patch is the host's git-diff off the worktree (always
 * extracted, including on timeout, since the worktree may hold partial edits).
 */
export function makeQwenSpawnDispatch(
  effects: QwenSpawnEffects,
  opts: DispatchBaseOpts & { pollIntervalMs?: number },
): Dispatch {
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  return async (task, provider) => {
    assertAgentCli(provider);
    const taskId = await effects.spawn(task, provider);
    const start = effects.now();

    let last: QwenPollSnapshot = { state: "running" };
    let timedOut = false;
    for (;;) {
      last = await effects.poll(taskId);
      if (isTerminal(last.state)) break;
      if (effects.now() - start >= task.timeout) {
        timedOut = true;
        break;
      }
      await effects.sleep(pollIntervalMs);
    }

    const outcome: AgentOutcome = timedOut
      ? "timeout"
      : classifyOutcome(last.state === "error" ? 1 : 0, {
          // Conditional spread, not `turnsUsed: last.turnsUsed`: under
          // exactOptionalPropertyTypes an optional prop may be omitted but not
          // explicitly assigned `undefined` (TS2379).
          maxTurns: task.maxTurns,
          ...(last.turnsUsed !== undefined ? { turnsUsed: last.turnsUsed } : {}),
        });
    const artifacts = await effects.harvest(runContextFor(task, opts));
    return { artifacts, turns: last.turnsUsed ?? 0, outcome, cost: last.cost ?? 0 };
  };
}
