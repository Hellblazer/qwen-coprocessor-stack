# SPDX-License-Identifier: MIT
"""Tests for the Arm C (claude -p sonnet) driver (RDR-006 40v.4).

Offline unit tests (ALWAYS run) inject a fake runner returning a canned
``claude -p --output-format json`` envelope and operate against a real local
git worktree built in tmp_path (mirroring tests/test_run_arm.py's fixture), so
no live ``claude`` invocation and no network occurs.

Integration tests on the RAIL instances SKIP unless the ``claude`` CLI is
present; they assert structure (a non-empty source-only diff that applies
cleanly), NOT resolution.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import arm_c  # noqa: E402
import run_arm  # noqa: E402

# A model_patch SENTINEL planted in the fake envelope. The driver MUST source
# the prediction from git extraction, so this string must NEVER appear in the
# written prediction.
ENVELOPE_MODEL_PATCH_SENTINEL = "SENTINEL_ENVELOPE_PATCH_MUST_NOT_LEAK"


def _git(args, cwd):
    subprocess.run(
        ["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True
    )


@pytest.fixture
def worktree(tmp_path) -> Path:
    """A real git repo with a source file + a generic test file, committed."""
    r = tmp_path / "wt"
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
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _canned_envelope(num_turns: int = 4) -> str:
    """A canned claude -p json envelope matching the verified spike shape, plus
    a (telemetry-only) model_patch field carrying the leak sentinel."""
    return json.dumps(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "duration_ms": 15894,
            "num_turns": num_turns,
            "result": "Fixed the bug.",
            "total_cost_usd": 0.717387,
            # This field is telemetry-only by the locked contract; if the driver
            # ever sourced model_patch from the envelope this sentinel would
            # leak into the prediction (the test below forbids that).
            "model_patch": ENVELOPE_MODEL_PATCH_SENTINEL,
            "usage": {"input_tokens": 100, "output_tokens": 50},
        }
    )


@pytest.fixture
def fake_env(worktree, monkeypatch):
    """Wire materialize.materialize -> the prebuilt worktree (no clone/network),
    materialize.cleanup -> no-op, and return rows + base_commit. The fake runner
    is supplied per-test so each can vary turns / mutate the worktree."""
    base = _base_commit(worktree)
    instance_id = "psf__requests-1963"
    rows = {
        instance_id: {
            "repo": "psf/requests",
            "base_commit": base,
            "problem_statement": "Redirect method conversion bug.",
            "test_patch": (
                "diff --git a/tests/test_core.py b/tests/test_core.py\n"
                "--- a/tests/test_core.py\n+++ b/tests/test_core.py\n"
            ),
        }
    }

    monkeypatch.setattr(arm_c.materialize, "materialize", lambda *a, **k: worktree)
    monkeypatch.setattr(arm_c.materialize, "cleanup", lambda *a, **k: None)
    return instance_id, rows, worktree, base


def _make_runner(worktree: Path, *, envelope: str, mutate=None):
    """Build a fake runner. ``mutate(worktree)`` (default: edit the source file)
    runs to simulate the agent's edits before the envelope is returned."""

    captured: dict = {}

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        captured["argv"] = list(cmd)
        captured["cwd"] = cwd
        captured["timeout_seconds"] = timeout_seconds
        if mutate is None:
            (worktree / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        else:
            mutate(worktree)
        return (run_arm.Outcome.COMPLETED, 0, envelope, "", 12.5)

    runner.captured = captured  # type: ignore[attr-defined]
    return runner


# ── offline unit tests (always run) ─────────────────────────────────────────


def test_argv_is_claude_p_sonnet_json(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_c.run_instance(
        instance_id,
        rows=rows,
        runner=runner,
        predictions_path=tmp_path / "predictions.C.jsonl",
    )
    argv = runner.captured["argv"]
    assert argv[0] == "claude"
    assert argv[1] == "-p"
    assert "--model" in argv and argv[argv.index("--model") + 1] == "sonnet"
    assert "--output-format" in argv
    assert argv[argv.index("--output-format") + 1] == "json"
    assert "--dangerously-skip-permissions" in argv
    # The prompt arg is the shared verbatim prompt embedding the issue.
    assert "Redirect method conversion bug." in argv[2]


def test_argv_pins_turn_budget_to_shared_max_turns(fake_env, tmp_path):
    # The claude CLI has no per-turn output-token cap; the report documents
    # "uncapped >= qwen floor". The TURN budget, however, is pinned to the
    # shared run_arm.MAX_TURNS so it is identical across arms.
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    argv = runner.captured["argv"]
    assert "--max-turns" in argv
    assert int(argv[argv.index("--max-turns") + 1]) == run_arm.MAX_TURNS


def test_runner_invoked_with_worktree_cwd_and_walltime(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert runner.captured["cwd"] == wt
    assert runner.captured["timeout_seconds"] == run_arm.WALL_CLOCK_SECONDS


def test_model_patch_from_git_not_envelope(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    preds = tmp_path / "predictions.C.jsonl"
    runner = _make_runner(wt, envelope=_canned_envelope())
    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=preds
    )
    # The written prediction's patch is the real git diff, NOT the sentinel.
    line = json.loads(preds.read_text().splitlines()[0])
    assert ENVELOPE_MODEL_PATCH_SENTINEL not in line["model_patch"]
    assert "pkg/core.py" in line["model_patch"]
    assert "return 2" in line["model_patch"]
    # And the RunResult carries the same git-sourced patch.
    assert ENVELOPE_MODEL_PATCH_SENTINEL not in result.model_patch
    assert "pkg/core.py" in result.model_patch


def test_telemetry_parsed_from_envelope(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=4))
    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.telemetry["total_cost_usd"] == 0.717387
    assert result.telemetry["num_turns"] == 4
    assert result.telemetry["duration_ms"] == 15894
    assert result.telemetry["raw_parse_ok"] is True


def test_write_prediction_has_three_swebench_keys(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    preds = tmp_path / "predictions.C.jsonl"
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_c.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=preds
    )
    row = json.loads(preds.read_text().splitlines()[0])
    assert set(row) == {"instance_id", "model_name_or_path", "model_patch"}
    assert row["instance_id"] == instance_id
    assert row["model_name_or_path"] == arm_c.MODEL_NAME


def test_classify_outcome_turn_limit(fake_env, tmp_path):
    # num_turns >= MAX_TURNS funnels through the shared classify_outcome ->
    # TURN_LIMIT (fairness: same rule as every arm).
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=run_arm.MAX_TURNS))
    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.outcome is run_arm.Outcome.TURN_LIMIT


