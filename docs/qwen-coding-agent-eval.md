# Coding-agent evaluation — Qwen vs Claude (SWE-bench Lite)

## Headline — pass@1 resolved

| Arm | resolved | total | resolved% (pass@1) |
| --- | ---: | ---: | --- |
| A | 15 | 40 | 37.5% ±20.0 pp (flip-rate-projection; not a CI) |
| B | 18 | 40 | 45.0% ±30.0 pp (flip-rate-projection; not a CI) |
| C | 21 | 40 | 52.5% ±20.0 pp (flip-rate-projection; not a CI) |

Bands are a flip-rate projection from the v1 variance probe (~10 instances × 3 reps), NOT a statistical confidence interval.

## Pairwise deltas (inconclusive-zone gated)

- A vs B: Δ=-3 — B resolves more than A.
- A vs C: Δ=-6 — C resolves more than A.
- B vs C: Δ=-3 — C resolves more than B.

The inconclusive zone is ±2 resolved instances; a delta inside it is a valid 'not detectable' outcome, not a tie to spin.

## Patch accounting (separate counters)

| Arm | resolved | empty-patch | non-empty | clean-apply | clean-apply-fail | clean-apply rate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A | 15 | 3 | 37 | 36 | 1 | 97.3% |
| B | 18 | 4 | 36 | 35 | 1 | 97.2% |
| C | 21 | 0 | 40 | 39 | 1 | 97.5% |

*resolved* = tests pass; *empty-patch* = agent produced no source diff; *clean-apply rate* = fraction of NON-empty patches that git-apply cleanly against base. These are distinct — an empty patch is not an apply failure, and applying is not resolving.

## Cost & tokens

| Arm | total tokens | total cost (USD) |
| --- | --- | --- |
| A | N/A | 0.0 |
| B | 27331131 | 0.0 |
| C | N/A | 11.594396699999999 |

N/A = the arm's CLI does not emit that counter (not zero). The qwen arms run on local hardware so cost is $0 at the margin; Claude cost is from the `--output-format json` envelope.

## Failure taxonomy

| Arm | clean_apply_fail | empty_patch | error | reasoning_starvation | test_edit_contamination | timeout | turn_limit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 1 | 3 | 0 | 0 | 0 | 0 | 0 |
| B | 1 | 4 | 0 | 0 | 0 | 1 | 1 |
| C | 1 | 0 | 0 | 0 | 0 | 0 | 1 |

Counts are per-class-per-instance and NOT mutually exclusive (one instance can be both a timeout and an empty-patch), so a row does not sum to the arm total. Behavioural classes (e.g. the RF-3 `//`-comment-in-Python class) are qualitative and noted in review, not auto-counted.

## Reproducibility

- Dataset: `princeton-nlp/SWE-bench_Lite` @ `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2` (pinned).
- Subset: 40 instances, a pure function of the pinned SWE-bench_Lite snapshot, drawn proportionally by repo weight (representative-Lite, not biased to lightweight repos), >=3 repos, fixed seed, sorted by instance_id.
- Iso-prompt: one shared task prompt verbatim across arms; per-turn output floor 16384 tokens; max-turns 40; per-instance wall-clock 1800s.
- Arm A tool surface: qwen core tools (nx disabled via supervisor extensions opt)
- Arm B tool surface: qwen core tools (nx disabled via clean HOME fixture)
- Arm C tool surface: claude core tools (sonnet, nx not applicable)

## Caveats & interpretation

- **Bands exceed the deltas.** The flip-rate bands (±20–30 pp) are wider than the
  pairwise resolved deltas (A↔B = 3 instances = 7.5 pp; A↔C = 6 = 15 pp). The
  point-estimate ordering C > B > A is *suggestive, not statistically robust* at
  N=40 with this pipeline's non-determinism. The pairwise section reports a
  direction only because the deltas clear the ±2 resolved-count inconclusive
  zone; the variance band is the stronger caveat and dominates.
- **qwentescence streaming-stall inflated the qwen-arm bands.** During the run the
  llama-server cancel-task bug (`--kv-unified` + `--cache-reuse`; ggml-org/
  llama.cpp#23493) stalled inference on several qwen reps; the 1800s wall-clock
  guard recovered each as a TIMEOUT (Arm B carries 1 in the headline). Those
  timeouts register as unresolved flips, so Arm B's ±30 pp band overstates
  *model* non-determinism — part of it is infra noise, not the model.
- **Single-host, serial scoring.** All scoring ran on one M-series Mac at
  `--max_workers 1` against a locally-built arm64 image set; this is a
  throughput floor, not a property of the models.
- **Robustness needs more reps / a larger slice** — exactly the trigger-gated
  Phase-3 work (`qwen-coprocessor-stack-40v.10`).
