# Optimizing the Qwen coprocessor's coding-agent results — findings

Follow-up to `docs/qwen-coding-agent-eval.md` (the RDR-006 three-arm eval) and its
post-mortem. Question: the headline showed C(claude) 21/40 > B(raw qwen) 18/40 >
A(qwen via MCP supervisor) 15/40 — is the A↔B gap real, and how do we lift qwen?
All numbers below are measured on our own run artifacts.

## 1. The MCP-vs-raw (A↔B) Δ=3 is noise, not a wrapper penalty

Same model (`qwen3.6-35b-a3b`); A and B differ only by invocation path. Paired
per-instance verdicts from run #1:

- **14 instances both solved.** Only **5 disagree** (1 A-only, 4 B-only), net +3.
- The variance probe measured **within-arm** flip rates of **20% (A) / 30% (B)** —
  re-running the *same* arm flips 2–3 of 10 borderline instances.
- The 5 disagreement instances are the same borderline kind (4/5 sympy/seaborn)
  that flip on re-runs.

→ The A↔B disagreement set (5) ≈ each arm's own run-to-run jitter, and Δ=3
(7.5 pp) sits well inside the ±20–30 pp bands. **You cannot conclude the MCP
supervisor costs resolves from this data.** To detect a *small* wrapper effect
you would hold instances fixed and add reps (paired multi-rep on the 5
disagreement instances), not run 1 rep × 40.

Instrumentation gap to fix first: Arm A reports `turns=None` / `finish=idle` (the
supervisor poll never surfaced turn counts or a real finish reason), so we cannot
compare *effort* between A and B. Wire the supervisor to report turns/finish.

## 2. Empty patches are sampling variance, not capability failures

3–4 instances/arm (~8–10%) produced **no source diff** yet finished "cleanly"
(A=`idle`, B=`success`) — the agent believed it was done having edited nothing.
Re-running the 3 worst (with transcript capture):

- **6/6 re-runs produced real, well-reasoned patches** (8–37 grep/read calls,
  edits, ran tests). The agent is fully capable on these; the empties were
  unlucky no-diff samples.
- Scored best-of-2 on those 3: **0 → 2 resolved** (`12747`, `15388`; each solved
  on exactly one of two reps). `14997` needs more attempts.

→ The fix is **retry / best-of-k**, NOT a prompt that nags the model to "always
leave an edit."

## 3. Don't tax the prompt — a self-test prompt REGRESSED qwen

A prompt mandating "write a reproduction, run it, end with `SELFCHECK: PASS/FAIL`"
was tested as a selector signal. It backfired on both axes (3 empties, k=3):

- **pass@3 dropped 2/3 → 0/3** vs the plain prompt. The reproduction/verdict
  ceremony distracted the model from the fix (P ≈ 5% by chance — very likely the
  prompt hurt).
- **The self-verdict is useless as a selector**: the model ignored the
  instruction on 7/9 attempts (no verdict emitted), and the 2 `SELFCHECK: PASS`
  verdicts were both wrong (precision 0/2). qwen cannot be trusted to self-judge.

→ Keep the plain prompt. The selector must be **external**, not agent self-report.

## 4. best-of-k + consensus selector delivers most of the ceiling

Plain prompt, k attempts, **external no-cheat selector = consensus** (largest
cluster of attempts touching the same file(s); tie-break smaller diff). A true
"regression filter" would need an independent test oracle, but the only one we
have is the gold `PASS_TO_PASS` — using it is cheating. Consensus
(self-consistency) needs no test execution and no cheating.

Measured on the **10 variance-probe instances** (the flippy population),
best-of-4 (headline + 3 probe reps, Arm B), reconstructed from existing artifacts:

| metric | result |
|---|---|
| pass@1 (single attempt) | **3/10 (30%)** |
| pass@4 (ceiling — perfect selector) | 5/10 (50%) |
| **consensus-selected (deliverable, no-cheat)** | **4/10 (40%)** |
| selector recall on recoverable instances | 4/5 |

- best-of-4 + consensus **lifts pass@1 30% → 40%** (+33% relative), capturing 4 of
  the 5 solvable-in-some-attempt instances.
- The one miss (`django-12747`: resolved 2/4, consensus picked a failing attempt)
  is the gap to the 50% ceiling — a better selector or higher k recovers it.
- 5/10 never resolved in 4 tries — genuinely hard; no selector helps.

