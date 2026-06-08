# SPDX-License-Identifier: MIT
"""v1 variance probe + per-arm flip-rate (RDR-006 40v.11).

RDR-006 reports **pass@1** but annotates the headline resolved% with a
flip-rate ±band so a reader knows how much of the number is noise (qwentescence
is non-deterministic even at temp 0 — shakeout finding). This module is the
SOURCE of that band; report.py (40v.9) consumes ``FlipRateRecord``.

**v1 scope (NOT Phase 3).** The probe is ~10 instances drawn from the 40-instance
subset, each arm run ``PROBE_REPS`` (3) times = 30 runs/arm — tractable. The
per-arm *flip rate* is the fraction of probed instances whose resolved/unresolved
verdict is NOT stable across the reps. Full multi-rep over the whole subset is
the Phase-3 item (40v.10); do not conflate.

The probe ORCHESTRATION reuses run_arm + score via an injectable
``run_and_score`` seam (so the methodology is unit-tested offline without live
backends/Docker); the live adapter wires that seam to the real arm runners.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from subset import rank_key  # version-stable sha256 ranking (reused for determinism)

PROBE_SIZE = 10
PROBE_REPS = 3
# Distinct from subset.SEED so the probe pick isn't correlated with anything in
# the subset's own within-repo selection.
PROBE_SEED = 40006
SUBSET_FULL_SIZE = 40


def select_probe_instances(
    subset_ids: Sequence[str],
    n: int = PROBE_SIZE,
    seed: int = PROBE_SEED,
) -> list[str]:
    """Deterministically pick ``n`` probe instances from the 40-subset.

    Pure function of ``(subset_ids, seed)``: rank by sha256("<seed>:<id>") and
    take the first ``n`` (version-stable, platform-stable), returned sorted by
    instance_id. A pseudo-random spread across the subset's repos rather than a
    positional stride (which would over-weight the id-sorted leading block).
    """
    if n > len(subset_ids):
        raise ValueError(f"probe size {n} > subset size {len(subset_ids)}")
    ranked = sorted(subset_ids, key=lambda i: rank_key(seed, i))
    return sorted(ranked[:n])


def instance_flipped(verdicts: Sequence[bool]) -> bool:
    """True if the resolved/unresolved verdict is NOT unanimous across reps.

    3/3 resolved or 0/3 resolved is stable (no flip); 2/3 or 1/3 is a flip.
    """
    return len(set(verdicts)) > 1


def flip_rate(verdicts_by_instance: Mapping[str, Sequence[bool]]) -> float:
    """Fraction of instances whose verdict flipped across reps (0.0 if empty)."""
    if not verdicts_by_instance:
        return 0.0
    flips = sum(1 for v in verdicts_by_instance.values() if instance_flipped(v))
    return flips / len(verdicts_by_instance)


@dataclass
class FlipRateRecord:
    """Per-arm variance summary report.py turns into a ±band on resolved%.

    ``band_points`` is the ±percentage-point band: the probe's flip rate scaled
    to a percentage. It is a CONSERVATIVE PROJECTION of an empirical flip
    fraction onto the headline number — NOT a statistical confidence interval
    (no binomial estimator). ``band_method`` carries this provenance so report.py
    must echo it (e.g. "±N pp, flip-rate projection") and cannot present the band
    as a tight CI. A flipping instance's verdict is unstable, so up to
    ``round(flip_rate * full_size)`` of the full subset's verdicts could swing.
    """

    arm: str
    n_instances: int
    n_reps: int
    n_flipped: int
    flip_rate: float
    band_points: float
    band_instances_full: int
    full_size: int
    band_method: str = "flip-rate-projection"  # NOT a CI; report.py must echo this

    def to_dict(self) -> dict:
        return asdict(self)


def summarize_arm(
    arm: str,
    verdicts_by_instance: Mapping[str, Sequence[bool]],
    *,
    n_reps: int = PROBE_REPS,
    full_size: int = SUBSET_FULL_SIZE,
) -> FlipRateRecord:
    """Build the per-arm FlipRateRecord from a probe's verdict matrix."""
    if not arm:
        raise ValueError("arm is required")
    fr = flip_rate(verdicts_by_instance)
    n_flipped = sum(
        1 for v in verdicts_by_instance.values() if instance_flipped(v)
    )
    return FlipRateRecord(
        arm=arm,
        n_instances=len(verdicts_by_instance),
        n_reps=n_reps,
        n_flipped=n_flipped,
        flip_rate=fr,
        band_points=round(fr * 100.0, 1),
        band_instances_full=round(fr * full_size),
        full_size=full_size,
    )


# A run_and_score seam: given (arm, instance_id, rep) -> resolved bool.
RunAndScore = Callable[[str, str, int], bool]


def run_probe(
    arms: Sequence[str],
    instance_ids: Sequence[str],
    run_and_score: RunAndScore,
    *,
    reps: int = PROBE_REPS,
    full_size: int = SUBSET_FULL_SIZE,
) -> dict[str, FlipRateRecord]:
    """Run the variance probe: each arm × instance × rep -> verdict, then
    summarize per-arm flip rate.

    ``run_and_score`` is injected (the live adapter wires it to run_arm +
    score; tests pass a deterministic fake). Reps run through the SAME run_arm /
    score path the headline uses — the probe measures the real pipeline's
    non-determinism, not a separate code path.
    """
    out: dict[str, FlipRateRecord] = {}
    for arm in arms:
        verdicts: dict[str, list[bool]] = {}
        for iid in instance_ids:
            verdicts[iid] = [run_and_score(arm, iid, rep) for rep in range(reps)]
        out[arm] = summarize_arm(
            arm, verdicts, n_reps=reps, full_size=full_size
        )
    return out


def write_flip_rates(path: Path, records: Mapping[str, FlipRateRecord]) -> None:
    """Write the per-arm flip-rate records as the band source for report.py."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {arm: rec.to_dict() for arm, rec in records.items()}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
