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

**Resolved by research (RF-2, RF-3):** the production `/accept` is a conexus skill that does **not**
call `qwen_dispatch`, and the executor structurally cannot populate `RunContext.emitted` with the
spine's `entity`/`tier` (those accumulate at the orchestrator across calls). So the executor's only
reachable PUSH artifact is `value`-from-`finalMessage` (Gaps 1-2). Gap 3's `entity`/`tier` emission +
`acceptHarvester` wiring is confirmed **orchestrator scope** — a demonstrator here would have to *fake*
the spine. This RDR therefore leans toward **(b)**: ship the executor `finalMessage`/value-harvest, and
treat any demonstrator as explicitly-fake-spine illustration, not a production `/accept`. The title's
"live `/accept` spine" is partly a misnomer; the real deliverable is **the executor's value-harvest +
`finalMessage` capture**.

### Technical Environment

- Executor: `mcp-bridges/qwen-agent-server/src/{dispatch,dispatch-tool,server}.ts`. `acceptHarvester`,
  `gitDiffHarvester`, `Harvest`, `RunContext`, `runContextFor` from RDR-009.
- Supervisor adapter: `makeSupervisorQwenSpawnEffects` (maps qwen_spawn/poll → effects; the place a
  `finalMessage` capture would land). `QwenPollSnapshot` currently carries `{state, turnsUsed?, cost?}`.
- Published contract: `docs/contracts/qwen-dispatch-operator-contract.md` (v3) + fixtures. Any new
  request field (e.g. selecting the value harvester) or response behavior is a v4 contract evolution.
- nexus: `plan_run` step outputs as the ledger (RDR-009 RF-4); Hellblazer/nexus#1174 (pending sign-off).

## Research Findings

### Investigation

