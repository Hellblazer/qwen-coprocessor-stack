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

import { createLogger } from "./log.js";
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

const log = createLogger("qwen-dispatch");

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
 *  PULL channel (`environment`) is always populated. PUSH: `finalMessage` is the
 *  leaf's structured return, threaded by the QWEN dispatcher from the terminal
 *  poll snapshot (RDR-010); `emitted` stays `[]` (the spine's entity/tier
 *  producer is orchestrator scope, deferred per RDR-010 §Out of scope). The
 *  claude-cli dispatcher passes no `finalMessage` — `ClaudeRunResult` has no
 *  such source, and claude-cli is not the value-harvest target (RDR-010 RF-1:
 *  the source is the qwen poll path). */
function runContextFor(
  task: AgentTask,
  opts: DispatchBaseOpts,
  finalMessage?: string,
): RunContext {
  return {
    emitted: [],
    environment: { worktree: task.worktree, baseCommit: opts.baseCommit },
    // Conditional spread, not `finalMessage: finalMessage`: under
    // exactOptionalPropertyTypes an optional prop may be omitted but not
    // explicitly assigned `undefined` (TS2379).
    ...(finalMessage !== undefined ? { finalMessage } : {}),
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
 * NOTE: RDR-010 wired the leaf-`value` path — P1 captures `finalMessage` and P2
 * adds the `harvest:"value"|"both"` selector ({@link valueHarvester}, the tool
 * layer in server.ts). This `acceptHarvester` (which ALSO passes `run.emitted`)
 * remains the PUSH-SPINE harvester: the `emitted` channel (the spine's
 * entity/tier producer) stays orchestrator scope, out of RDR-010, so
 * `runContextFor` keeps `emitted: []` and no dispatcher injects this harvester
 * yet. `valueHarvester` — not this — is what `harvest:"value"` uses.
 */
export const acceptHarvester: Harvest = async (run) => {
  // Shallow copy: a fresh array (so `push` below never mutates the caller's
  // ReadonlyArray); the element objects are shared (Artifacts are immutable data).
  const artifacts: Artifact[] = [...run.emitted];
  const value = parseFinalMessageValue(run.finalMessage);
  if (value !== undefined) artifacts.push(value);
  return artifacts;
};

/**
 * The value harvester (RDR-010 P2): surface the leaf's `finalMessage` as a single
 * `{kind:"value"}` artifact, or `[]` when there was no structured return. Pure;
 * reuses {@link parseFinalMessageValue}. The tool-layer harvest selector picks
 * this for `harvest:"value"`.
 *
 * Deliberately NOT `acceptHarvester`: that also passes `run.emitted` through (the
 * spine's `entity`/`tier` PUSH channel), which is orchestrator scope and out of
 * RDR-010. This harvester reads ONLY `finalMessage` (the leaf's own return).
 */
export const valueHarvester: Harvest = async (run) => {
  const value = parseFinalMessageValue(run.finalMessage);
  return value !== undefined ? [value] : [];
};

/** Parse the leaf's `finalMessage` into a `value` artifact, or `undefined` when
 *  there was no structured return (absent / whitespace-only / literal JSON
 *  `null`). JSON is parsed; non-JSON text is surfaced raw rather than discarded.
 *  Shared by {@link acceptHarvester} (PUSH spine path) and {@link valueHarvester}
 *  (RDR-010 leaf value path); kept private — both callers live in this module. */
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
 *  (it returns the last, possibly-running, snapshot). `lastMessage` is the
 *  leaf's terminal structured return (`PollResult.last_message`, the full text —
 *  not the 120-char summary; RDR-010 RF-1), present only at a terminal state
 *  that produced one; the dispatcher threads it into `RunContext.finalMessage`
 *  for the value harvester. */
export interface QwenPollSnapshot {
  state: SessionState;
  turnsUsed?: number;
  cost?: number;
  lastMessage?: string;
  /** Cumulative count of WRITE-tool `permission_denied` events the session has
   *  emitted so far (bead n8c). The poll adapter accumulates it across polls;
   *  the dispatcher uses it to refuse to call a run whose every write was
   *  refused `completed`. Absent when the poll source carries no events. */
  deniedWrites?: number;
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
  /** Optional: stop/remove the session. The dispatch owns its session and calls
   *  this once on every exit path (bead qad): before the harvest on a wall-clock
   *  timeout (fire-and-forget, the agent may still be editing), otherwise after
   *  the harvest, awaited. A terminal session left in the pool would sit `idle`
   *  until the reaper sweep. Errors are swallowed. Omitted in tests that don't
   *  exercise the path. */
  stop?: (taskId: string) => Promise<void>;
  /** Optional (bead q5mj): true when the dispatch worktree differs from
   *  `baseCommit` in any way — tracked or staged modifications, non-ignored
   *  untracked files, or `HEAD` no longer equal to the base commit. Supplying
   *  this TOGETHER with `send` arms the no-change nudge and the honest
   *  `completed`/`error` classification; supplying neither is today's
   *  dispatcher, bit for bit. A read-only dispatch must not supply it. */
  worktreeChanged?: () => Promise<boolean>;
  /** Optional (bead q5mj): push a follow-up user message into the session;
   *  resolves true when the session accepted it. Only used to deliver the
   *  one no-change nudge; a false/throwing result is never retried. */
  send?: (taskId: string, message: string) => Promise<boolean>;
  /** Optional MCP progress emitter (bead ht9). When supplied, the dispatcher
   *  emits one notification at start, one per poll iteration while the run is
   *  in flight, and one at the end — with strictly increasing `progress`
   *  values. Absent → no emissions (behaviour unchanged). Emissions are
   *  best-effort: a throwing/rejecting emitter never alters the run's result. */
  progress?: ProgressEmitter;
}

/**
 * MCP progress emitter (bead ht9). Structurally identical to server.ts's
 * `ProgressEmitter`; declared locally so this module stays free of an import
 * cycle (server.ts imports this module, not the reverse). A host with no MCP
 * progress token supplies nothing — every emission is then skipped.
 */
export type ProgressEmitter = (event: {
  progress: number;
  total?: number;
  message?: string;
}) => void;

/**
 * Emit one MCP progress event, swallowing a synchronous throw or an async
 * rejection (bead ht9): progress is best-effort and must never fail or alter
 * the dispatch result. A no-op when no emitter was supplied.
 */
function emitProgress(
  progress: ProgressEmitter | undefined,
  event: { progress: number; total?: number; message?: string },
): void {
  if (progress === undefined) return;
  try {
    const ret = progress(event) as unknown;
    if (
      ret !== null &&
      typeof ret === "object" &&
      typeof (ret as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(ret).catch(() => {});
    }
  } catch {
    // best-effort only
  }
}

/** Terminal session states for a one-shot agentic run: the agent has finished
 *  (`complete`), gone quiet awaiting input (`idle` — terminal for a one-shot),
 *  or failed (`error`). `running` keeps the loop polling. */
function isTerminal(state: SessionState): boolean {
  return state === "complete" || state === "idle" || state === "error";
}

/** True when the session emitted at least one write-tool `permission_denied`
 *  AND the harvest carries patch artifacts that are all empty — the signature
 *  of a run that tried to edit, was refused every time, and has nothing to show
 *  (bead n8c). No patch artifact at all (a value-only harvest) → false. */
export function refusedWithoutPatch(
  snapshot: Pick<QwenPollSnapshot, "deniedWrites">,
  artifacts: readonly Artifact[],
): boolean {
  if ((snapshot.deniedWrites ?? 0) === 0) return false;
  const patches = artifacts.filter((a) => a.kind === "patch");
  return patches.length > 0 && patches.every((a) => a.diff.trim() === "");
}

/**
 * The follow-up message sent ONCE to a write-authorised run that ended its turn
 * without touching the worktree (bead q5mj). Exported so callers and tests can
 * name the exact text.
 */
export const DISPATCH_NO_CHANGE_NUDGE =
  "You ended your turn without changing any file in the worktree. This is a one-shot run: nobody can answer questions or confirm a plan. If the task needs changes, make them now and verify them; where the task is ambiguous choose the smallest reasonable option and say what you chose. If you are certain no change is needed, reply with exactly NO_CHANGES_NEEDED followed by one sentence saying why.";

/** Sentinel a run replies with to declare it deliberately made no change
 *  (bead q5mj). Matched against the START of the trimmed terminal message; when
 *  present the nudge is suppressed and the outcome stays `completed`. */
const NO_CHANGES_NEEDED = "NO_CHANGES_NEEDED";

/**
 * Standing preamble prefixed to the task text a `qwen_dispatch` run is spawned
 * with (bead q5mj). Kept in one exported constant so the wire prompt and its
 * tests cannot drift. `makeSupervisorQwenSpawnEffects` prepends it unless the
 * caller passes `oneShotPreamble: false`.
 */
export const DISPATCH_ONE_SHOT_PREAMBLE =
  "This is a one-shot dispatched run. Nobody can answer questions or confirm a plan, and your first reply that contains no tool call ends the run. Do not stop to ask and do not end your turn on an announcement of what you will do. Where the task is ambiguous, choose the smallest reasonable option, do the work, verify it, and say what you chose in your final message.";

/** Terminal polls to tolerate after a successful nudge before giving up on the
 *  session picking up the follow-up, and classifying the last snapshot
 *  (bead q5mj). */
const NO_CHANGE_STALE_TERMINAL_POLLS = 30;

/** Read the injected worktree-change probe, treating a throw as `true` —
 *  fail open, so a broken check can never invent an "empty run" (bead q5mj). */
async function worktreeChangedSafely(effects: QwenSpawnEffects): Promise<boolean> {
  try {
    return await effects.worktreeChanged!();
  } catch {
    return true;
  }
}

/** Deliver the nudge, treating a throw as "not accepted" so the dispatcher
 *  never retries it (bead q5mj). */
async function sendSafely(
  effects: QwenSpawnEffects,
  taskId: string,
  message: string,
): Promise<boolean> {
  try {
    return await effects.send!(taskId, message);
  } catch {
    return false;
  }
}

/** True when `message` (trimmed) starts with `sentinel` (bead q5mj). */
function messageStartsWith(message: string | undefined, sentinel: string): boolean {
  return (message ?? "").trim().startsWith(sentinel);
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
  opts: DispatchBaseOpts & { pollIntervalMs?: number; noChangeNudges?: number },
): Dispatch {
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const noChangeNudges = opts.noChangeNudges ?? 1;
  return async (task, provider) => {
    assertAgentCli(provider);
    const taskId = await effects.spawn(task, provider);

    // Bead qad: a one-shot dispatch owns its session, so it removes it on EVERY
    // exit path. A terminal session left in the pool sits `idle` (holding its
    // qwen-code child) until the reaper sweeps it, and callers cannot clean up
    // themselves: qwen_sessions carries no owner to tell one dispatch's session
    // from another's. Best-effort: a failing stop is swallowed so it never masks
    // the run's result or error. `stopped` is set before the await, so the
    // timeout path's early stop and the `finally` stop never both fire.
    let stopped = false;
    const stopOnce = async (): Promise<void> => {
      if (stopped || effects.stop === undefined) return;
      stopped = true;
      try {
        await effects.stop(taskId);
      } catch {
        // cleanup only
      }
    };

    // Bead ht9: MCP progress. One counter for the whole run so `progress` is
    // strictly increasing across the start / in-flight / end notifications (the
    // spec requires monotonic values). `total` is left undefined — the
    // poll-iteration count has no known bound.
    let progressSeq = 0;
    const pin = provider.backend !== undefined ? ` (backend ${provider.backend})` : "";
    emitProgress(effects.progress, {
      progress: progressSeq++,
      message: `dispatch started: provider ${provider.id}${pin}`,
    });

    // Hoisted so the end notification in `finally` can name the terminal state.
    let last: QwenPollSnapshot = { state: "running" };
    try {
      // Inside the try: nothing between spawn and here may throw, or the
      // session would leak with no stop.
      const start = effects.now();
      let timedOut = false;

      // Bead q5mj: the no-change nudge is armed only when BOTH new effects are
      // supplied — a host that wires neither gets today's dispatcher exactly.
      const nudgeEnabled = effects.worktreeChanged !== undefined && effects.send !== undefined;
      // At most ONE nudge per dispatch (the spec's ceiling); `noChangeNudges: 0`
      // disables nudging entirely.
      let nudgeBudget = nudgeEnabled ? Math.max(0, noChangeNudges) : 0;
      // Non-null once a nudge was accepted: while set, a terminal snapshot is
      // not trusted until the session has moved past the nudge (a non-terminal
      // poll, or a higher `turnsUsed`), bounded by the stale cap.
      let afterNudge: { turnsAt: number | undefined; sawNonTerminal: boolean; stalePolls: number } | null =
        null;

      for (;;) {
        last = await effects.poll(taskId);
        // Bead ht9: one notification per poll iteration. The loop already wakes
        // every `pollIntervalMs`, so no second timer is needed.
        emitProgress(effects.progress, {
          progress: progressSeq++,
          message: `state=${last.state} turns=${last.turnsUsed ?? 0}`,
        });

        if (isTerminal(last.state)) {
          if (afterNudge !== null) {
            // Stale-terminal guard: the session can keep reporting its previous
            // terminal state for a poll or two before it picks up the nudge.
            const progressed =
              afterNudge.sawNonTerminal ||
              (afterNudge.turnsAt !== undefined &&
                last.turnsUsed !== undefined &&
                last.turnsUsed > afterNudge.turnsAt);
            if (!progressed) {
              if (++afterNudge.stalePolls >= NO_CHANGE_STALE_TERMINAL_POLLS) break;
              if (effects.now() - start >= task.timeout) {
                timedOut = true;
                break;
              }
              await effects.sleep(pollIntervalMs);
              continue;
            }
          } else if (
            nudgeBudget > 0 &&
            last.state !== "error" &&
            !messageStartsWith(last.lastMessage, NO_CHANGES_NEEDED)
          ) {
            // Terminal, non-error, and the agent did not declare the task needs
            // no change. Did it actually change anything?
            if (!(await worktreeChangedSafely(effects))) {
              const turnsAt = last.turnsUsed;
              const accepted = await sendSafely(effects, taskId, DISPATCH_NO_CHANGE_NUDGE);
              // Bead q5mj: one structured line per nudge, with the task id and
              // whether the send was accepted. Logged here (see the module
              // logger) because the classification event below must be logged
              // from here too, so one logger covers both.
              log.info(
                { event_type: "dispatch_no_change_nudge", task_id: taskId, accepted },
                "qwen_dispatch: the run ended without changing the worktree",
              );
              if (accepted) {
                nudgeBudget--;
                afterNudge = { turnsAt, sawNonTerminal: false, stalePolls: 0 };
                emitProgress(effects.progress, {
                  progress: progressSeq++,
                  message: "no changes yet: nudging the agent once",
                });
                if (effects.now() - start >= task.timeout) {
                  timedOut = true;
                  break;
                }
                await effects.sleep(pollIntervalMs);
                continue;
              }
              // send refused or threw: no retry, fall through to classification.
            }
          }
          break;
        }

        if (afterNudge !== null) afterNudge.sawNonTerminal = true;
        if (effects.now() - start >= task.timeout) {
          timedOut = true;
          break;
        }
        await effects.sleep(pollIntervalMs);
      }

      // On timeout the agent may still be editing: stop it BEFORE the harvest
      // diffs the worktree's partial edits. Fire-and-forget, as before; a
      // terminal exit is stopped after the harvest, in `finally`.
      if (timedOut) void stopOnce();

      let outcome: AgentOutcome = timedOut
        ? "timeout"
        : classifyOutcome(last.state === "error" ? 1 : 0, {
            // Conditional spread, not `turnsUsed: last.turnsUsed`: under
            // exactOptionalPropertyTypes an optional prop may be omitted but not
            // explicitly assigned `undefined` (TS2379).
            maxTurns: task.maxTurns,
            ...(last.turnsUsed !== undefined ? { turnsUsed: last.turnsUsed } : {}),
          });
      // Thread the leaf's terminal structured return (RDR-010) so a value
      // harvester can surface it; the git-diff harvester ignores it.
      const artifacts = await effects.harvest(runContextFor(task, opts, last.lastMessage));
      // Bead n8c: a run whose writes were refused and that produced no patch is
      // NOT `completed`, whatever the session state says. The agent tried to
      // edit, every edit was denied (permission_denied events), and the harvest
      // is empty — reporting `completed` with an empty diff is a silent zero.
      // Scoped to patch-bearing harvests: a value-only run (no patch artifact)
      // may legitimately be read-only and still complete.
      if (outcome === "completed" && refusedWithoutPatch(last, artifacts)) outcome = "error";

      // Bead q5mj: a write-authorised run that ended without changing the
      // worktree (checked AGAIN after the nudge round) is a silent zero — report
      // `error` instead of `completed`, unless the agent declared
      // NO_CHANGES_NEEDED. Only when the host wired the check; a read-only
      // dispatch never supplies it, so it is never nudged or reclassified here.
      if (
        effects.worktreeChanged !== undefined &&
        !timedOut &&
        outcome !== "error" &&
        !(await worktreeChangedSafely(effects)) &&
        !messageStartsWith(last.lastMessage, NO_CHANGES_NEEDED)
      ) {
        outcome = "error";
        log.warn(
          {
            event_type: "dispatch_no_changes",
            task_id: taskId,
            last_message: (last.lastMessage ?? "").slice(0, 500),
          },
          "qwen_dispatch: run ended without changing the worktree",
        );
      }
      return { artifacts, turns: last.turnsUsed ?? 0, outcome, cost: last.cost ?? 0 };
    } finally {
      // Bead ht9: the end notification, on every exit path (success or throw).
      emitProgress(effects.progress, {
        progress: progressSeq++,
        message: `dispatch finished: state=${last.state}`,
      });
      // After the harvest, so removing the session cannot disturb it; awaited,
      // so a caller that removes the worktree next never races a live session.
      await stopOnce();
    }
  };
}
