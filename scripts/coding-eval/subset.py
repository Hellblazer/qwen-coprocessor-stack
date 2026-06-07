# SPDX-License-Identifier: MIT
"""Deterministic SWE-bench Lite subset selection (RDR-006 40v.2).

The subset is a *pure function* of a pinned dataset snapshot. Given the same
``princeton-nlp/SWE-bench_Lite`` revision, ``select_subset`` always returns the
identical 40 instances, in the same order. This reproducibility is load-bearing:
the eval report cites the snapshot hash so the numbers can be regenerated.

Selection intent — **representative-Lite, not representative-easy**. Instances
are drawn *proportionally by repo weight* in Lite using the largest-remainder
(Hamilton) method, so heavyweight repos (django, sympy) carry their real share
and the subset is not biased toward lightweight pure-Python repos (requests,
flask). Within each repo the allocated instances are chosen by a seeded RNG over
the instance_ids sorted lexicographically; the final list is sorted by
instance_id.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from dataclasses import dataclass

# ── Pinned snapshot. Bump deliberately; the determinism test will flag drift. ──
DATASET = "princeton-nlp/SWE-bench_Lite"
SPLIT = "test"
# Resolved 2026-06-07 via huggingface_hub.HfApi().dataset_info(...).sha
SNAPSHOT_REVISION = "6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2"

SUBSET_SIZE = 40
MIN_REPOS = 3
# Fixed seed for the within-repo selection. Arbitrary but pinned.
SEED = 20260606


@dataclass(frozen=True)
class Instance:
    """The fields the eval harness needs from a Lite row."""

    instance_id: str
    repo: str
    base_commit: str

    @classmethod
    def from_row(cls, row: dict) -> "Instance":
        return cls(
            instance_id=row["instance_id"],
            repo=row["repo"],
            base_commit=row["base_commit"],
        )


def _rank(seed: int, instance_id: str) -> str:
    """Version-stable seeded rank key for an instance_id."""
    return hashlib.sha256(f"{seed}:{instance_id}".encode()).hexdigest()


def allocate(repo_counts: dict[str, int], size: int) -> dict[str, int]:
    """Proportional allocation of ``size`` slots across repos by weight.

    Largest-remainder (Hamilton) method: floor each repo's exact share, then
    hand out the leftover slots to the largest fractional remainders. Ties in
    the remainder are broken by repo name ascending, so the result is a pure
    function of ``repo_counts`` and ``size`` with no RNG.
    """
    total = sum(repo_counts.values())
    if total == 0:
        return {}
    if size > total:
        raise ValueError(f"requested {size} > available {total}")

    exact = {repo: size * n / total for repo, n in repo_counts.items()}
    floors = {repo: int(v) for repo, v in exact.items()}
    remaining = size - sum(floors.values())

    # Order leftover recipients by (descending remainder, ascending repo name).
    remainders = sorted(
        repo_counts,
        key=lambda repo: (-(exact[repo] - floors[repo]), repo),
    )
    alloc = dict(floors)
    for repo in remainders[:remaining]:
        alloc[repo] += 1
    return alloc


def select_subset(
    instances: list[Instance],
    size: int = SUBSET_SIZE,
    seed: int = SEED,
    min_repos: int = MIN_REPOS,
) -> list[Instance]:
    """Select ``size`` instances, proportional by repo, deterministically.

    Returns the chosen instances sorted by ``instance_id``. Pure function of
    ``(instances, size, seed)``.
    """
    repo_counts = Counter(inst.repo for inst in instances)
    alloc = allocate(dict(repo_counts), size)

    by_repo: dict[str, list[Instance]] = {}
    for inst in instances:
        by_repo.setdefault(inst.repo, []).append(inst)

    chosen: list[Instance] = []
    for repo in sorted(by_repo):
        k = alloc.get(repo, 0)
        if k == 0:
            continue
        # Stable seeded ranking: sha256("<seed>:<instance_id>"). Deterministic
        # across Python versions and platforms — unlike random.sample, whose
        # internal pool-vs-set algorithm has version-sensitive branches that
        # would silently shift the subset between interpreters. Tie-break by
        # instance_id (sha256 collisions are not a practical concern).
        pool = sorted(
            by_repo[repo],
            key=lambda inst: (_rank(seed, inst.instance_id), inst.instance_id),
        )
        chosen.extend(pool[:k])

    represented = {inst.repo for inst in chosen}
    if len(represented) < min_repos:
        raise ValueError(
            f"subset represents {len(represented)} repos, need >= {min_repos}"
        )
    if len(chosen) != size:
        raise ValueError(f"selected {len(chosen)} != requested {size}")

    return sorted(chosen, key=lambda inst: inst.instance_id)


def load_instances(revision: str = SNAPSHOT_REVISION) -> list[Instance]:
    """Load Lite at the pinned revision. Requires network on first fetch."""
    from datasets import load_dataset

    ds = load_dataset(DATASET, split=SPLIT, revision=revision)
    return [Instance.from_row(row) for row in ds]


def load_full_rows(revision: str = SNAPSHOT_REVISION) -> dict[str, dict]:
    """Full dataset rows keyed by instance_id, at the pinned revision.

    The arm drivers need ``problem_statement`` (for the prompt) and
    ``test_patch`` (for ``gold_test_globs``) — fields the lightweight
    ``Instance`` does not carry. One shared loader so every arm reads the
    same pinned data. Requires network on first fetch (HF-cached after).
    """
    from datasets import load_dataset

    ds = load_dataset(DATASET, split=SPLIT, revision=revision)
    return {row["instance_id"]: dict(row) for row in ds}


def main() -> None:
    ap = argparse.ArgumentParser(description="SWE-bench Lite deterministic subset")
    ap.add_argument("--revision", default=SNAPSHOT_REVISION)
    ap.add_argument("--size", type=int, default=SUBSET_SIZE)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument(
        "--format",
        choices=["ids", "json"],
        default="ids",
        help="ids: one instance_id per line; json: full records + snapshot meta",
    )
    args = ap.parse_args()

    instances = load_instances(args.revision)
    subset = select_subset(instances, size=args.size, seed=args.seed)

    if args.format == "ids":
        for inst in subset:
            print(inst.instance_id)
    else:
        print(
            json.dumps(
                {
                    "dataset": DATASET,
                    "split": SPLIT,
                    "revision": args.revision,
                    "size": args.size,
                    "seed": args.seed,
                    "instances": [
                        {
                            "instance_id": inst.instance_id,
                            "repo": inst.repo,
                            "base_commit": inst.base_commit,
                        }
                        for inst in subset
                    ],
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
