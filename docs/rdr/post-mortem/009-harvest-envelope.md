<!-- SPDX-License-Identifier: MIT -->
# Post-mortem — RDR-009: Generalized harvest envelope

**RDR:** [RDR-009](../RDR-009-harvest-envelope.md) · **Status:** closed (implemented) ·
**Accepted:** 2026-06-14 · **Closed:** 2026-06-14 · **Epic:** `qwen-coprocessor-stack-nh9` ·
**PRs:** #46 (P1+P3) + #47 (P2)

## Outcome

Generalized the agentic-dispatch result from a single `patch: string` to a typed `artifacts:
Artifact[]` harvest envelope. The `Artifact` union is exactly four kinds (`patch | value | entity |
tier`); the RDR-008 `ExtractPatch(worktree, base)` seam became `Harvest(run: RunContext) =>
Artifact[]` with two channels — PULL (the git-diff harvester reading the worktree end-state) and PUSH
(the `/accept` harvester reading `RunContext.emitted` + `finalMessage`). Two phase units, each
stacked-reviewed (code-review-expert + substantive-critic) to **0 Critical** before merge. The
SWE-bench scoring path stayed byte-decoupled (RF-3), pinned by a new regression test.

## Shipped vs. the RDR

| §Approach item / Phase | Bead | Delivered as planned? |
|------------------------|------|-----------------------|
| P1 — Artifact union + Harvest seam + AgentResult.artifacts migration (cross-host TS+Python) | nh9.1 | Yes |
| P3 — published spec → `Artifact[]` + conformance fixture + #1174 (ships WITH P1) | nh9.2 | Yes (issue update best-effort; see §Open threads) |
| R1 — stacked review of the P1+P3 unit | nh9.4 | Yes (1 Critical → fixed) |
| P2 — the `/accept` harvester (PUSH path) + integration test | nh9.3 | Yes (seam; see §MVV) |
| R2 — stacked review of Phase 2 | nh9.5 | Yes (0 Critical) |
| P4 — final gate + scope cross-walk + close readiness | nh9.6 | Yes (this bead) |

The four-kind union held — no speculative fifth kind, no missing kind (grounded only in what `/accept`
and SWE-bench actually need, per the RDR §Decision). `patchArtifact()` shipped as a TS-internal
back-compat accessor and never re-entered the MCP wire shape.

## What the reviews caught (the stacked gate earned its place)

The two reviewers caught **different classes** of issue at each boundary:

- **P1+P3 / R1 — consumer-visible wire-shape drift (substantive-critic, Critical).** The TS source and
  fixtures migrated to `{artifacts}`, but the *live* MCP surface — the `qwen_dispatch` tool description
  string and the Zod `.describe()` strings the framework exposes — still advertised `{patch}` /
  `extractPatch`. An engine reading the tool schema to map `$stepN.patch` would have formed the wrong
  expectation. This is the exact surface P3's breaking-change acknowledgement was meant to cover. Fixed
  pre-merge (commit `bcde734`); green tests did not surface it because no test asserts the description text.
- **P2 / R2 — overstated MVV (substantive-critic, Significant).** `acceptHarvester` is correct and
  RF-1-clean, but it has no live producer: `runContextFor` still emits `emitted: []`/no `finalMessage`,
  and no dispatcher injects it. The bead's "MVV complete" wording implied a live end-to-end `/accept`
  flow that does not exist. Resolved by recording the accurate status (harvester *seam* complete;
  end-to-end deferred) rather than fabricating a spine — see §MVV.
- **P2 / R2 — `finalMessage` null/JSON-string semantics (both reviewers, Medium).** `JSON.parse("null")`
  → `value:null` was undefined behavior; the JSON-encoded-string payload (`"\"x\""`) is
  indistinguishable from a bare string at the consumer. Resolved: literal JSON `null` is treated as
  *no structured return* (`false`/`0`/`""` remain genuine values); the string ambiguity is documented
  as accepted (a `raw` field would violate the locked union). Edge tests added.

## MVV — what "complete" means here

The MVV ("a non-patch artifact flows end-to-end through the harvester and is consumed downstream") is
demonstrated **through the harvester over a populated `RunContext`** (the P2 integration test:
spine-emitted `entity` + `tier` + leaf `value` all harvested and read back by kind; SWE-bench still
yields a `{kind:"patch"}` via the git-diff harvester). The **live producer** — the `/accept` spine that
populates `RunContext.emitted`/`finalMessage`, plus the dispatcher wiring that injects `acceptHarvester`
as the `harvest` effect — is **engine/host work outside RDR-009's one-shot executor scope** (the RDR
explicitly scopes the ledger and `/accept` orchestration to nexus). This is the **explicit deferral
(option b)** recorded against the nh9.6 close-readiness check; it is *not* a silent scope reduction.

## Scope cross-walk (P4, phase-review-gate pattern)

All eight close-readiness items verified against the merged code (evidence-based, not asserted):
union = the four locked kinds; `ExtractPatch` type fully replaced by `Harvest(RunContext)` (only the
`gitExtractPatch` function + historical doc references remain); `AgentResult.patch → artifacts`
everywhere (TS + Python + `agent-shapes.json`); P1+P3 shipped as one unit; `acceptHarvester` reads
`emitted` + `finalMessage` only (no git, no event-log scraping — RF-1); cross-host fixtures in sync
(both conformance suites green); out-of-scope respected (no environment-axis generalization, no mid-run
streaming, no ledger implementation).

## Gates at close (fresh run on merged main)

`tsc` clean · `vitest` 584 unit + 17 integration · `typecheck:tests` clean · Python conformance +
run_arm + swebench-decoupling 36 passed. (The full `coding-eval` suite has one pre-existing
`test_subset` failure — `datasets` module / network — unrelated to RDR-009.)

## Open threads

- **nexus #1174** (the published `qwen_dispatch` operator spec) — the v3 `{patch}→{artifacts}` update
  is best-effort and was **not** a merge gate; the issue update remains pending nexus sign-off. Tracked
  as an intentional external follow-up.
- **Live `/accept` end-to-end flow** — deferred to engine/host scope (a future RDR), per §MVV.
- **Environment NOTE:** `scripts/coding-eval` has no `.venv` in the current checkout; the Python gate
  ran under system `python3` (pytest 9.0.3). The `.venv/bin/python` path in CLAUDE.md/handoffs is stale.
