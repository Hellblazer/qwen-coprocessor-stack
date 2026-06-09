# SPDX-License-Identifier: MIT
"""Tests for bestofk.py (RDR-006 40v.21) — the consensus selector is the meat."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bestofk  # noqa: E402


def _diff(path: str, body: str = "+x\n") -> str:
    return f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n{body}"


# ── touched_files ────────────────────────────────────────────────────────────


def test_touched_files_parses_multiple():
    p = _diff("pkg/a.py") + _diff("pkg/b.py")
    assert bestofk.touched_files(p) == frozenset({"pkg/a.py", "pkg/b.py"})


def test_touched_files_empty_for_no_diff():
    assert bestofk.touched_files("") == frozenset()
    assert bestofk.touched_files("   \n") == frozenset()


# ── select_consensus ─────────────────────────────────────────────────────────


def test_consensus_picks_largest_same_file_cluster():
    # 2 attempts touch a.py, 1 touches b.py -> the 2-cluster wins.
    patches = [_diff("a.py", "+1\n"), _diff("b.py", "+2\n"), _diff("a.py", "+3\n")]
    idx = bestofk.select_consensus(patches)
    assert idx in (0, 2)                       # one of the a.py cluster
    assert bestofk.touched_files(patches[idx]) == frozenset({"a.py"})


def test_consensus_excludes_empty_patches():
    patches = ["", _diff("a.py"), ""]          # only index 1 is non-empty
    assert bestofk.select_consensus(patches) == 1


def test_consensus_all_empty_returns_zero():
    assert bestofk.select_consensus(["", "  ", "\n"]) == 0


def test_consensus_tiebreak_smaller_diff_then_earliest():
    # Same file, same cluster size (all singletons here are one cluster of 3);
    # tie-break the smaller diff, then earliest index.
    big = _diff("a.py", "+" + "x" * 100 + "\n")
    small = _diff("a.py", "+y\n")
    small2 = _diff("a.py", "+z\n")
    # cluster {a.py}=[0,1,2]; smallest among equal-length small/small2 -> earliest
    assert bestofk.select_consensus([big, small, small2]) == 1


def test_consensus_distinct_files_picks_smallest_singleton():
    # All different files -> all singleton clusters; pick the smallest diff.
    a = _diff("a.py", "+" + "x" * 50 + "\n")
    b = _diff("b.py", "+y\n")             # smallest
    c = _diff("c.py", "+" + "z" * 20 + "\n")
    assert bestofk.select_consensus([a, b, c]) == 1


def test_consensus_deterministic():
    patches = [_diff("a.py", "+1\n"), _diff("a.py", "+2\n"), _diff("b.py", "+3\n")]
    assert len({bestofk.select_consensus(patches) for _ in range(20)}) == 1


def test_consensus_empty_input_raises():
    with pytest.raises(ValueError):
        bestofk.select_consensus([])


def test_is_nonempty_rejects_header_only_and_nondiff():
    header_only = "diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n"  # no @@ hunk
    assert bestofk.is_nonempty(header_only) is False
    assert bestofk.is_nonempty("just some text\n") is False
    assert bestofk.is_nonempty(_diff("a.py")) is True


def test_consensus_skips_header_only_diff_for_real_patch():
    # A header-only diff (short, "touches" a.py) must NOT be selected over a real
    # patch — the bug the hunk-gate fixes.
    header_only = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n"
    real = _diff("b.py", "+realfix\n")
    assert bestofk.select_consensus([header_only, real]) == 1


def test_consensus_multifile_cluster_actually_discriminates():
    # 2 attempts touch {a,b}, 1 touches {a}: the larger {a,b} cluster wins even
    # though the {a} singleton has the smaller diff — clustering does real work.
    ab1 = _diff("a.py", "+1\n") + _diff("b.py", "+1\n")
    a_only = _diff("a.py", "+x\n")          # smaller, but minority file-set
    ab2 = _diff("a.py", "+2\n") + _diff("b.py", "+2\n")
    idx = bestofk.select_consensus([ab1, a_only, ab2])
    assert bestofk.touched_files([ab1, a_only, ab2][idx]) == frozenset({"a.py", "b.py"})


def test_consensus_injectable_key():
    # key = prefer LONGER diff (reverse of default) to prove the tiebreak is
    # swappable; all single-file so cluster is vacuous and key decides.
    big = _diff("a.py", "+" + "x" * 100 + "\n")
    small = _diff("a.py", "+y\n")
    assert bestofk.select_consensus([small, big], key=lambda p: -len(p)) == 1


def test_cluster_report_flags_vacuous():
    same = [_diff("a.py", "+1\n"), _diff("a.py", "+2\n")]
    rep = bestofk.cluster_report(same)
    assert rep["vacuous"] is True and rep["n_distinct_filesets"] == 1
    multi = [_diff("a.py"), _diff("b.py")]
    assert bestofk.cluster_report(multi)["vacuous"] is False


# ── run_best_of_k driver ─────────────────────────────────────────────────────


def test_run_best_of_k_runs_k_and_selects(capture=None):
    calls = []

    def attempt(i):
        calls.append(i)
        # attempt 0 + 2 touch a.py (consensus), attempt 1 touches b.py
        patch = _diff("a.py", f"+{i}\n") if i != 1 else _diff("b.py", "+1\n")
        return patch, {"i": i}

    out = bestofk.run_best_of_k(attempt, k=3)
    assert calls == [0, 1, 2]                  # ran exactly k attempts in order
    assert out["selected_index"] in (0, 2)     # consensus = a.py cluster
    assert bestofk.touched_files(out["patch"]) == frozenset({"a.py"})
    assert len(out["attempts"]) == 3           # losers retained for audit
    assert out["meta"] == {"i": out["selected_index"]}   # selected meta surfaced
    assert out["cluster_report"]["max_cluster"] == 2      # a.py cluster size


def test_run_best_of_k_injectable_selector():
    out = bestofk.run_best_of_k(
        lambda i: (_diff(f"f{i}.py"), None), k=3, selector=lambda patches: 2
    )
    assert out["selected_index"] == 2


def test_run_best_of_k_k_must_be_positive():
    with pytest.raises(ValueError):
        bestofk.run_best_of_k(lambda i: ("", None), k=0)


def test_run_best_of_k_all_empty_returns_first():
    out = bestofk.run_best_of_k(lambda i: ("", {"i": i}), k=3)
    assert out["selected_index"] == 0
    assert out["patch"] == ""
