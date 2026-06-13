# SPDX-License-Identifier: MIT
"""Tests for the shared run_arm spine (RDR-006 40v.3).

Patch extraction is exercised against a real local git worktree with a
deliberate source+test diff. The wall-clock cutoff is exercised with a real
hanging subprocess that must be killed (not hang the test).
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_arm import (  # noqa: E402
    MAX_TURNS,
    MIN_COMPLETION_TOKENS,
    WALL_CLOCK_SECONDS,
    Outcome,
    RunResult,
    build_agent_task,
    build_prompt,
    classify_outcome,
    detect_test_contamination,
    extract_source_patch,
    gold_test_globs,
    run_result_to_agent_result,
    run_with_timeout,
    write_prediction,
)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=str(cwd), check=True,
                   capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path) -> Path:
    """A repo with a source file, a generic-named test, a conftest, and an
    oddly-named test file (only catchable via per-instance refinement)."""
    r = tmp_path / "repo"
    (r / "pkg").mkdir(parents=True)
    (r / "tests").mkdir()
    (r / "pkg" / "core.py").write_text("def f():\n    return 1\n")
    (r / "tests" / "test_core.py").write_text("def test_f():\n    assert True\n")
    (r / "conftest.py").write_text("# fixtures\n")
    (r / "pkg" / "special_checks.py").write_text("def check():\n    return 0\n")
    _git(["init", "-q"], r)
    _git(["config", "user.email", "t@t.t"], r)
    _git(["config", "user.name", "t"], r)
    _git(["add", "."], r)
    _git(["commit", "-qm", "base"], r)
    return r


# ── shared prompt ──────────────────────────────────────────────────────────


def test_build_prompt_is_verbatim_and_embeds_issue():
    p = build_prompt("the bug text", "psf/requests")
    assert "the bug text" in p
    assert "psf/requests" in p
    # Same inputs -> byte-identical prompt (the arms must share it verbatim).
    assert p == build_prompt("the bug text", "psf/requests")


def test_build_prompt_forbids_test_edits():
    # The no-test-edit instruction is part of the shared prompt (fair across
    # arms) and load-bearing for keeping contamination low.
    p = build_prompt("x", "r/r")
    assert "test" in p.lower()


# ── gold_test_globs ──────────────────────────────────────────────────


def test_gold_test_globs_parses_paths():
    test_patch = (
        "diff --git a/requests/tests/test_x.py b/requests/tests/test_x.py\n"
        "--- a/requests/tests/test_x.py\n+++ b/requests/tests/test_x.py\n"
        "@@ -1 +1 @@\n-old\n+new\n"
        "diff --git a/pkg/special_checks.py b/pkg/special_checks.py\n"
        "--- a/pkg/special_checks.py\n+++ b/pkg/special_checks.py\n"
    )
    assert gold_test_globs(test_patch) == [
        "requests/tests/test_x.py",
        "pkg/special_checks.py",
    ]


# ── patch extraction (arm-uniform) ─────────────────────────────────────────


def test_extract_strips_generic_test_files_keeps_source(repo):
    (repo / "pkg" / "core.py").write_text("def f():\n    return 2\n")  # source
    (repo / "tests" / "test_core.py").write_text("def test_f():\n    assert False\n")
    (repo / "conftest.py").write_text("# fixtures changed\n")

    source, contaminated = extract_source_patch(repo)

    assert "pkg/core.py" in source        # source change kept
    assert "return 2" in source
    assert "tests/test_core.py" not in source   # generic test stripped
    assert "conftest.py" not in source          # conftest stripped
    assert contaminated is True


def test_extract_no_contamination_when_only_source_changed(repo):
    (repo / "pkg" / "core.py").write_text("def f():\n    return 99\n")
    source, contaminated = extract_source_patch(repo)
    assert "pkg/core.py" in source
    assert contaminated is False


def test_extract_refines_oddly_named_test_via_extra_paths(repo):
    # special_checks.py is a test in this instance but matches no generic
    # pattern. Without refinement it leaks into the source patch; with the
    # per-instance extra path it is stripped and flagged.
    (repo / "pkg" / "core.py").write_text("def f():\n    return 2\n")
    (repo / "pkg" / "special_checks.py").write_text("def check():\n    return 1\n")

    no_refine, contam_no = extract_source_patch(repo)
    assert "pkg/special_checks.py" in no_refine   # leaks without refinement
    assert contam_no is False                     # not seen as a test yet

    refined, contam_yes = extract_source_patch(repo, extra_test_paths=["pkg/special_checks.py"])
    assert "pkg/special_checks.py" not in refined  # stripped with refinement
    assert "pkg/core.py" in refined                # source still kept
    assert contam_yes is True


def test_extract_against_base_captures_committed_change(repo):
    # If the agent COMMITS its fix, `git diff HEAD` would be empty and the run
    # would score a silent zero. Diffing against the base commit captures it.
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip()
    (repo / "pkg" / "core.py").write_text("def f():\n    return 7\n")
    _git(["commit", "-aqm", "agent fix (committed)"], repo)

    # Bare HEAD diff misses the committed change...
    head_only, _ = extract_source_patch(repo, base="HEAD")
    assert head_only.strip() == ""
    # ...but diffing against base captures it.
    source, contaminated = extract_source_patch(repo, base=base)
    assert "pkg/core.py" in source
    assert "return 7" in source
    assert contaminated is False


def test_extract_nonrepo_path_raises(tmp_path):
    # A non-git worktree is a programming error, not a silent empty patch.
    with pytest.raises(subprocess.CalledProcessError):
        extract_source_patch(tmp_path / "not-a-repo")


def test_classify_outcome_rule_is_shared():
    assert classify_outcome(0) is Outcome.COMPLETED
    assert classify_outcome(3) is Outcome.ERROR
    # Turn-limit: same rule for every arm, driven by arm-supplied turns_used.
    assert classify_outcome(0, turns_used=MAX_TURNS) is Outcome.TURN_LIMIT
    assert classify_outcome(0, turns_used=MAX_TURNS + 5) is Outcome.TURN_LIMIT
    assert classify_outcome(0, turns_used=MAX_TURNS - 1) is Outcome.COMPLETED
    # A nonzero exit dominates turn count.
    assert classify_outcome(1, turns_used=MAX_TURNS) is Outcome.ERROR


def test_extract_empty_when_no_changes(repo):
    source, contaminated = extract_source_patch(repo)
    assert source.strip() == ""
    assert contaminated is False


def test_detect_contamination_direct(repo):
    assert detect_test_contamination(repo) is False
    (repo / "tests" / "test_core.py").write_text("def test_f():\n    assert 1\n")
    assert detect_test_contamination(repo) is True


# ── wall-clock cutoff ──────────────────────────────────────────────────────


def test_timeout_fires_and_is_recorded(tmp_path):
    start = time.monotonic()
    outcome, rc, _out, _err, duration = run_with_timeout(
        ["bash", "-c", "sleep 30"], timeout_seconds=1
    )
    elapsed = time.monotonic() - start
    assert outcome is Outcome.TIMEOUT
    assert elapsed < 10  # the cutoff fired; it did NOT wait 30s
    assert duration >= 1


def test_timeout_kills_child_process_group(tmp_path):
    # The agent CLIs spawn children; the cutoff must kill the whole group, not
    # leak a grandchild that keeps running. Write the grandchild PID FIRST
    # (before backgrounding) so the pidfile is reliably present even if SIGKILL
    # lands early, then poll for the grandchild's death rather than a fixed
    # sleep (robust on slow hosts).
    import os

    pidfile = tmp_path / "grandchild.pid"
    readyfile = tmp_path / "ready"
    # Start a grandchild, record ITS pid, signal ready, then idle.
    script = (
        f"sleep 30 & gpid=$!; echo $gpid > {pidfile}; touch {readyfile}; wait"
    )
    outcome, _rc, _o, _e, _d = run_with_timeout(
        ["bash", "-c", script], timeout_seconds=2
    )
    assert outcome is Outcome.TIMEOUT
    assert pidfile.exists(), "grandchild pid was never recorded"
    gpid = int(pidfile.read_text().strip())

    # Poll for death (bounded) instead of a fixed delay.
    dead = False
    for _ in range(40):
        try:
            os.kill(gpid, 0)
        except ProcessLookupError:
            dead = True
            break
        time.sleep(0.05)
    assert dead, f"grandchild {gpid} leaked past the process-group kill"


def test_completed_and_error_outcomes():
    ok, rc0, out, _e, _d = run_with_timeout(["bash", "-c", "echo hi"], timeout_seconds=5)
    assert ok is Outcome.COMPLETED and rc0 == 0 and "hi" in out

    bad, rc1, _o, _e2, _d2 = run_with_timeout(["bash", "-c", "exit 3"], timeout_seconds=5)
    assert bad is Outcome.ERROR and rc1 == 3


# ── prediction writer ──────────────────────────────────────────────────────


def test_write_prediction_appends_swebench_keys(tmp_path):
    path = tmp_path / "preds.jsonl"
    write_prediction(path, "psf__requests-2148", "qwen3.6.arm-a", "DIFF1")
    write_prediction(path, "django__django-11283", "qwen3.6.arm-a", "DIFF2")

    rows = [json.loads(l) for l in path.read_text().splitlines()]
    assert len(rows) == 2
    assert set(rows[0]) == {"instance_id", "model_name_or_path", "model_patch"}
    assert rows[0]["instance_id"] == "psf__requests-2148"
    assert rows[1]["model_patch"] == "DIFF2"


# ── shared controls are pinned ─────────────────────────────────────────────


def test_shared_controls_present():
    assert MAX_TURNS == 40
    assert WALL_CLOCK_SECONDS > 0


# ── RDR-007 §4 contract boundary: AgentTask / AgentResult projection ─────────
# These pin the Python spine to the SAME language-neutral shape the TS host
# emits (mcp-bridges/qwen-agent-server/src/types.ts AgentTask/AgentResult), so
# Phase 4b's golden fixtures are byte-identical across both hosts. Field names
# are camelCase deliberately — they are the JSON fixture keys, not Python style.


def test_agent_outcome_values_match_ts_union():
    # Outcome.value IS the TS AgentOutcome string union (verbatim, RF-1).
    assert {o.value for o in Outcome} == {"completed", "timeout", "turn_limit", "error"}


def test_agent_task_shape_matches_contract():
    task = build_agent_task("do the thing", "/tmp/wt")
    # Exact key set mirrors the TS AgentTask interface (camelCase JSON keys).
    assert set(task) == {"prompt", "worktree", "maxTurns", "minTokens", "timeout"}
    assert task["prompt"] == "do the thing"
    assert task["worktree"] == "/tmp/wt"


def test_build_agent_task_defaults_pin_shared_controls():
    task = build_agent_task("p", "/wt")
    assert task["maxTurns"] == MAX_TURNS
    assert task["minTokens"] == MIN_COMPLETION_TOKENS
    # timeout is emitted in MILLISECONDS to match TS AgentTask.timeout — the
    # host converts back to seconds for run_with_timeout locally (RF-1).
    assert task["timeout"] == int(WALL_CLOCK_SECONDS * 1000)


def test_build_agent_task_overrides_and_ms_conversion():
    task = build_agent_task("p", "/wt", max_turns=10, min_tokens=2048, timeout_seconds=5)
    assert task["maxTurns"] == 10
    assert task["minTokens"] == 2048
    assert task["timeout"] == 5000  # seconds -> ms at the contract boundary


def _rr(outcome=Outcome.COMPLETED, patch="DIFF", telemetry=None) -> RunResult:
    return RunResult(
        instance_id="psf__requests-2148",
        arm="arm-x",
        outcome=outcome,
        model_patch=patch,
        telemetry=telemetry if telemetry is not None else {},
    )


def test_agent_result_shape_matches_contract():
    res = run_result_to_agent_result(_rr())
    # Exact key set mirrors the TS AgentResult interface.
    assert set(res) == {"patch", "turns", "outcome", "cost"}
    assert res["patch"] == "DIFF"
    # outcome is the STRING value (JSON), never the Python enum.
    assert res["outcome"] == "completed"
    assert isinstance(res["outcome"], str)


def test_map_arm_a_turns_key_no_cost():
    # Arm A reports telemetry['turns'] and omits cost (local hardware -> 0.0).
    res = run_result_to_agent_result(_rr(telemetry={"turns": 5, "tool_calls": 12}))
    assert res["turns"] == 5
    assert res["cost"] == 0.0


def test_map_arm_c_num_turns_and_metered_cost():
    res = run_result_to_agent_result(
        _rr(telemetry={"num_turns": 3, "total_cost_usd": 0.717387})
    )
    assert res["turns"] == 3
    assert res["cost"] == pytest.approx(0.717387)


def test_map_arm_b_num_turns_zero_cost():
    res = run_result_to_agent_result(_rr(telemetry={"num_turns": 7, "cost_usd": 0.0}))
    assert res["turns"] == 7
    assert res["cost"] == 0.0


def test_map_turns_precedence_turns_over_num_turns():
    # If both keys appear, the Arm-A 'turns' key wins (documented precedence).
    res = run_result_to_agent_result(_rr(telemetry={"turns": 2, "num_turns": 9}))
    assert res["turns"] == 2


def test_map_cost_precedence_total_over_cost_usd():
    res = run_result_to_agent_result(
        _rr(telemetry={"total_cost_usd": 1.5, "cost_usd": 0.0})
    )
    assert res["cost"] == pytest.approx(1.5)


def test_map_missing_telemetry_defaults_to_zero():
    # Empty/parse-failed telemetry -> turns 0, cost 0.0 (matches TS `?? 0`).
    res = run_result_to_agent_result(_rr(telemetry={}))
    assert res["turns"] == 0
    assert res["cost"] == 0.0


def test_map_none_telemetry_values_default_to_zero():
    # A telemetry parse failure leaves the keys present but None.
    res = run_result_to_agent_result(
        _rr(telemetry={"turns": None, "num_turns": None, "total_cost_usd": None})
    )
    assert res["turns"] == 0
    assert res["cost"] == 0.0


def test_map_preserves_every_outcome():
    for o in Outcome:
        assert run_result_to_agent_result(_rr(outcome=o))["outcome"] == o.value
