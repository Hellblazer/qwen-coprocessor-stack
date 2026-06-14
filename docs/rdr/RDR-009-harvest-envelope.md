---
title: "Generalized harvest envelope — dispatch returns a typed Artifact[] (push+pull) instead of a patch; nexus owns the ledger"
id: RDR-009
type: Architecture
status: draft
priority: medium
author: hal
reviewed-by: self
created: 2026-06-14
accepted_date: # set by /rdr-accept
related_issues: ["Hellblazer/nexus#1174"]
---

# RDR-009: Generalized harvest envelope — dispatch returns a typed `Artifact[]` instead of a patch

> Revise during planning; lock at implementation. If wrong, abandon code and iterate the RDR.

## Problem Statement

RDR-008 shipped `qwen_dispatch` as a one-shot agentic executor whose result is a single
**git-diff patch** (`AgentResult.patch`). That envelope is SWE-bench inheritance from the eval
spine (`run_arm.py` / `materialize.py`): the task is always "edit a git repo, return a diff." It is
one cell of a much larger space, and it makes the executor useless for any task whose value is not a
source diff.

The driving counter-example (chosen during the brainstorm) is **`/accept` of an RDR** as a
dispatchable workflow. Its meaningful result is *not* a patch — it is a **status transition**, a set
of **created entities** (the strategic-planner mints beads; the catalog mints links), the planner's
**structured output** (the plan), and **tier writes** (T2). A `git diff` captures only the two
incidental file edits (frontmatter, README) and misses everything that matters.

### Enumerated gaps to close

#### Gap 1: The result envelope is a single git-diff patch — non-code work is unrepresentable

`AgentResult.patch: string` can only express "files changed, as a diff." Work that produces created
entities, structured values, or external effects has no place to land. A `/accept` run's beads, plan,
and status transition are invisible in the result.

#### Gap 2: Harvest is pull-only (end-state extraction) — emitted facts cannot be captured

The current `ExtractPatch(worktree, base)` derives the result by inspecting the environment's
**end-state** (`git diff`). It cannot recover facts that are not sitting in the filesystem at the
end: *which* beads the planner created, *what* the plan JSON was. Those have to be **emitted** by the
run as they happen. We need both modes — push (emitted) and pull (extracted) — and today we have only
pull.

#### Gap 3: `AgentResult.patch` is a string contract pinned by RDR-007's fixture, hardcoding the code-edit domain

