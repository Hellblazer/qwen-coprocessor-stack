# SPDX-License-Identifier: MIT
"""Tests for the Arm B (raw qwen-code CLI) driver (RDR-006 40v.5).

Offline unit tests (ALWAYS run) inject a fake runner returning a canned qwen
``-o json`` event array and operate against a real local git worktree built in
tmp_path (mirroring tests/test_run_arm.py's fixture), so no live ``qwen``
invocation and no network occurs.

Integration tests on the RAIL instances SKIP unless BOTH the ``qwen`` CLI is
present AND the qwentescence backend (:1234) is reachable; they assert structure
(a non-empty source-only diff that applies cleanly), NOT resolution. RF-3 notes
RAIL_KNOWN is expected to be unresolved — that is fine; we only assert a diff is
produced and extracted.
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import arm_b  # noqa: E402
import run_arm  # noqa: E402


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


def _canned_envelope(num_turns: int = 3) -> str:
    """A canned qwen ``-o json`` event array matching the verified live shape:
    a ``system/init`` event (tools + mcp_servers) followed by a terminal
    ``result`` event with structured turns/tokens. NO nx tools, mcp_servers=[]
    (as under the clean-config fixture)."""
    return json.dumps(
        [
            {
                "type": "system",
                "subtype": "init",
                "session_id": "sess-1",
                "model": arm_b.MODEL,
                "permission_mode": "yolo",
                "mcp_servers": [],
                "tools": [
                    "list_directory",
                    "read_file",
                    "grep_search",
                    "glob",
                    "edit",
                    "write_file",
                    "run_shell_command",
                ],
                "qwen_code_version": "0.15.6",
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Fixed the bug."}],
                },
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "duration_ms": 51158,
                "duration_api_ms": 51128,
                "num_turns": num_turns,
                "result": "Fixed the bug.",
                "usage": {
                    "input_tokens": 17975,
                    "output_tokens": 23,
                    "total_tokens": 17998,
                },
            },
        ]
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

    monkeypatch.setattr(arm_b.materialize, "materialize", lambda *a, **k: worktree)
    monkeypatch.setattr(arm_b.materialize, "cleanup", lambda *a, **k: None)
    return instance_id, rows, worktree, base


def _make_runner(worktree: Path, *, envelope: str, mutate=None):
    """Build a fake runner. ``mutate(worktree)`` (default: edit the source file)
    runs to simulate the agent's edits before the envelope is returned. Captures
    argv / cwd / env / timeout for assertions."""

    captured: dict = {}

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        captured["argv"] = list(cmd)
        captured["cwd"] = cwd
        captured["env"] = env
        captured["timeout_seconds"] = timeout_seconds
        if mutate is None:
            (worktree / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        else:
            mutate(worktree)
        return (run_arm.Outcome.COMPLETED, 0, envelope, "", 51.2)

    runner.captured = captured  # type: ignore[attr-defined]
    return runner


# ── offline unit tests (always run) ─────────────────────────────────────────


def test_argv_is_raw_qwen_yolo_openai(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id,
        rows=rows,
        runner=runner,
        predictions_path=tmp_path / "predictions.B.jsonl",
    )
    argv = runner.captured["argv"]
    assert argv[0] == "qwen"
    assert "--auth-type" in argv and argv[argv.index("--auth-type") + 1] == "openai"
    assert (
        "--openai-base-url" in argv
        and argv[argv.index("--openai-base-url") + 1] == "http://qwentescence:1234/v1"
    )
    assert "--openai-api-key" in argv
    assert "-m" in argv and argv[argv.index("-m") + 1] == "qwen3.6-35b-a3b"
    assert "--yolo" in argv
    # The prompt is the final positional arg: the shared verbatim prompt.
    assert "Redirect method conversion bug." in argv[-1]


def test_argv_requests_structured_json_and_turn_cap(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    argv = runner.captured["argv"]
    assert "-o" in argv and argv[argv.index("-o") + 1] == "json"
    assert (
        "--max-session-turns" in argv
        and int(argv[argv.index("--max-session-turns") + 1]) == run_arm.MAX_TURNS
    )


def test_clean_config_home_is_applied_and_lacks_nx_extension(fake_env, tmp_path):
    """The pinned clean-config mechanism: HOME points at an EPHEMERAL COPY of the
    committed fixture (so qwen's runtime writes don't pollute it), and that copy
    genuinely lacks the nx extension (empty extensions dir)."""
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    env = runner.captured["env"]
    assert env is not None
    # HOME is a throwaway copy under the temp dir, NOT the committed fixture.
    home = Path(env["HOME"])
    assert home != arm_b.CLEAN_HOME
    assert "armb-home-" in home.name


def test_ephemeral_home_copies_fixture_and_isolates_writes(tmp_path):
    """ephemeral_home gives a throwaway HOME with the nx-off structure intact,
    and writes into it never touch the committed fixture."""
    home = arm_b.ephemeral_home()
    try:
        assert home != arm_b.CLEAN_HOME
        # Same nx-off structure: pinned settings.json + empty extensions dir.
        assert (home / ".qwen" / "settings.json").is_file()
        ext_dir = home / ".qwen" / "extensions"
        assert ext_dir.is_dir()
        ext_children = [p.name for p in ext_dir.iterdir() if p.name != ".gitkeep"]
        assert ext_children == [], f"clean config must have NO extensions, found {ext_children}"
        assert not (ext_dir / "nx").exists()
        # A runtime write into the copy does not mutate the committed fixture.
        (home / ".qwen" / "installation_id").write_text("pollution")
        assert not (arm_b.CLEAN_HOME / ".qwen" / "installation_id").exists()
    finally:
        import shutil
        shutil.rmtree(home, ignore_errors=True)


def test_env_sets_completion_budget_at_or_above_floor(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    env = runner.captured["env"]
    assert "QWEN_CODE_MAX_OUTPUT_TOKENS" in env
    assert int(env["QWEN_CODE_MAX_OUTPUT_TOKENS"]) >= run_arm.MIN_COMPLETION_TOKENS


def test_runner_invoked_with_worktree_cwd_and_walltime(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert runner.captured["cwd"] == wt
    assert runner.captured["timeout_seconds"] == run_arm.WALL_CLOCK_SECONDS


def test_model_patch_from_git_extraction(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    preds = tmp_path / "predictions.B.jsonl"
    runner = _make_runner(wt, envelope=_canned_envelope())
    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=preds
    )
    line = json.loads(preds.read_text().splitlines()[0])
    assert "pkg/core.py" in line["model_patch"]
    assert "return 2" in line["model_patch"]
    assert "pkg/core.py" in result.model_patch


def test_test_edit_stripped_from_source_patch(fake_env, tmp_path):
    # If the agent edits a test file, the source patch excludes it (arm-uniform)
    # and contamination is flagged.
    instance_id, rows, wt, _base = fake_env

    def mutate(w):
        (w / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        (w / "tests" / "test_core.py").write_text("def test_f():\n    assert 1\n")

    runner = _make_runner(wt, envelope=_canned_envelope(), mutate=mutate)
    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert "pkg/core.py" in result.model_patch
    assert "tests/test_core.py" not in result.model_patch
    assert result.test_edit_contamination is True


def test_telemetry_parsed_structured_turns_and_tokens(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=3))
    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    tel = result.telemetry
    assert tel["telemetry_parseable"] is True
    assert tel["num_turns"] == 3
    assert tel["usage"]["total_tokens"] == 17998
    assert tel["duration_ms"] == 51158
    # qwen runs on local hardware -> cost recorded as $0.
    assert tel["cost_usd"] == 0.0
    # The active tool surface is reported and carries NO nx tools / servers.
    assert tel["mcp_servers"] == []
    assert "edit" in tel["tools"]
    assert not any("nx" in t for t in tel["tools"])


def test_write_prediction_has_three_swebench_keys(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    preds = tmp_path / "predictions.B.jsonl"
    runner = _make_runner(wt, envelope=_canned_envelope())
    arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=preds
    )
    row = json.loads(preds.read_text().splitlines()[0])
    assert set(row) == {"instance_id", "model_name_or_path", "model_patch"}
    assert row["instance_id"] == instance_id
    assert row["model_name_or_path"] == arm_b.MODEL_NAME


def test_classify_outcome_turn_limit(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=run_arm.MAX_TURNS))
    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert result.outcome is run_arm.Outcome.TURN_LIMIT


def test_classify_outcome_completed(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env
    runner = _make_runner(wt, envelope=_canned_envelope(num_turns=3))
    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert result.outcome is run_arm.Outcome.COMPLETED


def test_nonzero_exit_is_error(fake_env, tmp_path):
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        (wt / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        return (run_arm.Outcome.ERROR, 1, _canned_envelope(), "", 1.0)

    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert result.outcome is run_arm.Outcome.ERROR


def test_timeout_preserved_not_reclassified(fake_env, tmp_path):
    # run_with_timeout owns TIMEOUT; the driver must NOT reclassify it.
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        return (run_arm.Outcome.TIMEOUT, None, "", "", 1800.0)

    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert result.outcome is run_arm.Outcome.TIMEOUT


def test_telemetry_robust_to_malformed_output(fake_env, tmp_path):
    # Non-JSON / empty output must not crash the run; git patch still wins.
    instance_id, rows, wt, _base = fake_env

    def runner(cmd, timeout_seconds=None, cwd=None, env=None, input_text=None):
        (wt / "pkg" / "core.py").write_text("def f():\n    return 2\n")
        return (run_arm.Outcome.COMPLETED, 0, "not json at all", "", 1.0)

    result = arm_b.run_instance(
        instance_id, rows=rows, runner=runner, predictions_path=tmp_path / "p.jsonl"
    )
    assert result.telemetry["telemetry_parseable"] is False
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
    monkeypatch.setattr(arm_b.materialize, "materialize", lambda *a, **k: worktree)
    calls = {"cleanup": 0}
    monkeypatch.setattr(
        arm_b.materialize,
        "cleanup",
        lambda *a, **k: calls.__setitem__("cleanup", calls["cleanup"] + 1),
    )

    def boom(cmd, **k):
        raise RuntimeError("runner blew up")

    with pytest.raises(RuntimeError):
        arm_b.run_instance(
            instance_id, rows=rows, runner=boom, predictions_path=tmp_path / "p.jsonl"
        )
    assert calls["cleanup"] == 1


def _capture_ephemeral_home(monkeypatch):
    """Wrap arm_b.ephemeral_home to record the temp HOME it hands out, so a test
    can assert it was removed afterwards (no leak)."""
    holder: dict = {}
    real = arm_b.ephemeral_home

    def wrapped(*a, **k):
        h = real(*a, **k)
        holder["home"] = h
        return h

    monkeypatch.setattr(arm_b, "ephemeral_home", wrapped)
    return holder


def _rows_one(base):
    return {
        "psf__requests-1963": {
            "repo": "psf/requests", "base_commit": base,
            "problem_statement": "x", "test_patch": "",
        }
    }


def test_ephemeral_home_removed_when_materialize_raises(worktree, monkeypatch, tmp_path):
    # materialize() raises BEFORE the inner try — the outer finally must still
    # remove the temp HOME (no /tmp leak).
    base = _base_commit(worktree)
    holder = _capture_ephemeral_home(monkeypatch)

    def boom(*a, **k):
        raise RuntimeError("clone failed")

    monkeypatch.setattr(arm_b.materialize, "materialize", boom)
    with pytest.raises(RuntimeError):
        arm_b.run_instance(
            "psf__requests-1963", rows=_rows_one(base),
            runner=_make_runner(worktree, envelope=_canned_envelope()),
            predictions_path=tmp_path / "p.jsonl",
        )
    assert holder["home"] is not None
    assert not holder["home"].exists(), "temp HOME leaked when materialize raised"


def test_ephemeral_home_removed_when_cleanup_raises(worktree, monkeypatch, tmp_path):
    # cleanup() raises in the inner finally (its git-prune is unguarded) — the
    # outer finally must STILL remove the temp HOME.
    base = _base_commit(worktree)
    holder = _capture_ephemeral_home(monkeypatch)
    monkeypatch.setattr(arm_b.materialize, "materialize", lambda *a, **k: worktree)

    def boom_cleanup(*a, **k):
        raise RuntimeError("git worktree prune failed")

    monkeypatch.setattr(arm_b.materialize, "cleanup", boom_cleanup)
    with pytest.raises(RuntimeError):
        arm_b.run_instance(
            "psf__requests-1963", rows=_rows_one(base),
            runner=_make_runner(worktree, envelope=_canned_envelope()),
            predictions_path=tmp_path / "p.jsonl",
        )
    assert not holder["home"].exists(), "temp HOME leaked when cleanup raised"


def test_telemetry_parser_handles_object_shape():
    # Defensive: a bare result object (not the array) still parses.
    tel = arm_b.parse_telemetry(
        json.dumps({"type": "result", "num_turns": 2, "duration_ms": 10})
    )
    assert tel["telemetry_parseable"] is True
    assert tel["num_turns"] == 2


def test_init_event_tools_extraction():
    tools = arm_b.init_event_tools(_canned_envelope())
    assert "edit" in tools and "run_shell_command" in tools
    assert arm_b.init_event_mcp_servers(_canned_envelope()) == []


# ── integration tests (skip without qwen CLI / unreachable backend) ──────────


def _qwentescence_reachable(host: str = "qwentescence", port: int = 1234) -> bool:
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except OSError:
        return False


import shutil  # noqa: E402

_QWEN_ABSENT = shutil.which("qwen") is None
_BACKEND_DOWN = not _qwentescence_reachable()
_skip_no_backend = pytest.mark.skipif(
    _QWEN_ABSENT or _BACKEND_DOWN,
    reason="qwen CLI absent or qwentescence:1234 unreachable; skipping live Arm B run",
)


@pytest.mark.integration
@_skip_no_backend
@pytest.mark.parametrize(
    "instance_id",
    [run_arm.RAIL_KNOWN_INSTANCE, run_arm.RAIL_CLEAN_INSTANCE],
)
def test_rail_instance_produces_extracted_source_diff(instance_id, tmp_path):
    """Live Arm B run on a rail instance. Asserts STRUCTURE (a non-empty
    source-only diff that applies cleanly against base), not resolution. RF-3
    expects RAIL_KNOWN unresolved — that is fine; we assert a diff is produced
    and extracted, and that the run used the isolated (nx-OFF) tool surface."""
    from subset import load_full_rows

    try:
        rows = load_full_rows()
    except Exception as exc:  # pragma: no cover - network/dataset unavailable
        pytest.skip(f"dataset unavailable (no network?): {exc}")

    preds = tmp_path / "predictions.B.jsonl"
    result = arm_b.run_instance(instance_id, rows=rows, predictions_path=preds)

    assert result.model_patch.strip() != "", "expected a non-empty source diff"
    # Source-only: no test-file diff headers.
    assert "diff --git a/test" not in result.model_patch

    # Tool-surface isolation held on the live run: nx MCP server OFF.
    if result.telemetry.get("telemetry_parseable"):
        assert result.telemetry.get("mcp_servers") == []
        assert not any("nx" in t for t in result.telemetry.get("tools", []))

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
