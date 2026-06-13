---
title: "Suspendable MCP workflow engine — agentic dispatch as step executor with injectable choice"
id: RDR-008
type: Design
status: draft
priority: medium
author: hal
reviewed-by: self
created: 2026-06-13
related_issues: []
---

# RDR-008: Suspendable MCP workflow engine — agentic dispatch as step executor with injectable choice

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft** (2026-06-13). Successor to RDR-007 (closed, implemented). RDR-007 shipped the
`dispatch()` contract (`src/dispatch.ts`, `kind:"agent-cli"`, one-shot poll-to-completion)
as interface + implementations + tests, with **no MCP server wiring** — deliberately, so this
wiring phase has a contract to land against. RDR-007 also explicitly deferred "the in-loop
coprocessor capability (a running Claude session delegating to Qwen subagents)" to its own RDR.
This is that RDR.

Prior art surveyed and indexed to the T3 knowledge store (2026-06-13): *Separating Intelligence
from Execution: A Workflow Engine for the Model Context Protocol* (Parmar, arXiv:2605.00827).

## Problem Statement

Today the top-level orchestrator (Claude) does fan-out the only way it can: it spawns **Claude
subagents** for every bounded sub-task. That is exactly the work `/usage` flags as expensive —
metered frontier tokens spent on labor a cheaper model could do. RDR-007 built the routing and
the `dispatch()` engine to send such work to a **local Qwen agent** instead, but nothing exposes
it: there is no MCP tool, and there are no `kind:"agent-cli"` providers configured. The capability
is groundwork with no surface.

At the same time, the *structure* of the orchestrator's work is repetitive. Workflows like the RDR
lifecycle (notably `/accept`) are trees of invocations with a recognizable mechanical spine and a
few genuine judgment points. The prevailing pattern re-reasons the whole tree every run. The Parmar
work shows the clean separation: **intelligence is one-time (design), execution is repeated
(mechanical)** — compile the plan once into a declarative blueprint and replay it with the model out
of the loop.

But pure "compile once, replay with zero LLM" is too strict for our workflows: ours need judgment at
branch points, and sometimes a human in the loop. The gap this RDR closes: a workflow engine that
runs a mostly-mechanical spine cheaply, **dispatches individual nodes to local Qwen** instead of
metered Claude subagents, and **suspends at the judgment nodes to inject a choice** — from the
driving Claude, or from a human.

## Context

- **RDR-001** (closed): the supervisor is a stateful MCP server with an in-memory session pool
  (`spawn`/`poll`/`send`/`stop`). Load-bearing invariant: **the supervisor holds no Anthropic
  credential** — unmodified Claude Code is the only credential holder.
- **RDR-007** (closed): `AgentProvider` (`kind: "model-endpoint" | "agent-cli"`), the `select()`
  routing spine, `dispatch(task, provider)` for `kind:"agent-cli"` providers, one-shot (idle is
  terminal), all host effects injected (RF-1). `ExtractPatch` must diff against the instance
  `base_commit`, not `HEAD` (carry-forward invariant on the wiring step).
- **Prior art** (Parmar 2026): the MCP Mediator pattern (a server that is simultaneously a client
  to downstream MCP servers); a five-primitive declarative DSL (`call`/`loop`/`parallel`/`pipe`/
  `collect`); implicit data flow via `steps.<id>`; JMESPath templates; a client-pool routing table
  (`toolName → server`) that *statically dispatches* each step. Deliberately excludes conditionals
  ("branching needs agent reasoning"). Achieves >99% token reduction on *repeated identical*
  orchestrations.
- **MCP capabilities** relevant here: **sampling** (server → client LLM completion) and
  **elicitation** (server → client structured human input). Both are server-initiated callbacks.
- **Surface stack**: the a2ui / palinex surface-emission tooling already available, for rendering a
  human choice inline.

## Decision

Build a **suspendable MCP workflow engine** in/alongside the supervisor. An agent compiles intent
once into a declarative blueprint; the engine replays it, dispatching nodes to the cheapest capable
executor and suspending at choice points where intelligence (LLM or human) is injected from outside.

The design is **layered**, and the layers ship in order:

**L1 — Workflow engine + Mediator.** A declarative blueprint (JSON) of steps over a minimal DSL
(`call`/`loop`/`parallel`/`pipe`/`collect`, borrowed from Parmar), executed by an MCP-mediator: a
server that is also a client to downstream MCP servers. Implicit data flow via `steps.<id>`,
template resolution for parameters. This is the deterministic spine. **(RF-1, resolved: the mediator
is a SEPARATE component/process — the supervisor is one downstream MCP server it calls via
`qwen_spawn`/`poll`/`send`/`stop`, not the mediator itself. `@modelcontextprotocol/sdk` already
ships the client, so no new dependency and zero supervisor changes.)**

