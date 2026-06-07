# SPDX-License-Identifier: MIT
"""Tests for Arm A — qwen via the MCP supervisor (RDR-006 40v.6).

Offline unit tests (ALWAYS run): inject a FAKE supervisor + a real local git
worktree fixture, and assert the load-bearing contract — qwen_spawn opts
(write_authority / cwd==worktree / extensions disabled), the poll loop reaching
a terminal state, the model_patch coming from git extraction (NOT the
supervisor), prediction keys, and that cwd routes to the per-instance worktree.

Integration test (SKIPPED unless the supervisor dist is built AND
qwentescence:1234 is reachable): drives the RAIL instances through the SPAWNED
supervisor and asserts a non-empty cleanly-applying source-only diff.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import arm_a  # noqa: E402
import run_arm  # noqa: E402


# ── local git worktree fixture (mirrors test_run_arm.py) ────────────────────


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True,
                   capture_output=True, text=True)


@pytest.fixture
def worktree(tmp_path) -> Path:
    """A repo with a source file + a generic test, committed at a base."""
    r = tmp_path / "repo"
    (r / "pkg").mkdir(parents=True)
    (r / "tests").mkdir()
    (r / "pkg" / "core.py").write_text("def f():\n    return 1\n")
    (r / "tests" / "test_core.py").write_text("def test_f():\n    assert True\n")
    _git(["init", "-q"], r)
    _git(["config", "user.email", "t@t.t"], r)
    _git(["config", "user.name", "t"], r)
    _git(["add", "."], r)
    _git(["commit", "-qm", "base"], r)
    return r


def _base_commit(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(repo),
        capture_output=True, text=True, check=True,
    ).stdout.strip()


# ── Fake supervisor seam ────────────────────────────────────────────────────


class FakeSupervisor:
    """Records the spawn call and walks a scripted state sequence on poll.

    On the turn it reports a terminal/idle state it OPTIONALLY edits the
    worktree (simulating the inner Qwen writing source) — but it NEVER supplies
    a patch; the driver must extract the patch from git itself.
    """

    def __init__(self, *, states, edit: "callable | None" = None,
                 turns: "int | None" = 2):
        self._states = list(states)
        self._edit = edit
        self._turns = turns  # turns_completed reported in last_known (None omits)
        self.spawn_calls: list[dict] = []
        self.send_calls: list[dict] = []
        self.stop_calls: list[str] = []
        self.closed = False
        self._poll_n = 0
        self._edited = False

    def spawn(self, task, opts):
        self.spawn_calls.append({"task": task, "opts": dict(opts)})
        return {"task_id": "fake-task-1", "chosen_backend": "fake-backend"}

    def poll(self, task_id, since=None):
        idx = min(self._poll_n, len(self._states) - 1)
        state = self._states[idx]
        self._poll_n += 1
        # Apply the worktree edit exactly once, as the run reaches terminal.
        if state in ("complete", "idle", "error") and self._edit and not self._edited:
            self._edit()
            self._edited = True
        return {
            "state": state,
            "recent_events": [],
            "more_events_available": False,
            "latest_event_id": f"ev-{self._poll_n}",
            "budget": {"est_tokens": 100, "max_tokens": 16384,
                       "tool_calls": 3, "max_tool_calls": 0},
            "last_known": ({"turns_completed": self._turns}
                           if self._turns is not None else {}),
        }

    def send(self, task_id, message):
        self.send_calls.append({"task_id": task_id, "message": message})
        return {"ack": True}

    def stop(self, task_id):
        self.stop_calls.append(task_id)
        return {"ack": True}

    def close(self):
        self.closed = True


def _rows_for(instance_id: str, worktree: Path) -> dict:
    """A minimal rows mapping; problem_statement/test_patch/repo/base_commit."""
    return {
        instance_id: {
            "repo": "psf/requests",
            "base_commit": _base_commit(worktree),
            "problem_statement": "fix the bug in f()",
            "test_patch": (
                "diff --git a/tests/test_core.py b/tests/test_core.py\n"
                "--- a/tests/test_core.py\n+++ b/tests/test_core.py\n"
            ),
        }
    }


def _patch_materialize(monkeypatch, worktree: Path):
    """Route materialize.materialize -> the fixture worktree; cleanup -> no-op,
    and capture which path the driver hands to the supervisor."""
    monkeypatch.setattr(arm_a.materialize, "materialize",
                        lambda iid, repo, base: worktree)
    monkeypatch.setattr(arm_a.materialize, "cleanup",
                        lambda iid, repo: None)


# ── build_spawn_opts: the load-bearing dict ─────────────────────────────────


def test_spawn_opts_shape():
    opts = arm_a.build_spawn_opts(Path("/abs/worktree"))
    assert opts["write_authority"] is True
    assert opts["cwd"] == "/abs/worktree"
    # extensions disabled: only=[] -> supervisor renders envValue "none",
    # disabling ALL extensions incl the ~/.qwen nx extension (parity w/ Arm B).
    assert opts["extensions"] == {"only": []}
    # Per-turn output floor (4yx): forwarded as QWEN_CODE_MAX_OUTPUT_TOKENS to
    # the inner qwen for Arm A/Arm B parity.
    assert opts["max_output_tokens"] == run_arm.MIN_COMPLETION_TOKENS
    # max_context_tokens is the accumulated-context abort ceiling (default
    # ~111000), a DIFFERENT axis — deliberately NOT pinned (16K would abort
    # multi-turn sessions early).
    assert "max_context_tokens" not in opts


def test_owns_supervisor_points_inner_qwen_at_clean_ephemeral_home(
    monkeypatch, worktree, tmp_path
):
    # When run_instance owns the supervisor (no injection), it must spawn it with
    # HOME pointed at a clean ephemeral copy (so the inner qwen doesn't read/
    # mutate the dev's real ~/.qwen and shares Arm B's config baseline), then
    # remove that HOME afterwards. (40v.13)
    _patch_materialize(monkeypatch, worktree)
    fake_home = tmp_path / "clean-home"
    fake_home.mkdir()
    monkeypatch.setattr(arm_a.run_arm, "ephemeral_home", lambda *a, **k: fake_home)
    fake = FakeSupervisor(states=["complete"])
    monkeypatch.setattr(arm_a, "SpawnedSupervisor", lambda *a, **k: fake)
    arm_a.run_instance(
        "psf__requests-1963",
        rows=_rows_for("psf__requests-1963", worktree),
        predictions_path=tmp_path / "p.jsonl",
    )
    # HOME is passed via the spawn opt (supervisor's own HOME untouched), so the
    # inner qwen gets the clean config without breaking backend resolution.
    assert fake.spawn_calls[0]["opts"]["home"] == str(fake_home)
    assert not fake_home.exists(), "ephemeral HOME leaked"


def test_ephemeral_home_removed_even_when_supervisor_close_raises(
    monkeypatch, worktree, tmp_path
):
    # The finally must remove the temp HOME even if supervisor.close() blows up.
    _patch_materialize(monkeypatch, worktree)
    fake_home = tmp_path / "clean-home"
    fake_home.mkdir()
    monkeypatch.setattr(arm_a.run_arm, "ephemeral_home", lambda *a, **k: fake_home)

    class BadCloseSup(FakeSupervisor):
        def close(self):
            raise RuntimeError("close blew up")

    fake = BadCloseSup(states=["complete"])
    monkeypatch.setattr(arm_a, "SpawnedSupervisor", lambda *a, **k: fake)
    # close() failure is a best-effort-reap issue: it is swallowed (the instance
    # result is already computed) and must NOT skip the temp-HOME cleanup.
    arm_a.run_instance(
        "psf__requests-1963",
        rows=_rows_for("psf__requests-1963", worktree),
        predictions_path=tmp_path / "p.jsonl",
    )
    assert not fake_home.exists(), "temp HOME leaked when close() raised"


# ── run_instance offline (fake supervisor) ──────────────────────────────────


def test_run_instance_spawn_opts_and_cwd_routed(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["running", "complete"])
    rows = _rows_for("psf__requests-1", worktree)

    arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl",
        poll_interval=0,
    )

    assert len(fake.spawn_calls) == 1
    opts = fake.spawn_calls[0]["opts"]
    assert opts["write_authority"] is True
    assert opts["extensions"] == {"only": []}
    # cwd actually routed to the per-instance (fixture) worktree.
    assert opts["cwd"] == str(worktree)


def test_poll_loop_reaches_terminal_and_stops(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["running", "running", "complete"])
    rows = _rows_for("psf__requests-1", worktree)

    arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl",
        poll_interval=0,
    )
    # Stopped exactly once at terminal; poll advanced past the running states.
    assert fake.stop_calls == ["fake-task-1"]
    assert fake._poll_n >= 3


def test_poll_loop_stops_on_idle(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["running", "idle"])
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl",
        poll_interval=0,
    )
    assert result.outcome is run_arm.Outcome.COMPLETED


def test_model_patch_from_git_not_supervisor(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)

    def edit():
        (worktree / "pkg" / "core.py").write_text("def f():\n    return 2\n")

    fake = FakeSupervisor(states=["running", "complete"], edit=edit)
    rows = _rows_for("psf__requests-1", worktree)

    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl",
        poll_interval=0,
    )
    # The patch came from the git worktree extraction (fake supplied none).
    assert "pkg/core.py" in result.model_patch
    assert "return 2" in result.model_patch
    assert result.outcome is run_arm.Outcome.COMPLETED


def test_model_patch_strips_tests(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)

    def edit():
        (worktree / "pkg" / "core.py").write_text("def f():\n    return 5\n")
        # Agent (wrongly) touches a test file; must be stripped + flagged.
        (worktree / "tests" / "test_core.py").write_text(
            "def test_f():\n    assert 1\n")

    fake = FakeSupervisor(states=["complete"], edit=edit)
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl",
        poll_interval=0,
    )
    assert "pkg/core.py" in result.model_patch
    assert "tests/test_core.py" not in result.model_patch
    assert result.test_edit_contamination is True


def test_write_prediction_keys(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)

    def edit():
        (worktree / "pkg" / "core.py").write_text("def f():\n    return 9\n")

    fake = FakeSupervisor(states=["complete"], edit=edit)
    rows = _rows_for("psf__requests-1", worktree)
    preds = worktree.parent / "preds.A.jsonl"

    arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=preds, model_name="qwen3.6.arm-a", poll_interval=0,
    )
    line = json.loads(preds.read_text().splitlines()[0])
    assert set(line) == {"instance_id", "model_name_or_path", "model_patch"}
    assert line["instance_id"] == "psf__requests-1"
    assert line["model_name_or_path"] == "qwen3.6.arm-a"
    assert "return 9" in line["model_patch"]


def test_error_state_classified_as_error(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["running", "error"])
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl", poll_interval=0,
    )
    assert result.outcome is run_arm.Outcome.ERROR


def test_turn_limit_classified_via_shared_rule(monkeypatch, worktree):
    # A completed run that exhausted MAX_TURNS must report TURN_LIMIT (the same
    # shared classify_outcome rule every arm uses), not COMPLETED.
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["running", "complete"], turns=run_arm.MAX_TURNS)
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl", poll_interval=0,
    )
    assert result.outcome is run_arm.Outcome.TURN_LIMIT


def test_absent_turn_count_falls_back_to_completed(monkeypatch, worktree):
    # If the supervisor does not report turns_completed, the run is COMPLETED
    # (graceful None handling), never a crash or a wrong TURN_LIMIT.
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["complete"], turns=None)
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl", poll_interval=0,
    )
    assert result.outcome is run_arm.Outcome.COMPLETED


def test_telemetry_from_supervisor_counters(monkeypatch, worktree):
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["complete"])
    rows = _rows_for("psf__requests-1", worktree)
    result = arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl", poll_interval=0,
    )
    assert result.telemetry["tool_calls"] == 3
    assert result.telemetry["turns"] == 2
    assert result.telemetry["supervisor_state"] == "complete"


def test_supervisor_not_closed_when_injected(monkeypatch, worktree):
    # An injected supervisor is owned by the caller; the driver must NOT close
    # it (only a self-spawned one).
    _patch_materialize(monkeypatch, worktree)
    fake = FakeSupervisor(states=["complete"])
    rows = _rows_for("psf__requests-1", worktree)
    arm_a.run_instance(
        "psf__requests-1", rows=rows, supervisor=fake,
        predictions_path=worktree.parent / "preds.A.jsonl", poll_interval=0,
    )
    assert fake.closed is False


# ── Integration: spawned supervisor + qwentescence ──────────────────────────


def _qwentescence_reachable(host="qwentescence", port=1234, timeout=2.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


_SKIP_REASON = None
if not arm_a.SUPERVISOR_DIST.exists():
    _SKIP_REASON = f"supervisor dist not built: {arm_a.SUPERVISOR_DIST}"
elif not _qwentescence_reachable():
    _SKIP_REASON = "qwentescence:1234 unreachable"


@pytest.mark.integration
@pytest.mark.skipif(_SKIP_REASON is not None, reason=_SKIP_REASON or "")
@pytest.mark.parametrize(
    "instance_id",
    [run_arm.RAIL_KNOWN_INSTANCE, run_arm.RAIL_CLEAN_INSTANCE],
)
def test_integration_spawned_supervisor_rail(instance_id, tmp_path):
    import subset

    rows = subset.load_full_rows()
    result = arm_a.run_instance(
        instance_id,
        rows=rows,
        predictions_path=tmp_path / "preds.A.jsonl",
        # Bound the integration run well under the spine cutoff for CI sanity.
        wall_clock_seconds=run_arm.WALL_CLOCK_SECONDS,
    )

    assert result.model_patch.strip() != "", "expected a non-empty source patch"
    # Source-only: no test-file diff headers in the extracted patch.
    assert "diff --git a/tests/" not in result.model_patch
    assert "diff --git a/test/" not in result.model_patch
    # Apply cleanly onto a fresh worktree at base_commit.
    import materialize

    repo = rows[instance_id]["repo"]
    base = rows[instance_id]["base_commit"]
    check_wt = materialize.materialize(f"{instance_id}__applycheck", repo, base)
    try:
        proc = subprocess.run(
            ["git", "-C", str(check_wt), "apply", "--check", "-"],
            input=result.model_patch, text=True,
            capture_output=True,
        )
        assert proc.returncode == 0, f"patch did not apply cleanly: {proc.stderr}"
    finally:
        materialize.cleanup(f"{instance_id}__applycheck", repo)
