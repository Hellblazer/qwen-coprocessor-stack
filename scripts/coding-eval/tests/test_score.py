# SPDX-License-Identifier: MIT
"""Tests for the official-harness scoring wrapper (RDR-006 40v.8).

Offline unit tests (ALWAYS run): inject a fake runner that writes a canned
swebench report to the path the real harness would, and assert (a) the argv we
build matches the RF-1 proven shape — crucially ``--namespace swebench`` by default
(bead hbjw), ``--cache_level instance``, the dataset name, predictions path, run_id,
and instance_ids — and (b) the report parse yields correct resolved/unresolved
counts, including the missing-instance-counts-as-unresolved case (no crash).

The integration test (``-m integration``, deselected by default) mirrors RF-1:
builds gold-patch predictions for a small subset and asserts they score 100%
RESOLVED via the real Docker harness. Skipped when Docker is unavailable.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import score  # noqa: E402
import subset  # noqa: E402


# ── fixtures ────────────────────────────────────────────────────────────────


def _write_preds(path: Path, model: str, instance_ids) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for iid in instance_ids:
            fh.write(
                json.dumps(
                    {
                        "instance_id": iid,
                        "model_name_or_path": model,
                        "model_patch": "diff --git a/x b/x\n",
                    }
                )
                + "\n"
            )


def _canned_report(resolved_ids, unresolved_ids) -> dict:
    """A swebench-shaped summary report (schema_version 2)."""
    resolved_ids = list(resolved_ids)
    unresolved_ids = list(unresolved_ids)
    submitted = sorted(resolved_ids + unresolved_ids)
    return {
        "total_instances": len(submitted),
        "submitted_instances": len(submitted),
        "completed_instances": len(submitted),
        "resolved_instances": len(resolved_ids),
        "unresolved_instances": len(unresolved_ids),
        "empty_patch_instances": 0,
        "error_instances": 0,
        "completed_ids": submitted,
        "incomplete_ids": [],
        "empty_patch_ids": [],
        "submitted_ids": submitted,
        "resolved_ids": sorted(resolved_ids),
        "unresolved_ids": sorted(unresolved_ids),
        "error_ids": [],
        "schema_version": 2,
    }


def _fake_runner_factory(report_payload: dict, *, captured: dict, rc: int = 0):
    """Return a runner that records argv/cwd and writes ``report_payload`` to the
    cwd-relative ``<model>.<run_id>.json`` the harness would produce."""

    def runner(argv, cwd):
        captured["argv"] = list(argv)
        captured["cwd"] = Path(cwd)
        # Mirror reporting.make_run_report's filename derivation: it reads the
        # model from the predictions file. We re-derive from the argv's preds.
        preds = captured["argv"][captured["argv"].index("--predictions_path") + 1]
        run_id = captured["argv"][captured["argv"].index("--run_id") + 1]
        rep = score.report_path(preds, run_id, Path(cwd))
        rep.write_text(json.dumps(report_payload, indent=2), encoding="utf-8")
        return rc

    return runner


# ── argv shape (RF-1) ───────────────────────────────────────────────────────


def test_build_argv_defaults_to_prebuilt_namespace_and_pinned_flags():
    argv = score.build_argv(
        "preds.jsonl", "run-x", ["a__b-1", "c__d-2"]
    )
    # Default is the published prebuilt images (bead hbjw: the local x86 build
    # segfaults under emulation on arm64).
    ns_idx = argv.index("--namespace")
    assert argv[ns_idx + 1] == "swebench"
    assert score.DEFAULT_NAMESPACE == "swebench"

    # --cache_level instance
    cl_idx = argv.index("--cache_level")
    assert argv[cl_idx + 1] == "instance"

    # dataset / predictions / run_id present with expected values
    assert argv[argv.index("--dataset_name") + 1] == score.DATASET_NAME
    assert argv[argv.index("--predictions_path") + 1] == "preds.jsonl"
    assert argv[argv.index("--run_id") + 1] == "run-x"

    # instance ids passed explicitly, all of them
    ii_idx = argv.index("--instance_ids")
    assert argv[ii_idx + 1 :] == ["a__b-1", "c__d-2"]

    # invokes the official harness module, not a reimplementation
    assert "swebench.harness.run_evaluation" in argv
    assert "--max_workers" in argv and argv[argv.index("--max_workers") + 1] == "1"


def test_build_argv_empty_namespace_selects_local_build():
    # The empty string still reaches the harness verbatim: optional_str("")
    # -> None -> build_env_images (local build).
    argv = score.build_argv("p.jsonl", "r", ["i-1"], namespace="")
    assert argv[argv.index("--namespace") + 1] == ""


def test_score_predictions_passes_namespace(tmp_path):
    preds = tmp_path / "preds.jsonl"
    ids = ["psf__requests-1963"]
    _write_preds(preds, "gold", ids)
    captured: dict = {}
    runner = _fake_runner_factory(
        _canned_report(ids, []), captured=captured
    )
    score.score_predictions(
        preds, "ns", ids, runner=runner, cwd=tmp_path, namespace=""
    )
    assert captured["argv"][captured["argv"].index("--namespace") + 1] == ""
    assert json.loads((tmp_path / "report.json").read_text())["namespace"] == ""


def test_default_runner_refuses_interpreter_without_swebench(tmp_path, monkeypatch):
    # The harness runs under sys.executable; an interpreter without swebench
    # used to fail only after hours of generation, with a misleading
    # "report not found". It must fail before the harness starts.
    import importlib.util

    real = importlib.util.find_spec
    monkeypatch.setattr(
        importlib.util, "find_spec",
        lambda name, *a, **k: None if name == "swebench" else real(name, *a, **k),
    )
    def _no_harness(_timeout):
        raise AssertionError("harness must not start")

    monkeypatch.setattr(score, "_make_default_runner", _no_harness)
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ["psf__requests-1963"])
    with pytest.raises(RuntimeError, match="swebench"):
        score.score_predictions(
            preds, "x", ["psf__requests-1963"], cwd=tmp_path
        )


def test_cli_passes_empty_namespace_through(tmp_path, monkeypatch):
    seen = {}

    def fake_score(*a, **k):
        seen.update(k)
        return {"resolved": 0, "total": 1, "report_out": "r.json"}

    monkeypatch.setattr(score, "score_predictions", fake_score)
    monkeypatch.setattr(score, "require_swebench", lambda: None)
    monkeypatch.setattr(sys, "argv", ["score.py", "--predictions_path", "p.jsonl",
                                      "--run_id", "r", "--instance_ids", "i-1",
                                      "--namespace", ""])
    score.main()
    assert seen["namespace"] == ""


def test_build_argv_dataset_override():
    argv = score.build_argv("p.jsonl", "r", ["i-1"], dataset="custom/DS")
    assert argv[argv.index("--dataset_name") + 1] == "custom/DS"


# ── report parsing ──────────────────────────────────────────────────────────


def test_parse_report_counts(tmp_path):
    ids = ["i-1", "i-2", "i-3"]
    rep_file = tmp_path / "m.run.json"
    rep_file.write_text(
        json.dumps(_canned_report(["i-1", "i-3"], ["i-2"])), encoding="utf-8"
    )
    norm = score.parse_report(rep_file, ids, run_id="run")
    assert norm["resolved"] == 2
    assert norm["total"] == 3
    assert norm["resolved_ids"] == ["i-1", "i-3"]
    assert norm["unresolved_ids"] == ["i-2"]
    assert norm["per_instance"] == {
        "i-1": "resolved",
        "i-2": "unresolved",
        "i-3": "resolved",
    }
    assert norm["snapshot_revision"] == subset.SNAPSHOT_REVISION


def test_parse_report_rejects_non_dict_json(tmp_path):
    # A harness report that is a bare array / string / null would make
    # raw.get(...) raise an opaque AttributeError; parse_report must fail with a
    # clear message naming the file and shape instead.
    rep_file = tmp_path / "m.run.json"
    rep_file.write_text("[]", encoding="utf-8")
    with pytest.raises(ValueError, match="not a JSON object"):
        score.parse_report(rep_file, ["i-1"], run_id="run")


def test_parse_report_missing_instance_counts_unresolved(tmp_path):
    """An instance we asked to score but absent from the harness report (error /
    empty-patch / incomplete) is counted unresolved — no crash."""
    ids = ["i-1", "i-MISSING"]
    rep_file = tmp_path / "m.run.json"
    # Harness report only knows about i-1 (resolved); i-MISSING never appears.
    rep_file.write_text(
        json.dumps(_canned_report(["i-1"], [])), encoding="utf-8"
    )
    norm = score.parse_report(rep_file, ids, run_id="run")
    assert norm["resolved"] == 1
    assert norm["total"] == 2
    assert norm["per_instance"]["i-MISSING"] == "unresolved"
    assert "i-MISSING" in norm["unresolved_ids"]


# ── end-to-end (offline, fake runner) ───────────────────────────────────────


def test_score_predictions_offline_full_flow(tmp_path):
    ids = ["psf__requests-1963", "psf__requests-2148"]
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ids)

    captured: dict = {}
    runner = _fake_runner_factory(
        _canned_report(["psf__requests-1963"], ["psf__requests-2148"]),
        captured=captured,
    )

    norm = score.score_predictions(
        preds, "spike-gold", ids, runner=runner, cwd=tmp_path
    )

    # runner saw the default (prebuilt) namespace
    ns_idx = captured["argv"].index("--namespace")
    assert captured["argv"][ns_idx + 1] == "swebench"
    assert captured["cwd"] == tmp_path

    # normalized counts correct
    assert norm["resolved"] == 1
    assert norm["total"] == 2
    assert norm["harness_exit_code"] == 0

    # report.json written to cwd and parseable
    out = tmp_path / "report.json"
    assert out.exists()
    on_disk = json.loads(out.read_text(encoding="utf-8"))
    assert on_disk["resolved"] == 1
    assert on_disk["dataset"] == score.DATASET_NAME
    assert on_disk["raw"]["schema_version"] == 2


def test_score_predictions_raises_when_report_absent(tmp_path):
    ids = ["i-1"]
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ids)

    def noop_runner(argv, cwd):  # writes no report
        return 0

    with pytest.raises(FileNotFoundError):
        score.score_predictions(
            preds, "run", ids, runner=noop_runner, cwd=tmp_path
        )


def test_nonzero_harness_exit_with_report_warns(tmp_path):
    # A harness crash that still left a (partial) report must NOT be consumed
    # silently — score_predictions warns and surfaces harness_exit_code.
    ids = ["psf__requests-1963", "psf__requests-2148"]
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ids)
    captured: dict = {}
    runner = _fake_runner_factory(
        _canned_report(["psf__requests-1963"], ["psf__requests-2148"]),
        captured=captured,
        rc=1,
    )

    with pytest.warns(RuntimeWarning, match="exited 1"):
        norm = score.score_predictions(
            preds, "run", ids, runner=runner, cwd=tmp_path
        )
    assert norm["harness_exit_code"] == 1


def test_model_name_missing_field_raises_value_error(tmp_path):
    preds = tmp_path / "preds.jsonl"
    preds.write_text(json.dumps({"instance_id": "i-1", "model_patch": "x"}) + "\n",
                     encoding="utf-8")
    with pytest.raises(ValueError):
        score.model_name_from_predictions(preds)


def test_report_path_replaces_slash(tmp_path):
    preds = tmp_path / "p.jsonl"
    _write_preds(preds, "org/model", ["i-1"])
    rp = score.report_path(preds, "rid", tmp_path)
    assert rp.name == "org__model.rid.json"


# ── integration: live gold-patch scoring (Docker-gated) ─────────────────────

_DOCKER_ABSENT = (
    shutil.which("docker") is None
    or subprocess.run(
        ["docker", "info"], capture_output=True
    ).returncode
    != 0
)
_skip_no_docker = pytest.mark.skipif(
    _DOCKER_ABSENT, reason="Docker unavailable; skipping live harness scoring"
)


# Harness-correctness anchor: a HERMETIC instance whose test suite needs NO
# external network, so a gold-patch pass isolates "is score.py + the harness
# correct" from environmental flakiness. NOT psf__requests-* — those 2014-era
# suites hit httpbin.org and score false-negative without external network
# (bd memory swebench-requests-network-flaky-2026-06-07). sympy is pure-Python
# and hermetic.
GOLD_SANITY_INSTANCE = "sympy__sympy-24213"


@pytest.mark.integration
@_skip_no_docker
def test_gold_patch_scores_resolved(tmp_path):
    """RF-1 mirror: a gold-patch prediction must score RESOLVED via the REAL
    official harness on local arm64 images. The harness-correctness guard — if
    the gold patch does not resolve, scoring is broken, not the agents.

    Non-vacuous: asserts resolved == 1 (not > 0). Uses a HERMETIC instance
    (GOLD_SANITY_INSTANCE) so the guard does not conflate a score.py/harness
    defect with external-network flakiness; the gold patch is the dataset row's
    own ``patch`` field, so a correct harness MUST resolve it.
    """
    try:
        rows = subset.load_full_rows()
    except Exception as exc:  # pragma: no cover - network/dataset unavailable
        pytest.skip(f"dataset unavailable (no network?): {exc}")

    instance_ids = [GOLD_SANITY_INSTANCE]
    preds = tmp_path / "gold_preds.jsonl"
    with preds.open("w", encoding="utf-8") as fh:
        for iid in instance_ids:
            fh.write(
                json.dumps(
                    {
                        "instance_id": iid,
                        "model_name_or_path": "gold",
                        "model_patch": rows[iid]["patch"],
                    }
                )
                + "\n"
            )

    norm = score.score_predictions(
        preds, "test-gold", instance_ids, cwd=tmp_path
    )
    assert norm["resolved"] == len(instance_ids), (
        f"gold patch must resolve all {len(instance_ids)} instances; "
        f"got {norm['resolved']} (report: {norm})"
    )
    assert norm["per_instance"][GOLD_SANITY_INSTANCE] == "resolved"


# ── per-instance apply status (clean-apply signal) ──────────────────────────


def _write_log(base: Path, run_id, model, iid, body):
    d = base / "logs" / "run_evaluation" / run_id / model / iid
    d.mkdir(parents=True, exist_ok=True)
    (d / "run_instance.log").write_text(body, encoding="utf-8")


def test_parse_apply_status_pass_fail_missing(tmp_path):
    run_id, model = "rid", "m"
    log_dir = score.instance_log_dir(tmp_path, run_id, model)
    _write_log(tmp_path, run_id, model, "passed",
               f"...\n{score.APPLY_PASS_MARKER}:\n hunk ok\n")
    _write_log(tmp_path, run_id, model, "failed",
               f"...\n{score.APPLY_FAIL_MARKER}:\n conflict\n")
    _write_log(tmp_path, run_id, model, "neither", "ran but no marker\n")
    status = score.parse_apply_status(
        log_dir, ["passed", "failed", "neither", "absent"]
    )
    assert status == {
        "passed": True, "failed": False, "neither": None, "absent": None
    }


def test_instance_log_dir_shape(tmp_path):
    p = score.instance_log_dir(tmp_path, "rid", "model.arm-a")
    assert p == tmp_path / "logs" / "run_evaluation" / "rid" / "model.arm-a"


# ── harness timeout configurability (recovery from the 2h-cap failure) ───────


def test_default_harness_timeout_is_generous_for_cold_40_instance_scoring():
    # The old 2h (7200s) cap killed cold 40-instance scoring mid-eval. The
    # default must give cold scoring (env-image builds + eval) ample headroom.
    assert score.DEFAULT_HARNESS_TIMEOUT_SECONDS >= 14400  # >= 4h


def test_make_default_runner_returns_callable_per_timeout():
    r1 = score._make_default_runner(60)
    r2 = score._make_default_runner(3600)
    assert callable(r1) and callable(r2) and r1 is not r2


def test_score_predictions_threads_harness_timeout_to_built_runner(tmp_path, monkeypatch):
    # The swebench preflight is not under test here; keep this test valid in a
    # pytest-only interpreter (requirements-dev.txt does not install swebench).
    monkeypatch.setattr(score, "require_swebench", lambda: None)
    # When no runner is injected, score_predictions builds one with the given
    # harness_timeout; verify the timeout reaches the subprocess wait. The
    # default runner uses Popen + wait(timeout=) (start_new_session) so a hung
    # harness's whole process group can be SIGKILLed on timeout.
    captured = {}

    class _FakeProc:
        pid = 4321

        def wait(self, timeout=None):
            captured["timeout"] = timeout
            # Write a minimal harness report so parse_report succeeds.
            rep = score.report_path(tmp_path / "preds.jsonl", "rid", tmp_path)
            rep.write_text('{"resolved_ids": [], "completed_ids": []}', encoding="utf-8")
            return 0

    def fake_popen(argv, cwd=None, start_new_session=False):
        captured["start_new_session"] = start_new_session
        return _FakeProc()

    monkeypatch.setattr("subprocess.Popen", fake_popen)
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ["x"])
    score.score_predictions(
        preds, "rid", ["x"],
        harness_timeout=12345, cwd=tmp_path, report_out=tmp_path / "out.json",
    )
    assert captured["timeout"] == 12345
    assert captured["start_new_session"] is True


def test_default_runner_kills_process_group_on_timeout(tmp_path, monkeypatch):
    # A harness that exceeds the cutoff must have its whole process group
    # SIGKILLed (not merely abandoned, which orphans Docker containers), and the
    # runner must return the distinct 124 code.
    import signal
    import subprocess

    killed = {}

    class _HangingProc:
        pid = 9999

        def __init__(self):
            self._waits = 0

        def wait(self, timeout=None):
            self._waits += 1
            if self._waits == 1:
                raise subprocess.TimeoutExpired(cmd="harness", timeout=timeout)
            return 0  # bounded reap after kill

    monkeypatch.setattr("subprocess.Popen", lambda *a, **k: _HangingProc())
    monkeypatch.setattr("os.getpgid", lambda pid: pid)
    monkeypatch.setattr("os.killpg", lambda pgid, sig: killed.update(pgid=pgid, sig=sig))

    runner = score._make_default_runner(timeout_seconds=0.01)
    rc = runner(["harness"], tmp_path)
    assert rc == 124
    assert killed["pgid"] == 9999
    assert killed["sig"] == signal.SIGKILL


def test_build_argv_max_workers_default_and_override():
    a1 = score.build_argv("p.jsonl", "r", ["i"])
    assert a1[a1.index("--max_workers") + 1] == "1"   # headline default
    a4 = score.build_argv("p.jsonl", "r", ["i"], max_workers=4)
    assert a4[a4.index("--max_workers") + 1] == "4"   # batched probe override


def test_parse_crash_ids_flags_emulation_crashes(tmp_path):
    # Bead hbjw: under Docker's x86 emulation a test run can segfault, which the
    # harness scores as unresolved. Such instances must be visible for re-score.
    for iid, text in {
        "a__b-1": "ok\n/eval.sh: line 49:   199 Segmentation fault      (core dumped) ./runtests.py\n",
        "c__d-2": "gcc: internal compiler error: Segmentation fault signal terminated program cc1\n",
        "e__f-3": "all tests passed\n",
    }.items():
        (tmp_path / iid).mkdir()
        (tmp_path / iid / "test_output.txt").write_text(text)
    assert score.parse_crash_ids(tmp_path, ["a__b-1", "c__d-2", "e__f-3", "g__h-4"]) == [
        "a__b-1",
        "c__d-2",
    ]


def test_score_predictions_reports_unresolved_crash_suspects(tmp_path):
    preds = tmp_path / "preds.jsonl"
    ids = ["psf__requests-1963", "psf__requests-2148"]
    _write_preds(preds, "gold", ids)
    captured: dict = {}
    base = _fake_runner_factory(_canned_report(["psf__requests-1963"], ["psf__requests-2148"]), captured=captured)

    def runner(argv, cwd):
        rc = base(argv, cwd)
        log_dir = score.instance_log_dir(cwd, "crash", "gold")
        for iid in ids:  # both crashed; only the unresolved one is a suspect
            (log_dir / iid).mkdir(parents=True, exist_ok=True)
            (log_dir / iid / "test_output.txt").write_text("Segmentation fault (core dumped)\n")
        return rc

    with pytest.warns(RuntimeWarning, match="re-score"):
        norm = score.score_predictions(preds, "crash", ids, runner=runner, cwd=tmp_path)
    assert norm["crash_suspect_ids"] == ["psf__requests-2148"]
