# SPDX-License-Identifier: MIT
"""Tests for per-instance worktree materialization (RDR-006 40v.2).

Worktree mechanics are exercised against a real *local* bare repo built in a
tmp dir — no network. The network clone path (``ensure_mirror`` on first use)
is verified by command construction with an injected runner.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from materialize import (  # noqa: E402
    cleanup,
    ensure_mirror,
    materialize,
    materialize_from_mirror,
    mirror_path,
    repo_url,
    worktree_path,
)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True,
                   capture_output=True, text=True)


@pytest.fixture
def local_mirror(tmp_path) -> tuple[Path, str, str]:
    """Build a small real repo, return (bare_mirror_path, commit1, commit2)."""
    src = tmp_path / "src"
    src.mkdir()
    _git(["init", "-q"], src)
    _git(["config", "user.email", "t@t.t"], src)
    _git(["config", "user.name", "t"], src)
    (src / "a.txt").write_text("v1\n")
    _git(["add", "."], src)
    _git(["commit", "-q", "-m", "c1"], src)
    c1 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(src),
                        capture_output=True, text=True, check=True).stdout.strip()
    (src / "a.txt").write_text("v2\n")
    _git(["commit", "-aqm", "c2"], src)
    c2 = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(src),
                        capture_output=True, text=True, check=True).stdout.strip()

    mirror = tmp_path / "cache" / "owner__name.git"
    mirror.parent.mkdir(parents=True)
    _git(["clone", "--bare", "-q", str(src), str(mirror)], tmp_path)
    return mirror, c1, c2


# ── path helpers ─────────────────────────────────────────────────────────


def test_repo_url():
    assert repo_url("django/django") == "https://github.com/django/django.git"


def test_mirror_and_worktree_paths(tmp_path):
    assert mirror_path("a/b", tmp_path).name == "a__b.git"
    assert worktree_path("a__b-1", tmp_path) == tmp_path / "a__b-1"


# ── worktree mechanics (offline, real git) ───────────────────────────────


def test_materialize_checks_out_base_commit(local_mirror, tmp_path):
    mirror, c1, _c2 = local_mirror
    work = tmp_path / "work"
    dest = materialize_from_mirror(mirror, "owner__name-1", c1, work_root=work)

    assert dest.exists()
    assert (dest / "a.txt").read_text() == "v1\n"  # checked out at c1, not HEAD
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(dest),
                          capture_output=True, text=True, check=True).stdout.strip()
    assert head == c1


def test_materialize_is_idempotent(local_mirror, tmp_path):
    mirror, c1, c2 = local_mirror
    work = tmp_path / "work"
    materialize_from_mirror(mirror, "inst-1", c1, work_root=work)
    # Re-materialize the same instance at a different commit — must not error.
    dest = materialize_from_mirror(mirror, "inst-1", c2, work_root=work)
    assert (dest / "a.txt").read_text() == "v2\n"


def test_cleanup_removes_worktree(local_mirror, tmp_path):
    mirror, c1, _c2 = local_mirror
    work = tmp_path / "work"
    cache = mirror.parent
    dest = materialize_from_mirror(mirror, "inst-1", c1, work_root=work)
    assert dest.exists()

    cleanup("inst-1", "owner/name", work_root=work, cache_root=cache)
    assert not dest.exists()
    # Mirror survives cleanup (shared across instances).
    assert mirror.exists()


def test_cleanup_is_safe_when_absent(local_mirror, tmp_path):
    mirror, _c1, _c2 = local_mirror
    cache = mirror.parent
    # No worktree created — cleanup must be a no-op, not an error.
    cleanup("never-made", "owner/name", work_root=tmp_path / "work", cache_root=cache)


def test_two_instances_share_one_mirror(local_mirror, tmp_path):
    mirror, c1, c2 = local_mirror
    work = tmp_path / "work"
    d1 = materialize_from_mirror(mirror, "inst-1", c1, work_root=work)
    d2 = materialize_from_mirror(mirror, "inst-2", c2, work_root=work)
    assert d1.exists() and d2.exists()
    assert (d1 / "a.txt").read_text() == "v1\n"
    assert (d2 / "a.txt").read_text() == "v2\n"


# ── network clone path (command construction, no network) ────────────────


def test_ensure_mirror_clones_when_absent(tmp_path):
    calls: list[list[str]] = []

    def fake_runner(cmd, cwd=None):
        calls.append(list(cmd))
        if "clone" in cmd:
            Path(cmd[-1]).mkdir(parents=True, exist_ok=True)  # simulate clone output

    cache = tmp_path / "cache"
    got = ensure_mirror("django/django", cache_root=cache, runner=fake_runner)

    assert got == mirror_path("django/django", cache)
    assert got.exists()  # temp clone atomically renamed into place
    assert len(calls) == 1
    assert calls[0][:3] == ["git", "clone", "--bare"]
    assert repo_url("django/django") in calls[0]
    # The clone targets a temp path, not the final mirror, for atomic install.
    assert calls[0][-1] != str(got)


def test_ensure_mirror_race_lost_falls_back_to_fetch(tmp_path):
    # Simulate losing the cold-start race: another worker populates the final
    # mirror while ours is mid-clone. os.replace onto the now-populated dir
    # fails, and we must fall back to fetch rather than error.
    cache = tmp_path / "cache"
    final = mirror_path("a/b", cache)
    calls: list[list[str]] = []

    def fake_runner(cmd, cwd=None):
        calls.append(list(cmd))
        if "clone" in cmd:
            Path(cmd[-1]).mkdir(parents=True, exist_ok=True)  # our temp clone
            # Another worker finishes first: populate the non-empty final dir.
            final.mkdir(parents=True, exist_ok=True)
            (final / "HEAD").write_text("ref: refs/heads/main\n")

    got = ensure_mirror("a/b", cache_root=cache, runner=fake_runner)
    assert got == final
    ops = [c for c in calls]
    assert any("clone" in c for c in ops)
    assert any("fetch" in c for c in ops)  # fell back to fetch after lost race


def test_ensure_mirror_fetches_when_present(tmp_path):
    cache = tmp_path / "cache"
    mirror = mirror_path("a/b", cache)
    mirror.mkdir(parents=True)  # pretend it already exists
    calls: list[list[str]] = []

    ensure_mirror("a/b", cache_root=cache, runner=lambda cmd, cwd=None: calls.append(list(cmd)))

    assert len(calls) == 1
    assert "fetch" in calls[0]
    assert "clone" not in " ".join(calls[0])


def test_materialize_injects_ensure(local_mirror, tmp_path):
    # The full materialize() uses the injected ensure to skip the network and
    # then performs real worktree mechanics off the local mirror.
    mirror, c1, _c2 = local_mirror
    work = tmp_path / "work"

    def fake_ensure(repo, cache_root, runner):
        return mirror

    dest = materialize("inst-1", "owner/name", c1, work_root=work,
                       cache_root=mirror.parent, ensure=fake_ensure)
    assert (dest / "a.txt").read_text() == "v1\n"


# ── per-mirror lock: agent-concurrency safety (P0) ───────────────────────────

import threading  # noqa: E402
import time  # noqa: E402

import materialize as _m  # noqa: E402


def test_mirror_lock_is_per_path():
    a1 = _m._mirror_lock(Path("/x/a.git"))
    a2 = _m._mirror_lock(Path("/x/a.git"))
    b = _m._mirror_lock(Path("/x/b.git"))
    assert a1 is a2 and a1 is not b


def _overlap_probe():
    state = {"active": 0, "max": 0}
    lk = threading.Lock()

    def runner(cmd, cwd=None):
        # Only the worktree-add command holds the mirror lock in the impl.
        if "add" in cmd:
            with lk:
                state["active"] += 1
                state["max"] = max(state["max"], state["active"])
            time.sleep(0.05)
            with lk:
                state["active"] -= 1

    return state, runner


def test_materialize_from_mirror_serializes_same_mirror(tmp_path):
    # Two concurrent adds on the SAME mirror must NOT overlap (lock serializes).
    state, runner = _overlap_probe()
    mirror = tmp_path / "repo.git"

    def work(iid):
        materialize_from_mirror(mirror, iid, "HEAD", work_root=tmp_path / "wt", runner=runner)

    ts = [threading.Thread(target=work, args=(f"i{n}",)) for n in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert state["max"] == 1, "same-mirror worktree adds overlapped (race risk)"


def test_materialize_from_mirror_allows_cross_mirror_parallelism(tmp_path):
    # Adds on DIFFERENT mirrors may overlap (cross-repo concurrency preserved).
    state, runner = _overlap_probe()

    def work(repo_n):
        materialize_from_mirror(tmp_path / f"repo{repo_n}.git", "i", "HEAD",
                                work_root=tmp_path / f"wt{repo_n}", runner=runner)

    ts = [threading.Thread(target=work, args=(n,)) for n in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert state["max"] >= 2, "cross-mirror adds were needlessly serialized"


def test_ensure_mirror_concurrent_first_clone_no_tmp_collision(tmp_path):
    # Two threads cold-cloning the SAME repo (shared pid) must not collide on the
    # tmp clone dir or corrupt each other: the per-mirror lock serializes so
    # exactly ONE clone runs and the rest fetch the now-existing mirror.
    cache = tmp_path / "cache"
    clones = []
    fetches = []
    lk = threading.Lock()

    def runner(cmd, cwd=None):
        if "clone" in cmd:
            dest = Path(cmd[-1])
            with lk:
                clones.append(dest)
            time.sleep(0.05)
            dest.mkdir(parents=True, exist_ok=True)  # simulate a populated bare repo
            (dest / "HEAD").write_text("ref: refs/heads/main\n")
        elif "fetch" in cmd:
            with lk:
                fetches.append(tuple(cmd))

    threads = [threading.Thread(target=ensure_mirror, args=("psf/requests", cache, runner))
               for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Exactly one real clone happened; the other three saw the mirror and fetched.
    assert len(clones) == 1, f"expected 1 clone, got {len(clones)} (tmp race)"
    assert len(fetches) == 3
    assert mirror_path("psf/requests", cache).exists()
