---
title: "Coding-agent evaluation — Qwen3.6-35B-A3B vs Claude on SWE-bench Lite, three arms"
id: RDR-006
type: Research
status: accepted
priority: high
author: hal
reviewed-by: self
created: 2026-06-06
accepted_date: 2026-06-07
related_issues: []
---

# RDR-006: Coding-agent evaluation — Qwen3.6-35B-A3B vs Claude on SWE-bench Lite

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate RDR.

## Problem Statement

We have a thorough comparison of Qwen3.6-35B-A3B vs Claude as a **nexus
operator / dispatch backend** (schema-bounded oneshot operators and
search-driven tier-B tool loops) in `docs/qwen-field-report.md`. We have
**zero data** on the question the supervisor was actually built to answer:
**can we hand a real coding task to Qwen via the MCP supervisor and get a
working result back?**

"Coding task" here means the full agentic loop — issue/spec in, the agent
edits files in a working tree, runs commands, iterates, and produces a
patch — not JSON synthesis and not metadata enrichment. The existing
`scripts/bench/` harness explicitly does **not** measure this (its README
says so). `docs/qwen-offload-transition-plan.md` is governance scaffolding
for *if* we offload coding bundles, not an executed measurement.

Without this, the "hand coding tasks to the local Qwen" value proposition
of the whole stack is unvalidated.

## Context

- **Inference backend:** qwentescence (`Qwen3.6-35B-A3B-UD-Q4_K_XL`,
  llama.cpp, `:1234`, 131K ctx, vision=True). Confirmed live and healthy
  (full shakeout 2026-06-06, `scripts/shakeout.py`, 9/9 capabilities).
- **Supervisor:** `mcp-bridges/qwen-agent-server` wraps `@qwen-code/sdk`
  `query()`. Coding handoff path = `qwen_spawn` / `qwen_send` / `qwen_poll`.
  `write_authority:true` → `permissionMode:"yolo"` (free file edit + shell);
  `default` mode gates every tool via a `canUseTool` callback
  (`src/permissions.ts`).
- **Known constraint:** `src/session.ts:240` hardcodes `cwd: process.cwd()`.
  There is no per-spawn working directory, so a supervisor session cannot
  be pointed at a per-instance worktree without a code change.
- **Reasoning-model behaviour:** Qwen3.6's think block precedes content and
  consumes the token budget non-deterministically even at temp 0 (the
  qwentescence `--kv-unified`+`--cache-reuse` config). Established in the
  shakeout (`bd` memory `shakeout-2026-06-06-reasoning-token-budget`).

## Decision

Build a **three-arm SWE-bench Lite evaluation harness** that separates
*agent execution* (produces a patch per instance) from *scoring* (official
SWE-bench Docker harness verifies the patch), and compares:

- **Arm A** — Qwen via the MCP supervisor (`qwen_spawn`, `write_authority:true`,
  per-instance `cwd`). The real hand-off path.
- **Arm B** — raw `qwen-code` CLI against qwentescence, **control** to
  isolate model behaviour from supervisor-wrapper overhead.
- **Arm C** — `claude -p` (sonnet), the realistic alternative and baseline.

Host split: **inference on qwentescence**; **agent runner + Docker scoring
on the Mac**. (The model never runs on the Mac; only orchestration and
test-scoring do.)

Primary metric: **% resolved (pass@1)** per arm on a fixed Lite subset.
Secondary: wall-clock, agent turns / tool-calls, tokens & cost, diff size,
files touched, clean-apply rate, empty-patch rate, plus a failure taxonomy.

**Subset size and the inconclusive zone (resolves measurement-validity
risk).** Small models resolve ~5–20% of Lite, so at 25 instances an arm
scores 1–5 resolved — a 1–2 instance A-vs-B gap is inside the noise. v1
therefore fixes the subset at **40 instances** (the floor at which a
~5-point delta is meaningful) and the report applies an explicit
**inconclusive-zone rule**: if `|A_resolved − B_resolved| ≤ 2` the
scorecard states "wrapper overhead not detectable at this scale" rather
than reporting a direction; likewise for any pair. The failure taxonomy
is reported regardless of count (it is rich even at N=40). The headline
goodness claim is gated on the resolved counts clearing the inconclusive
zone — otherwise the report says so plainly.

## Research Findings

Phase-0 feasibility spike executed **2026-06-06** (bd memory
`coding-agent-eval-phase0-spike-2026-06-06`). All gates green:

**RF-1 — arm64 Docker scoring works on the Mac (top risk, RETIRED).**
`swebench 4.1.0`; build images locally with `--namespace ''` (the published
images are x86-only; the local build is `linux/arm64` despite the `x86_64`
tag in the image name). Gold patch for `psf__requests-1963` scored
**resolved**. First base-image build ~8 min (one-time); per-instance eval
**47–80 s**. Requires Docker Desktop running (`open -a Docker`).

