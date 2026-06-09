# SPDX-License-Identifier: MIT
"""best-of-k with a no-cheat selector (RDR-006 40v.21).

A $0-at-the-margin coprocessor capability: run an agent k independent times on a
task and keep the best patch. The hard part is SELECTION — a local coprocessor
cannot peek at the hidden test, so it must pick via a proxy over the patches.

Empirically (40v findings):
  * self-report selection FAILS — a "write a reproduction + SELFCHECK" prompt
    regressed qwen (pass@3 2/3 -> 0/3) and its self-verdict had 0/2 precision.
  * best-of-k with the selector below lifted qwen pass@1 30% -> 40% on the 10
    flippy probe instances (ceiling 50%, recall 4/5).

HONEST mechanism note: the selector clusters attempts by touched-file set and
prefers the largest cluster ("consensus"/self-consistency), tie-broken by a
per-patch ``key`` (default: smaller diff). BUT on the measured data **9 of 10
instances had all attempts touch a single, identical file-set** — so clustering
was vacuous and the observed lift is attributable to the *tiebreak*
("smallest applying diff among k"), NOT to file consensus. File consensus only
discriminates on multi-file instances, which were rare here; whether it adds
signal there is UNVALIDATED. The smaller-diff tiebreak is itself a *hypothesis*
("a focused fix beats a sprawling one"), not a validated finding — it is exposed
as the injectable ``key`` so callers can ablate it (random, verifier score, etc.).
Caveats on the 30->40%: the probe set is enriched for borderline instances (not a
random sample), n=10 is below significance, and the lift is undecomposed.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from typing import Any

# A unified-diff file header: `diff --git a/<path> b/<path>`.
_FILE_HDR = re.compile(r"^diff --git a/(\S+) b/")


def touched_files(patch: str) -> frozenset[str]:
    """The set of source files a unified-diff patch changes (empty for no diff)."""
    return frozenset(
        m.group(1) for m in (_FILE_HDR.match(line) for line in patch.splitlines()) if m
    )


def is_nonempty(patch: str) -> bool:
    """True only for a patch with a real change — at least one ``@@`` hunk.

    Guards against degenerate inputs that ``patch.strip()`` alone would accept:
    a header-only diff (``diff --git`` + ``---``/``+++`` but no hunks) or
    arbitrary non-diff text. Either would otherwise pass an empty-check, join a
    cluster, and (being short) win the smaller-diff tiebreak — selecting a no-op
    over a real fix."""
    if not patch.strip():
        return False
    return any(line.startswith("@@") for line in patch.splitlines())


def select_consensus(
    patches: Sequence[str],
    *,
    key: Callable[[str], Any] = len,
) -> int:
    """Index of the best attempt: largest touched-file-set cluster, tie-broken by
    ``key`` (smaller is better; default ``len`` = smaller diff), then earliest.

    Rules, in order:
      1. Empty/degenerate patches (see ``is_nonempty``) are never selected when a
         real one exists.
      2. Cluster the real attempts by touched-file set; the LARGEST cluster wins
         (independent attempts converging on the same file(s) — the consensus
         signal). NOTE: when all attempts share one file-set (the common case
         observed), this step is a no-op and selection falls entirely to ``key``.
      3. Within the winning cluster pick the best by ``(key, index)``. Clusters
         are compared by ``(size, best-member key)`` using the SAME champion, so
         inter- and intra-cluster tiebreaks are consistent.
      4. If every attempt is empty, return 0.

    Returns an index into ``patches``. Raises ``ValueError`` on empty input.
    """
    if not patches:
        raise ValueError("select_consensus requires at least one patch")

    real = [i for i, p in enumerate(patches) if is_nonempty(p)]
    if not real:
        return 0

    clusters: dict[frozenset[str], list[int]] = {}
    for i in real:
        clusters.setdefault(touched_files(patches[i]), []).append(i)

    def champion(members: list[int]) -> int:
        return min(members, key=lambda i: (key(patches[i]), i))

    # Choose the cluster by (size, champion's key, champion index) — consistent
    # with the intra-cluster pick (its own champion), avoiding the asymmetry of
    # ranking a cluster by an outlier member it wouldn't ultimately select.
    best_key = max(
        clusters,
        key=lambda k: (
            len(clusters[k]),
            -key(patches[champion(clusters[k])]),
            -champion(clusters[k]),
        ),
    )
    return champion(clusters[best_key])


def cluster_report(patches: Sequence[str]) -> dict:
    """Observability for the consensus step: how much did attempts agree?

    Returns ``{n_real, n_distinct_filesets, max_cluster, vacuous}`` where
    ``vacuous`` is True when clustering did no discriminating work (<=1 distinct
    file-set among the real attempts) — i.e. selection reduced to the tiebreak."""
    real = [p for p in patches if is_nonempty(p)]
    fsets = [touched_files(p) for p in real]
    distinct = set(fsets)
    sizes = [fsets.count(f) for f in distinct]
    return {
        "n_real": len(real),
        "n_distinct_filesets": len(distinct),
        "max_cluster": max(sizes) if sizes else 0,
        "vacuous": len(distinct) <= 1,
    }


def run_best_of_k(
    attempt: Callable[[int], tuple[str, Any]],
    k: int,
    *,
    selector: Callable[[Sequence[str]], int] = select_consensus,
) -> dict:
    """Run ``attempt(i)`` for i in 0..k-1 and select the best by ``selector``.

    ``attempt(i)`` returns ``(patch, meta)`` — the caller wires it to an arm's
    per-instance run (each attempt is an independent agent invocation). Returns
    ``{selected_index, patch, meta, attempts, cluster_report}``: the chosen patch
    and its meta, the full attempts list (losers retained for audit / a better
    selector later), and the consensus diagnostics (so a degenerate/vacuous
    consensus is visible, not hidden behind the word "consensus")."""
    if k < 1:
        raise ValueError("k must be >= 1")
    results = [attempt(i) for i in range(k)]
    patches = [p for p, _ in results]
    idx = selector(patches)
    return {
        "selected_index": idx,
        "patch": patches[idx],
        "meta": results[idx][1],
        "attempts": results,
        "cluster_report": cluster_report(patches),
    }