**L2 — Dispatch as a step executor, executor selectable.** A node's executor is a routing choice,
not a structural one:
- **default** → a top-level Claude subagent (the native fork). `claude -p` is explicitly **out of
  scope** here; how Claude-side nodes run is optimized orthogonally later.
- **alternative** → a local Qwen agent, via RDR-007 `dispatch()`. The inverted gradient applied
  per node: "needs some intelligence, but not frontier intelligence" runs cheap and local.
RDR-007's `dispatch()` is the `agent-cli` step executor this layer plugs in. The `base_commit`
extraction invariant from RDR-007 lands with it, with the integration test the RDR-007 close
demanded.

**L3 — Continuations with injectable choice.** Loosen Parmar's no-runtime-intelligence rule. A node
may suspend the run and emit a *choice request*; the run resumes when an external actor supplies the
answer.

The **baseline mechanism is poll/resume tools**: `run_workflow(...) → {status:"suspended", runId,
choicePoint}`, then `resume_workflow(runId, choice)`. **(RF-2, resolved:** the suspended run's state
lives in an engine-side `Map<runId, RunState>` — *not* in the supervisor's session pool. A run spans
multiple Qwen sessions, outlives any one of them, and must not be subject to the session reaper's
idle-TTL. Per-node Qwen execution still uses the session model, but each Qwen step completes and is
stopped *before* the run suspends, so no session is held across a suspension. The shape is
session-like; the container is the engine's own map.**)**

Choice channels:
- **LLM / driving-Claude judgment** — carried by the poll/resume baseline itself. The driving Claude
  is the *caller* of `run_workflow`; on suspend the engine yields control with a `choicePoint`, and
  the driving Claude reasons and calls `resume_workflow`. Yielding to the caller *is* the mechanism —
  no server-initiated call needed. (RF-3: Claude Code does **not** support server-initiated
  `sampling`, so this yield-to-caller path is the design, not a fallback. Autonomous mid-run judgment,
  when wanted, dispatches to a local Qwen agent instead.) The credential boundary holds: the engine
  never reasons and never holds a key.
- **Human choice** → MCP **elicitation** (RF-3: supported in Claude Code **2.1.76+**, 2026-03-14). The
  engine requests structured input against a JSON schema; Claude Code renders the form. A genuine
  server-initiated enhancement layered on the poll/resume baseline.

Server-initiated `sampling` (engine pulls an LLM completion mid-run *without* yielding) is
**deferred** until Claude Code ships it. The design does not depend on it.

**L4 — Human choice rendered as a surface.** The elicitation/choice request renders through the
a2ui / palinex surface stack; the selection resolves the continuation.

### Bright line — explicit non-goals (we are not Temporal)

This engine is **best-effort and in-memory only**. We deliberately do **not** build, and we accept
the limitations of not having:
- **Durability** — suspended runs live in process memory. A supervisor restart loses every in-flight
  run. (Consistent with the existing session pool, which is also non-durable.)
- **Idempotency / exactly-once** — re-running or resuming gives no convergence guarantee; the engine
  does not dedupe or fence side effects.
- **Checkpointing / replay** — there is no durable event log, no resume-from-checkpoint, no
  deterministic replay.

These are Temporal's problem space and we will not replicate them. The accepted consequences: a crash
mid-workflow loses the run; resume only works while the process that suspended it is alive; there is
no durable audit trail. If a future need demands durable execution, that is its own RDR — not a
loosening of this one.

### Approach

The numbered Decision layers above are realized as implementation phases, each closed by a bead
(`ItemN=<closing-bead>` for the phase-review-gate cross-walk). Beads are filed at planning time.

1. **Workflow engine + MCP Mediator (L1)** — blueprint schema, the five-primitive DSL, template
   resolution, implicit `steps.<id>` data flow, the mediator (server-that-is-also-client) + downstream
   client pool. Item1=none (bead TBD at planning).
2. **Dispatch as selectable step executor (L2)** — wire RDR-007 `dispatch()` as the `agent-cli`
   executor; declare/register `kind:"agent-cli"` providers; the `base_commit`-not-`HEAD` extractPatch
   host effect + its integration test. Item2=none (bead TBD).
3. **Continuation core (L3, baseline)** — in-memory suspend/resume over the session model;
   `run_workflow`/`resume_workflow` tools; the choice-point contract. Item3=none (bead TBD).
4. **Choice channels (L3, enhancement)** — `sampling` (LLM/driving-Claude) and `elicitation` (human)
   as server-initiated channels, gated on verified client support. Item4=none (bead TBD).
5. **Surface-rendered human choice (L4)** — render the elicitation/choice request through the
   a2ui/palinex surface stack. Item5=none (bead TBD).

Validation gate before committing to phases: prove **one real workflow** (the RDR `/accept` lifecycle
is the probe) actually has a reusable mechanical spine + offloadable nodes + genuine judgment nodes,
such that this engine beats top-level-Claude-orchestrating-live. If we cannot demonstrate that, park
the RDR (no rails without a train).

## Research Findings

- **RF-1 — Mediator placement. RESOLVED (2026-06-13): separate engine.** The workflow engine is its
  own MCP-mediator process; the supervisor is one downstream MCP server it calls (`qwen_spawn`/etc.).
  `@modelcontextprotocol/sdk` already ships the client → no new deps, zero supervisor changes. The
  supervisor stays a single-upstream stdio server; mixing N-downstream-client lifecycle into it was
  rejected (transport coupling + tool-surface separation). T2: `RDR-008-research-01-mediator-placement`.
- **RF-2 — Continuation baseline. RESOLVED (2026-06-13): poll/resume, separate `RunState` map.** The
  poll/resume *interface* is right, but run state lives in an engine-side `Map<runId, RunState>`, NOT
  in the session pool (a run spans multiple sessions, outlives them, and the 30-min session reaper
  would evict a run waiting on a human choice). Sessions are reused only for per-node Qwen execution,
  stopped before the run suspends. Pool confirmed in-memory/non-durable — the bright line describes
  existing reality. T2: `RDR-008-research-02-continuation-baseline`.
- **RF-3 — Client callback support. RESOLVED (2026-06-13): elicitation yes, sampling no.** Elicitation
  shipped in Claude Code 2.1.76 (2026-03-14) → human-choice channel is available. Server-initiated
  `sampling` is not supported (on roadmap) → the LLM-judgment case is carried by the poll/resume
  yield-to-caller path instead, and `sampling` is deferred. `@modelcontextprotocol/sdk` implements
  both `createMessage`/`elicitInput` server-side, gated on client capability. T2:
  `RDR-008-research-03-client-callback-support`.
- **RF-4 — Value validation. OPEN.** Does `/accept` (or another real workflow) have a spine worth
  compiling and nodes worth dispatching? Quantify against top-level-Claude-live. This is the value
  gate; still to be probed.
- **RF-5 — Worktree/base_commit ownership. OPEN.** Caller-supplied worktree+base vs engine-created
  worktree. Iterate; the `base_commit`-not-`HEAD` invariant is non-negotiable regardless.

## Consequences

### Positive
- The orchestrator's fan-out can route bounded nodes to free, local Qwen instead of metered Claude
  subagents — the inverted gradient, applied at workflow-node granularity.
- Repeated workflow spines are compiled once and replayed cheaply (partial Parmar win).
- Judgment and human-in-the-loop are first-class via continuations, without the engine holding a
  credential (sampling) and without a bespoke UI protocol (elicitation + existing surfaces).
- Reuses the existing session machinery; the continuation engine is the session pool generalized.

### Negative
- **No durability/idempotency/checkpointing** (the bright line) — crashes lose in-flight runs;
  resume is process-bound; no durable audit. Accepted.
- Scope is a stack (L1–L4); risk of building a platform. Mitigated by hard phasing and the value gate.
- The Parmar headline (>99%) does **not** transfer — ours is the hybrid case (repeated structure,
  per-run content, judgment branches), so savings are smaller and split across two mechanisms.
- `sampling`/`elicitation` depend on client support that may not exist (RF-3).

### Neutral
- `claude -p` stays out of scope; Claude-side node execution is optimized orthogonally later.

## References

- RDR-007 — Unified agent dispatch contract (the `dispatch()` executor this builds on).
- RDR-001 — Supervisor + session model + credential-boundary invariant.
- Parmar, *Separating Intelligence from Execution: A Workflow Engine for the MCP*, arXiv:2605.00827
  (indexed to T3 `knowledge`, 2026-06-13).
- MCP sampling and elicitation capabilities (Model Context Protocol specification).
- T2: `design-rdr008-dispatch-workflow-engine-direction` (the working design note this RDR formalizes).