**RF-2 — agent→predictions→score rail proven (Arm C).** Clone @ base_commit
→ `claude -p --dangerously-skip-permissions --output-format json` → `git diff`
→ score = **resolved**. Telemetry available from the JSON envelope
(`total_cost_usd`, `num_turns`, `duration_ms`): $0.72 / 4 turns on this
instance.

**RF-3 — qwen-code arm via qwentescence works and already differentiates
(Arm B).** `qwen --auth-type openai --openai-base-url http://qwentescence:1234/v1
--openai-api-key sk-local -m qwen3.6-35b-a3b --yolo <prompt>` →
`git diff` → score = **unresolved**. Failure is interpretable: Qwen's
*algorithm was essentially correct* (track a `req_source`, advance it to the
previous `prepared_request`) but it **leaked C/JS `//` comments into a
Python file** → `SyntaxError` → all tests error. This is the careless-
mechanics failure class the eval exists to surface.

**RF-4 — both agent CLIs present on the Mac:** `claude` 2.1.168,
`qwen-code` 0.15.6. qwentescence has `git`, `node v24`, `claude` but **no
Docker / Python / WSL** — confirming scoring must run on the Mac, not
qwentescence.

**RF-5 — Arm A not yet exercised.** The spike used the raw CLI (Arm B). Arm A
requires the `cwd` SpawnOpt (see Context). This is the first implementation
task, not a research gap.

## Proposed Solution

### Harness shape

```
            ┌─ Arm A: qwen via supervisor (qwen_spawn cwd=<worktree>, write_authority)
 instance ──┼─ Arm B: raw qwen-code CLI (--openai-base-url qwentescence)  ─→ git diff ─→ predictions.<arm>.jsonl
            └─ Arm C: claude -p sonnet                                                         │
                                                                                               ▼
                                              official swebench harness (Docker, --namespace '') → report.json
                                                                                               │
                                       telemetry (turns/tokens/wall-clock/diffstat) ───────────┴─→ scorecard
```

Each arm only produces a `{instance_id, model_name_or_path, model_patch}`
prediction. Scoring is **not reinvented** — `swebench.harness.run_evaluation`
does FAIL_TO_PASS / PASS_TO_PASS verification.

**Patch extraction — exact, arm-uniform (resolves silent-invalidation
risk).** After the agent terminates, `run_arm.py` extracts the source-only
diff identically for every arm:
`git diff HEAD -- ':(exclude)test/**' ':(exclude)tests/**' ':(exclude)**/test_*.py' ':(exclude)**/*_test.py' ':(exclude)conftest.py'`
(per-repo test-path globs refined in Phase 1 from the instance's
`test_patch` target paths). The harness applies the gold `test_patch`
itself, so a model patch that touched test files would otherwise conflict
and score a false negative. If a non-empty test-file delta is present it is
recorded in the failure taxonomy as `test_edit_contamination` and the run
is scored on the stripped source-only patch. This rule is identical across
A/B/C — Arm C uses the same `git diff` extraction from the worktree, **not**
the `--output-format json` `model_patch` field (which is used only for
telemetry), so all three arms have identical patch semantics.

**Arm fairness — iso-configuration (resolves unfair-harness risk).** All
three arms receive the **same task prompt verbatim** from a single shared
template (only arm-specific invocation flags differ). The qwen arms set an
explicit completion budget of **≥ 16K tokens/turn** to clear the reasoning
block (reasoning starvation otherwise reads as a false failure); `claude -p`
is run with a comparable per-turn budget, and the report documents the
comparison as iso-prompt with per-turn budgets stated. Every arm gets the
same **max-turns** and **per-instance wall-clock cutoff**; hitting either is
recorded as `turn_limit` / `timeout` in the taxonomy, distinct from a wrong
answer.

**Tool-surface isolation (resolves nx-extension-contamination risk).** The
A-vs-B delta must isolate the spawn path, not the tool surface. All qwen
arms run with a **pinned config fixture** that disables the `~/.qwen` nx
extension (clean minimal config) so Arms A and B see an identical tool
surface; the report states the active tool set per arm.

### Components (all under `scripts/coding-eval/`)

- `subset.py` — deterministic Lite subset selection: **40 instances**, a
  pure function of a **pinned dataset snapshot** (`princeton-nlp/SWE-bench_Lite`
  revision hash recorded in the file), drawn **proportionally by repo weight
  in Lite** (representative-Lite, *not* representative-easy — explicitly not
  biased toward lightweight pure-Python repos like requests/flask), minimum
  3 repos represented, sorted by `instance_id`, fixed seed. The selection
  intent and the snapshot hash are documented in the report for
  reproducibility.
