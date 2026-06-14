---
title: "Executor value-harvest — a dispatched leaf returns its structured finalMessage as a {kind:value} artifact"
id: RDR-010
type: Design
status: accepted
priority: medium
author: hal
reviewed-by: self
created: 2026-06-14
accepted_date: 2026-06-14
related_issues: ["Hellblazer/nexus#1174"]
---

# RDR-010: Executor value-harvest — a dispatched leaf returns its structured `finalMessage` as a `value`

> Revise during planning; lock at implementation. If wrong, abandon code and iterate the RDR.
>
> **Retargeted 2026-06-14 (post-research).** This RDR began as "the live `/accept` spine" (the
> RDR-009-deferred PUSH producer). Research (RF-1..RF-4) showed that framing was wrong for this repo:
> the production `/accept` is a conexus skill that does not call `qwen_dispatch` (RF-2), and the
> executor structurally cannot emit the spine's `entity`/`tier` artifacts (RF-3). The honest,
> in-repo, valuable deliverable is narrower and concrete: let a dispatched **leaf** surface its own
> structured return (`finalMessage`) as a `{kind:"value"}` artifact. The spine / `entity`+`tier`
> emission stays orchestrator scope. See §Out of scope.

## Problem Statement

RDR-009 generalized the dispatch result to a typed `Artifact[]` and shipped both harvesters: the
git-diff harvester (PULL, reads `RunContext.environment`) and `acceptHarvester` (PUSH, reads
`RunContext.emitted` + `finalMessage`). The R2 stacked review flagged that the PUSH path is
**unreachable in production**. Of its three causes, exactly one is the executor's to fix; the other
two are orchestrator scope (see §Out of scope):

1. **(This RDR.)** The leaf's structured return (`finalMessage`) is never captured from the qwen
   session and threaded into `RunContext`, and a run cannot ask for a value harvest. So a dispatched
   leaf that produces a *value* (a plan, a verdict, a JSON answer) rather than a *diff* has no way to
   return it — the executor can only ever emit a `patch`.
2. (Orchestrator scope.) `RunContext.emitted` is empty because the spine's `entity`/`tier` emissions
   accumulate at the orchestrator across calls, not inside a single one-shot dispatch (RF-3).
3. (Orchestrator scope.) The deterministic `/accept` spine is a conexus skill that does not dispatch
   through `qwen_dispatch` at all (RF-2).

Concretely: today every `qwen_dispatch` run returns `[{kind:"patch"}]` (or `[]`). A non-code leaf
(e.g. a planner returning plan JSON, the canonical RDR-009 `/accept` example) cannot return its work
product. This RDR closes that: a dispatched leaf can return `[{kind:"value", value: <its
finalMessage>}]`.

### Enumerated gaps to close

#### Gap 1: The leaf's structured return is never captured

The qwen leaf returns its structured output (e.g. a strategic-planner's plan JSON) in the session's
final message, but the supervisor adapter (`makeSupervisorQwenSpawnEffects`) only maps `state` and
`turns_completed` from the poll result. The leaf's `last_message` is discarded, so
`RunContext.finalMessage` is always absent and a dispatched leaf can never surface a `{kind:"value"}`.

#### Gap 2: A run cannot select a value harvester

`qwen_dispatch` always wires the git-diff harvester. A non-code leaf (a planner returning a plan, not
a diff) has no way to ask the executor to harvest its `finalMessage` as a `value` instead of (or in
addition to) a worktree diff.

> **Retargeted out (was Gap 3): the spine that emits `entity`/`tier`.** The deterministic `/accept`
> spine is a conexus skill that does not dispatch through `qwen_dispatch` (RF-2), and a single one-shot
> dispatch cannot accumulate the spine's cross-call emissions (RF-3). That channel is orchestrator
> scope, not the executor's. See §Out of scope.

## Context

### Background

RDR-009's driving counter-example was `/accept` of an RDR as a dispatchable workflow: a deterministic
**spine** (mint beads, write T2, edit files) plus dispatchable heavy **leaves** (strategic-planner,
`nx_plan_audit`, `nx_enrich_beads`). RDR-009 built the result envelope (`Artifact[]` + both harvesters)
but deferred the producer. This RDR delivers the one producer piece that is genuinely the executor's:
a dispatched leaf returning its structured output as a `value`.

### Why the scope is the leaf, not the spine (settled by research)

RDR-009 said "nexus owns the ledger; the `/accept` orchestration is an engine concern." Research
confirmed where the executor boundary actually falls:

- **The executor's to fix:** capturing a dispatched leaf's `finalMessage` and surfacing it as a
  `value` artifact (Gap 1 + Gap 2) is squarely executor-side and in-repo testable. A single
  `qwen_dispatch` call returns one leaf's `Artifact[]`, and the leaf's structured return is available
  at terminal state (RF-1).
- **NOT the executor's:** the multi-step spine that accumulates `entity`/`tier` across the workflow. A
  single dispatch cannot emit the spine's artifacts (it spans multiple dispatches + deterministic host
  work), and the real `/accept` does not use `qwen_dispatch` at all (RF-2/RF-3). That is the `plan_run`
  ledger's job (RDR-009 RF-4) / the orchestrator's, out of this repo.

