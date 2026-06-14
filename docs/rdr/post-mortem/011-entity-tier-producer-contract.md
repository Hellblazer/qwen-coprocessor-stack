<!-- SPDX-License-Identifier: MIT -->
# Post-mortem: RDR-011 — Entity/tier producer contract

**Closed:** 2026-06-14 · **Reason:** implemented · **Type:** Design (design-only) ·
**Epic:** `qwen-coprocessor-stack-8xe` · **PR:** #55 (merged, main `9175851`)

## What shipped

The orchestrator-side **producer contract** for the two PUSH-channel `Artifact` kinds (`entity`,
`tier`) — the slice deferred out of RDR-009 and re-confirmed out-of-executor-scope by RDR-010
(RF-2/RF-3). Design-only: a published contract, **no executor code**, because the producer's
implementation home is nexus and nexus is not checked out here.

- `docs/contracts/harvest-producer-contract.md` — normative, single-actor (orchestrator) contract:
  emit-at-side-effect (P1), append-ordered log-not-set accumulation (P2), idempotent re-emit (P3),
  identity encoding (P4 — catalog-link composite edge key + per-tier key delimiters), the
  `entity.op`/`tier`-upsert asymmetry (P5), consumer rules (C1–C4), best-effort/append-only +
  dangling-endpoint + parallel-ordering semantics (F1–F3), composition with the one-shot executor.
- `docs/contracts/fixtures/harvest-ledger-example.json` + `tests/harvest-ledger-example.test.ts` —
  illustrative composite ledger exercising all four kinds, log-not-set (repeated tier key + bead
  created→updated), and both 3-field and 5-field span link keys. `agent-shapes.json` untouched.
- Cross-link from `qwen-dispatch-operator-contract.md`; summary comment on Hellblazer/nexus#1174.

## Scope cross-walk (RDR §Approach → delivered)

| §Approach item | Delivered |
|---|---|
| 1. New producer contract doc (6 normative sections) | `harvest-producer-contract.md` |
| 1a. All 7 gate "doc MUST pin" findings | pinned (P4 link encoding incl. spans; C-2 tier-upsert-as-consumer-rule; F1 partial-failure; value→entity promotion; T2/T3 delimiter safety; F3 parallel ordering; F2 dangling endpoints) |
| 2. Illustrative fixture + validation test (RQ-E) | `harvest-ledger-example.json` + test (7 cases) |
| 3. Cross-link + #1174 note | executor-contract cross-link + #1174 comment |

No silent scope reduction: every §Approach item has a closing artifact.

## What went well

- **Research reused, not redone.** RQ-A/RQ-B/RQ-C were already settled by RDR-009/010; only RQ-D
  (identifier mapping) was genuinely open. It was verified **empirically against the live
  nexus/conexus MCP surface** rather than the nexus source — the right move when the repo isn't
  checked out but the running system is reachable. RQ-D found the one real wrinkle (a catalog link is
  an edge, not a node) without forcing a shape change.
- **The gate earned its keep.** It converted the vague "specify identity" into a concrete 7-item
  checklist (link span encoding, the producer/consumer upsert split, partial-failure semantics) that
  the doc then pinned. Without it the contract would have shipped the same ambiguities that left
  `acceptHarvester` unreachable and forced RDR-010's retarget.
- **Stacked review caught the right class.** Both reviewers **approved the prose** and converged on
  the same defect surface: the illustrative fixture/test were too weak (false log-not-set claim, a
  dead 5-field-span test branch, a link id in the wrong identifier namespace). The fix made the test
  non-vacuous — it now fails if a producer dedups at emission or drops the span form. A green test
  that proves nothing is worse than no test; the critic's "is this assertion vacuous?" lens is what
  caught it.

## What to watch

- **Spec without a live consumer.** The standing #1174 risk: this contract binds nexus only if nexus
  adopts it. It is cheap insurance (no executor surface to maintain) but could bit-rot. The #1174
  comment is the adoption nudge; revisit if nexus diverges.
- **`agent-shapes.json` tier example predates the P4 key convention** (`{tier:"T2", key:"RDR-009"}`).
  Left as-is (it's a cross-host-asserted shape literal; changing it touches both conformance suites
  for no shape benefit). The doc notes the discrepancy and the new ledger fixture follows the
  convention. If the fixture example is ever promoted to normative, reconcile it.
- **Identity conventions are verified against *today's* nexus identifiers.** If bead-id / tumbler /
  tier-key formats change, P4 must be revisited — the `|` and `/` forbidden-delimiter constraints are
  the tripwires.

## Follow-ups (not filed)

- nexus-side adoption of the producer contract (their repo, their call). Our note is on #1174.
- If nexus adopts and an identifier needs a character currently forbidden as a delimiter, that is a
  new RDR (revise P4 encoding before emitting such an identifier).
