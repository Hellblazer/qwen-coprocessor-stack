# SPDX-License-Identifier: MIT
"""Tests for report.py (RDR-006 40v.9). Focus: the two gate-flagged invariants
— inconclusive-zone rule ENFORCED, and resolved/empty-patch/clean-apply as
SEPARATE counters."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import report  # noqa: E402


def _tele(instance_id, *, outcome="completed", added=1, removed=0, files=1,
          contamination=False, finish_reason="success", tokens_total=None,
          cost_usd=0.0):
    return {
        "instance_id": instance_id,
        "arm": "X",
        "outcome": outcome,
        "diff_added": added,
        "diff_removed": removed,
        "diff_files": files,
        "test_edit_contamination": contamination,
        "finish_reason": finish_reason,
        "tokens_total": tokens_total,
        "cost_usd": cost_usd,
    }


def _score(resolved_ids, total, raw):
    return {"resolved_ids": list(resolved_ids), "total": total, "raw": raw}


# ── inconclusive-zone rule (MANDATE) ───────────────────────────────────────


def test_delta_inside_zone_is_not_detectable():
    for da, db in [(5, 5), (5, 7), (7, 5), (6, 4)]:  # |Δ| in {0,2}
        v = report.classify_delta("A", da, "B", db)
        assert v.detectable is False
        assert "not detectable" in v.statement
        # No direction word leaks for a non-detectable delta.
        assert "resolves more than" not in v.statement


def test_delta_outside_zone_reports_direction():
    v = report.classify_delta("A", 10, "B", 5)  # Δ=5 > 2
    assert v.detectable is True
    assert "A resolves more than B" in v.statement

    v2 = report.classify_delta("A", 3, "B", 9)  # Δ=-6
    assert v2.detectable is True
    assert "B resolves more than A" in v2.statement


def test_delta_boundary_exactly_zone_and_just_outside():
    assert report.classify_delta("A", 5, "B", 3).detectable is False  # Δ=2 == zone
    assert report.classify_delta("A", 6, "B", 3).detectable is True   # Δ=3 > zone


# ── separate counters (MANDATE) ────────────────────────────────────────────


def test_resolved_empty_cleanapply_are_distinct_no_doublecount():
    # 4 instances: one resolved+applied, one non-empty-applied-unresolved,
    # one non-empty-FAILED-apply, one empty-patch.
    raw = {
        "r": {"patch_exists": True, "patch_successfully_applied": True, "resolved": True},
        "a": {"patch_exists": True, "patch_successfully_applied": True, "resolved": False},
        "f": {"patch_exists": True, "patch_successfully_applied": False, "resolved": False},
        "e": {"patch_is_None": True, "patch_exists": False, "resolved": False},
    }
    tele = [
        _tele("r", files=1, added=2),
        _tele("a", files=1, added=1),
        _tele("f", files=1, added=3),
        _tele("e", files=0, added=0, removed=0),  # empty
    ]
    card = report.build_scorecard(
        report.ArmInputs("X", _score(["r"], 4, raw), tele)
    )
    assert card.resolved == 1
    assert card.empty_patch == 1
    assert card.non_empty == 3          # r, a, f (NOT e)
    assert card.clean_apply == 2        # r, a applied; f failed
    assert card.clean_apply_failures == 1
    # No double-count: empty + non_empty == total instances.
    assert card.empty_patch + card.non_empty == 4
    # An empty patch is NOT counted as an apply failure.
    assert card.clean_apply_failures == 1  # only 'f', not 'e'
    # clean_apply_fail is also a first-class taxonomy class (same value).
    assert card.taxonomy["clean_apply_fail"] == 1


def test_clean_apply_rate_is_over_non_empty_only():
    raw = {
        "a": {"patch_successfully_applied": True},
        "e": {"patch_exists": False},
    }
    tele = [_tele("a", files=1), _tele("e", files=0, added=0, removed=0)]
    card = report.build_scorecard(report.ArmInputs("X", _score([], 2, raw), tele))
    # 1 non-empty, applied -> 100%, NOT 50% (empty excluded from denominator).
    assert card.clean_apply_rate == 100.0


# ── taxonomy ───────────────────────────────────────────────────────────────


def test_taxonomy_counts_outcomes_and_classes():
    tele = [
        _tele("a", outcome="timeout"),
        _tele("b", outcome="turn_limit"),
        _tele("c", outcome="error"),
        _tele("d", outcome="completed", contamination=True),
        _tele("e", outcome="completed", files=0, added=0, removed=0),  # empty
        _tele("f", outcome="completed", finish_reason="length"),       # starvation
    ]
    tax = report.build_taxonomy(tele)
    assert tax["timeout"] == 1
    assert tax["turn_limit"] == 1
    assert tax["error"] == 1
    assert tax["test_edit_contamination"] == 1
    assert tax["empty_patch"] == 1
    assert tax["reasoning_starvation"] == 1


# ── N/A handling + band ────────────────────────────────────────────────────


def test_band_none_when_no_variance_record():
    card = report.build_scorecard(
        report.ArmInputs("X", _score([], 1, {}), [_tele("a")], flip=None)
    )
    assert card.band_points is None


def test_band_echoes_method_not_ci():
    flip = {"band_points": 20.0, "band_method": "flip-rate-projection"}
    card = report.build_scorecard(
        report.ArmInputs("X", _score([], 1, {}), [_tele("a")], flip=flip)
    )
    assert card.band_points == 20.0
    assert card.band_method == "flip-rate-projection"


# ── end-to-end render ──────────────────────────────────────────────────────


def test_build_report_renders_all_sections_and_na():
    arms = [
        report.ArmInputs(
            "A",
            _score(["r"], 2, {"r": {"patch_successfully_applied": True}}),
            [_tele("r", files=1), _tele("e", files=0, added=0, removed=0)],
            flip={"band_points": 10.0, "band_method": "flip-rate-projection"},
            tool_set="qwen core (nx disabled via supervisor)",
        ),
        report.ArmInputs(
            "B",
            _score([], 2, {}),
            [_tele("x", tokens_total=None)],  # N/A tokens
            flip={"band_points": 5.0, "band_method": "flip-rate-projection"},
            tool_set="qwen core (nx disabled via HOME fixture)",
        ),
    ]
    cards, deltas, md = report.build_report(arms)
    assert len(cards) == 2
    assert len(deltas) == 1  # one pair
    # All required sections present.
    for section in ["Headline", "Pairwise deltas", "Patch accounting",
                    "Failure taxonomy", "Reproducibility"]:
        assert section in md
    # Inconclusive-zone wording present (A=1 vs B=0 -> Δ=1 <= 2).
    assert "not detectable" in md
    # Band rendered with the not-a-CI provenance.
    assert "not a CI" in md
    # Arm B's unavailable token counter renders N/A (never fabricated to 0).
    assert "Cost & tokens" in md
    assert "N/A" in md
    # Reproducibility cites the pinned snapshot.
    import subset
    assert subset.SNAPSHOT_REVISION in md


def test_build_report_rejects_nondistinct_tool_sets():
    import pytest

    arms = [
        report.ArmInputs("A", _score([], 1, {}), [_tele("a")], tool_set="same"),
        report.ArmInputs("B", _score([], 1, {}), [_tele("b")], tool_set="same"),
    ]
    with pytest.raises(ValueError):
        report.build_report(arms)