**Caveat on extrapolation:** the 10 probe instances are *enriched for borderline
cases* (they were selected as the variance sample), so this is near the *upper*
end of the population effect. The whole-40 lift is smaller (many instances are
stable solves or stable fails where k doesn't help) — a full best-of-k run would
quantify it, at ~k× the (qwentescence-bound) agent cost.

**Correction (mechanism) — review of 40v.21 found the consensus story is wrong
for this data.** On **9 of the 10** instances, *all* attempts touched a single,
identical file-set, so the file-consensus clustering did NO discriminating work —
selection reduced to the tiebreak. The measured 30→40% is therefore attributable
to **"smallest applying diff among k,"** NOT to file consensus. File consensus
only discriminates on multi-file instances (rare here) and remains **unvalidated**
as a signal. The smaller-diff tiebreak is itself a *hypothesis* ("focused fix >
sprawling fix"), now exposed as an injectable `key` for ablation (random /
verifier-score / similarity). n=10 is also below significance. Net: best-of-k
with *some* cheap selector lifts qwen here; *which* selector earns the lift is
still open (40v.22). The `bestofk` module reports `cluster_report.vacuous` so this
degeneracy is visible, not hidden behind the word "consensus."

## 5. The recipe + recommendations

**Recipe for the coprocessor:** plain prompt → k independent attempts → select by
**any cheap non-degenerate pick** over the non-empty/applying attempts (the
diff-size tiebreak is an unvalidated default — see §6, it is noise on this data) →
fall back to non-empty/applies. $0 local cost; exploits the measured ~20–30%
per-attempt instability. The lift is *diversification across k*, not the selector.

Priorities:
1. **Implement best-of-k with a consensus selector as a first-class coprocessor
   capability** (40v.21). Per-task quality lever; measured 30→40% on the flippy
   set.
2. **Better selector than file-consensus / diff-size** (40v.22) — both are
   unvalidated (§6: diff-size direction is noise; consensus vacuous on 9/10).
   Closing the 40→50% gap needs a *discriminating* signal — content-level
   agreement, an independent verifier model, or a cheap regression run — validated
   on a random, non-enriched sample (new runs required).
3. **Fix Arm A turn/finish instrumentation** (prereq for any rigorous wrapper
   analysis; §1).
4. **Do NOT** pursue: self-test prompts (§3), or treating the A↔B Δ as signal
   (§1).
5. Backend decode (qwentescence P4) remains the orthogonal lever for *speed*, not
   resolve rate.

## 6. Selector-key ablation — the diff-size tiebreak is NOISE (40v.22a)

§4's correction left one hypothesis standing: that "smallest applying diff among
k" (the default `key=len` tiebreak) is what earns the 30→40% lift. We ablated the
`key` directly on the existing k=4 Arm-B artifacts (headline + 3 probe reps per
instance; **zero new agent runs**), scoring how many of the 10 probe instances
each selector lands on a *resolved* attempt:

| selector key | resolved selections |
|---|---|
| pass@1 (headline, attempt 0) | 3/10 |
| earliest (const key ⇒ attempt 0) | 3/10 |
| **smallest-diff (`key=len`)** | **4/10** |
| **largest-diff (`key=-len`)** | **4/10** |
| random (uniform within winning cluster, analytic E) | 3.92/10 |
| pass@4 (ceiling, perfect selector) | 5/10 |

**Smallest-diff does NOT beat its own opposite.** Both land 4/10 — and on
*different* instances: smallest resolves `{astropy-14995, django-14411, scikit-10297,
sympy-18698}`, largest resolves `{astropy-14995, django-12747, scikit-10297,
sympy-18698}`. They trade `django-14411 ↔ django-12747`. The diff-size *direction*
carries no signal; which one "wins" an instance is luck. Random selection captures
essentially the whole lift (3.92 ≈ 4).

**Conclusion:** the 3→4 (30→40%) improvement is entirely *"sample k attempts and
don't pin to attempt 0"* — pure diversification. Neither file-consensus (vacuous
on 9/10) NOR the smallest-diff tiebreak is a validated discriminating signal; any
non-degenerate pick over k attempts yields ~4/10. Per-instance detail confirms the
mechanism: 9/10 are single-file (consensus inert), and on the one multi-file
instance (`matplotlib-22835`) no attempt resolved anyway.

**Implication for the 40→50% gap.** Closing 4/10 → the 5/10 ceiling cannot come
from tuning `key` — it requires a selector with *genuine* discriminating signal
(content-level agreement across attempts, an independent verifier model, or a cheap
regression oracle), and it must be validated on a **random, non-enriched** sample
(the n=10 probe set is borderline-enriched and below significance). That needs new
agent runs (qwentescence-bound) — gated, not free. Until then, ship best-of-k with
*any* cheap non-degenerate selector and label the diff-size tiebreak as an
unvalidated default, not the mechanism.

(Reproduce: `scripts/coding-eval/work/ablate_selector.py`.)
