---
title: "Agentic dispatch executor — a pluggable dispatcher framework exposing dispatch() as a nexus-callable MCP operator"
id: RDR-008
type: Design
status: accepted
priority: medium
author: hal
reviewed-by: self
created: 2026-06-13
accepted_date: 2026-06-13
related_issues: []
---

# RDR-008: Agentic dispatch executor — a pluggable dispatcher framework

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft. Rescoped 2026-06-13** after research resolved RF-6 (build-vs-extend) in favour of
**extending nexus**. The original draft scoped a full *suspendable workflow engine* in this repo.
Research found nexus already implements that substrate in production — `plan_match` → `plan_run` →
`plan_save` over a typed-operator DAG, with `nx_answer` as the compile-once-run-many loop and
`plan_save` as the **declarative capture** (new use cases become plans/data, not code). Rebuilding
that here would be a second "galactic hammer."

So the split is: **the workflow engine, continuations, and declarative capture are deferred to a
nexus proposal** (separate repo, no change authority here — we publish a spec it may adopt). **This
RDR scopes only the executor side**, and per the project's intent builds it as a **small, pluggable
dispatcher framework** so new executor/provider kinds can be added and adapted over time without a
rewrite. Successor to RDR-007 (closed), whose `dispatch()` contract this exposes.

## Problem Statement

RDR-007 shipped `dispatch()` (`src/dispatch.ts`: `kind:"agent-cli"`, one-shot poll-to-completion,
all host effects injected) with **no MCP surface and no `agent-cli` providers configured**. The
capability is groundwork with no caller. Meanwhile the orchestrator's fan-out still spends metered
Claude subagents on bounded coding sub-tasks a local Qwen agent could do.

We need to expose `dispatch()` as a **callable operator** — so an orchestrator (specifically nexus's
plan engine, as a new operator) can route a bounded sub-task to a local Qwen agent and get back a
`{patch, turns, outcome, cost}` result. And we want the executor side to be a **framework, not a
one-off tool**: a registry of pluggable dispatchers and host-effect strategies, so the next executor
kind (another agent CLI, a different result-extraction strategy, a future provider) plugs in.

## Context

- **RDR-007** (closed): `dispatch(task, provider)` for `kind:"agent-cli"`; the `Dispatch` type;
  `makeQwenSpawnDispatch` / `makeClaudeCliDispatch` built from injected effect interfaces
  (`QwenSpawnEffects`, `ClaudeCliEffects`, `ExtractPatch`). This injection design is already a plugin
  seam — RDR-008 formalizes it into a small registry. The `ExtractPatch` invariant: diff against the
  task's `base_commit`, **not** `HEAD`, and return a source-only patch (the `azf.12` carry-forward).
- **RDR-001** (closed): the supervisor's in-memory session pool (`spawn`/`poll`/`send`/`stop`) and the
  credential-boundary invariant (the supervisor holds no Anthropic credential).
- **nexus plan engine** (separate repo, RF-6 Option B substrate): `plan_match`/`plan_run`/`plan_save`
  + typed operators (`search`/`extract`/`rank`/…) + `nx_answer`. The workflow engine, the plan
  library, and declarative capture *already exist there*. The continuations the workflow needs
  (suspend/resume, human choice via MCP **elicitation** — supported in Claude Code 2.1.76+; LLM
  judgment via yield-to-caller, since server-initiated **sampling** is not yet supported) are nexus
  engine concerns, not this repo's.

## Decision

### In scope (this repo) — the pluggable dispatcher framework + first dispatcher

1. **A dispatcher registry.** A small `providerKind → Dispatch` registry built on RDR-007's existing
   `Dispatch` type and injected-effects design. Resolving and invoking a dispatcher is uniform;
   adding a new executor kind is a registration, not a rewrite. This *is* the "plugin framework."
2. **The first dispatcher: local Qwen (`makeQwenSpawnDispatch`).** Spawn a Qwen agent via the session
   model, poll to completion, return `AgentResult`. One-shot (idle is terminal — matching `dispatch()`).
3. **The MCP tool surface: `qwen_dispatch`.** Resolves a dispatcher from the registry, runs the task,
   returns `{patch, turns, outcome, cost}`. This is the operator nexus (or any orchestrator) calls.
