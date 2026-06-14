<!-- SPDX-License-Identifier: MIT -->
# Post-mortem — RDR-010: Executor value-harvest

**RDR:** [RDR-010](../RDR-010-executor-value-harvest.md) · **Status:** closed (implemented) ·
**Accepted:** 2026-06-14 · **Closed:** 2026-06-14 · **Epic:** `qwen-coprocessor-stack-855` ·
**PRs:** #51 (doc lifecycle), #52 (P1), #53 (P2)

## Outcome

A dispatched qwen leaf can now return its structured `finalMessage` as a `{kind:"value"}` artifact,
selectable per-call via an optional `harvest: "patch" | "value" | "both"` input (default `"patch"`).
This makes the RDR-009 harvest envelope's value channel reachable through a real `qwen_dispatch` path —
the first non-`patch` production artifact. Two phases, each stacked-reviewed (code-review-expert +
substantive-critic) to **0 Critical** before merge. Fully additive: the response shape, the four-kind
`Artifact` union, and the SWE-bench scoring path are unchanged.

## The retarget (the defining event of this RDR)

RDR-010 began as "the live `/accept` spine — the PUSH producer" (the RDR-009-deferred work). Research
(RF-1..RF-4) killed that framing before any code:

- **RF-2:** the production `/accept` is a conexus skill whose leaves dispatch via the Agent tool +
  MCP calls, **not** `qwen_dispatch`, with no `Artifact[]` ledger. A "live `/accept` spine through the
  executor" would be a demonstrator, not the real thing.
- **RF-3:** a one-shot per-call `RunContext` means the executor structurally cannot emit the spine's
  `entity`/`tier` — those accumulate at the orchestrator across calls.

So the RDR was **retargeted in place** (file renamed `accept-spine-push-producer` →
`executor-value-harvest`) to what is actually buildable and valuable here: the leaf value-harvest. The
`entity`/`tier` emission + `acceptHarvester` wiring stayed out of scope (orchestrator concern). The gate
explicitly judged the scope reduction legitimate and evidence-grounded, not a dodge.

## Shipped vs. the RDR

| §Approach / Phase | Bead | Delivered as planned? |
|-------------------|------|-----------------------|
| Gap 1 / P1 — capture `finalMessage` (`QwenPollSnapshot.lastMessage` + adapter map + `runContextFor` thread) | br2 | Yes (qwen-only; see below) |
| R1 — stacked review of P1 | 5s7 | Yes (0 Critical) |
| Gap 2 / P2 — selectable `harvest` input, tool-layer resolution, v4-additive contract | 2ee | Yes |
| R2 — stacked review of P2 | lqz | Yes (0 Critical) |
| P3 — final gate + scope cross-walk + close readiness | qz8 | Yes (this bead) |

## The qwen-only decision (P1)

The plan audit flagged it and P1 resolved it explicitly at the start (not deferred to R1): the
`claude-cli` dispatcher has no `finalMessage` source (`ClaudeRunResult` lacks it), and claude-cli is not
the value-harvest target (RF-1: the source is the qwen poll path). So `runContextFor` gained an optional
`finalMessage` param fed only by `makeQwenSpawnDispatch`; `makeClaudeCliDispatch` passes none. The
asymmetry is documented in JSDoc and pinned by a regression test — a future contributor extending
`ClaudeRunResult` sees the test fail and learns why. `ClaudeRunResult` was not extended (speculative
scope for a non-target provider).

## What the reviews caught

- **P1 / R1 — adapter not state-gating `last_message` (code-review, Medium).** The poll adapter mapped
  `last_message` whenever present; the server only sets it at idle/complete. Added the state guard so
  the snapshot's "terminal only" invariant holds at every poll, not incidentally because the dispatcher
  reads the last snapshot. (Plus the in-situ P2 export marker and a JSDoc refresh.)
- **P2 / R2 — `opts` shadowing in the harvest-injection function (both reviewers, Significant).** The
  inner `const opts: Partial<SpawnOpts>` in the spawn closure shadowed the new outer
  effects-options param (`opts.harvest`/`opts.clock`). No runtime bug today, but the highest-risk spot
  for a future misread — renamed to `spawnOpts`. Also added a `"both"`-with-no-value test (the common
  coding-run case).

## Scope cross-walk (P3, evidence-based)

Verified against merged code: `Dispatch` signature unchanged (`(task, provider) => AgentResult`);
`AgentTask` has no `harvest` field (resolution is tool-layer, server.ts); `Artifact` union still
exactly four kinds; `runContextFor` keeps `emitted: []` (spine producer out of scope); `valueHarvester`
reads only `finalMessage`, never `run.emitted`; default `harvest:"patch"` ⇒ coding runs byte-identical
(response/agent-shapes unchanged, so the Python conformance suite needed no change).

## Gates at close (fresh on merged main)

`tsc` clean · `vitest` 595 unit + 22 integration · `typecheck:tests` clean · Python conformance +
run_arm + swebench-decoupling 36 passed.

## Open threads

- **nexus #1174** — v4-additive note posted (optional `harvest` request field; response unchanged).
  Best-effort, not a nexus merge gate; the broader #1174 adoption remains pending nexus sign-off.
- **The `entity`/`tier` PUSH channel** stays orchestrator scope (a future RDR / nexus), as it was in
  RDR-009. RDR-010 deliberately did not touch it.