- `materialize.py` — per-instance throwaway worktree at `base_commit`.
- `run_arm.py` — drives one arm over the subset, captures telemetry,
  extracts `git diff` (source-only), writes `predictions.<arm>.jsonl`.
  - Arm A driver: **spawned supervisor process** (the production path —
    `qwen_spawn → supervisor → @qwen-code/sdk`), `qwen_spawn(..., opts=
    {write_authority:true, cwd:<worktree>})`, poll to terminal, read final
    state. In-process `createToolHandlers` is **only** permitted as a
    Phase-1 bootstrap shim and must be labelled as such — the headline Arm A
    number must come from the spawned-supervisor path or it does not validate
    "qwen via the MCP supervisor."
  - Arm B driver: `qwen-code` CLI subprocess, yolo, qwentescence backend.
  - Arm C driver: `claude -p` subprocess, sonnet, `--output-format json`.
- **Telemetry capture (asymmetry flagged).** Arm C telemetry
  (`total_cost_usd`/`num_turns`/`duration_ms`) is confirmed via
  `--output-format json` (RF-2). Arm A turns/tool-calls come from the
  supervisor's existing counters (`tool_calls`, assistant-message debug).
  **Open Phase-1 risk:** the qwen-code CLI (Arm B) may not emit structured
  turn/token counts in yolo mode; Phase 1 confirms parseability or the
  scorecard shows those cells as `N/A` for Arm B rather than scraping
  fragile stdout. Qwen cost is $0 at margin (local GPU); only wall-clock and
  turns are the cross-arm-comparable secondary metrics if tokens are
  unavailable.
- `score.py` — wraps the official harness per predictions file.
- `report.py` — merges `report.json` + telemetry into
  `docs/qwen-coding-agent-eval.md` (scorecard + failure taxonomy).

### Supervisor enabler

Add a `cwd?: string` field to `SpawnOpts` (`src/types.ts` + the opts schema
in `src/server.ts`), threaded into `queryOptions.cwd` (`src/session.ts:240`),
defaulting to `process.cwd()`. Unit test. This is the only production-code
change; it ships through the normal versioned-supervisor release flow.

### Token budget

Per RF and the shakeout finding, the qwen arms set a generous completion
budget (reasoning starvation otherwise reads as a false failure). Record
`finish_reason` per turn so starvation is distinguishable from a genuine
wrong answer in the taxonomy.

## Alternatives Considered

**A. Hand-built mini-fixtures instead of SWE-bench.** Pro: no Docker, runs
anywhere, deterministic, polyglot. Con: synthetic, not leaderboard-
comparable, lower external credibility. **Rejected** — user chose SWE-bench
Lite for real-issue credibility; the arm64 Docker concern that motivated
this alternative was retired in RF-1.

**B. MCP-supervisor arm only (no raw-CLI control).** Pro: simpler. Con:
can't attribute a failure to the model vs the supervisor wrapper (cwd,
permission shim, MCP-stdio overhead). **Rejected** — the control arm is
cheap and the attribution is a primary question.

**C. Opus baseline (or both tiers).** Pro: measures against the ceiling.
Con: higher spend; sonnet is the realistic hand-off alternative and matches
the field-report cost constants. **Rejected for v1**; Opus can be a Phase-3
add.

**D. Scoring on qwentescence.** Rejected — no Docker/Python/WSL there (RF-4);
provisioning it is strictly more work than scoring on the Mac, which RF-1
proved works.

## Trade-offs

- **Small-model floor.** Qwen may resolve few Lite instances; the *relative*
  ordering (A vs B vs C) and the failure taxonomy are the real signal, not
  an absolute leaderboard number. Set expectations accordingly.
- **pass@1 vs variance.** qwentescence is non-deterministic at temp 0, so a
  single attempt understates/overstates. v1 reports pass@1 with a **3-rep
  variance probe on ~10 instances** (30 runs, tractable) and reports the
  observed **per-arm flip rate**; the report annotates the pass@1 headline
  with a ±N-point band derived from that flip rate, so the directional
  conclusion is read against its own uncertainty. Full multi-rep over the
  whole subset is Phase-3.
- **yolo on host.** Agent edits run in throwaway worktrees on the Mac; the
  Docker harness is the only thing that runs the actual tests. Acceptable
  for ephemeral checkouts; documented.

## Implementation Plan