4. **Host-effect strategies (pluggable).** The injected effects become named strategies: the run
   effect (spawn+poll local Qwen), `extractPatch`, and worktree handling — pluggable so a future
   executor can supply its own. Two contract points are **locked** here:
   - **`base_commit` is explicit at the tool/effect boundary.** RDR-007's in-process `ExtractPatch`
     was `(worktree) => Promise<string>` with `base_commit` closure-captured; a closure can't cross
     the MCP boundary, so the `qwen_dispatch` input carries `base_commit` and `ExtractPatch` becomes
     `(worktree, baseCommit) => Promise<string>`. It always diffs against `base_commit`, never `HEAD`,
     and returns the source-only patch. **`AgentTask`/`AgentResult` are pinned by RDR-007's closed
     golden fixtures (`agent-shapes.json`)**, so `base_commit` is carried as a `qwen_dispatch`
     tool-input + `ExtractPatch` parameter — **not** by mutating the locked `AgentTask`, unless we
     explicitly amend RDR-007's contract and its fixture (which this RDR does not).
   - **Contamination is host-internal (decided, not open).** Per RDR-007 P4b, `test_edit_contamination`
     is deliberately *not* a field of `AgentResult`. The executor returns the source-only
     (test-stripped) patch; the contamination boolean stays a host-internal eval concern. Surfacing it
     would be a future `AgentResult` contract extension, out of scope here.
5. **`agent-cli` provider registration.** Today every backend is `kind:"model-endpoint"`; define how
   an `agent-cli` provider (the local Qwen agent) is declared/configured.
6. **The `base_commit` integration test** the RDR-007 close demanded (agent-commits-its-edits case;
   diff against base, not HEAD).
7. **A published, language-neutral spec for nexus** — the dispatch-operator contract plus the
   *continuation requirements* an engine needs from an executor — mirroring how RDR-007 handled the
   out-of-scope nexus piece (publish a spec it may adopt; no code in their repo from here).

### Discipline — a seam, not a speculative platform