def test_classify_outcome_completed(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=3))
    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.outcome is run_arm.Outcome.COMPLETED


def test_nonzero_exit_is_error(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        (wt / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        return (run_arm.Outcome.ERROR, 1, _canned_envelope(), "", 1.0)

    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.outcome is run_arm.Outcome.ERROR


def test_timeout_preserved_not_reclassified(fake_env, tmp_path):
    # run_with_timeout owns TIMEOUT; the driver must NOT reclassify it.
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        return (run_arm.Outcome.TIMEOUT, None, "", "", 1800.0)

    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.outcome is run_arm.Outcome.TIMEOUT


def test_telemetry_robust_to_malformed_envelope(fake_env, tmp_path):
    # A non-JSON / empty envelope must not crash the run; git patch still wins.
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        (wt / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        return (run_arm.Outcome.COMPLETED, 0, "not json at all", "", 1.0)

    result = arm_c.run_instance(
        instance_id, rows=rows, runner=runner,
        predictions_path=tmp_path / "p.jsonl",
    )
    assert result.telemetry["raw_parse_ok"] is False
    assert result.telemetry["num_turns"] is None
    assert "pkg/core.py" in result.model_patch


def test_cleanup_called_even_on_failure(worktree, monkeypatch, tmp_path):
    base = _base_commit(worktree)
    instance_id = "psf__requests-1963"
    rows = {
        instance_id: {
            "repo": "psf/requests",
            "base_commit": base,
            "problem_statement": "x",
            "test_patch": "",
        }
    }
    monkeypatch.setattr(arm_c.materialize, "materialize", lambda *a, **k: worktree)
    calls = {"cleanup": 0}
    monkeypatch.setattr(
        arm_c.materialize,
        "cleanup",
        lambda *a, **k: calls.__setitem__("cleanup", calls["cleanup"] + 1),
    )

    def boom(cmd, **k):
        raise RuntimeError("runner blew up")

    with pytest.raises(RuntimeError):
        arm_c.run_instance(
            instance_id, rows=rows, runner=boom,
            predictions_path=tmp_path / "p.jsonl",
        )
    assert calls["cleanup"] == 1


def test_envelope_parser_handles_array_shape():
    # Defensive: a JSON array (shape drift) degrades, does not raise.
    tel = arm_c.parse_telemetry("[1, 2, 3]")
    assert tel["raw_parse_ok"] is False
    assert tel["total_cost_usd"] is None


# ── integration tests (skip without the claude CLI / network) ───────────────

_CLAUDE_ABSENT = shutil.which("claude") is None
_skip_no_claude = pytest.mark.skipif(
    _CLAUDE_ABSENT, reason="claude CLI not installed; skipping live Arm C run"
)


@pytest.mark.integration
@_skip_no_claude
@pytest.mark.parametrize(
    "instance_id",
    [run_arm.RAIL_KNOWN_INSTANCE, run_arm.RAIL_CLEAN_INSTANCE],
)
def test_rail_instance_produces_applying_source_diff(instance_id, tmp_path):
    """Live Arm C run on a rail instance. Asserts STRUCTURE (a non-empty
    source-only diff that applies cleanly against base), not resolution."""
    from subset import load_full_rows

    try:
        rows = load_full_rows()
    except Exception as exc:  # pragma: no cover - network/dataset unavailable
        pytest.skip(f"dataset unavailable (no network?): {exc}")

    preds = tmp_path / "predictions.C.jsonl"
    result = arm_c.run_instance(
        instance_id, rows=rows, predictions_path=preds
    )

    assert result.model_patch.strip() != "", "expected a non-empty source diff"
    # Source-only: no test-file diff headers in the extracted patch.
    assert "diff --git a/tests/" not in result.model_patch
    assert "diff --git a/test/" not in result.model_patch

    # Applies cleanly against a fresh worktree at base_commit.
    row = rows[instance_id]
    import materialize

    check_wt = materialize.materialize(
        instance_id + "-applycheck", row["repo"], row["base_commit"]
    )
    try:
        proc = subprocess.run(
            ["git", "-C", str(check_wt), "apply", "--check", "-"],
            input=result.model_patch,
            text=True,
            capture_output=True,
        )
        assert proc.returncode == 0, f"patch did not apply: {proc.stderr}"
    finally:
        materialize.cleanup(instance_id + "-applycheck", row["repo"])
