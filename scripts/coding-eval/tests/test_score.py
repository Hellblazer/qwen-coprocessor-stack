# SPDX-License-Identifier: MIT
"""Tests for the official-harness scoring wrapper (RDR-006 40v.8).

Offline unit tests (ALWAYS run): inject a fake runner that writes a canned
swebench report to the path the real harness would, and assert (a) the argv we
build matches the RF-1 proven shape — crucially ``--namespace ''`` (the empty
string), ``--cache_level instance``, the dataset name, predictions path, run_id,
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


def test_build_argv_has_empty_namespace_and_pinned_flags():
    argv = score.build_argv(
        "preds.jsonl", "run-x", ["a__b-1", "c__d-2"]
    )
    # --namespace immediately followed by the EMPTY STRING (load-bearing arm64).
    ns_idx = argv.index("--namespace")
    assert argv[ns_idx + 1] == "", "namespace value must be the empty string"

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

    # runner saw the RF-1 argv with empty namespace
    ns_idx = captured["argv"].index("--namespace")
    assert captured["argv"][ns_idx + 1] == ""
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
    # When no runner is injected, score_predictions builds one with the given
    # harness_timeout; verify the timeout reaches subprocess.run.
    captured = {}

    class _Done:
        returncode = 0

    def fake_run(argv, cwd=None, timeout=None):
        captured["timeout"] = timeout
        # Write a minimal harness report so parse_report succeeds.
        rep = score.report_path(tmp_path / "preds.jsonl", "rid", tmp_path)
        rep.write_text('{"resolved_ids": [], "completed_ids": []}', encoding="utf-8")
        return _Done()

    monkeypatch.setattr("subprocess.run", fake_run)
    preds = tmp_path / "preds.jsonl"
    _write_preds(preds, "gold", ["x"])
    score.score_predictions(
        preds, "rid", ["x"],
        harness_timeout=12345, cwd=tmp_path, report_out=tmp_path / "out.json",
    )
    assert captured["timeout"] == 12345


def test_build_argv_max_workers_default_and_override():
    a1 = score.build_argv("p.jsonl", "r", ["i"])
    assert a1[a1.index("--max_workers") + 1] == "1"   # headline default
    a4 = score.build_argv("p.jsonl", "r", ["i"], max_workers=4)
    assert a4[a4.index("--max_workers") + 1] == "4"   # batched probe override
