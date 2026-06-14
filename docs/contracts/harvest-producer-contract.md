<!-- SPDX-License-Identifier: MIT -->
# Harvest Producer Contract — `entity` / `tier` (RDR-011)

**Status:** published · **draft for nexus sign-off** (companion to the executor's
[`qwen-dispatch-operator-contract.md`](./qwen-dispatch-operator-contract.md)) · **Source RDR:** RDR-011
(accepted), building on RDR-009 (the four-kind `Artifact` union) and RDR-010 (the executor `value`
slice) · **Golden fixture:** the four-kind union is pinned by
[`fixtures/agent-shapes.json`](./fixtures/agent-shapes.json); an illustrative composite ledger is in
[`fixtures/harvest-ledger-example.json`](./fixtures/harvest-ledger-example.json)

This is the **language-neutral**, **single-actor** contract for the *producer* of the PUSH-channel
`Artifact` kinds — `entity` and `tier`. Its single actor is the **orchestrator** (e.g. **nexus**, or
the conexus `/accept` spine), **not** the executor. It is the mirror image of the executor contract:
where `qwen-dispatch-operator-contract.md` states what the `qwen_dispatch` *executor* provides and
requires, this document states what an *orchestrator* must do to emit `entity`/`tier` and how those
compose with the executor's per-leaf `patch`/`value` artifacts into one workflow-level ledger.

Like the executor contract, it is a spec an adopter **may** conform to, **not** shared code. nexus owns
its engine; this document states only the producer obligations.

> **Why a separate document.** The executor and the orchestrator are different actors. The executor is
> strictly one-shot and emits only its own leaf's `patch`/`value` (see §Composition). Folding producer
> obligations into the executor contract would wrongly imply the executor produces `entity`/`tier`. The
> two contracts cross-link; they do not merge.

It has two halves, the same split as the executor contract:

1. **Fixture-pinnable** — the `Artifact` **shapes**. These are *not redefined here*; they are the
   four-kind union pinned by [`agent-shapes.json`](./fixtures/agent-shapes.json) and asserted on this
   host by both the TS and Python conformance suites. This document **points at** that fixture and must
   never drift a field or add a fifth kind.
2. **Prose** — the **producer obligations** (emission timing, accumulation, idempotency, identity
   encoding, failure semantics, composition). These cannot be fixture-pinned; they are **normative** for
   any orchestrator producing these artifacts.

## The producer

An **orchestrator** runs a multi-step workflow — a deterministic **spine** (host code that mints
beads/links/rdrs, writes memory tiers, edits files) interleaved with dispatchable **leaves** (e.g.
`qwen_dispatch` calls, Claude subagents, direct MCP calls). The spine's side effects are the source of
`entity` and `tier` artifacts. The producer's job is to surface those side effects as typed `Artifact`s
into the workflow's ledger.

This contract was driven by RDR-009's `/accept`-of-an-RDR example: a spine that writes T2 status
(`tier`), edits the RDR frontmatter + README (`patch`, via the executor or git), and mints planning
beads (`entity`), plus dispatched heavy leaves that return plans/audits (`value`).

### The shapes (pinned — do not redefine)

From the four-kind union ([`agent-shapes.json`](./fixtures/agent-shapes.json),
`src/types.ts`):

```ts
| { kind: "entity"; type: "bead" | "link" | "rdr"; id: string; op: "created" | "updated" }
| { kind: "tier";   tier: "T1" | "T2" | "T3"; key: string }
```

