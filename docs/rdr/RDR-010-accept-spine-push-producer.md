---
title: "Live /accept spine — the PUSH producer that populates RunContext.emitted/finalMessage and wires acceptHarvester into a dispatched run"
id: RDR-010
type: Design
status: draft
priority: medium
author: hal
reviewed-by: self
created: 2026-06-14
related_issues: ["Hellblazer/nexus#1174"]
---

# RDR-010: Live /accept spine — the PUSH producer for the harvest envelope

> Revise during planning; lock at implementation. If wrong, abandon code and iterate the RDR.

## Problem Statement

RDR-009 generalized the dispatch result to a typed `Artifact[]` and shipped both harvesters: the
git-diff harvester (PULL, reads `RunContext.environment`) and `acceptHarvester` (PUSH, reads
`RunContext.emitted` + `finalMessage`). But it shipped only the **consumer half**. The R2 stacked
review flagged this precisely: `acceptHarvester` is correct and RF-1-clean, yet **unreachable in
production** because:

1. `runContextFor` (`src/dispatch.ts`) hardcodes `emitted: []` and never sets `finalMessage` — so a
   dispatched run always produces an empty PUSH channel.
2. No dispatcher injects `acceptHarvester` as its `harvest` effect — the default supervisor wiring
   only ever installs the git-diff harvester.
3. There is no **producer**: no code path emits `entity`/`tier` artifacts into a run, and the leaf's
   structured return (`finalMessage`) is never captured from the qwen session and threaded into
   `RunContext`.

The MVV in RDR-009 ("a non-patch artifact flows end-to-end and is consumed downstream") was therefore
demonstrated only over a **hand-built** `RunContext` in an integration test, never through a live
dispatched run. RDR-009 recorded this as an explicit deferral (engine/host scope) rather than
overclaiming. This RDR is that deferred work: make the PUSH path **reachable through a real producer**.

### Enumerated gaps to close

#### Gap 1: The leaf's structured return is never captured