**Phase 1 — runner → predictions (per arm).**
- Bead: `cwd` SpawnOpt on the supervisor + unit test (Arm A enabler).
- Bead: `subset.py` + `materialize.py` (deterministic subset, worktrees).
- Bead: `run_arm.py` Arm C (claude) — closes the rail already spiked.
- Bead: `run_arm.py` Arm B (qwen-code CLI).
- Bead: `run_arm.py` Arm A (supervisor, cwd, write_authority).
- Bead: telemetry capture (turns, tokens, cost, finish_reason, diffstat).

**Phase 2 — scoring + scorecard.**
- Bead: `score.py` over all three predictions files.
- Bead: `report.py` → `docs/qwen-coding-agent-eval.md` (resolved%, latency,
  cost, failure taxonomy; A-vs-B wrapper delta; {A,B}-vs-C model gap).

**Phase 3 — optional depth (triggered, not automatic).** Escalate only if
Phase 2 shows one of: the A-vs-B delta lands in the inconclusive zone (need
more N to resolve wrapper cost), a flip rate high enough that the ±band
crosses the model-gap conclusion, or the failure taxonomy shows a systematic
recurring pattern (e.g. the RF-3 `//`-in-Python class).
- Bead: full multi-rep over the whole subset; larger Lite slice; Opus arm;
  upstream findings against qwen-code for any recurring behaviour class.

## Test Plan

- Unit: `cwd` SpawnOpt routes to `queryOptions.cwd`; defaults preserved.
- Integration: gold-patch predictions for the subset score 100% resolved
  (harness sanity, mirrors RF-1).
- Integration: each arm produces a non-empty, cleanly-applying diff on
  `psf__requests-1963` (mirrors RF-2/RF-3) **plus** at least one instance
  where Arm A/B are expected to produce a clean source-only diff (so the
  rail test isn't anchored only on a known qwen-failure case).
- Integration: the patch-extraction rule strips a deliberately test-touching
  diff and records `test_edit_contamination` (verifies the exclusion glob).
- Determinism: subset selection is a pure function of the **pinned** dataset
  snapshot hash (regression-test the instance-id list).
- Harness hygiene: per-instance wall-clock cutoff fires and is recorded as
  `timeout` rather than hanging the run.

## Validation

The RDR is validated when a full run over the 40-instance subset produces
`docs/qwen-coding-agent-eval.md` with: per-arm resolved% (annotated with the
flip-rate ±band), the A-vs-B wrapper delta **subject to the inconclusive-zone
rule**, the {A,B}-vs-C model gap, and a populated failure taxonomy. A result
inside the inconclusive zone is a *valid* outcome — the report states
"wrapper overhead not detectable at this scale" rather than manufacturing a
direction. The validation question — "is Qwen-via-MCP good enough to hand
real coding tasks to, and does the supervisor wrapper cost anything?" — is
answered either with a delta clearing the zone or with an explicit
"inconclusive at N=40, escalate per Phase-3."

`clean-apply rate` is defined as: the fraction of non-empty model patches
that `git apply` cleanly against the base commit (failures = conflict or
malformed diff), reported separately from `empty-patch` (agent produced no
diff) and from `resolved` (tests pass)._

## Finalization Gate

_Pending — run `/conexus:rdr-gate` after the Proposed Solution is locked._

## References

- `docs/qwen-field-report.md` — operator/dispatch comparison (prior art).
- `docs/qwen-offload-transition-plan.md` — offload governance.
- `scripts/bench/` — operator A/B harness (in-process `createToolHandlers`).
- `scripts/shakeout.py` — capability shakeout (reasoning-budget finding).
- `scripts/coding-eval/` — Phase-0 spike artifacts.
- bd: `coding-agent-eval-phase0-spike-2026-06-06`,
  `shakeout-2026-06-06-reasoning-token-budget`.
- SWE-bench Lite: `princeton-nlp/SWE-bench_Lite`; `swebench` 4.1.0.

## Revision History

- 2026-06-06 — draft created with Phase-0 spike results pre-folded (RF-1..5).
- 2026-06-06 — gate round 1 (substantive-critic): 3 Critical, 4 Significant.
  Resolved in-doc: subset → 40 + inconclusive-zone rule (measurement scale);
  iso-config arm fairness (shared verbatim prompt, ≥16K qwen token floor,
  shared max-turns + wall-clock cutoff); exact arm-uniform patch-extraction
  glob + `test_edit_contamination` taxonomy (Arm C now uses git diff, not the
  json model_patch field, for parity); nx-extension tool-surface pinned off
  across qwen arms; Arm A fork closed to the spawned-supervisor path;
  telemetry asymmetry flagged with N/A fallback; variance probe → ~10
  instances + flip-rate ±band; subset stratification (proportional,
  representative-Lite, pinned snapshot); clean-apply defined; Phase-3 made
  trigger-gated.
