# SPDX-License-Identifier: MIT
"""Tests for deterministic subset selection (RDR-006 40v.2).

Two layers:
  * Pure-function tests over synthetic instances — always run, no network.
    They pin the algorithm's contract: proportional-by-repo, exact size,
    min-repos, sorted, and call-to-call determinism.
  * A snapshot regression test that loads the REAL pinned Lite revision and
    asserts the exact 40 instance_ids. This is the load-bearing reproducibility
    guard; it skips (does not fail) when HuggingFace is unreachable so it can
    run offline, but pins the result whenever the data is available.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from subset import (  # noqa: E402
    SEED,
    SNAPSHOT_REVISION,
    SUBSET_SIZE,
    Instance,
    _rank,
    allocate,
    select_subset,
)

# The frozen expected subset at SNAPSHOT_REVISION
# (6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2). Regenerate deliberately with
# `python subset.py --format ids` only when the pinned revision is bumped.
EXPECTED_IDS = [
    "astropy__astropy-14995",
    "django__django-11283",
    "django__django-11620",
    "django__django-11815",
    "django__django-12747",
    "django__django-12908",
    "django__django-13158",
    "django__django-13321",
    "django__django-13933",
    "django__django-14017",
    "django__django-14411",
    "django__django-14997",
    "django__django-15388",
    "django__django-15902",
    "django__django-16041",
    "django__django-16527",
    "matplotlib__matplotlib-22711",
    "matplotlib__matplotlib-22835",
    "matplotlib__matplotlib-25498",
    "mwaskom__seaborn-3190",
    "psf__requests-2148",
    "pydata__xarray-4094",
    "pylint-dev__pylint-7228",
    "pytest-dev__pytest-11148",
    "pytest-dev__pytest-5413",
    "scikit-learn__scikit-learn-10297",
    "scikit-learn__scikit-learn-10949",
    "scikit-learn__scikit-learn-13496",
    "sphinx-doc__sphinx-7975",
    "sphinx-doc__sphinx-8273",
    "sympy__sympy-13177",
    "sympy__sympy-14817",
    "sympy__sympy-16106",
    "sympy__sympy-18698",
    "sympy__sympy-19254",
    "sympy__sympy-20442",
    "sympy__sympy-21379",
    "sympy__sympy-23117",
    "sympy__sympy-24152",
    "sympy__sympy-24213",
]

# Repo distribution of Lite at the pinned revision (300 instances, 12 repos).
LITE_REPO_COUNTS = {
    "django/django": 114,
    "sympy/sympy": 77,
    "matplotlib/matplotlib": 23,
    "scikit-learn/scikit-learn": 23,
    "pytest-dev/pytest": 17,
    "sphinx-doc/sphinx": 16,
    "astropy/astropy": 6,
    "psf/requests": 6,
    "pylint-dev/pylint": 6,
    "pydata/xarray": 5,
    "mwaskom/seaborn": 4,
    "pallets/flask": 3,
}


def _synthetic_instances(repo_counts: dict[str, int]) -> list[Instance]:
    """Build instances with deterministic, zero-padded instance_ids per repo."""
    out: list[Instance] = []
    for repo, n in repo_counts.items():
        slug = repo.replace("/", "__")
        for i in range(n):
            out.append(
                Instance(
                    instance_id=f"{slug}-{i:04d}",
                    repo=repo,
                    base_commit=f"{slug}{i:040d}"[:40],
                )
            )
    return out


# ── allocate() ───────────────────────────────────────────────────────────


def test_allocate_sums_to_size():
    alloc = allocate(LITE_REPO_COUNTS, SUBSET_SIZE)
    assert sum(alloc.values()) == SUBSET_SIZE


def test_allocate_is_proportional_largest_remainder():
    # Exact Hamilton allocation for Lite -> 40. Heavyweight repos carry their
    # real share (representative-Lite), flask (3/300) rounds to 0.
    alloc = allocate(LITE_REPO_COUNTS, SUBSET_SIZE)
    assert alloc == {
        "django/django": 15,
        "sympy/sympy": 10,
        "matplotlib/matplotlib": 3,
        "scikit-learn/scikit-learn": 3,
        "pytest-dev/pytest": 2,
        "sphinx-doc/sphinx": 2,
        "astropy/astropy": 1,
        "psf/requests": 1,
        "pylint-dev/pylint": 1,
        "pydata/xarray": 1,
        "mwaskom/seaborn": 1,
        "pallets/flask": 0,
    }


def test_allocate_not_biased_to_lightweight_repos():
    # Guard against representative-easy: django+sympy (the heavy repos) must
    # dominate, never under-weighted relative to requests/flask.
    alloc = allocate(LITE_REPO_COUNTS, SUBSET_SIZE)
    assert alloc["django/django"] > alloc["psf/requests"]
    assert alloc["sympy/sympy"] > alloc["pallets/flask"]
    assert alloc["django/django"] + alloc["sympy/sympy"] >= SUBSET_SIZE // 2


def test_allocate_tie_break_is_deterministic():
    # Three repos tie on remainder; allocation must be a pure function.
    counts = {"c/c": 1, "a/a": 1, "b/b": 1}
    assert allocate(counts, 2) == allocate(counts, 2)
    # With 2 slots over 3 equal repos, ties break by repo name ascending.
    alloc = allocate(counts, 2)
    assert alloc == {"a/a": 1, "b/b": 1, "c/c": 0}


def test_allocate_rejects_oversize():
    with pytest.raises(ValueError):
        allocate({"a/a": 5}, 6)


# ── select_subset() ──────────────────────────────────────────────────────


def test_select_subset_exact_size_and_sorted():
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    subset = select_subset(insts, size=SUBSET_SIZE, seed=SEED)
    assert len(subset) == SUBSET_SIZE
    ids = [i.instance_id for i in subset]
    assert ids == sorted(ids)


def test_select_subset_min_three_repos():
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    subset = select_subset(insts, size=SUBSET_SIZE, seed=SEED)
    assert len({i.repo for i in subset}) >= 3


def test_select_subset_respects_allocation():
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    subset = select_subset(insts, size=SUBSET_SIZE, seed=SEED)
    got = Counter(i.repo for i in subset)
    assert dict(got) == {
        r: k for r, k in allocate(LITE_REPO_COUNTS, SUBSET_SIZE).items() if k
    }


def test_select_subset_is_deterministic_across_calls():
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    a = [i.instance_id for i in select_subset(insts, size=SUBSET_SIZE, seed=SEED)]
    b = [i.instance_id for i in select_subset(insts, size=SUBSET_SIZE, seed=SEED)]
    assert a == b


def test_select_subset_independent_of_input_order():
    # Selection must be a function of the set, not the input ordering.
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    rev = list(reversed(insts))
    a = [i.instance_id for i in select_subset(insts, size=SUBSET_SIZE, seed=SEED)]
    b = [i.instance_id for i in select_subset(rev, size=SUBSET_SIZE, seed=SEED)]
    assert a == b


def test_rank_is_a_stable_known_hash():
    # Lock the ranking scheme: a fixed sha256 over "<seed>:<instance_id>".
    # This is the cross-Python-version-stable replacement for random.sample;
    # if the hashing scheme ever changes, the frozen subset would shift, so
    # pin a known value to make such a change loud.
    import hashlib

    expected = hashlib.sha256(b"20260606:django__django-11283").hexdigest()
    assert _rank(20260606, "django__django-11283") == expected


def test_select_subset_seed_changes_selection():
    insts = _synthetic_instances(LITE_REPO_COUNTS)
    a = [i.instance_id for i in select_subset(insts, size=SUBSET_SIZE, seed=SEED)]
    b = [i.instance_id for i in select_subset(insts, size=SUBSET_SIZE, seed=SEED + 1)]
    assert a != b


def test_select_subset_min_repos_enforced():
    # A degenerate single-repo input must raise rather than silently return.
    insts = _synthetic_instances({"only/repo": 50})
    with pytest.raises(ValueError):
        select_subset(insts, size=SUBSET_SIZE, seed=SEED, min_repos=3)


# ── Snapshot regression (real pinned data; skips when offline) ───────────


def test_real_snapshot_matches_frozen_ids():
    """The load-bearing reproducibility guard: the real pinned Lite revision
    must yield exactly EXPECTED_IDS. Skips (not fails) if HF is unreachable."""
    try:
        from subset import load_instances
    except ImportError as exc:
        pytest.skip(f"datasets not installed: {exc}")

    # ONLY connectivity / offline failures are a skip. A schema change, corrupt
    # cache, or data-integrity error must FAIL this guard, not silently hide a
    # reproducibility regression behind a skip (per review).
    skip_errors: tuple[type[BaseException], ...] = (OSError,)  # incl. ConnectionError
    try:
        from huggingface_hub.errors import (  # type: ignore
            HfHubHTTPError,
            LocalEntryNotFoundError,
        )

        skip_errors += (HfHubHTTPError, LocalEntryNotFoundError)
    except ImportError:
        pass

    try:
        instances = load_instances(SNAPSHOT_REVISION)
    except skip_errors as exc:
        pytest.skip(f"SWE-bench Lite snapshot unavailable offline: {exc}")

    subset = select_subset(instances, size=SUBSET_SIZE, seed=SEED)
    assert [i.instance_id for i in subset] == EXPECTED_IDS