The qwen leaf returns its structured output (e.g. a strategic-planner's plan JSON) in the session's
final message, but the supervisor adapter (`makeSupervisorQwenSpawnEffects`) only maps `state` and
`turns_completed` from the poll result. The leaf's `last_message` is discarded, so
`RunContext.finalMessage` is always absent and a dispatched leaf can never surface a `{kind:"value"}`.

#### Gap 2: A run cannot select a non-git harvester

`qwen_dispatch` always wires the git-diff harvester. A non-code leaf (a planner returning a plan, not
a diff) has no way to ask the executor to harvest its `finalMessage` as a `value` instead of (or in
addition to) a worktree diff.

#### Gap 3: There is no spine, so spine-emitted entity/tier artifacts have no origin

The deterministic `/accept` spine (the host code that mints beads, writes T2, edits frontmatter) is
the thing that emits `entity`/`tier` artifacts "directly at the time it writes them" (RF-1). Today no
such spine exists as dispatchable/composable host code. The `rdr-accept` capability is a conexus skill
orchestrated by the main conversation, not a producer that emits `Artifact[]` into a ledger.

## Context

### Background

RDR-009's driving counter-example was `/accept` of an RDR as a dispatchable workflow: a deterministic
**spine** (mint beads, write T2, edit files) plus dispatchable heavy **leaves** (strategic-planner,
`nx_plan_audit`, `nx_enrich_beads`). RDR-009 built the envelope to carry that workflow's output; it
deferred building the workflow itself. The deferral was correct (envelope first, producer second), but
it leaves the harvest envelope a seam with no production traffic.

### The ownership question this RDR must settle

RDR-009 said "nexus owns the ledger; the `/accept` orchestration is an engine concern." That leaves a
real fork this RDR must resolve, **not** assume:

- **What is buildable in qwen-coprocessor-stack (the executor):** capturing a dispatched leaf's
  `finalMessage` and surfacing it as a `value` artifact (Gap 1 + Gap 2) is squarely executor-side and
  in-repo testable. A single `qwen_dispatch` call returns one leaf's `Artifact[]`.
- **What may belong to the orchestrator (nexus, or a host spine):** the multi-step spine that
  accumulates `entity`/`tier` emissions across the workflow. A single dispatch cannot emit the spine's
  artifacts because the spine spans multiple dispatches plus deterministic host work. This is the
  `plan_run` ledger's job (RDR-009 RF-4) OR a reference spine built here as a demonstrator.

The honest scope question for THIS repo: do we (a) close Gaps 1-2 in the executor + build a **reference
`/accept` spine demonstrator** that proves the full PUSH path end-to-end against a real (local) dispatch,
or (b) close Gaps 1-2 only and leave the spine entirely to nexus? This RDR must pick one explicitly.

### Technical Environment

- Executor: `mcp-bridges/qwen-agent-server/src/{dispatch,dispatch-tool,server}.ts`. `acceptHarvester`,
  `gitDiffHarvester`, `Harvest`, `RunContext`, `runContextFor` from RDR-009.
- Supervisor adapter: `makeSupervisorQwenSpawnEffects` (maps qwen_spawn/poll → effects; the place a
  `finalMessage` capture would land). `QwenPollSnapshot` currently carries `{state, turnsUsed?, cost?}`.
- Published contract: `docs/contracts/qwen-dispatch-operator-contract.md` (v3) + fixtures. Any new
  request field (e.g. selecting the value harvester) or response behavior is a v4 contract evolution.
- nexus: `plan_run` step outputs as the ledger (RDR-009 RF-4); Hellblazer/nexus#1174 (pending sign-off).

## Research Findings

> To be completed via `/conexus:rdr-research`. Open questions to investigate (source-grounded):

- **RQ-1 — does the qwen poll result expose the leaf's structured return reliably?** Inspect
  `PollResult` / the session's `last_message` (or equivalent) in `src/session.ts` / the supervisor
  poll path. Determine whether a non-truncated final structured message is available at terminal state
  (RF-1 noted `summary` is truncated to 120 chars and the real text lives in `last_message`). Confirms
  or refutes the feasibility of Gap 1's `finalMessage` capture.
- **RQ-2 — how should a run select the value/accept harvester?** A new optional `qwen_dispatch` input
  (e.g. `harvest: "patch" | "value" | "accept"`), a per-provider default, or a composed harvester that
  always runs both (git-diff + value) and returns whatever is non-empty? Weigh against the locked
  four-kind union and the v3 contract.
- **RQ-3 — where does the `/accept` spine live, and what is the minimal demonstrator?** Survey whether
  a reference spine belongs in this repo (a demonstrator + integration test) or whether the executor
  should only expose the value-harvest and leave all spine/ledger accumulation to nexus. Check the
  existing `rdr-accept` skill to see what the spine actually does today.
- **RQ-4 — emission entry point.** If a spine emits `entity`/`tier` into a run, what is the API? Does
  `RunContext.emitted` get populated by the dispatcher (per-call, only the leaf's own emissions) or by
  the orchestrator across calls? Confirm against RDR-009's "executor is one-shot; each step returns its
  Artifact[] at completion" invariant.

### Critical Assumptions

- [ ] **The leaf's structured return is available at terminal state, untruncated** — Status: UNVERIFIED
  — Method: source search of the supervisor poll/session path (RQ-1).
- [ ] **A single dispatch returns only the leaf's own artifacts; spine emissions accumulate at the
  orchestrator** — Status: UNVERIFIED — Method: confirm against the RDR-009 one-shot invariant + the
  nexus step-output model (RQ-4).
- [ ] **No live nexus consumer depends on the current v3 response shape** (so a v4 evolution, if any,
  is land-together not migrate-live) — Status: UNVERIFIED — Method: #1174 status check.

## Proposed Solution

> First cut, pre-research. Expect revision after `/conexus:rdr-research` and the gate.

### Approach

Close the executor-side gaps in-repo and prove the PUSH path with a reference demonstrator; leave the
production `/accept` orchestration to nexus.

1. **Capture the leaf's `finalMessage` (Gap 1).** Extend the supervisor adapter / poll snapshot to
   carry the terminal `last_message`; thread it into `RunContext.finalMessage` in the dispatchers (the
   one field `runContextFor` currently never sets).
2. **Make the harvester selectable (Gap 2).** Let a `qwen_dispatch` run choose a value/accept harvester
   (exact mechanism = RQ-2) so a non-code leaf surfaces its `finalMessage` as a `{kind:"value"}`
   without inventing a worktree diff. The git-diff harvester stays the default for coding runs.
3. **Reference `/accept` spine demonstrator (Gap 3, scope TBD by RQ-3).** A host-side spine that drives
   a (local/fake) dispatch, emits an `entity`(bead)/`tier`(T2) as it does deterministic work, captures
   the leaf's `value`, composes the full `Artifact[]`, and a downstream reader consumes the non-patch
   entity — the RDR-009 MVV, now through a real producer rather than a hand-built `RunContext`.

### Out of scope (carried from RDR-009, do not re-open)

- The production `/accept` workflow living in nexus (engine concern); building the nexus ledger.
- Mid-run artifact streaming / continuations (still the engine's suspend/resume channel).
- A fifth `Artifact` kind. Environment-axis generalization (container/remote).

## Alternatives Considered

### Alternative 1: Leave everything to nexus (executor exposes nothing new)

**Description**: publish the requirement that orchestrators populate `RunContext` themselves; build
nothing in this repo.

**Cons**: the PUSH path stays unreachable from the executor; a dispatched leaf still can't return its
own structured `value`. The R2 gap (Gap 1) persists indefinitely.

### Alternative 2: Build the full production `/accept` workflow in this repo

**Description**: implement the real `/accept`-of-an-RDR spine as dispatchable host code here.

**Reason for likely rejection**: contradicts RDR-009's ledger-ownership decision (nexus owns
accumulation/persistence) and re-opens the build-vs-extend fork; far larger than closing the executor
gaps. A *demonstrator* spine (Alt-in-Approach) gets the end-to-end proof without owning production.

## Trade-offs

### Consequences

- (+) The harvest envelope gains real production traffic; a dispatched leaf can return structured
  non-code output.
- (+) The RDR-009 MVV becomes a live end-to-end proof, not a hand-built fixture.
- (−) Possibly a v4 contract evolution (harvester selection / `finalMessage` capture surfaced) — a
  cross-repo coordination on #1174.

### Risks and Mitigations

- **Risk**: scope creep into building production `/accept` in this repo. **Mitigation**: a reference
  *demonstrator* only; production orchestration stays nexus's (RDR-009 decision).
- **Risk**: `last_message` is truncated/unavailable. **Mitigation**: RQ-1 verifies before committing to
  Gap 1; if unavailable, the value channel narrows to what the leaf can be made to emit explicitly.

## Implementation Plan

> Phases are provisional; finalize after research.

### Minimum Viable Validation

A live (local/fake-backed) dispatch of a non-code leaf returns `[{kind:"value", value: <parsed
finalMessage>}]`; a reference spine emits an `entity`(bead, created) alongside; the composed
`Artifact[]` is read by a downstream consumer that extracts the created-bead entity. Proven without a
hand-built `RunContext` (the RDR-009 gap).

### Phase 1 (provisional): Capture `finalMessage` + selectable value harvester

Gaps 1-2 in the executor + conformance/contract update if the request/response surface changes.

### Phase 2 (provisional): Reference `/accept` spine demonstrator + end-to-end MVV test

Gap 3 (scope per RQ-3): a host spine emitting entity/tier + consuming the leaf value, with an
integration test proving the live PUSH path.

## References

- RDR-009 (`docs/rdr/RDR-009-harvest-envelope.md`, closed) + post-mortem (§MVV deferral, §Open threads).
- R2 review finding: `acceptHarvester` unreachable in production (`runContextFor` emits `[]`).
- `src/dispatch.ts` (`acceptHarvester`, `runContextFor`), `src/dispatch-tool.ts`
  (`makeSupervisorQwenSpawnEffects`), `src/session.ts` (poll / `last_message`).
- Hellblazer/nexus#1174 (v3 contract, pending sign-off).

## Revision History

- 2026-06-14: created (draft). Scaffolds the RDR-009-deferred PUSH producer. Research (RQ-1..RQ-4) and
  the gate pending.