`AgentResult` is fixed by `docs/contracts/fixtures/agent-shapes.json` and the published nexus operator
spec (#1174 — `output: { patch, turns, outcome, cost }`). The patch field hardcodes the SWE-bench
domain into the cross-host contract; generalizing the executor means evolving that envelope and the
published operator output type.

## Context

### Background

Discovered in conversation while wiring the executor-managed worktree strategy (bead `dps`): the
worktree/patch model is the *wrong altitude*. Provision → run → **harvest** is the real shape; RDR-008
hardcoded all three to the code-editing case. RDR-008's own research (RF-4) had already identified
`/accept` as the value probe — a deterministic spine + dispatchable heavy nodes (strategic-planner,
`nx_plan_audit`, `nx_enrich_beads`) + a human-choice continuation. That decomposition is exactly the
non-patch case that motivates this RDR.

### Technical Environment

- Executor: `mcp-bridges/qwen-agent-server/src/{dispatch,dispatch-tool,worktree}.ts`. `Dispatch`,
  `ExtractPatch`, `AgentResult` from RDR-007/008.
- Cross-host contract: `docs/contracts/agent-dispatch-contract.md` +
  `docs/contracts/fixtures/agent-shapes.json` (RDR-007, Python + TS hosts).
- Published nexus operator spec: `docs/contracts/qwen-dispatch-operator-contract.md` +
  `qwen-dispatch-shapes.json` (RDR-008 P3), filed as Hellblazer/nexus#1174.
- nexus plan engine: `plan_run` (DAG of typed operators with referenceable step outputs `$stepN`),
  `plan_save` (declarative capture), `nx_answer`. **This RDR depends on nexus's step-output model but
  introduces NO code in the nexus repo** (publish-a-spec posture, same as RDR-007/008).

## Research Findings

### Investigation

The brainstorm decomposed dispatch into `provision → run → harvest` and analysed `/accept`'s actual
effects against the patch envelope. Two ownership questions were settled with the user:

1. **The ledger is nexus's, not the executor's.** A dispatched leaf's artifacts are a `plan_run` step
   output; the plan accumulates them across the spine + dispatched nodes; `plan_save` persists; later
   steps reference prior artifacts (`$stepN.artifacts`). We do not build a ledger — we emit into
   nexus's existing step-output machinery.
2. **Both push and pull are needed.** `/accept` needs push (the planner's created beads / plan are
   not in the filesystem end-state) and can use pull (the frontmatter/README diff). The general
   harvester reads both from a `RunContext`.

### Key Discoveries

- **Documented** — `ExtractPatch` is the only harvest seam today and is pull-only
  (`src/dispatch-tool.ts:gitExtractPatch`, a `git diff <base>` against the worktree end-state).
- **Documented** — `AgentResult` is pinned by `agent-shapes.json` and the #1174 operator output type;
  both must evolve to carry `artifacts`.
- **Documented** — nexus `plan_run` already accumulates and references typed step outputs; a leaf's
  `Artifact[]` is a natural step-output value. (RDR-008 RF-4 / RF-6 Option B.)
- **Assumed** — the executor stays one-shot; each step (deterministic spine or agentic leaf) returns
  its `Artifact[]` at completion; there is **no mid-run streaming** of artifacts to nexus (that needs
  the suspend/continuation channel RDR-008 deliberately punted to the nexus engine). Needs no spike —
  it is a deliberate scope line, validated by `/accept`'s spine being host code that returns directly.

### Critical Assumptions

- [ ] **Each step returns its `Artifact[]` at completion; no mid-run streaming** — **Status**:
  Unverified (design decision) — **Method**: confirmed against `/accept`'s structure (spine returns
  directly; only the planner is a real leaf and can return at completion).