RQ-1..RQ-4 investigated at source (2026-06-14). Findings recorded in T2
(`RDR-010-research-01-push-producer-feasibility`). The net effect is a **scope reshape**: the
executor's only reachable PUSH artifact is `value`-from-`finalMessage`; the `entity`/`tier` emission
channel is confirmed orchestrator scope (RDR-009's "engine owns it" holds at the executor boundary).

- **RF-1 (RQ-1) — the leaf's structured return IS available untruncated. Verified (source).**
  `PollResult.last_message?: string` (`src/types.ts:421`) is set on terminal `idle`/`complete`
  (`session.ts:424-425`) from `QwenSession._last_message`, which holds the **full** assistant
  `textBlocks` (`session.ts:598`), not the 120-char `_last_assistant_summary`. The supervisor even
  instructs leaves to emit structured JSON ("final assistant message must START with `{` or `[`",
  `session.ts:779`). **Gap**: `makeSupervisorQwenSpawnEffects` maps only `state`/`turns_completed`
  into `QwenPollSnapshot {state, turnsUsed?, cost?}` and **drops** `last_message`. Fix is small: add a
  `lastMessage` field to `QwenPollSnapshot`, map it in the adapter, and thread `last.lastMessage` into
  `RunContext.finalMessage` in the dispatchers (the one field `runContextFor` never sets). **Gap 1
  feasible.**
- **RF-2 (RQ-3) — the `/accept` workflow today is a CONEXUS SKILL, not `qwen_dispatch` traffic.
  Verified (source: `conexus/skills/rdr-accept/SKILL.md`).** Its structure maps to RDR-009's
  decomposition (Steps 1-6 = deterministic spine: T2 status write → `tier:T2`, frontmatter+README edits
  → `patch`, `git add`; Step 7 = dispatched leaves), BUT the leaves use the **Agent tool** (Claude
  subagents: `strategic-planner`) + direct MCP calls (`nx_plan_audit`, `nx_enrich_beads`) — **not
  `qwen_dispatch`** — and effects are tracked implicitly (`bd` mints beads, `memory_put` writes T2),
  with **no `Artifact[]` ledger**. **Consequence**: a "live `/accept` spine through the executor"
  would be a **demonstrator only**; the production `/accept` does not call `qwen_dispatch`, so wiring
  `acceptHarvester` into a `qwen_dispatch` run does not capture the real `/accept`.
- **RF-3 (RQ-4) — `RunContext` is per-call; one dispatch = one leaf; the executor cannot populate
  `emitted` with spine artifacts. Verified (source).** `runContextFor(task, opts)` (`src/dispatch.ts`)
  builds a fresh `RunContext` per dispatch call. The executor could only populate `emitted` with
  artifacts the **leaf** emits during its own run — and a qwen leaf emits nothing structured mid-run
  except its `finalMessage`. The spine's `entity`/`tier` emissions accumulate at the **orchestrator
  across calls** + deterministic host work, never inside a single dispatch's `RunContext` (consistent
  with RDR-009's one-shot invariant). **Consequence**: `acceptHarvester`'s `emitted` pass-through is
  fundamentally an **orchestrator-layer** concept; at the executor layer the only reachable PUSH
  artifact is `value`-from-`finalMessage`.
- **RF-4 (RQ-2) — harvester selection.** Options: (a) a new optional `qwen_dispatch` input
  `harvest: "patch" | "value" | "both"` (explicit; default `"patch"` is additive, no breaking v4);
  (b) a per-provider default; (c) a composed default that always runs git-diff + value and returns the
  non-empty ones (risk: a coding leaf's `last_message` chatter becomes a spurious `value` artifact —
  noise). **Lean (a) defaulting to `"patch"`** so coding runs stay byte-unchanged and a non-code leaf
  opts into `"value"`; additive, so no live-consumer migration. Final pick at the gate.

### Critical Assumptions

- [x] **The leaf's structured return is available at terminal state, untruncated** — Status: VERIFIED
  — Method: Source Search (`types.ts:421`, `session.ts:424-425,598,779`). RF-1.
- [x] **A single dispatch returns only the leaf's own artifacts; spine emissions accumulate at the
  orchestrator** — Status: VERIFIED — Method: Source Search (`runContextFor`, RDR-009 one-shot
  invariant). RF-3.
- [ ] **No live nexus consumer depends on the current v3 response shape** (so a v4 evolution, if any,
  is land-together not migrate-live) — Status: DOCUMENTED-PENDING — #1174 is pending sign-off; no known
  live consumer. Confirm before shipping any new response surface.

## Proposed Solution

> Revised after `/conexus:rdr-research` (RF-1..RF-4). The two executor-side gaps are the real in-repo
> deliverable; Gap 3 is confirmed orchestrator scope.

### Approach

Close the two executor-side gaps so a dispatched leaf can return its structured `value`; leave the
spine's `entity`/`tier` emission + `acceptHarvester` wiring to the orchestrator (nexus / the conexus
skill), per RF-2/RF-3.

1. **Capture the leaf's `finalMessage` (Gap 1, feasible per RF-1).** Add a `lastMessage` field to
   `QwenPollSnapshot`; map `PollResult.last_message` in `makeSupervisorQwenSpawnEffects`; thread
   `last.lastMessage` into `RunContext.finalMessage` in the dispatchers (the one field `runContextFor`
   never sets today).
2. **Make the harvester selectable (Gap 2, mechanism per RF-4).** Add an optional `qwen_dispatch` input
   `harvest: "patch" | "value" | "both"` defaulting to `"patch"` (additive — coding runs stay
   byte-identical, no v4 break). `"value"` surfaces `finalMessage` as a single `{kind:"value"}` (reuse
   the `acceptHarvester` value-parse path); `"both"` composes git-diff + value. The dispatcher selects
   the harvester from the input.
