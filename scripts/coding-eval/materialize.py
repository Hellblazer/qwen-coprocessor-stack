# SPDX-License-Identifier: MIT
"""Per-instance throwaway worktree materialization (RDR-006 40v.2).

Each eval instance runs in its own throwaway git worktree checked out at the
instance's ``base_commit``. To avoid re-cloning a repo once per instance (Lite
has 15 django instances in the subset), we keep one *bare mirror* per repo under
``work/.cache`` and add a detached worktree per instance off that mirror.

Layout (all under ``scripts/coding-eval/``, gitignored):
  work/.cache/<owner>__<name>.git   # bare mirror, shared across instances
  work/<instance_id>/               # throwaway worktree at base_commit

``work/`` is gitignored and safe to delete wholesale; ``cleanup`` removes a
single worktree and prunes the mirror's worktree registry.

The git invocations go through an injectable ``runner`` so the network clone can
be isolated in tests; the worktree mechanics are exercised against a local bare
repo with no network.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
from collections.abc import Callable, Sequence
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK_ROOT = HERE / "work"
CACHE_ROOT = WORK_ROOT / ".cache"

# A runner takes an argv and an optional cwd and runs it, raising on failure.
Runner = Callable[[Sequence[str], "Path | None"], None]

# Per-mirror lock so the agent-concurrency pool (orchestrate P0) can run instances
# of DIFFERENT repos in parallel while the git operations that mutate ONE mirror's
# shared worktree registry / refs (fetch, worktree add/remove/prune) are
# serialized — concurrent `git worktree add` on the same mirror otherwise races on
# git's internal locks. RLock so a function holding the lock can call a helper
# that re-acquires it (e.g. materialize_from_mirror -> _remove_worktree). The lock
# is held only during git subprocesses, never during the agent run.
_MIRROR_LOCKS: dict[str, threading.RLock] = {}
_MIRROR_LOCKS_GUARD = threading.Lock()


def _mirror_lock(mirror: Path) -> threading.RLock:
    key = str(mirror)
    with _MIRROR_LOCKS_GUARD:
        lk = _MIRROR_LOCKS.get(key)
        if lk is None:
            lk = threading.RLock()
            _MIRROR_LOCKS[key] = lk
        return lk


def _run(cmd: Sequence[str], cwd: "Path | None" = None) -> None:
    subprocess.run(list(cmd), cwd=str(cwd) if cwd else None, check=True)


def repo_url(repo: str) -> str:
    """GitHub clone URL for a ``owner/name`` slug."""
    return f"https://github.com/{repo}.git"


def mirror_path(repo: str, cache_root: Path = CACHE_ROOT) -> Path:
    """Path to the bare mirror for ``repo`` under ``cache_root``."""
    return cache_root / (repo.replace("/", "__") + ".git")


def worktree_path(instance_id: str, work_root: Path = WORK_ROOT) -> Path:
    """Path to the throwaway worktree for ``instance_id``."""
    return work_root / instance_id


def ensure_mirror(
    repo: str,
    cache_root: Path = CACHE_ROOT,
    runner: Runner = _run,
) -> Path:
    """Ensure a bare mirror of ``repo`` exists and is up to date.

    Clones ``--bare`` on first use; otherwise fetches. Returns the mirror path.
    """
    mirror = mirror_path(repo, cache_root)
    # Hold the per-mirror lock across the WHOLE check-and-clone: under the P0
    # agent-concurrency pool the threads share one PID, so several instances of
    # the same repo would otherwise race to first-clone it. Serializing per
    # mirror means the first thread clones and the rest see it exists and fetch.
    # Cross-repo first-clones still run in parallel (distinct mirror locks).
    with _mirror_lock(mirror):
        if mirror.exists():
            runner(["git", "-C", str(mirror), "fetch", "--all", "--quiet"], None)
            return mirror
        cache_root.mkdir(parents=True, exist_ok=True)
        # Clone into a unique temp dir, then atomically rename into place. The
        # tmp name includes the THREAD id (not just the pid) so it is unique even
        # across threads of one process; os.replace makes the publish atomic, and
        # losing the race falls back to fetch. Belt-and-suspenders alongside the
        # lock above (covers a caller that bypasses ensure via the injectable
        # seam).
        tmp = cache_root / f"{mirror.name}.tmp.{os.getpid()}.{threading.get_ident()}"
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        runner(["git", "clone", "--bare", "--quiet", repo_url(repo), str(tmp)], None)
        try:
            os.replace(tmp, mirror)
        except OSError:
            # Lost the race — another worker materialized the mirror first.
            shutil.rmtree(tmp, ignore_errors=True)
            runner(["git", "-C", str(mirror), "fetch", "--all", "--quiet"], None)
    return mirror


def materialize_from_mirror(
    mirror: Path,
    instance_id: str,
    base_commit: str,
    work_root: Path = WORK_ROOT,
    runner: Runner = _run,
) -> Path:
    """Add a detached worktree at ``base_commit`` off an existing mirror.

    Offline: operates purely on the local mirror. Idempotent — an existing
    worktree at the destination is removed first so re-runs are clean.
    """
    dest = worktree_path(instance_id, work_root)
    with _mirror_lock(mirror):
        if dest.exists():
            _remove_worktree(mirror, dest, runner)
        work_root.mkdir(parents=True, exist_ok=True)
        runner(
            ["git", "-C", str(mirror), "worktree", "add", "--detach",
             "--force", str(dest), base_commit],
            None,
        )
    return dest


def materialize(
    instance_id: str,
    repo: str,
    base_commit: str,
    work_root: Path = WORK_ROOT,
    cache_root: Path = CACHE_ROOT,
    runner: Runner = _run,
    ensure: "Callable[..., Path]" = ensure_mirror,
) -> Path:
    """Full path: ensure the mirror (may clone) then add the worktree.

    ``ensure`` is injectable so tests can supply a pre-built local mirror and
    skip the network clone.
    """
    mirror = ensure(repo, cache_root, runner)
    return materialize_from_mirror(mirror, instance_id, base_commit, work_root, runner)


def _remove_worktree(mirror: Path, dest: Path, runner: Runner) -> None:
    """Remove a worktree via git, falling back to rmtree, then prune.

    Serialized per mirror (RLock) so concurrent cleanups don't race on the
    worktree registry."""
    with _mirror_lock(mirror):
        try:
            runner(
                ["git", "-C", str(mirror), "worktree", "remove", "--force", str(dest)],
                None,
            )
        except subprocess.CalledProcessError:
            # The worktree dir may exist without being registered (partial run).
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)
        runner(["git", "-C", str(mirror), "worktree", "prune"], None)


def cleanup(
    instance_id: str,
    repo: str,
    work_root: Path = WORK_ROOT,
    cache_root: Path = CACHE_ROOT,
    runner: Runner = _run,
) -> None:
    """Remove a single instance's throwaway worktree (mirror is kept)."""
    mirror = mirror_path(repo, cache_root)
    dest = worktree_path(instance_id, work_root)
    if mirror.exists():
        _remove_worktree(mirror, dest, runner)
    elif dest.exists():
        shutil.rmtree(dest, ignore_errors=True)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Materialize a per-instance worktree")
    ap.add_argument("instance_id")
    ap.add_argument("repo", help="owner/name slug")
    ap.add_argument("base_commit")
    ap.add_argument("--cleanup", action="store_true", help="remove instead of create")
    args = ap.parse_args()

    if args.cleanup:
        cleanup(args.instance_id, args.repo)
        print(f"removed {worktree_path(args.instance_id)}")
    else:
        path = materialize(args.instance_id, args.repo, args.base_commit)
        print(path)


if __name__ == "__main__":
    main()
