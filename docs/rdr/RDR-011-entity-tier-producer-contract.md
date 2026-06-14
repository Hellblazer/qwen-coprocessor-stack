---
title: "Entity/tier producer contract — what an orchestrator must emit for the entity/tier Artifact kinds, and how they compose with executor patch/value artifacts"
id: RDR-011
type: Design
status: closed
priority: medium
author: hal
reviewed-by: self
created: 2026-06-14
accepted_date: 2026-06-14
closed_date: 2026-06-14
close_reason: implemented
post_mortem: docs/rdr/post-mortem/011-entity-tier-producer-contract.md
related_issues: ["Hellblazer/nexus#1174"]
---

# RDR-011: Entity/tier producer contract

> Revise during planning; lock at implementation. If wrong, abandon and iterate the RDR.
>
> **Design-only RDR.** The deliverable is a published **contract document** (plus any fixtures that
> can be pinned) describing what an *orchestrator* must do to produce the `entity` and `tier`
> `Artifact` kinds and how those compose with the executor's `patch`/`value` artifacts. **No executor
> code changes.** RF-2/RF-3 (RDR-010) established the producer is orchestrator scope (nexus / the
> conexus `/accept` skill), and this repo's one-shot executor structurally cannot emit it. This RDR
> closes the *specification* gap so nexus can implement the producer against a written contract,
> exactly as RDR-007/008 published the dispatch contract without shipping nexus's engine.

## Problem Statement

The `Artifact` union has exactly four kinds — `patch | value | entity | tier` (RDR-009, locked). Two
of the four now have a reachable producer:

- `patch` — the git-diff (PULL) harvester. Shipped RDR-008/009.
- `value` — a dispatched leaf's structured `finalMessage` (PUSH). Shipped RDR-010.

The other two — `entity` (a bead/link/rdr created or updated) and `tier` (a write to a memory tier
T1/T2/T3) — have **defined shapes and a consuming seam but no producer**. The seam is real and in
this repo: `acceptHarvester` (`src/dispatch.ts`) passes `RunContext.emitted` through **verbatim**
(every kind, unfiltered), and `RunContext` carries an `emitted: Artifact[]` field. But
`runContextFor` keeps `emitted: []`, no dispatcher injects `acceptHarvester`, and RF-2/RF-3 proved
that is *correct*: a single one-shot `qwen_dispatch` call cannot accumulate the cross-call,
host-side-effect emissions that `entity`/`tier` represent. The deterministic `/accept` spine that
actually mints beads and writes tiers is a conexus skill that never calls `qwen_dispatch`.