So this RDR ships **only** the executor value-harvest. No spine, no demonstrator-that-fakes-a-spine
(the RDR-009 P2 integration test already exercises `acceptHarvester` over a populated `RunContext`).

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
- [ ] **No live nexus consumer depends on the current v3 response shape** — Status: DOCUMENTED-PENDING,
  and **moot for this RDR's v4**. This was load-bearing for RDR-009's v3 wire change (`patch` →
  `artifacts`). RDR-010's v4 is an **optional request field only**: the response shape stays
  `{artifacts: Artifact[]}`, `value` is already in the four-kind union (already in `agent-shapes.json`,
  already asserted by both conformance suites). There is nothing to migrate, so the PENDING status does
  not gate v4. Listed for completeness, not as a pre-ship blocker.

## Proposed Solution

> Retargeted after `/conexus:rdr-research` (RF-1..RF-4) to the executor value-harvest only.

### Approach

Two small, additive executor changes so a dispatched leaf can return its structured `value`. Nothing
about the spine, `emitted`, or the production `/accept` is touched.

1. **Capture the leaf's `finalMessage` (Gap 1, feasible per RF-1).** Add a `lastMessage` field to
   `QwenPollSnapshot`; map `PollResult.last_message` in `makeSupervisorQwenSpawnEffects`; thread
   `last.lastMessage` into `RunContext.finalMessage` in the dispatchers (the one field `runContextFor`
   never sets today).
2. **Make the harvester selectable (Gap 2, mechanism per RF-4).** Add an optional `qwen_dispatch` input
   `harvest: "patch" | "value" | "both"` defaulting to `"patch"` (additive — coding runs stay
   byte-identical, no breaking change). `"value"` surfaces `finalMessage` as a single `{kind:"value"}`
   (reuse the existing `acceptHarvester` value-parse path — `null` → no value, JSON parsed, else raw
   string); `"both"` composes git-diff + value.
   **Resolution lives in the tool layer (`dispatch-tool.ts`), NOT the in-process interface:** the tool
   reads the `harvest` input field, builds the appropriate `Harvest` function, and constructs
   `QwenSpawnEffects` with that harvester before invoking `dispatch`. The `AgentTask` interface and the
   `Dispatch` signature are **unchanged** — `harvest` is an MCP-boundary concern and must NOT be added
   to `AgentTask` (that is the cross-host shape pinned by `agent-shapes.json` + both conformance
   suites; polluting it would force a needless cross-language fixture change for a qwen-specific knob).

### Out of scope (retargeted out + carried from RDR-009, do not re-open)

- **The spine / `entity`+`tier` emission + `acceptHarvester` wiring** (was Gap 3): orchestrator scope
  per RF-2/RF-3. The real `/accept` is a conexus skill that does not use `qwen_dispatch`.
- **A spine demonstrator**: the RDR-009 P2 integration test already exercises `acceptHarvester` over a
  populated `RunContext`; a fake-spine demonstrator would add nothing.
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

**Reason for rejection**: contradicts RDR-009's ledger-ownership decision (nexus owns
accumulation/persistence) and re-opens the build-vs-extend fork; far larger than closing the executor
gap. RF-2 also shows the real `/accept` does not use `qwen_dispatch`, so a spine here would be fake.

## Trade-offs

### Consequences

- (+) A dispatched leaf can return structured non-code output (`value`); the harvest envelope gains its
  first reachable non-`patch` production path.
- (+) Coding runs are byte-identical (default `harvest: "patch"`), so the SWE-bench path is untouched.
- (−) An additive contract surface (`harvest` input) — a v4-additive bump on #1174, no migration.