The "framework" is the **registry + the RDR-007 effect interfaces**, nothing more. We do **not** build
plugin discovery, dynamic loading, or a plugin lifecycle until a *second concrete* executor justifies
it. (Same restraint that kept us from rebuilding nexus's engine here.) Two axes, honestly:
- **Dispatcher axis** — we ship **one** dispatcher (local Qwen). The registry stays a thin seam until
  a real second dispatcher appears; this axis is single-member by design for now.
- **Host-effect axis** — the worktree strategy has a *proven* second member (the eval harness's
  `scripts/coding-eval/materialize.py` mechanics) shipping as an immediate fast-follow, not the same
  instant. So this seam is justified by an actual, already-written second strategy — not a speculative one.

### Out of scope (deferred to a nexus proposal)

- The workflow engine / mediator / plan execution — nexus has it (`plan_run` + operators).
- Declarative capture of workflows — nexus has it (`plan_save`).
- Continuations / suspend-resume / choice injection / elicitation — nexus engine concern. Our executor
  is **one-shot and does not suspend**; the published spec (item 7) tells nexus what an executor needs.
- Wiring dispatch as an operator *inside* nexus — nexus's to build against our spec.
- `claude -p` as a provider — explicitly out of scope; Claude-side execution is the native subagent
  fork, optimized orthogonally later.

### Bright line (carried from the original draft)

No durability, no idempotency, no checkpointing/replay. Mostly moot for a one-shot executor; the
engine's durability posture is nexus's call. We do not build Temporal here.

### Approach

Implementation phases, each closed by a bead (`ItemN=<closing-bead>`; beads filed at planning).

1. **Dispatcher registry + local-Qwen dispatcher + `agent-cli` provider registration** — the plugin
   seam and its first plugin. Item1=qwen-coprocessor-stack-q8k.
2. **`qwen_dispatch` MCP tool + host-effect strategies + the `base_commit` contract change & its
   integration test (same bead).** The tool input carries `base_commit`; `ExtractPatch` gains the
   `baseCommit` parameter; the agent-commits-its-edits integration test (diff-vs-base non-empty,
   diff-vs-`HEAD` empty) lands in the **same bead** as the signature change, so the silent-zero path
   can't ship unguarded. Ships the caller-supplied worktree strategy; the executor-managed strategy
   (the `materialize.py` port) is a fast-follow. Item2=qwen-coprocessor-stack-exn.
3. **Published dispatch-operator + continuation-requirements spec for nexus — with an enforcement
   hook.** The continuation behavior is prose (not fixture-pinnable), so item 3 carries an explicit
   acceptance criterion: **(a)** a linked nexus issue with an agreed dispatch-operator interface
   signature, AND **(b)** a JSON-shape conformance fixture for the `qwen_dispatch` request/response
   contract (which *is* fixture-pinnable, as RDR-007 did for `AgentTask`/`AgentResult`). The spec must
   also document that this executor is strictly one-shot (`idle` is terminal — nexus must not build a
   resume-the-executor path) and the operator-registration ceremony nexus needs. Without (a)+(b),
   item 3 is documentation with no feedback loop. Item3=qwen-coprocessor-stack-pwa.

## Research Findings

- **RF-1 — Mediator placement. RESOLVED + RELOCATED.** The mediator/engine is **nexus** (RF-6 Option
  B). This repo is a downstream MCP server nexus calls; it is not the mediator. T2:
  `RDR-008-research-01-mediator-placement`.
- **RF-2 — Continuation baseline. RELOCATED to nexus.** Suspend/resume over a `Map<runId, RunState>`
  (not the session pool) is the *engine's* concern. Our executor is one-shot. Finding retained to seed
  the nexus proposal. T2: `RDR-008-research-02-continuation-baseline`.
- **RF-3 — Client callbacks. RELOCATED to nexus.** Elicitation (human choice) is supported in Claude
  Code 2.1.76+; sampling is not (deferred, yield-to-caller instead). Both are engine-side; our executor
  does not suspend. T2: `RDR-008-research-03-client-callback-support`.
- **RF-4 — Value validation. RESOLVED.** The value is the inverted gradient as a nexus operator: route
  heavy workflow nodes (e.g. `/accept`'s planner/audit/enrich) to local Qwen instead of metered Claude.
  Not Parmar token-elimination (our spines are trivial). T2:
  `RDR-008-research-04-value-probe-and-nexus-substrate`.
- **RF-5 — Worktree/base_commit ownership. RESOLVED (2026-06-13).** `base_commit` is **always
  caller-supplied and explicit in the `qwen_dispatch` task payload** (across the MCP boundary it can't
  be the closure-captured value RDR-007 used in-process). `extractPatch` always diffs against it, never
  `HEAD`, source-only. **Worktree handling is a pluggable host-effect strategy**: default
  *caller-supplied worktree path* (executor just runs + extracts; lifecycle is the caller's), with an
  optional *executor-managed worktree* (a TS port of the eval harness's bare-mirror + detached-worktree
  + cleanup mechanics, `materialize.py`) as a second strategy. Ship the caller-supplied default first;
  the executor-managed strategy (a port of the proven `materialize.py` mechanics) is the immediate
  fast-follow — a beat after the first, not the same instant. So the host-effect seam is justified by a
  real, already-written second strategy. (The *dispatcher* axis still has one member until a real
  second dispatcher appears.) T2: `RDR-008-research-05-worktree-base-commit-ownership`.
- **RF-6 — Build-new vs extend-nexus. RESOLVED: extend nexus (Option B).** Engine + capture live in
  nexus; this repo contributes only the executor (as a pluggable framework). The strategic
  "build substrate, capture use cases declaratively without a framework per case" bet rides on nexus's
  existing `plan_save`. T2: `RDR-008-research-04-value-probe-and-nexus-substrate`.

## Consequences

### Positive
- Small, self-contained, on-thesis: the inverted gradient delivered as one nexus operator.
- Reuses RDR-007's contract and the existing session model; no new engine to own.
- Declarative capture is **free** (nexus `plan_save`); the over-engineering risk is avoided.
- The pluggable seam lets new executor kinds adapt in without rewrites, while staying minimal.

### Negative
- Depends on nexus adopting the dispatch operator and building the continuations (cross-repo
  coordination; we only publish a spec, as RDR-007 did for `pick_dispatcher_for`). Until nexus adopts,
  `qwen_dispatch` has only ad-hoc callers. **The strategic value (plan-engine-routed inverted gradient)
  is contingent on nexus adoption — an accepted risk, not a positive.** The executor is independently
  useful on delivery (any orchestrator can call `qwen_dispatch`), but the inverted-gradient *thesis*
  needs nexus to wire it as a typed operator. Precedent caution: RDR-007's `pick_dispatcher_for` spec
  remains unadopted by nexus — item 3's acceptance criterion (linked issue + conformance fixture)
  exists precisely to avoid a published-but-ignored spec.
- A registry is a (small) abstraction with one implementation at first — justified only by the intent
  to add more; the discipline note guards against it growing prematurely.

### Neutral
- `claude -p` stays out of scope; engine durability is nexus's call.

## References

- RDR-007 — Unified agent dispatch contract (the `dispatch()` executor + injected-effects seam).
- RDR-001 — Supervisor, session model, credential-boundary invariant.
- nexus plan engine — `plan_match` / `plan_run` / `plan_save`, typed operators, `nx_answer` (the
  workflow + declarative-capture substrate this defers to).
- Parmar, *Separating Intelligence from Execution: A Workflow Engine for the MCP*, arXiv:2605.00827
  (indexed to T3 `knowledge`).
- MCP elicitation (Claude Code 2.1.76+) and sampling (deferred) — engine-side choice channels.
- T2: `design-rdr008-dispatch-workflow-engine-direction`; `RDR-008-research-01..04`.