3. **(Optional) explicitly-fake-spine demonstrator (Gap 3 is orchestrator scope — RF-2/RF-3).** Only if
   it earns its keep at the gate: an integration test where a *fake* spine hand-emits an `entity`(bead)
   + `tier`(T2), a real (fake-backed) dispatch contributes the leaf `value`, and `acceptHarvester`
   composes the full `Artifact[]` a reader consumes — an illustration of the orchestrator pattern, NOT
   a production `/accept`. Default lean: **skip** — the RDR-009 P2 integration test already proves
   `acceptHarvester` over a populated `RunContext`; add only if it demonstrates something that test
   does not.

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

- **Risk**: scope creep into building production `/accept` in this repo. **Mitigation**: RF-2 shows the
  real `/accept` is a conexus skill that does not use `qwen_dispatch`; this RDR ships only the executor
  value-harvest. Any demonstrator is explicitly-fake and optional.
- **Risk (RETIRED)**: `last_message` truncated/unavailable. RF-1 verified the full terminal text is in
  `PollResult.last_message` (not the 120-char summary). Gap 1 is feasible as designed.

## Implementation Plan

> Reshaped by research. The deliverable is the executor value-harvest (Gaps 1-2); Gap 3 is orchestrator
> scope and the demonstrator is optional.

### Minimum Viable Validation

A dispatched non-code leaf, run with `harvest: "value"`, returns `[{kind:"value", value: <parsed
finalMessage>}]` — proving a structured non-patch artifact is reachable through a real `qwen_dispatch`
call (not a hand-built `RunContext`). A coding run with the default `harvest: "patch"` is byte-identical
to today (the regression guard).

### Phase 1: Capture `finalMessage` (Gap 1)

Add `lastMessage` to `QwenPollSnapshot`; map `PollResult.last_message` in
`makeSupervisorQwenSpawnEffects`; thread `last.lastMessage` into `RunContext.finalMessage` in both
dispatchers. Unit tests: the adapter maps `last_message`; the dispatcher sets `finalMessage`.

### Phase 2: Selectable harvester + the `"value"`/`"both"` paths (Gap 2)

Add the optional `harvest` input (default `"patch"`), select the harvester in the dispatcher/wiring,
and reuse `acceptHarvester`'s value-parse for `"value"`. Update `qwen-dispatch-shapes.json` (additive
request field) + both conformance suites + the operator contract (v4-additive, default unchanged).
Integration test: a fake-backed dispatch with `harvest: "value"` yields the `{kind:"value"}`; with the
default, the patch path is unchanged.

### Phase 3 (optional, gate-decided): explicitly-fake-spine demonstrator

Only if it adds beyond the RDR-009 P2 test. A fake spine emits `entity`+`tier`, a fake-backed dispatch
contributes the leaf `value`, `acceptHarvester` composes them; a reader consumes the entity. Labeled a
demonstrator of the orchestrator pattern, not a production `/accept`.

## References

- RDR-009 (`docs/rdr/RDR-009-harvest-envelope.md`, closed) + post-mortem (§MVV deferral, §Open threads).
- R2 review finding: `acceptHarvester` unreachable in production (`runContextFor` emits `[]`).
- `src/dispatch.ts` (`acceptHarvester`, `runContextFor`), `src/dispatch-tool.ts`
  (`makeSupervisorQwenSpawnEffects`), `src/session.ts` (poll / `last_message`).
- Hellblazer/nexus#1174 (v3 contract, pending sign-off).

## Revision History

- 2026-06-14: created (draft). Scaffolds the RDR-009-deferred PUSH producer.
- 2026-06-14: research complete (RF-1..RF-4, T2 `RDR-010-research-01-push-producer-feasibility`). Two
  Critical Assumptions verified at source; the scope reshaped: the in-repo deliverable is the executor
  value-harvest + `finalMessage` capture (Gaps 1-2), Gap 3 (`entity`/`tier` emission) is confirmed
  orchestrator scope (the real `/accept` is a conexus skill that does not call `qwen_dispatch`). Gate
  pending (`/conexus:rdr-gate`).
