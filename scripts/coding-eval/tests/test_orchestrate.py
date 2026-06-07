# SPDX-License-Identifier: MIT
"""Tests for orchestrate.py (RDR-006 top-level glue).

Focus: the orchestrator is THIN — it wires the already-tested seams
(arm.run_instance, score.score_predictions, telemetry.normalize/write,
report.build_report) without re-implementing them. These tests inject fakes
for every live seam so the suite stays offline and fast.

Invariants under test:
  * fresh-run: predictions + telemetry files are TRUNCATED before a run (no
    stale-line accumulation across re-runs).
  * one telemetry line per instance, unified schema, even on per-instance error.
  * a per-instance run failure does NOT abort the arm — it is recorded as an
    ERROR RunResult and an empty prediction is still written so scoring sees it.
  * contamination is surfaced (collected per arm), never silently dropped.
  * the report is built from the scored arms and written to the docs path.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import orchestrate  # noqa: E402
import run_arm  # noqa: E402
import variance  # noqa: E402


# ── fakes ───────────────────────────────────────────────────────────────────


def _fake_arm_module(arm, *, model_name=None, fail_ids=frozenset(),
                     contaminate_ids=frozenset(), patch="diff --git a/f b/f\n+x\n"):
    """A stand-in arm module: ARM/MODEL_NAME + a run_instance that writes a real
    prediction line and returns a RunResult. ``fail_ids`` raise inside
    run_instance (driver failure); ``contaminate_ids`` flag contamination."""
    mod = types.SimpleNamespace()
    mod.ARM = arm
    mod.MODEL_NAME = model_name or f"model.arm-{arm.lower()}"

    def run_instance(instance_id, *, rows=None, predictions_path, model_name=mod.MODEL_NAME):
        if instance_id in fail_ids:
            raise RuntimeError(f"boom {instance_id}")
        run_arm.write_prediction(predictions_path, instance_id, model_name, patch)
        return run_arm.RunResult(
            instance_id=instance_id,
            arm=arm,
            outcome=run_arm.Outcome.COMPLETED,
            model_patch=patch,
            test_edit_contamination=instance_id in contaminate_ids,
            duration_seconds=1.0,
            returncode=0,
            telemetry={"turns": 3, "num_turns": 3},
        )

    mod.run_instance = run_instance
    return mod


def _fake_score_fn(resolved_ids):
    """A score.score_predictions stand-in returning a normalized report dict."""
    def score_predictions(predictions_path, run_id, instance_ids, *, report_out=None, **kw):
        ids = list(instance_ids)
        resolved = [i for i in ids if i in resolved_ids]
        rep = {
            "resolved": len(resolved),
            "total": len(ids),
            "resolved_ids": resolved,
            "unresolved_ids": [i for i in ids if i not in resolved_ids],
            "raw": {i: {"patch_exists": True,
                        "patch_successfully_applied": True,
                        "resolved": i in resolved_ids} for i in ids},
            "harness_exit_code": 0,
        }
        if report_out is not None:
            Path(report_out).write_text(json.dumps(rep), encoding="utf-8")
        return rep
    return score_predictions


# ── select_instance_ids ──────────────────────────────────────────────────────


def test_select_instance_ids_limit(monkeypatch):
    # Unsorted-by-construction input + an order-preserving selector; the function
    # sorts, so limit takes a deterministic prefix regardless of selector order.
    fake = [types.SimpleNamespace(instance_id=f"i{n:02d}", repo="r")
            for n in (5, 0, 9, 1, 3, 2, 4, 8, 7, 6)]
    ids = orchestrate.select_instance_ids(
        limit=5, loader=lambda: fake, selector=lambda insts: insts
    )
    assert ids == [f"i{n:02d}" for n in range(5)]


# ── run_one_arm ──────────────────────────────────────────────────────────────


def test_run_one_arm_writes_one_pred_and_telemetry_per_instance(tmp_path):
    mod = _fake_arm_module("A")
    ids = ["a", "b", "c"]
    ar = orchestrate.run_one_arm(
        "A", ids, rows={}, out_dir=tmp_path, arm_modules={"A": mod}
    )
    preds = [json.loads(l) for l in ar.predictions_path.read_text().splitlines()]
    tele = [json.loads(l) for l in ar.telemetry_path.read_text().splitlines()]
    assert [p["instance_id"] for p in preds] == ids
    assert [t["instance_id"] for t in tele] == ids
    assert all(t["arm"] == "A" for t in tele)
    assert len(ar.results) == 3


def test_run_one_arm_truncates_stale_files(tmp_path):
    mod = _fake_arm_module("A")
    # Seed stale content.
    (tmp_path / "predictions.A.jsonl").write_text('{"stale":1}\n')
    (tmp_path / "telemetry.A.jsonl").write_text('{"stale":1}\n')
    ar = orchestrate.run_one_arm(
        "A", ["a"], rows={}, out_dir=tmp_path, arm_modules={"A": mod}
    )
    preds = ar.predictions_path.read_text().splitlines()
    assert len(preds) == 1
    assert json.loads(preds[0])["instance_id"] == "a"


def test_run_one_arm_records_failure_as_error_with_empty_pred(tmp_path):
    mod = _fake_arm_module("B", fail_ids={"b"})
    ar = orchestrate.run_one_arm(
        "B", ["a", "b", "c"], rows={}, out_dir=tmp_path, arm_modules={"B": mod}
    )
    preds = {json.loads(l)["instance_id"]: json.loads(l)
             for l in ar.predictions_path.read_text().splitlines()}
    # All three instances present (b as empty patch so scoring still sees it).
    assert set(preds) == {"a", "b", "c"}
    assert preds["b"]["model_patch"] == ""
    errored = [r for r in ar.results if r.outcome is run_arm.Outcome.ERROR]
    assert [r.instance_id for r in errored] == ["b"]


def test_run_one_arm_collects_contamination(tmp_path):
    mod = _fake_arm_module("A", contaminate_ids={"b"})
    ar = orchestrate.run_one_arm(
        "A", ["a", "b"], rows={}, out_dir=tmp_path, arm_modules={"A": mod}
    )
    assert ar.contaminated_ids == ["b"]


def test_contamination_round_trips_into_telemetry_jsonl(tmp_path):
    # The taxonomy in the rendered report reads test_edit_contamination back
    # from the telemetry JSONL — it MUST be written, not only collected in the
    # summary. (Guards the telemetry-schema gap the critic flagged.)
    mod = _fake_arm_module("A", contaminate_ids={"b"})
    ar = orchestrate.run_one_arm(
        "A", ["a", "b"], rows={}, out_dir=tmp_path, arm_modules={"A": mod}
    )
    recs = orchestrate._read_telemetry(ar.telemetry_path)
    by_id = {r["instance_id"]: r for r in recs}
    assert by_id["b"]["test_edit_contamination"] is True
    assert by_id["a"]["test_edit_contamination"] is False


def test_model_name_falls_back_when_arm_lacks_name_attrs(tmp_path):
    # A module missing both MODEL_NAME and DEFAULT_MODEL_NAME must not crash the
    # fail-soft path — _model_name returns a sentinel, the loop continues.
    mod = types.SimpleNamespace(ARM="A")

    def run_instance(instance_id, *, rows=None, predictions_path, model_name=None):
        raise RuntimeError("boom")

    mod.run_instance = run_instance
    ar = orchestrate.run_one_arm(
        "A", ["a"], rows={}, out_dir=tmp_path, arm_modules={"A": mod}
    )
    pred = json.loads(ar.predictions_path.read_text().splitlines()[0])
    assert pred["model_name_or_path"] == "unknown"
    assert ar.results[0].outcome is run_arm.Outcome.ERROR


# ── score_one_arm ────────────────────────────────────────────────────────────


def _stateful_arm(arm, *, error_until, patch="diff --git a/f b/f\n+y\n"):
    """run_instance returns ERROR for the first ``error_until[iid]`` calls of an
    instance, then COMPLETED. Records call counts in mod.calls."""
    mod = types.SimpleNamespace(ARM=arm, MODEL_NAME=f"m.{arm}", calls={})

    def run_instance(instance_id, *, rows=None, predictions_path, model_name=f"m.{arm}"):
        mod.calls[instance_id] = mod.calls.get(instance_id, 0) + 1
        if mod.calls[instance_id] <= error_until.get(instance_id, 0):
            return run_arm.RunResult(
                instance_id=instance_id, arm=arm,
                outcome=run_arm.Outcome.ERROR, model_patch="", returncode=1,
            )
        run_arm.write_prediction(predictions_path, instance_id, model_name, patch)
        return run_arm.RunResult(
            instance_id=instance_id, arm=arm,
            outcome=run_arm.Outcome.COMPLETED, model_patch=patch, returncode=0,
        )

    mod.run_instance = run_instance
    return mod


def test_run_one_arm_retries_transient_error_then_succeeds(tmp_path):
    mod = _stateful_arm("B", error_until={"x": 1})  # fail once, then succeed
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
        error_retries=1,
    )
    assert mod.calls["x"] == 2  # one retry
    assert ar.results[0].outcome is run_arm.Outcome.COMPLETED
    preds = ar.predictions_path.read_text().splitlines()
    assert len(preds) == 1  # no duplicate line from the failed attempt
    assert json.loads(preds[0])["model_patch"]  # final non-empty patch
    # attempts count actually LANDS in the telemetry JSONL (not just in-memory).
    rec = orchestrate._read_telemetry(ar.telemetry_path)[0]
    assert rec["outcome"] == "completed"
    assert rec["attempts"] == 2


def test_first_try_success_records_one_attempt(tmp_path):
    mod = _stateful_arm("B", error_until={})
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
    )
    rec = orchestrate._read_telemetry(ar.telemetry_path)[0]
    assert rec["attempts"] == 1


def test_run_one_arm_retries_on_raised_exception(tmp_path):
    # The exception path (run_instance RAISES) must also retry, then exhaust to
    # a synthesized ERROR + empty prediction.
    mod = _fake_arm_module("B", fail_ids={"x"})  # raises every call
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
        error_retries=2,
    )
    assert ar.results[0].outcome is run_arm.Outcome.ERROR
    rec = orchestrate._read_telemetry(ar.telemetry_path)[0]
    assert rec["attempts"] == 3
    preds = ar.predictions_path.read_text().splitlines()
    assert len(preds) == 1 and json.loads(preds[0])["model_patch"] == ""


def test_run_one_arm_does_not_retry_timeout_or_turnlimit(tmp_path):
    for oc in (run_arm.Outcome.TIMEOUT, run_arm.Outcome.TURN_LIMIT):
        mod = types.SimpleNamespace(ARM="B", MODEL_NAME="m.B", n=0)

        def run_instance(iid, *, rows=None, predictions_path, model_name="m.B", _oc=oc, _m=mod):
            _m.n += 1
            return run_arm.RunResult(instance_id=iid, arm="B", outcome=_oc,
                                     model_patch="", returncode=0)

        mod.run_instance = run_instance
        orchestrate.run_one_arm(
            "B", ["x"], rows={}, out_dir=tmp_path / oc.value,
            arm_modules={"B": mod}, error_retries=3,
        )
        assert mod.n == 1, f"{oc} must not be retried"


def test_run_one_arm_persistent_error_exhausts_retries(tmp_path):
    mod = _stateful_arm("B", error_until={"x": 99})  # always ERROR
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
        error_retries=2,
    )
    assert mod.calls["x"] == 3  # initial + 2 retries
    assert ar.results[0].outcome is run_arm.Outcome.ERROR
    preds = ar.predictions_path.read_text().splitlines()
    assert len(preds) == 1
    assert json.loads(preds[0])["model_patch"] == ""  # empty patch recorded once


def test_run_one_arm_no_retry_when_disabled(tmp_path):
    mod = _stateful_arm("B", error_until={"x": 1})
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
        error_retries=0,
    )
    assert mod.calls["x"] == 1  # no retry
    assert ar.results[0].outcome is run_arm.Outcome.ERROR


def test_run_one_arm_does_not_retry_nonerror_outcomes(tmp_path):
    # A COMPLETED-but-unresolved (real model verdict) must NOT be retried.
    mod = _stateful_arm("B", error_until={})  # always COMPLETED first try
    ar = orchestrate.run_one_arm(
        "B", ["x"], rows={}, out_dir=tmp_path, arm_modules={"B": mod},
        error_retries=3,
    )
    assert mod.calls["x"] == 1


def test_score_one_arm_attaches_normalized_report(tmp_path):
    mod = _fake_arm_module("C")
    ar = orchestrate.run_one_arm(
        "C", ["a", "b"], rows={}, out_dir=tmp_path, arm_modules={"C": mod}
    )
    rep = orchestrate.score_one_arm(
        ar, run_id="t", instance_ids=["a", "b"], out_dir=tmp_path,
        score_fn=_fake_score_fn({"a"}),
    )
    assert rep["resolved"] == 1
    assert ar.score is rep


# ── full orchestrate (offline, all seams faked) ──────────────────────────────


def test_orchestrate_end_to_end_writes_report(tmp_path):
    mods = {
        "A": _fake_arm_module("A"),
        "B": _fake_arm_module("B"),
        "C": _fake_arm_module("C"),
    }
    docs = tmp_path / "eval.md"
    summary = orchestrate.orchestrate(
        arms="ABC",
        instance_ids=["a", "b", "c"],
        rows={},
        out_dir=tmp_path,
        docs_path=docs,
        run_id="t",
        arm_modules=mods,
        score_fn=_fake_score_fn({"a", "b"}),
    )
    assert docs.exists()
    md = docs.read_text()
    assert "A" in md and "B" in md and "C" in md
    # Each arm scored 2/3 resolved -> all pairwise deltas inside the zone.
    assert summary["arms"] == ["A", "B", "C"]
    for arm in "ABC":
        assert summary["scorecards"][arm]["resolved"] == 2


def test_orchestrate_distinct_tool_sets_per_arm(tmp_path):
    # report.build_report rejects duplicate tool_set strings; orchestrate must
    # supply distinct ones for A/B/C.
    assert len(set(orchestrate.TOOL_SETS.values())) == 3


def test_orchestrate_truncates_stale_files_end_to_end(tmp_path):
    # Integration-level guard: stale lines present BEFORE orchestrate() must be
    # gone after (not just at the run_one_arm seam).
    (tmp_path / "predictions.A.jsonl").write_text('{"stale":1}\n{"stale":2}\n')
    (tmp_path / "telemetry.A.jsonl").write_text('{"stale":1}\n')
    orchestrate.orchestrate(
        arms="A", instance_ids=["a"], rows={}, out_dir=tmp_path,
        docs_path=tmp_path / "eval.md", run_id="t",
        arm_modules={"A": _fake_arm_module("A")},
        score_fn=_fake_score_fn({"a"}),
    )
    preds = (tmp_path / "predictions.A.jsonl").read_text().splitlines()
    assert len(preds) == 1 and json.loads(preds[0])["instance_id"] == "a"


def test_orchestrate_renders_band_when_flips_supplied(tmp_path):
    docs = tmp_path / "eval.md"
    flips = {a: {"band_points": 5.0, "band_method": "flip-rate-projection"}
             for a in "ABC"}
    orchestrate.orchestrate(
        arms="ABC", instance_ids=["a", "b", "c"], rows={}, out_dir=tmp_path,
        docs_path=docs, run_id="t",
        arm_modules={a: _fake_arm_module(a) for a in "ABC"},
        score_fn=_fake_score_fn({"a", "b"}),
        flips=flips,
    )
    md = docs.read_text()
    assert "±5.0 pp" in md
    assert "not a CI" in md
    # All arms resolve 2/3 -> every pairwise delta is inside the zone.
    assert "not detectable at this scale" in md


def test_run_variance_serializes_records_to_dicts(tmp_path):
    # run_variance must return PLAIN DICTS (report.py calls .get on them), not
    # FlipRateRecord dataclasses. Inject a fake probe_fn + selector to stay
    # offline; assert the band dict survives the to_dict() serialization.
    calls = []

    def fake_run_and_score_probe(arms, ids, run_and_score, *, full_size):
        # Drive run_and_score so the adapter (and its score_fn) is exercised.
        for a in arms:
            for i in ids:
                run_and_score(a, i, 0)
        return {
            a: variance.summarize_arm(a, {i: [True, False, True] for i in ids},
                                      full_size=full_size)
            for a in arms
        }

    flips = orchestrate.run_variance(
        "AB", ["a", "b", "c"], rows={}, out_dir=tmp_path, run_id="t",
        arm_modules={a: _fake_arm_module(a) for a in "AB"},
        score_fn=_fake_score_fn({"a"}),
        probe_fn=fake_run_and_score_probe,
        probe_selector=lambda ids: list(ids),
    )
    assert set(flips) == {"A", "B"}
    for rec in flips.values():
        assert isinstance(rec, dict)  # serialized, not a dataclass
        assert "band_points" in rec and "band_method" in rec
    assert (tmp_path / "flip_rates.json").exists()


def test_probe_path_retries_transient_error(tmp_path):
    # The probe must get the SAME retry as the headline run, else an infra blip
    # registers as a false flip and inflates the band.
    mod = _stateful_arm("A", error_until={"x": 1})  # fail once then succeed
    ras = orchestrate.make_run_and_score(
        rows={}, out_dir=tmp_path, run_id="t",
        arm_modules={"A": mod}, score_fn=_fake_score_fn({"x"}),
        error_retries=1,
    )
    resolved = ras("A", "x", 0)
    assert resolved is True       # retry recovered the transient
    assert mod.calls["x"] == 2    # one retry in the probe path


def test_orchestrate_computes_variance_when_enabled(tmp_path):
    # do_variance=True with a subset >= PROBE_SIZE wires the probe end-to-end.
    ids = [f"i{n}" for n in range(variance.PROBE_SIZE)]
    docs = tmp_path / "eval.md"
    summary = orchestrate.orchestrate(
        arms="A", instance_ids=ids, rows={}, out_dir=tmp_path,
        docs_path=docs, run_id="t", do_variance=True,
        arm_modules={"A": _fake_arm_module("A")},
        score_fn=_fake_score_fn(set(ids)),
    )
    assert summary["flips"] is not None
    assert "A" in summary["flips"]
    assert "band_points" in summary["flips"]["A"]


def test_orchestrate_skips_variance_when_subset_too_small(tmp_path, capsys):
    summary = orchestrate.orchestrate(
        arms="A", instance_ids=["a", "b"], rows={}, out_dir=tmp_path,
        docs_path=tmp_path / "eval.md", run_id="t", do_variance=True,
        arm_modules={"A": _fake_arm_module("A")},
        score_fn=_fake_score_fn({"a"}),
    )
    assert summary["flips"] is None
    assert "skipping variance probe" in capsys.readouterr().err


def test_orchestrate_summary_keys_present_when_no_score(tmp_path):
    summary = orchestrate.orchestrate(
        arms="A", instance_ids=["a"], rows={}, out_dir=tmp_path,
        docs_path=tmp_path / "eval.md", run_id="t", do_score=False,
        arm_modules={"A": _fake_arm_module("A")},
    )
    # Keys present (None), so programmatic callers need no do_score guard.
    assert summary["docs_path"] is None
    assert summary["scorecards"] is None