So the producer is orchestrator scope — but there is **no written contract** stating what that
orchestrator must emit, when, in what shape, how it accumulates across steps, or how it composes the
spine's `entity`/`tier` emissions with the executor's per-leaf `patch`/`value` artifacts into one
workflow-level ledger. Without that contract, nexus (#1174) cannot adopt the PUSH spine: it would be
guessing the shapes and the accumulation semantics. This RDR writes the contract.

### What this RDR is NOT

- Not building the producer (that is nexus's engine, out of this repo).
- Not wiring `acceptHarvester` into a dispatcher, not populating `runContextFor.emitted` (locked
  out by RDR-009/010 — the executor stays one-shot and emits only its own leaf's artifacts).
- Not a fifth `Artifact` kind, not changing the four existing shapes.

## Context

### Background

RDR-009 generalized the dispatch result to a typed `Artifact[]` and shipped both harvesters: the
git-diff (PULL) harvester and `acceptHarvester` (PUSH, reads `emitted` + `finalMessage`). It deferred
the *live producer* of the PUSH channel as orchestrator scope. RDR-010 split that deferral: the
leaf-`value` slice was the one executor-reachable piece and shipped; the `entity`/`tier` slice was
re-confirmed orchestrator scope and pushed out (RDR-010 §Out of scope, RF-2/RF-3). This RDR picks up
exactly that pushed-out slice — but as a **specification**, since the implementation home is nexus and
nexus is not available in this repo.

### The defined shapes (from `src/types.ts`, locked by RDR-009)

```ts
| { kind: "entity"; type: "bead" | "link" | "rdr"; id: string; op: "created" | "updated" }
| { kind: "tier";   tier: "T1" | "T2" | "T3"; key: string }
```

The contract this RDR produces must hold these shapes verbatim — they are already asserted by both
conformance suites (`agent-shapes.json` set-membership) and must not drift.

### Why a written contract and not code (settled by RDR-010 research)

- **RF-2** — the production `/accept` is a conexus skill (Agent tool + direct MCP), not `qwen_dispatch`
  traffic. A producer built *here* would be a demonstrator with no real consumer.
- **RF-3** — `RunContext` is per-call; one dispatch returns one leaf's artifacts. The spine's
  `entity`/`tier` accumulate at the orchestrator across calls + deterministic host work, never inside
  a single dispatch. Producing them is structurally an orchestrator-layer concern.
- **RF-4 (RDR-009)** — `plan_run` step outputs are the intended ledger. The orchestrator (nexus)
  concatenates per-step `Artifact[]` into the workflow ledger; that is where `entity`/`tier` land.

Therefore the right artifact from *this* repo is the **producer contract** — the normative spec an
orchestrator conforms to — published the same way RDR-007/008 published the dispatch contract.

### Technical Environment

- Consuming seam (this repo, already shipped): `acceptHarvester` (`src/dispatch.ts`),
  `RunContext.emitted`, the four-kind `Artifact` union (`src/types.ts`).
- Published contracts: `docs/contracts/qwen-dispatch-operator-contract.md` (v4),
  `docs/contracts/nexus-dispatch-operator-proposal.md`, `docs/contracts/fixtures/*`.
- nexus: `plan_run` step outputs as the ledger (RDR-009 RF-4); Hellblazer/nexus#1174 (pending sign-off).

## Research Findings

### Investigation

The feasibility questions were largely settled by RDR-009 (RF-1, RF-4) and RDR-010 (RF-2, RF-3): the
producer is orchestrator scope, accumulation is at `plan_run`, the shapes are fixed. The open
questions for *this* RDR are **design/specification** questions, not feasibility:

- **RQ-A — emission timing.** Must `entity`/`tier` be emitted *at the moment the side effect occurs*
  (the spine knows what it wrote), or may they be reconstructed after the fact? RDR-009 RF-1 already
  answered the negative case: scraping the raw event log is lossy (no "created" signal, truncated
  summaries). So the contract MUST require emit-at-side-effect. (Confirmed by existing research; the
  contract states it normatively.)
- **RQ-B — accumulation & ordering.** How does a multi-step workflow combine per-step `Artifact[]`?
  Append-ordered concatenation by side-effect occurrence (matches `acceptHarvester`'s verbatim
  pass-through + value-append order). To be specified.
- **RQ-C — idempotency on retry/resume.** If a spine step re-runs, does it re-emit? The `op:
  "created" | "updated"` distinction is the lever. To be specified (likely: re-emit with the true op;
  the ledger is a log, not a set — dedup, if any, is the consumer's).
- **RQ-D — `tier.key` and `entity.id` namespacing.** What identifies a tier write (`key`) and an
  entity (`id`) unambiguously across T1/T2/T3 and bead/link/rdr? **RESOLVED (research, verified
  against the live nexus/conexus MCP surface — T2 `RDR-011-research-01-identifier-mapping`):** the
  locked `id:string`/`key:string` shapes hold every real identifier, with two contract-specification
  obligations and one documented asymmetry:
  - `entity{type:"bead"}.id` = the bead id (`qwen-coprocessor-stack-855`, dotted children
    `…-40v.18`); `entity{type:"rdr"}.id` = `RDR-NNN`. Both fit `string` directly.
  - `entity{type:"link"}.id` — a catalog link is an **edge, not a node**
    (`{from, to, type, spans}`), so it has no single id. `id:string` carries it only as a
    **composite-encoded edge key** (proposed `"<from>|<type>|<to>"`, spans appended if present). The
    contract MUST specify this encoding (no shape change — `id:string` holds the delimited key).
  - `tier.key` — the `tier` field already namespaces which tier, so the key need only be unique
    *within* a tier: T1 = `entry_id`; T2 = `"project/title"`; T3 = `"collection/doc_id"`. The
    contract MUST state this per-tier delimiter convention.
  - **Asymmetry (intentional):** `entity` carries `op:"created"|"updated"` (create-vs-update is
    consumer-meaningful); `tier` has no `op` — tier writes are **upserts** identified by
    `(tier,key)`, latest-wins. The contract states this.
- **RQ-E — conformance surface.** Can any of this be fixture-pinned in *this* repo, or is it
  prose-only (like the one-shot semantics)? The shapes already are pinned via `agent-shapes.json`;
  the *producer obligations* are prose-normative. A small producer-example fixture (a sample ledger)
  may be pinnable as an illustrative echo.

**Research status (2026-06-14):** RQ-A settled (RDR-009 RF-1, no scraping); RQ-B locked
(append-ordered log, matches `acceptHarvester`); RQ-C locked (re-emit true `op`, consumer dedups,
tier upserts); RQ-D resolved (above — shapes sufficient, two encoding obligations + one asymmetry);
RQ-E (prose-normative + optional illustrative fixture). Findings in T2
`RDR-011-research-01-identifier-mapping`.

### Critical Assumptions

- [x] **The `entity`/`tier` shapes are fixed and consumed verbatim** — VERIFIED (source:
  `acceptHarvester` passes `emitted` unfiltered; `Artifact` union in `types.ts`; both conformance
  suites assert the four kinds).
- [x] **The producer is orchestrator scope; the executor cannot emit these** — VERIFIED (RDR-010
  RF-2/RF-3).
- [x] **The shapes are sufficient to identify real nexus side effects** (RQ-D: `entity.id` /
  `tier.key` map cleanly onto bead ids, RDR ids, catalog links, T1/T2/T3 keys) — VERIFIED against the
  live nexus/conexus MCP surface (T2 `RDR-011-research-01-identifier-mapping`). `id:string`/`key:string`
  hold every real identifier; **no shape change, no fifth kind**. Two contract-specification
  obligations surfaced (catalog-link composite-encoding; per-tier key delimiter convention) and one
  intentional asymmetry (`entity.op` vs tier upsert) — all spec text, not union changes.
- [ ] **No live nexus consumer is blocked waiting on this** — Status: DOCUMENTED-PENDING (#1174). The
  contract is publishable regardless; adoption is nexus's call. Spec-without-consumer risk is real and
  is the chief reason this is design-only (cheap to publish, no executor surface to maintain).

## Proposed Solution

### Approach

Publish a **producer contract** — a normative document stating what an orchestrator must do to emit
`entity`/`tier` and how a workflow accumulates a composite `Artifact[]` ledger. Concretely:

1. **A new contract doc** `docs/contracts/harvest-producer-contract.md` (companion to the executor's
   `qwen-dispatch-operator-contract.md`). It states, normatively:
   - **Emit-at-side-effect** (RQ-A): the deterministic spine emits an `entity`/`tier` artifact at the
     instant it mints a bead/link/rdr or writes a tier — never by post-hoc log scraping. The producer
     is host code that *knows what it wrote*.
   - **Shapes** (verbatim from the locked union): `entity {type,id,op}`, `tier {tier,key}`. The doc
     restates them and points at `agent-shapes.json` as the pinned source of truth.
   - **Accumulation & ordering** (RQ-B): a workflow ledger is the append-ordered concatenation of each
     step's `Artifact[]` in side-effect-occurrence order; executor leaf calls contribute `patch`/`value`,
     spine steps contribute `entity`/`tier`; the ledger is a **log, not a set**.
   - **Idempotency** (RQ-C): re-runs re-emit with the true `op`; consumers that need set semantics
     dedup on `(kind, type, id)` / `(kind, tier, key)` themselves.
   - **Identity** (RQ-D, resolved): `entity{bead}.id`=bead id, `entity{rdr}.id`=`RDR-NNN`,
     `entity{link}.id`=composite edge key `"<from>|<type>|<to>"` (spans appended if present);
     `tier.key` per-tier — T1=`entry_id`, T2=`"project/title"`, T3=`"collection/doc_id"`. The doc
     specifies the link-encoding and per-tier delimiter conventions normatively, and states the
     `entity.op` / tier-upsert asymmetry.
   - **Composition with the executor**: the executor (`qwen_dispatch`) emits ONLY `patch`/`value` for
     its one leaf; the orchestrator owns the `entity`/`tier` emissions and the cross-step ledger. The
     doc explicitly states the executor does NOT and will NOT produce `entity`/`tier` (one-shot
     invariant), so an adopter does not wait for an executor feature that will never come.
2. **An illustrative fixture** (if pinnable per RQ-E): a sample composite ledger
   (`docs/contracts/fixtures/harvest-ledger-example.json`) showing a workflow that emits all four
   kinds, with a tiny test asserting it validates against the four-kind union — an echo, not a new
   enforcement surface.
3. **Cross-references**: link the new doc from `qwen-dispatch-operator-contract.md` (the "PUSH-channel
   kinds are produced by other harvesters" line) and add a note to #1174.

### Out of scope (do not re-open)

- Building the producer / spine in this repo (orchestrator scope; nexus is not checked out).
- Wiring `acceptHarvester` into a dispatcher or populating `runContextFor.emitted` (locked by
  RDR-009/010 — would break the one-shot invariant).
- A fifth `Artifact` kind or any change to the four locked shapes (if RQ-D shows the shapes are
  insufficient, that is a *finding* that seeds a future RDR, not a change here).
- The nexus `plan_run` ledger implementation, the production `/accept` workflow, mid-run streaming.

## Alternatives Considered

### Alternative 1: Do nothing — leave entity/tier shape-only, no producer contract

**Description**: the shapes exist; let nexus infer producer semantics when it adopts.

**Reason for rejection**: that is exactly the gap that left `acceptHarvester` unreachable and forced
RDR-010's retarget. An adopter guessing accumulation/ordering/identity will diverge from the seam this
repo already ships. A written contract is cheap and prevents drift.

### Alternative 2: Build the producer here as a demonstrator

**Description**: implement a fake spine in this repo that emits `entity`/`tier` and wire
`acceptHarvester`.

**Reason for rejection**: RF-2/RF-3 — the real `/accept` does not use `qwen_dispatch`, so a
demonstrator proves nothing and the RDR-009 P2 test already exercises `acceptHarvester` over a
populated `RunContext`. It would also violate the one-shot invariant if wired into a real dispatcher.

### Alternative 3: Fold the producer spec into the existing executor contract

**Description**: add an "orchestrator obligations" section to `qwen-dispatch-operator-contract.md`.

**Reason for rejection**: that doc is scoped to *what the executor provides/requires*. Producer
obligations are a different actor (the orchestrator). A separate companion doc keeps each contract
single-actor and avoids implying the executor produces `entity`/`tier`. (Cross-link instead.)

## Trade-offs

### Consequences

- (+) The harvest envelope gains a complete, written producer story for all four kinds; nexus can
  adopt the PUSH spine against a spec instead of guessing.
- (+) Zero executor surface change — nothing new to maintain or regression-test in the hot path.
- (−) A spec without a live consumer (the standing #1174 risk). Mitigated by it being design-only and
  cheap; publishing does not commit the executor to anything.
- (−) RQ-D may reveal the locked shapes don't fit a real nexus identifier — surfaced as a finding,
  possibly seeding a future shape RDR.

### Risks and Mitigations

- **Risk**: the contract drifts from the actual seam (`acceptHarvester`/`Artifact` union).
  **Mitigation**: the doc restates shapes by pointing at `agent-shapes.json`; the illustrative fixture
  (if pinned) validates against the real union, catching drift.
- **Risk**: spec-without-consumer rot. **Mitigation**: keep it normative-but-minimal; mark adoption as
  nexus's call (#1174); no executor code to bit-rot.

## Implementation Plan

> Design-only. "Implementation" = authoring the contract doc (+ optional fixture) and cross-links.

### Minimum Viable Validation

The contract document exists, restates the `entity`/`tier` shapes consistently with the locked union,
specifies emit-at-side-effect + accumulation/ordering + identity + executor-composition normatively,
and is cross-linked from the executor contract and #1174. If an illustrative ledger fixture is added,
a test asserts it validates against the four-kind union. No executor behavior changes; all existing
gates (tsc, vitest, Python conformance) stay green (a doc/fixture-only change must not perturb them).

### Phase 1: Research lock (RQ-B/RQ-C/RQ-D)

`/conexus:rdr-research`: confirm RQ-D against nexus's real identifiers (bead id, T2 `project/title`,
catalog tumbler) — the one externally-dependent item; lock RQ-B (append-ordered log) and RQ-C
(re-emit with true `op`, consumer dedups) wording. Record findings in T2. Surface any shape
insufficiency as an explicit finding.

### Phase 2: Author the producer contract

Write `docs/contracts/harvest-producer-contract.md` per §Approach. Add the illustrative ledger fixture
+ validation test iff RQ-E says it is pinnable. Cross-link from `qwen-dispatch-operator-contract.md`
and add a #1174 note. Stacked review (code-review-expert + substantive-critic) on the doc — the critic
checks the spec is non-vacuous, the accumulation semantics are unambiguous, and nothing silently
implies the executor will produce `entity`/`tier`.

**The Phase 2 doc MUST pin these (gate findings 2026-06-14 — the spec is unusable otherwise):**

1. **Link id encoding — normative, not "proposed" (Significant).** Define it precisely; spans are
   load-bearing for identity (two links may share `{from,type,to}` and differ only by span). Pin:
   `"<from>|<type>|<to>"` with no spans; `"<from>|<type>|<to>|<from_span>|<to_span>"` when spans
   exist, **absent spans as empty strings** (e.g. only `to_span` → `"<from>|<type>|<to>||<to_span>"`);
   fixed field order; and state `|` as a forbidden character in tumblers/link-types (the delimiter's
   safety is a stated constraint, not an assumption).
2. **Tier upsert = consumer rule, not producer rule (Significant).** State both halves explicitly:
   the producer emits a `tier` artifact at **every** write as it occurs (the same `(tier,key)` MAY
   appear multiple times — log, not set, matching `acceptHarvester`'s no-dedup pass-through); a
   consumer applying the ledger treats `(tier,key)` as an upsert key, later-in-log-order wins.
   Dedup/collapse is consumer-side, never producer-side (a producer that emits only the latest is a
   lossy-ledger bug).
3. **Partial-failure semantics (Significant).** The ledger is **best-effort, append-only**: an
   emitted artifact is NOT retracted if a later step fails (the side effect already happened and is
   irreversible — emit-at-side-effect forbids rollback-the-emit). Consumers must tolerate partial
   execution (e.g. `entity{op:"created"}` with no following `tier` write). Retry/resume re-runs the
   failed step and re-emits with the true `op` (RQ-C).
4. **Value→entity promotion is orchestrator logic (Observation).** State that the executor emits only
   `patch`/`value`, but an orchestrator MAY inspect a leaf's `{kind:"value"}` and promote it to an
   `entity`/`tier` in its own code — that is orchestrator behavior, not the executor producing
   `entity`/`tier`. (Avoids implying entity/tier come only from the deterministic spine.)
5. **T2 key delimiter ambiguity (Observation).** `T2="project/title"` uses `/`; state `/` is
   forbidden in project/title names (a producer constraint) or pick a delimiter not in current/likely
   names. Same diligence for the T3 `collection/doc_id` delimiter.
6. **Cross-step ordering under parallelism (Observation).** State whether `plan_run` is serial for
   this contract; if DAG branches run in parallel, within-branch order is preserved but cross-branch
   merge order is implementation-defined.
7. **Link dangling-endpoint semantics (Observation).** State whether an emitted `entity{type:"link"}`
   guarantees both endpoints exist, or may be dangling (consumer must defer / create endpoints first /
   accept with `allow_dangling` — `catalog_link` raises on a missing endpoint by default).

## References

- RDR-009 (`docs/rdr/RDR-009-harvest-envelope.md`, closed) — the four-kind union, both harvesters.
- RDR-010 (`docs/rdr/RDR-010-executor-value-harvest.md`, closed) — RF-2/RF-3 (producer is
  orchestrator scope), the leaf-`value` slice.
- `src/types.ts` (`Artifact` union), `src/dispatch.ts` (`acceptHarvester`, `RunContext`,
  `runContextFor`).
- `docs/contracts/qwen-dispatch-operator-contract.md` (v4), `docs/contracts/fixtures/agent-shapes.json`.
- Hellblazer/nexus#1174 (contract adoption, pending sign-off).

## Revision History

- 2026-06-14: created (draft). Carries the `entity`/`tier` producer slice deferred out of RDR-009 and
  RDR-010 (orchestrator scope, RF-2/RF-3). Design-only: a producer **contract** for nexus to
  implement, since the implementation home (nexus) is not available in this repo.
- 2026-06-14: research complete (RQ-A..RQ-E). RQ-D verified empirically against the live
  nexus/conexus MCP surface (bead/rdr/link ids, T1/T2/T3 keys) — the locked `id:string`/`key:string`
  shapes are sufficient (no shape change, no fifth kind); two contract-specification obligations
  (catalog-link composite-encoding, per-tier key delimiter) and one intentional asymmetry
  (`entity.op` vs tier upsert) folded into §Approach. Findings in T2
  `RDR-011-research-01-identifier-mapping`. NEXT: `/conexus:rdr-gate`.
- 2026-06-14: **gate PASSED** (0 Critical, 3 Significant, 4 Observations). substantive-critic
  confirmed the scope is sound and consistent with RDR-009/010, no contradictions with locked
  invariants. All 7 findings are Phase-2 doc-authoring obligations (not pre-accept blockers) and are
  captured as the "Phase 2 doc MUST pin" checklist in §Phase 2: link-id encoding precision (incl.
  spans), tier-upsert as a consumer rule, partial-failure (best-effort append-only) semantics, plus
  four observations (value→entity promotion, T2/T3 key delimiter safety, parallel-step ordering,
  link dangling-endpoint semantics). NEXT: `/conexus:rdr-accept RDR-011`.