(`patch` and `value` are the executor's; see the executor contract.) A producer MUST emit exactly these
shapes. There is no fifth kind, and these fields must not drift — both conformance suites assert the
union set-membership as a cross-host tripwire.

## What a producer PROVIDES

### P1 — Emit-at-side-effect (not by log scraping)

A producer MUST emit an `entity`/`tier` artifact **at the instant the side effect occurs** — when it
mints the bead/link/rdr, or writes the tier. The producer is host code that *knows what it wrote*; it
declares the artifact directly.

A producer MUST NOT reconstruct artifacts by scraping a raw event/log stream after the fact. That is
lossy and was rejected in RDR-009 (RF-1): the raw supervisor event log has no explicit "created"
signal, no success confirmation, and truncates structured output to 120 chars. Emit-at-side-effect is
the only reliable source.

### P2 — Accumulation & ordering: an append-ordered log, not a set

A workflow's ledger is the **append-ordered concatenation** of each step's `Artifact[]`, in
**side-effect-occurrence order**. Executor leaves contribute `patch`/`value`; spine steps contribute
`entity`/`tier`. The ledger is a **log, not a set**: the same logical target MAY appear more than once
(e.g. a bead created then updated, a tier key written twice).

This matches the consuming seam exactly. The reference consumer in this repo, `acceptHarvester`
(`src/dispatch.ts`), copies `RunContext.emitted` **verbatim and unfiltered** (`[...run.emitted]`) — it
performs **no deduplication and no reordering** — then appends the leaf's parsed `finalMessage` as a
single `value`. A producer that pre-dedups or reorders would diverge from this seam.

### P3 — Idempotency on retry/resume

If a step re-runs (retry/resume), the producer re-emits with the **true `op`**: a re-run that finds the
entity already exists emits `op: "updated"`, not a second `"created"`. The ledger remains a log — the
re-emission appears as an additional entry. A consumer that needs set semantics deduplicates itself
(see C-rules below); deduplication is **never** the producer's job (P2).

### P4 — Identity encoding (NORMATIVE)

`entity.id` and `tier.key` are `string`. The `string` shape holds every real identifier, but a producer
MUST form them by the following conventions so that two independent producers emit the **same** id for
the **same** target (verified against the live nexus/conexus identifier surface — RDR-011 research
`RDR-011-research-01-identifier-mapping`).

#### `entity.id`

| `entity.type` | identity source | `id` form | example |
|---|---|---|---|
| `bead` | bead id (incl. dotted children) | the bead id verbatim | `qwen-coprocessor-stack-nh9.1` |
| `rdr` | RDR id | `RDR-NNN` verbatim | `RDR-011` |
| `link` | a catalog **edge**, not a node | composite edge key (below) | `1.9.80\|implements\|1.9.14` |

A catalog **link is an edge**, identified by `(from_tumbler, link_type, to_tumbler)` plus optional
`from_span` / `to_span`. It has no single node id, so `entity{type:"link"}.id` MUST be a
**composite-encoded edge key**:

- No spans: `"<from>|<type>|<to>"`.
- With spans: `"<from>|<type>|<to>|<from_span>|<to_span>"`, with a **fixed five-field order** and an
  **absent span represented as an empty string**. So a link with only `to_span` encodes as
  `"<from>|<type>|<to>||<to_span>"` (note the doubled `|`).
- The delimiter is the pipe `|`. A producer MUST treat `|` as **forbidden** inside a tumbler or a
  link-type (it is not used by current nexus tumblers/link-types; this is a stated constraint, not an
  assumption). If a future identifier could contain `|`, this encoding must be revised by a new RDR
  before such an identifier is emitted.

Spans are **load-bearing for identity**: two links may share `(from, type, to)` and differ only by
span. Dropping the span suffix would collide them. A producer MUST include the five-field form whenever
either span is present.

#### `tier.key`

The `tier` field already names which tier, so `key` need only be unique **within** that tier:

| `tier` | identity source | `key` form | example |
|---|---|---|---|
| `T1` | scratch `entry_id` | the entry id verbatim | `00581262` |
| `T2` | memory `(project, title)` | `"<project>/<title>"` | `qwen-coprocessor-stack_rdr/RDR-011` |
| `T3` | store `(collection, doc_id)` | `"<collection>/<doc_id>"` | `knowledge/4f1c…` |

The delimiter is `/`. A producer MUST treat `/` as **forbidden** in a T2 `project` or `title` and in a
T3 `collection` (none use `/` today; stated constraint). A T1 `entry_id` is a single opaque token and
needs no delimiter.

> The `tier` example in [`agent-shapes.json`](./fixtures/agent-shapes.json) (`{tier:"T2", key:"RDR-009"}`)
> predates this convention and is an illustrative literal of the *shape* only; the normative `key`
> convention is the table above. The composite ledger fixture follows the convention.

### P5 — The `entity.op` / `tier`-upsert asymmetry (intentional)

`entity` carries `op: "created" | "updated"` because create-vs-update is consumer-meaningful (a new
bead vs a status change). `tier` carries **no `op`**: a tier write is an **upsert**. This asymmetry is
deliberate. See C-2 for how a consumer interprets it.

## What a producer REQUIRES / a consumer must honor

These are **consumer-side** rules (the orchestrator applying or interpreting a ledger). They are stated
here because a producer's emissions are only well-defined together with them.

- **C-1 — dedup is consumer-side.** Because the ledger is a log (P2), a consumer needing set semantics
  deduplicates on `(kind, type, id)` for `entity` and `(kind, tier, key)` for `tier`. A producer never
  dedups. When the same `(kind, type, id)` entity appears multiple times with differing `op` (P3's
  retry pattern — `op:"created"` then later `op:"updated"`), a consumer retaining the **last
  occurrence** is consistent with C-2's latest-wins principle: the later `op` reflects the entity's
  later state.
- **C-2 — tier upsert, latest-wins (consumer rule).** When a consumer *applies* a ledger, it treats
  `(tier, key)` as an upsert key: **later-in-log-order overwrites earlier**. This is a consumer
  interpretation of the append log — it does **not** license a producer to emit only the latest write
  (that would be a lossy-ledger bug, P2). Both halves hold simultaneously: the producer emits every
  write; the consumer collapses by latest.
- **C-3 — partial execution is expected.** The ledger is **best-effort and append-only** (see F1). A
  consumer MUST tolerate a ledger that reflects partial execution — e.g. an `entity{op:"created"}` with
  no following `tier` write because the run failed in between.
- **C-4 — link endpoints may be unresolved.** See F2: a consumer applying an `entity{type:"link"}` must
  handle a missing endpoint (the catalog `link` call raises on a missing endpoint by default).

## Failure & concurrency semantics

### F1 — Best-effort, append-only; no retraction

The ledger is **best-effort and append-only**. An emitted artifact is **NOT retracted** if a later step
fails. The side effect already happened and is irreversible — emit-at-side-effect (P1) forbids
"rolling back the emit" (rolling back the record would not undo the bead that was created). If the spine
mints a bead (emits `entity{op:"created"}`) and then fails before writing T2, the `entity` stays in the
ledger and no `tier` appears. This is the only semantics consistent with P1 and with irreversible side
effects. Retry/resume re-runs the failed step and re-emits per P3 (true `op`).

### F2 — Link dangling endpoints

An emitted `entity{type:"link"}` does **not** by itself guarantee both endpoints exist as catalog
entries. A producer SHOULD emit a link artifact only after both endpoints exist; where that cannot be
guaranteed, the contract is that a **consumer** applying the link must handle a dangling endpoint —
defer the link until the endpoints exist, create the endpoints first, or accept it with the catalog's
`allow_dangling` path. (The nexus `catalog_link` tool raises on a missing endpoint by default.) A
producer MUST NOT assume the consumer will silently succeed.

### F3 — Ordering under parallel steps

P2's "side-effect-occurrence order" is a total order only for **serial** step execution. If an
orchestrator executes DAG branches in **parallel**, within-branch order is preserved, but the
cross-branch interleaving in the merged ledger is **implementation-defined**. A consumer that depends on
a cross-branch ordering is relying on unspecified behavior. (For the `/accept` spine, execution is
serial; this clause governs any parallel `plan_run` adopter.)

## Composition with the executor

The executor (`qwen_dispatch`) emits **only** `patch`/`value` for its one leaf (the git-diff harvester
and the RDR-010 `value` harvester). The orchestrator owns the `entity`/`tier` emissions and the
cross-step ledger.

> **The executor does NOT and WILL NOT produce `entity`/`tier`.** This is a structural consequence of
> the one-shot invariant: a single `qwen_dispatch` returns one leaf's artifacts and cannot accumulate
> the cross-call, host-side-effect emissions that `entity`/`tier` represent (RDR-010 RF-3). An adopter
> MUST NOT wait for an executor feature that will never ship. The `acceptHarvester` seam reads
> `RunContext.emitted`, but `runContextFor` keeps it `[]` and no dispatcher injects that harvester —
> the `emitted` channel is the orchestrator's to populate, never the executor's.

### Value→entity promotion is orchestrator logic

A leaf MAY itself perform a side effect (e.g. call `bd` or `memory_put`) and report it in its
structured `finalMessage`; the executor surfaces that as a `{kind:"value"}` artifact (RDR-010). An
orchestrator **MAY** inspect such a `value` and **promote** it into an `entity`/`tier` artifact in its
own code — recording, say, the bead the leaf created. That promotion is **orchestrator behavior**, not
the executor producing `entity`/`tier`. The point of distinction: `entity`/`tier` always enter the
ledger via orchestrator code, whether from the deterministic spine or from promoting a leaf's `value`.

## Conformance

- **Shapes** — pinned by [`agent-shapes.json`](./fixtures/agent-shapes.json) (the four-kind union +
  one canonical literal per kind), asserted by `tests/contract-conformance.test.ts` (TS) and the
  Python conformance suite. This document adds no new pinned shape — it reuses the union.
- **Producer obligations (P1–P5, C1–C4, F1–F3)** — **prose-normative**, not fixture-pinnable (the same
  status as the executor contract's one-shot prose). They are normative for any conforming producer.
- **Illustrative ledger** — [`fixtures/harvest-ledger-example.json`](./fixtures/harvest-ledger-example.json)
  is a sample composite ledger emitting all four kinds and following the P4 identity conventions. It is
  an **echo / worked example**, validated against the four-kind union by a small test — **not** a new
  enforcement surface for the obligations.

## Linked nexus proposal

The executor-side operator interface and registration ceremony live in
[`nexus-dispatch-operator-proposal.md`](./nexus-dispatch-operator-proposal.md), filed as
[Hellblazer/nexus#1174](https://github.com/Hellblazer/nexus/issues/1174). This producer contract is the
orchestrator-side companion to that proposal — it states what nexus (as the orchestrator) must emit to
populate the PUSH channel. Adoption is **nexus's call**; publishing this contract commits the executor
to nothing (it is design-only and adds no executor surface).