### Risks and Mitigations

- **Risk**: a coding leaf's chatter in `last_message` becomes a spurious `value`. **Mitigation**: the
  default is `"patch"`; `value` is opt-in. `null`/empty `finalMessage` yields no value (reused
  `acceptHarvester` rule).
- **Risk (RETIRED)**: `last_message` truncated/unavailable. RF-1 verified the full terminal text is in
  `PollResult.last_message` (not the 120-char summary). Gap 1 is feasible as designed.

## Implementation Plan

> Retargeted to the executor value-harvest (Gaps 1-2). The spine / demonstrator is out of scope.

### Minimum Viable Validation

A dispatched non-code leaf, run with `harvest: "value"`, returns `[{kind:"value", value: <parsed
finalMessage>}]` — proving a structured non-patch artifact is reachable through the **full dispatch
machinery** (spawn + poll through the real dispatcher logic, with a stub supervisor returning a
`last_message`; NOT by hand-building a `RunContext` and calling `acceptHarvester` directly). A live
Qwen backend is not required — RF-1 source-verified that `PollResult.last_message` carries the full
terminal text, so the stub-backed integration test exercises the real capture → threading → harvest
path. A coding run with the default `harvest: "patch"` is byte-identical to today (the regression guard).

### Phase 1: Capture `finalMessage` (Gap 1)

Add `lastMessage` to `QwenPollSnapshot`; map `PollResult.last_message` in
`makeSupervisorQwenSpawnEffects`; thread `last.lastMessage` into `RunContext.finalMessage` in both
dispatchers. Unit tests: the adapter maps `last_message`; the dispatcher sets `finalMessage`.

### Phase 2: Selectable harvester + the `"value"`/`"both"` paths (Gap 2)

Add the optional `harvest` input (default `"patch"`), select the harvester in the dispatcher/wiring,
and reuse `acceptHarvester`'s value-parse for `"value"`. Update `qwen-dispatch-shapes.json` (additive
request field) + both conformance suites + the operator contract (v4-additive, default unchanged) +
the #1174 note. Integration test: a fake-backed dispatch with `harvest: "value"` yields the
`{kind:"value"}`; with the default, the patch path is unchanged.

Each phase boundary runs the stacked review (code-review-expert + substantive-critic) per repo
discipline.

## References

- RDR-009 (`docs/rdr/RDR-009-harvest-envelope.md`, closed) + post-mortem (§MVV deferral, §Open threads).
- R2 review finding: `acceptHarvester` unreachable in production (`runContextFor` emits `[]`).
- `src/dispatch.ts` (`acceptHarvester`, `runContextFor`), `src/dispatch-tool.ts`
  (`makeSupervisorQwenSpawnEffects`), `src/session.ts` (poll / `last_message`).
- Hellblazer/nexus#1174 (v3 contract, pending sign-off).

## Revision History

- 2026-06-14: created (draft). Scaffolds the RDR-009-deferred PUSH producer.
- 2026-06-14: research complete (RF-1..RF-4, T2 `RDR-010-research-01-push-producer-feasibility`). Two
  Critical Assumptions verified at source.
- 2026-06-14: **retargeted** (file renamed `RDR-010-accept-spine-push-producer.md` →
  `RDR-010-executor-value-harvest.md`). Research showed the original "live `/accept` spine" framing was
  wrong for this repo (the real `/accept` is a conexus skill that does not call `qwen_dispatch`; the
  executor cannot emit the spine's `entity`/`tier`). New target: the executor value-harvest only —
  capture `finalMessage`, add a selectable `harvest` input. Gap 3 (spine) + the demonstrator moved to
  out-of-scope. Gate pending (`/conexus:rdr-gate`).
- 2026-06-14: **gate PASSED** (0 Critical, 1 Significant, 3 Observations). substantive-critic confirmed
  the scope reduction is legitimate and evidence-grounded, the MVV and additive-contract claims sound.
  Fixed pre-accept: the Significant (specify harvest selection resolves at the tool layer
  `dispatch-tool.ts`, NOT by polluting `AgentTask`); Observation-1 (MVV phrasing: full dispatch
  machinery with a stub supervisor, no live backend needed); Observation-3 (the v3-consumer assumption
  is moot for v4's additive request field). Observation-2 (operator-contract value-promotion line) is
  tracked by Phase 2's contract update.
