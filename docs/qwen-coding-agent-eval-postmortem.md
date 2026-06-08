# RDR-006 harness post-mortem — why the full run took >1 day, and how to make it ~4–5×faster

Data source: `scripts/coding-eval/work/full_run/{run.log,recover.log,probe/}` from the
2026-06-07/08 three-arm run (headline + variance probe). All numbers below are measured.

## TL;DR

- **Scoring was NOT the bottleneck.** A warm single-instance Docker score is
  **median 29 s / mean 40 s / p90 85 s** (n=180 probe scorings). My earlier
  "5–6 min per scoring" claim was wrong — I conflated it with the one-time cold
  image build and with agent + worktree-checkout time.
- **The dominant cost is serial agent *inference*** (qwen is slow per instance and
  every run was sequential), then the **90-rep variance probe** (90 more serial
  agent runs), then a **one-time ~2 h cold Docker-image build** that also tripped
  the old 2 h scoring timeout (≈2 h wasted, since fixed in 40v.15).
- **The qwentescence stall was rare here** — exactly **1** timeout in the whole
  run (not the many I feared while watching slow progress live).
- **Single biggest lever: parallelize the agent runs.** ~17 h of the ~24 h was
  agents running one-at-a-time. Concurrency takes a full run from ~24 h toward
  ~5–7 h.

## Measured time breakdown (~24 h wall-clock)

| Phase | Time | Notes |
|---|---|---|
| Headline Arm A agents (40) | **4.0 h** | mean 358 s/inst, max 1179 s |
| Headline Arm A cold scoring | **~2 h, WASTED** | built ~37 env images cold, hit the old 2 h harness timeout → no report → crash |
| Recovery Arm A re-score (warm) | 1.4 h | 37 inst @ 137 s/it (images now cached) |
| Recovery Arm B agents (40) | **4.7 h** | mean 422 s/inst, 1 timeout (the only stall) |
| Recovery Arm B scoring | 0.4 h | 36 inst @ 43 s/it warm |
| Recovery Arm C agents (40) | 0.8 h | mean 72 s/inst (claude is fast) |
| Recovery Arm C scoring | 0.45 h | 40 inst @ 41 s/it warm |
| **Variance probe (90 reps)** | **~10 h** | 90 × (agent + worktree checkout + ~30 s score); qwen reps dominate |

- **Agent inference ≈ 17 h ≈ 70 % of wall-clock.** Scoring (warm) ≈ 2.3 h. The
  cold-build failure wasted ~2 h. Worktree materialization (210 full-repo
  checkouts, e.g. django = 6526 files each) is folded into the per-run times.

## Why a probe rep *felt* like 5–6 min

A probe rep = **materialize worktree** (git checkout of the whole repo, tens of
seconds for big repos) + **run the agent** (qwen ~5–7 min, claude ~1–2 min) +
**score one instance** (~30 s warm). The ~30 s score is the *smallest* part. The
90-rep probe was slow because it ran 90 agents **serially**, not because scoring
is slow.

## Why scoring is ~30 s, not minutes (once warm)

`--cache_level instance` means the per-instance Docker image is built once and
reused. After the first cold run, a score is just: start container → `git apply`
→ run the instance's test command → grade. ~20–90 s depending on the repo's test
suite. The expensive part is strictly the **one-time** env/instance image build
(~37 images, ~1 h, paid once and persisted on the host).

## Optimizations, by impact

### P0 — Parallelize agent runs within an arm  (≈3–4× on the dominant cost)
~17 h of agents ran one instance at a time. The arm drivers are independent per
instance; qwentescence is a server and `claude -p` is a fresh process, so N
instances can run concurrently. Even N=3–4 for the qwen arms (VRAM/throughput
permitting) and higher for claude would cut headline agents ~9.5 h → ~3 h and the
probe ~10 h → ~3 h. **This is the headline win.** Requires: a bounded worker pool
in `run_one_arm` / the probe loop, and a qwentescence concurrency check.

### P1 — Make the variance probe cheaper, not just parallel
90 full agent re-runs to estimate a flip-rate band is inherently the second-
biggest cost. Options: (a) parallelize probe reps (same mechanism as P0); (b)
drop reps 3→2 or probe size 10→8 (documented precision trade-off); (c) reuse the
headline run as rep-0 so the probe only adds 2 reps, not 3.

### P2 — Parallelize scoring (`--max_workers > 1`)  (free 4–8× on the scoring slice)
Already plumbed (40v.16, opt-in via `--probe-max-workers`; headline still serial).
For the *headline* scoring (40 inst serial @ ~40 s = ~27 min/arm) a small worker
pool is safe once images are cached — the only reason it's pinned to 1 is cold-
build determinism. Add `--score-max-workers` for headline scoring too. Note: keep
the *variance probe* serial (measurement purity — see 40v.16 critique).

### P3 — Never pay the cold build / timeout twice
Env images persist on the host, so future runs skip the ~1 h build. The 40v.15
timeout fix (2 h→6 h) prevents the cold-build-vs-timeout crash that cost ~2 h +
the recovery restart. Optionally pre-warm images in a setup step so the first
real scoring is already warm.

### P4 — qwentescence inference speed & the stall bug
Raw qwen agent time (mean ~360–420 s/inst) is the floor under P0. Faster decode
(backend tuning / more GPU) cuts it directly. Separately, drop `--kv-unified`
(keep `--cache-reuse`) to remove the cancel-task hang (bd `bisect-2026-05-21…`,
ggml-org/llama.cpp#23493) — only 1 stall this run, but it both wastes 30 min and
inflates the qwen variance bands when it fires.

### P5 — Cheaper worktree materialization (minor)
210 full-repo checkouts. A shared bare mirror + `git worktree` is already used;
sparse-checkout or keeping per-(repo,commit) worktrees warm would trim the
tens-of-seconds-per-run checkout, but this is small next to agents.

## Projected effect

P0 (agent concurrency 4×) + P2 (scoring 4×) + P3 (no cold re-pay): a full 3-arm +
variance run drops from **~24 h to ~5–7 h**, bounded mainly by qwentescence decode
speed (P4). Without touching the backend, P0 alone is the difference between an
overnight run and a long-afternoon run.