- [ ] **nexus's step-output model can hold an `Artifact[]` per step and reference it** — **Status**:
  Unverified — **Method**: Docs Only (nexus is out of change scope; the spec states the requirement,
  nexus confirms on #1174).

## Proposed Solution

### Approach

One seam change on the executor side delivers the generalization; nexus owns the rest.

1. **Generalize the harvest seam.** Replace `ExtractPatch(worktree, base) => string` with
   `Harvest(run: RunContext) => Promise<Artifact[]>`, where `RunContext` exposes **both** sources:
   `run.events` (the agent's emitted/observed event stream — PUSH) and `run.environment` (the
   end-state, e.g. the worktree — PULL). The pluggable harvester decides what to surface. The current
   git-diff logic becomes one harvester emitting `[{kind:"patch"}]`.

2. **Generalize the result envelope.** `AgentResult.patch: string` becomes
   `AgentResult.artifacts: Artifact[]`. `turns` / `outcome` / `cost` stay as run metadata. A
   back-compat accessor ("the `patch` artifact, if any") keeps the SWE-bench scorer path simple.

3. **Ledger ownership = nexus.** A dispatched leaf returns its `Artifact[]`; nexus's `plan_run` stores
   it as one step output and accumulates the workflow's ledger across steps. We publish the
   requirement; we do not implement a ledger.

### Technical Design

The `Artifact` union is grounded **only** in what `/accept` and SWE-bench actually need — minimal,
extensible, no speculative taxonomy (the galactic-hammer risk RDR-008 kept flagging):

```text
// Illustrative — verify exact field names during implementation.
type Artifact =
  | { kind: "patch";  diff: string; base: string }                    // file edits as a diff (SWE-bench)
  | { kind: "value";  value: unknown; schema?: string }               // structured agent output (a plan, a verdict)
  | { kind: "entity"; type: "bead" | "link" | "rdr"; id: string; op: "created" | "updated" }
  | { kind: "tier";   tier: "T1" | "T2" | "T3"; key: string }         // memory writes

// AgentResult: patch -> artifacts.
interface AgentResult { artifacts: Artifact[]; turns: number; outcome: AgentOutcome; cost: number }

// Harvest seam (replaces ExtractPatch). Reads PUSH (events) + PULL (environment).
type Harvest = (run: RunContext) => Promise<Artifact[]>
interface RunContext { events: ReadonlyArray<RunEvent>; environment: { worktree?: string; baseCommit?: string } }
```

- **Code guidance**: define the `Artifact` union, `Harvest`, and `RunContext` as types; the
  git-diff harvester is one `Harvest` implementation reading `environment`; the `/accept` harvester
  reads `events` (for `entity`/`tier`) and the planner node's return value (`value`). Do not enumerate
  artifact kinds beyond the four until a real consumer needs a fifth.

### Existing Infrastructure Audit

| Proposed Component | Existing Module | Decision |
| --- | --- | --- |
| `Harvest` seam | `src/dispatch-tool.ts` `ExtractPatch` / `gitExtractPatch` | Replace: generalize signature; git-diff becomes one harvester |
| `AgentResult.artifacts` | `src/types.ts` `AgentResult.patch` + `agent-shapes.json` | Replace field; supersede the RDR-007 golden shape (or extend with a `patch` accessor) |
| The ledger | nexus `plan_run` step outputs | Reuse (out of repo): publish the requirement, no code here |
| Worktree / environment | `src/worktree.ts` (RDR-008 1gl/dps) | Reuse: the worktree is one `RunContext.environment`; environment-axis generalization is OUT of scope |

### Decision Rationale

Generalizing the **harvest** (not the environment) is the high-leverage move: it is the field that
makes dispatch a uniform interface over heterogeneous agentic work (code, workflow, research, ops),
and it is the one the patch envelope actively obstructs. Pushing the ledger to nexus avoids
rebuilding the accumulation/referencing/persistence nexus already has (RF-6 Option B, on the result
axis). Keeping the executor one-shot keeps all streaming/continuation complexity on the nexus engine
side, where RDR-008 already parked it.

## Alternatives Considered

### Alternative 1: Executor-owned ledger

**Description**: the executor accumulates artifacts across a workflow and owns referencing/persistence.

**Cons**: duplicates nexus's `plan_run` step-output + `plan_save` machinery; re-opens the
build-vs-extend fork RDR-008 RF-6 resolved toward nexus.

**Reason for rejection**: the user chose nexus step-output ownership; the executor only emits one
leaf's `Artifact[]`.

### Alternative 2: Keep `patch`, add a side-channel for non-code results

**Description**: leave `AgentResult.patch` and bolt a separate `metadata`/`effects` field beside it.

**Reason for rejection**: keeps the patch-centric framing; a side-channel is a second-class envelope
that consumers must special-case. A single typed `Artifact[]` with `patch` as one kind is uniform.

### Briefly Rejected

- **Push-only harvest**: cannot capture the incidental file diff cleanly. **Pull-only harvest**:
  cannot recover emitted facts (created beads, plan). `/accept` needs both.
- **Mid-run artifact streaming to nexus**: requires the suspend/continuation channel RDR-008 punted —
  out of scope; each step returns at completion.

## Trade-offs

### Consequences

- (+) Dispatch becomes a uniform interface over heterogeneous agentic work; `/accept`-class workflows
  become expressible.
- (+) The worktree/patch apparatus survives intact as one environment + one harvester — no wasted
  RDR-008 work.
- (−) Breaks the RDR-007 `AgentResult.patch` golden shape and the #1174 operator output type — a
  cross-host + cross-repo contract evolution.

### Risks and Mitigations

- **Risk**: the `Artifact` union grows speculative kinds (galactic hammer).
  **Mitigation**: ground every kind in a real consumer; ship the four `/accept`+SWE-bench needs only.
- **Risk**: nexus does not adopt the `Artifact[]` operator output.
  **Mitigation**: publish-a-spec posture; the executor side is conformance-pinned; nexus confirms on
  #1174 (already pending sign-off).

### Failure Modes

- A harvester that reads neither source returns `[]` (visible empty result, not a crash).
- A patch-only consumer reading a `/accept` result finds no `patch` artifact (the back-compat
  accessor returns "none") rather than mis-scoring.

## Implementation Plan

### Prerequisites

- [ ] Critical Assumptions confirmed (one-shot altitude; nexus step-output adoption agreed on #1174).

### Minimum Viable Validation

`/accept`-shaped run: a dispatched leaf returns an `Artifact[]` containing `entity` (a created bead)
+ `value` (the plan), and a consumer reads the created-bead entity from the result — proving a
non-patch artifact flows end-to-end. The SWE-bench case still yields a `patch` artifact. **In scope,
not deferred.**

### Phase 1: The `Artifact` union + `Harvest` seam + `AgentResult.artifacts`

Replace `ExtractPatch` with `Harvest(RunContext)`, define the `Artifact` union, migrate
`AgentResult.patch → artifacts` (+ back-compat accessor). The git-diff harvester emits `{kind:"patch"}`.
Update `agent-shapes.json` / conformance + the threading through `makeQwenSpawnDispatch`.

### Phase 2: The `/accept` harvester (the push path)

A harvester that reads `RunContext.events` for `entity`/`tier` artifacts and the leaf return value for
`value`. Integration test against a real `/accept`-shaped run (or a faithful fixture).

### Phase 3: Published spec update for nexus

Evolve `qwen-dispatch-operator-contract.md` + `qwen-dispatch-shapes.json`: operator output becomes
`Artifact[]`; document ledger = nexus step output; add the `Artifact`-union conformance fixture.
Update #1174.

### Day 2 Operations

| Resource | List | Info | Delete | Verify | Backup |
| --- | --- | --- | --- | --- | --- |
| Harvested artifacts | N/A (returned values, not persisted by the executor) | N/A | N/A | conformance fixture | N/A — nexus owns persistence via plan_save |

### New Dependencies

None.

## Test Plan

- **Scenario**: git-diff harvester on a worktree with a committed edit — **Verify**: returns
  `[{kind:"patch", diff≠"", base}]` (the RDR-008 base-commit invariant, re-expressed as an artifact).
- **Scenario**: `/accept` harvester over an event stream with bead-create + T2-write + a plan return —
  **Verify**: `entity`(bead, created) + `tier`(T2) + `value`(plan) artifacts present.
- **Scenario**: harvester reading neither source — **Verify**: `[]`, no throw.
- **Scenario**: conformance — **Verify**: `AgentResult.artifacts` + the `Artifact` union assert against
  the golden fixture on-host (the #1174 enforcement-hook pattern).

## Validation

### Testing Strategy

1. **Scenario**: end-to-end `/accept`-shaped dispatch → `Artifact[]` with a non-patch entity consumed
   by a downstream reader. **Expected**: the MVV holds.

## Finalization Gate

> Complete before marking Accepted (filled during `/rdr-gate`).

### Contradiction Check

[To complete at gate.]

### Assumption Verification

[To complete at gate — confirm one-shot altitude and the nexus step-output adoption on #1174.]

### Scope Verification

The MVV (a non-patch artifact flowing end-to-end) is in scope, Phase 1+2.

### Cross-Cutting Concerns

- **Versioning**: contract evolution of `AgentResult` + #1174 operator output — handled via the
  conformance fixture + a published spec bump.
- **Incremental adoption**: `patch` becomes one artifact kind + a back-compat accessor; SWE-bench path
  unchanged in behaviour.
- **Deployment model**: N/A (in-process executor). **Licensing / Secrets / Memory / IDE / Build**: N/A.

### Proportionality

Right-sized: one seam (`Harvest`), one envelope field (`artifacts`), a four-member union, and a
published-spec update. Environment-axis generalization and mid-run streaming are explicitly out.

## References

- RDR-007 (`AgentResult` golden shape), RDR-008 (one-shot executor; RF-4 `/accept` probe; RF-6 extend-nexus).
- `docs/contracts/qwen-dispatch-operator-contract.md`, `qwen-dispatch-shapes.json`, Hellblazer/nexus#1174.
- `scripts/coding-eval/run_arm.py` (the patch-centric origin), `src/dispatch-tool.ts` (`ExtractPatch`).

## Revision History

[Gate findings appended here.]
