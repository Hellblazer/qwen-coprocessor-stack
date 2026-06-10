# Post-mortem — RDR-006: Coding-agent evaluation (Qwen3.6-35B-A3B vs Claude, three arms)

**Closed:** 2026-06-10 · **Reason:** implemented · **Outcome:** delivered + extended

This is the lifecycle capstone. The detailed write-ups live in:
- `docs/qwen-coding-agent-eval.md` — results of record + caveats
- `docs/qwen-coding-agent-eval-postmortem.md` — timing breakdown + optimization plan
- `docs/qwen-coprocessor-optimization-findings.md` — noise analysis, best-of-k, §6/§7 selector validation

## Did it answer the question?

**Yes.** The question was: can we hand a real agentic coding task to Qwen via the
MCP supervisor and get a working patch back? It can. Headline (SWE-bench Lite,
frozen 40-instance subset, pass@1):

| arm | description | resolved |
|---|---|---|
| C | claude-sonnet | 21/40 |
| B | raw qwen-code | 18/40 |
| A | qwen via MCP supervisor | 15/40 |

±20–30 pp flip-rate bands (from the variance probe) **exceed the deltas**, so the
ordering is suggestive, not robust at N=40. That band — not the point estimate —
is the honest headline.

## What we learned beyond the original scope

1. **The MCP-vs-raw A↔B Δ=3 is noise, not a wrapper penalty.** Only 5/40 instances
   disagree, ≈ each arm's own run-to-run flip rate. You cannot read a supervisor
   cost from this data at N=40/1-rep.
2. **Empty patches are sampling variance, not capability failure** — re-runs
   produced real patches 6/6. The fix is retry/best-of-k, not prompt nagging.
3. **best-of-k does NOT survive de-enrichment (40v.22).** The enriched-probe
   "30→40%" lift was a selection artifact. On a random 40-instance sample no
   no-cheat selector — smallest-diff, file/content-consensus, or a claude verifier
   — beats pass@1 significantly (ceiling 23/40, pass@1 18/40, all sign tests
   p≥0.38). The gap is the **ceiling**, not the selector.
4. **Self-test prompting regresses qwen** (pass@3 2/3→0/3; self-verdict precision
   0/2). External selection only.
5. **P0 agent concurrency is qwentescence-throughput-bound** — it speeds claude +
   scoring + the probe, not the qwen arms. The qwen speed lever is backend decode
   (P4), not orchestration.

## Process notes

- The stacked review (code-review-expert → substantive-critic) caught a real
  defect or mis-claim on **every** non-trivial change: a thread-collision in
  worktree materialization, a clean_apply counter bug, the parallel-scoring
  measurement-noise risk, and the best-of-k "consensus is actually smallest-diff"
  mis-attribution. Neither reviewer alone would have caught all four.
- "Measure before believing a mechanism" paid off twice — the consensus story
  (vacuous on 9/10) and the smallest-diff story (ties its own opposite) both
  looked right and reproduced the number, yet both were wrong.

## Deferred (re-run-only; no current trigger)

- 40v.18 cheaper variance probe · 40v.19 parallel headline scoring · 40v.20 env
  image pre-warm — harness-speed wins that only matter for a future run.
- 40v.23 Arm A turn/finish telemetry — mooted by finding #1 (A↔B Δ is noise).
- 40v.10 trigger-gated Phase-2 depth — parked until a concrete trigger.

All carried in the optimization plan in `qwen-coding-agent-eval-postmortem.md`.

## Shipped

PR #13 (harness + fixes + results) and PR #14 (best-of-k module + §6/§7 selector
validation), both merged to main. 205 offline tests green.
