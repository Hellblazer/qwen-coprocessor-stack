# SPDX-License-Identifier: MIT
"""Tests for the v1 variance probe + flip-rate (RDR-006 40v.11)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import variance  # noqa: E402

# The frozen probe selection from the pinned 40-subset. Regenerate deliberately
# (same trigger as the subset frozen list) only when the subset or PROBE_SEED
# changes. 10 instances spanning 6 repos — representative, not django-dominated.
EXPECTED_PROBE = [
    "astropy__astropy-14995",
    "django__django-12747",
    "django__django-13321",
    "django__django-14411",
    "matplotlib__matplotlib-22835",
    "scikit-learn__scikit-learn-10297",
    "sphinx-doc__sphinx-7975",
    "sphinx-doc__sphinx-8273",
    "sympy__sympy-18698",
    "sympy__sympy-19254",
]

# A stand-in 40-subset for pure-function selection tests (no dataset/network).
FAKE_SUBSET = [f"repo{ i % 5 }__r-{i:04d}" for i in range(40)]


# ── selection ────────────────────────────────────────────────────────────


def test_select_probe_size_and_sorted():
    probe = variance.select_probe_instances(FAKE_SUBSET)
    assert len(probe) == variance.PROBE_SIZE
    assert probe == sorted(probe)
    assert len(set(probe)) == len(probe)  # no dupes
    assert set(probe) <= set(FAKE_SUBSET)  # a genuine subset


def test_select_probe_is_deterministic_and_order_independent():
    a = variance.select_probe_instances(FAKE_SUBSET)
    b = variance.select_probe_instances(list(reversed(FAKE_SUBSET)))
    assert a == b


def test_select_probe_seed_changes_pick():
    a = variance.select_probe_instances(FAKE_SUBSET, seed=variance.PROBE_SEED)
    b = variance.select_probe_instances(FAKE_SUBSET, seed=variance.PROBE_SEED + 1)
    assert a != b


def test_select_probe_rejects_oversize():
    with pytest.raises(ValueError):
        variance.select_probe_instances(["a", "b"], n=10)


def test_real_probe_matches_frozen_list():
    """The probe selection over the real pinned subset must equal EXPECTED_PROBE.
    Skips offline; pins the result whenever the dataset is reachable."""
    try:
        import subset

        insts = subset.select_subset(subset.load_instances())
    except Exception as exc:  # noqa: BLE001 — offline is a skip
        pytest.skip(f"subset unavailable offline: {exc}")
    ids = [i.instance_id for i in insts]
    assert variance.select_probe_instances(ids) == EXPECTED_PROBE


# ── flip detection / rate ──────────────────────────────────────────────────


def test_instance_flipped():
    assert variance.instance_flipped([True, True, True]) is False     # 3/3
    assert variance.instance_flipped([False, False, False]) is False  # 0/3
    assert variance.instance_flipped([True, True, False]) is True     # 2/3
    assert variance.instance_flipped([True, False, False]) is True    # 1/3


def test_flip_rate_basic():
    verdicts = {
        "a": [True, True, True],     # stable
        "b": [False, False, False],  # stable
        "c": [True, True, False],    # flip
        "d": [False, True, False],   # flip
    }
    assert variance.flip_rate(verdicts) == 0.5


def test_flip_rate_empty_is_zero():
    assert variance.flip_rate({}) == 0.0


def test_flip_rate_all_stable_is_zero():
    assert variance.flip_rate({"a": [True] * 3, "b": [False] * 3}) == 0.0


# ── per-arm summary + band ─────────────────────────────────────────────────


def test_summarize_arm_band_derivation():
    # 2 of 10 flip -> flip_rate 0.2 -> band 20.0 pp; over full 40 -> 8 instances.
    verdicts = {f"i{n}": [True, True, True] for n in range(8)}
    verdicts["i8"] = [True, True, False]
    verdicts["i9"] = [False, True, False]
    rec = variance.summarize_arm("A", verdicts, full_size=40)
    assert rec.arm == "A"
    assert rec.n_instances == 10
    assert rec.n_flipped == 2
    assert rec.flip_rate == pytest.approx(0.2)
    assert rec.band_points == pytest.approx(20.0)
    assert rec.band_instances_full == 8
    # JSON-serializable for report.py, and carries the non-CI provenance.
    d = json.loads(json.dumps(rec.to_dict()))
    assert d["band_points"] == 20.0
    assert d["band_method"] == "flip-rate-projection"  # report.py must not call it a CI


def test_summarize_arm_requires_arm():
    with pytest.raises(ValueError):
        variance.summarize_arm("", {"a": [True, True, True]})


def test_summarize_arm_warns_when_n_reps_below_two():
    # A single rep can never flip, so flip_rate is a vacuous 0.0 that report.py
    # would render as a deceptively clean band. summarize_arm must warn.
    with pytest.warns(RuntimeWarning, match="n_reps=1 < 2"):
        rec = variance.summarize_arm("A", {"a": [True]}, n_reps=1)
    assert rec.flip_rate == 0.0


def test_summarize_arm_no_warning_at_two_reps(recwarn):
    variance.summarize_arm("A", {"a": [True, False]}, n_reps=2)
    assert not [w for w in recwarn.list if "n_reps" in str(w.message)]


# ── probe orchestration (injectable run_and_score seam) ────────────────────


def test_run_probe_with_fake_seam():
    # Deterministic fake: instance "flipper" yields [T, F, T] across 3 reps
    # (resolves on even reps) -> a flip; others always resolve (stable).
    instances = ["stable-1", "flipper", "stable-2"]

    def fake_run_and_score(arm, iid, rep):
        if iid == "flipper":
            return rep % 2 == 0   # reps 0,1,2 -> [True, False, True] -> flip
        return True               # stable

    records = variance.run_probe(["A", "B"], instances, fake_run_and_score, reps=3)
    assert set(records) == {"A", "B"}
    for rec in records.values():
        assert rec.n_instances == 3
        assert rec.n_flipped == 1
        assert rec.flip_rate == pytest.approx(1 / 3)


def test_run_probe_runs_every_arm_instance_rep():
    calls = []

    def counting(arm, iid, rep):
        calls.append((arm, iid, rep))
        return True

    variance.run_probe(["A", "B", "C"], ["i1", "i2"], counting, reps=3)
    # 3 arms × 2 instances × 3 reps = 18 invocations.
    assert len(calls) == 18
    assert len(set(calls)) == 18  # each (arm,instance,rep) exactly once


def test_write_flip_rates(tmp_path):
    records = variance.run_probe(
        ["A"], ["i1"], lambda a, i, r: True, reps=3
    )
    out = tmp_path / "variance.json"
    variance.write_flip_rates(out, records)
    payload = json.loads(out.read_text())
    assert payload["A"]["flip_rate"] == 0.0
    assert payload["A"]["n_reps"] == 3
