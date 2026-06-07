# SPDX-License-Identifier: MIT
"""RDR-006 top-level eval orchestrator — the thin glue that runs all arms over
the frozen subset, scores each via the official harness, and renders the report.

This module owns NO eval logic. Every step delegates to an already-tested,
independently-reviewed seam:

  * subset.select_subset / load_instances  — the frozen 40-instance subset
  * subset.load_full_rows                  — pinned dataset rows (one loader)
  * arm_a/arm_b/arm_c.run_instance         — per-arm, per-instance run
  * telemetry.normalize / write_telemetry  — unified per-instance telemetry line
  * score.score_predictions                — official swebench harness wrapper
  * variance.run_probe / select_probe…     — v1 flip-rate ±band probe (opt-in)
  * report.build_report                    — scorecards + deltas + markdown

Every live seam is injectable so the test suite runs fully offline. The CLI
``main()`` wires the production seams.

Fresh-run invariant: ``write_prediction`` and ``write_telemetry`` APPEND, so a
re-run would otherwise stack stale lines onto a prior run's files. ``run_one_arm``
TRUNCATES both files before the loop — each orchestrate() is a clean run.

Contamination invariant: an instance whose source patch was flagged as touching
test paths (``RunResult.test_edit_contamination``) is collected per arm and
surfaced loudly in the summary — never silently dropped.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))

import arm_a  # noqa: E402
import arm_b  # noqa: E402
import arm_c  # noqa: E402
import report  # noqa: E402
import run_arm  # noqa: E402
import score  # noqa: E402
import subset  # noqa: E402
import telemetry  # noqa: E402
import variance  # noqa: E402

HERE = Path(__file__).resolve().parent

# Production arm modules. Each exposes ARM, a model-name constant, and a uniform
# run_instance(instance_id, *, rows, predictions_path[, model_name]) -> RunResult.
ARM_MODULES: dict[str, Any] = {"A": arm_a, "B": arm_b, "C": arm_c}

# Tool-surface strings MUST be distinct per arm — report.build_report rejects
# duplicates (the A-vs-B tool-surface-parity claim hinges on them being
# genuinely different mechanisms: supervisor opt vs HOME fixture).
TOOL_SETS: dict[str, str] = {
    "A": "qwen core tools (nx disabled via supervisor extensions opt)",
    "B": "qwen core tools (nx disabled via clean HOME fixture)",
    "C": "claude core tools (sonnet, nx not applicable)",
}

DEFAULT_DOCS_PATH = HERE.parent.parent / "docs" / "qwen-coding-agent-eval.md"


def _model_name(mod: Any) -> str:
    """Each arm names its model differently (arm_a: DEFAULT_MODEL_NAME; arm_b/c:
    MODEL_NAME). Resolve whichever it exposes for the synthetic-error path."""
    return (
        getattr(mod, "MODEL_NAME", None)
        or getattr(mod, "DEFAULT_MODEL_NAME", None)
        or "unknown"
    )


@dataclass
class ArmRun:
    """Everything produced for one arm: the per-instance results, the on-disk
    artifact paths, the collected contamination ids, and (after scoring) the
    normalized score report."""

    arm: str
    results: list[run_arm.RunResult]
    predictions_path: Path
    telemetry_path: Path
    contaminated_ids: list[str] = field(default_factory=list)
    score: dict | None = None


def select_instance_ids(
    limit: int | None = None,
    *,
    loader: Callable[[], Sequence[Any]] = subset.load_instances,
    selector: Callable[[Sequence[Any]], Sequence[Any]] = subset.select_subset,
) -> list[str]:
    """Resolve the frozen subset to a sorted list of instance ids.

    ``limit`` (smoke runs only) takes the first N AFTER selection+sort, so a
    truncated run is still a deterministic prefix of the real subset.
    """
    chosen = selector(loader())
    # Sort here so the determinism guarantee is a property of THIS function, not
    # a precondition on the injected selector. limit then takes a stable prefix.
    ids = sorted(inst.instance_id for inst in chosen)
    if limit is not None:
        ids = ids[:limit]
    return ids


def _run_instance_with_retry(
    mod: Any,
    arm: str,
    iid: str,
    rows: Mapping[str, Mapping[str, Any]],
    attempt_dir: Path,
    *,
    error_retries: int,
) -> tuple[run_arm.RunResult, int]:
    """Run one instance, retrying ONLY on ERROR (infrastructure/invocation
    failures), up to ``error_retries`` extra attempts. Returns the first
    non-ERROR result, or the last ERROR if all attempts fail, plus the attempt
    count.

    Retry distinguishes a transient instant-fail (qwen-code/claude failing to
    start or briefly losing the inference endpoint — the Arm B smoke-run blip)
    from a genuine config break: a transient succeeds on a later attempt; a real
    failure exhausts the budget and is recorded as ERROR. We do NOT retry
    COMPLETED/TIMEOUT/TURN_LIMIT — those are real model verdicts, not infra
    failures, and re-running them would bias the eval.

    Scope: this covers the observed Arm B failure (nonzero-exit / immediate
    crash -> ERROR, duration ~0s) and unhandled exceptions. It does NOT cover an
    endpoint loss that lets the CLI exit 0 with empty output (classified
    COMPLETED with an empty patch) — retrying that would risk re-running a
    legitimate model give-up. Widen the predicate deliberately if such transients
    appear in the real run, not by reflex.

    Each attempt writes its prediction to a THROWAWAY path so retries never
    stack duplicate lines on the real predictions file; the caller writes the
    chosen result's prediction exactly once.
    """
    last: run_arm.RunResult | None = None
    attempts = 0
    for attempt in range(error_retries + 1):
        attempts += 1
        tmp_preds = attempt_dir / f".attempt.{arm}.{iid}.{attempt}.jsonl"
        if tmp_preds.exists():
            tmp_preds.unlink()
        try:
            res = mod.run_instance(iid, rows=rows, predictions_path=tmp_preds)
        except Exception as exc:  # noqa: BLE001 — fail-soft is the contract
            res = run_arm.RunResult(
                instance_id=iid,
                arm=arm,
                outcome=run_arm.Outcome.ERROR,
                model_patch="",
                returncode=1,
                telemetry={"orchestrator_error": repr(exc)},
            )
        finally:
            if tmp_preds.exists():
                tmp_preds.unlink()
        last = res
        if res.outcome is not run_arm.Outcome.ERROR:
            break
    assert last is not None  # error_retries >= 0 => at least one attempt
    return last, attempts


def run_one_arm(
    arm: str,
    instance_ids: Sequence[str],
    rows: Mapping[str, Mapping[str, Any]],
    out_dir: Path,
    *,
    arm_modules: Mapping[str, Any] = ARM_MODULES,
    error_retries: int = 1,
    on_progress: Callable[[str, run_arm.RunResult], None] | None = None,
) -> ArmRun:
    """Run one arm over every instance. Fresh-run (truncates artifacts first),
    fail-soft per instance with a bounded retry on ERROR (a transient instant-
    fail is retried; a real failure exhausts the budget and is recorded as ERROR
    + an empty prediction so scoring still sees the instance), one telemetry line
    per instance in the unified schema.

    The prediction + telemetry are written exactly ONCE per instance from the
    chosen result, so retries leave no duplicate lines."""
    mod = arm_modules[arm]
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    preds_path = out_dir / f"predictions.{arm}.jsonl"
    tele_path = telemetry.telemetry_path(arm, out_dir)

    # Fresh run: drop any prior lines before appending this run's.
    for p in (preds_path, tele_path):
        if p.exists():
            p.unlink()

    results: list[run_arm.RunResult] = []
    contaminated: list[str] = []
    for iid in instance_ids:
        res, attempts = _run_instance_with_retry(
            mod, arm, iid, rows, out_dir, error_retries=error_retries
        )
        # Write the chosen result's prediction once (the per-attempt temp files
        # are discarded). model_patch is the arm-uniform git extraction.
        run_arm.write_prediction(preds_path, iid, _model_name(mod), res.model_patch)
        if attempts > 1:
            res.telemetry = {**(res.telemetry or {}), "attempts": attempts}
        rec = telemetry.normalize(res, arm=arm)
        telemetry.write_telemetry(tele_path, rec)
        if res.test_edit_contamination:
            contaminated.append(iid)
        results.append(res)
        if on_progress is not None:
            on_progress(arm, res)

    return ArmRun(
        arm=arm,
        results=results,
        predictions_path=preds_path,
        telemetry_path=tele_path,
        contaminated_ids=contaminated,
    )


def score_one_arm(
    arm_run: ArmRun,
    run_id: str,
    instance_ids: Sequence[str],
    out_dir: Path,
    *,
    score_fn: Callable[..., dict] = score.score_predictions,
) -> dict:
    """Score one arm's predictions via the official harness wrapper and attach
    the normalized report to the ArmRun."""
    out_dir = Path(out_dir)
    rep = score_fn(
        arm_run.predictions_path,
        f"rdr006-arm{arm_run.arm}-{run_id}",
        list(instance_ids),
        report_out=out_dir / f"report.{arm_run.arm}.json",
    )
    arm_run.score = rep
    return rep


def _read_telemetry(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def build_and_write_report(
    arm_runs: Sequence[ArmRun],
    docs_path: Path,
    *,
    flips: Mapping[str, Mapping] | None = None,
    builder: Callable[..., tuple] = report.build_report,
) -> tuple[list, list, str]:
    """Assemble ArmInputs from each scored arm and render the markdown report."""
    flips = flips or {}
    inputs = [
        report.ArmInputs(
            arm=ar.arm,
            score=ar.score or {},
            telemetry=_read_telemetry(ar.telemetry_path),
            flip=flips.get(ar.arm),
            tool_set=TOOL_SETS.get(ar.arm, f"arm {ar.arm} tools"),
        )
        for ar in arm_runs
    ]
    cards, deltas, md = builder(inputs)
    docs_path = Path(docs_path)
    docs_path.parent.mkdir(parents=True, exist_ok=True)
    docs_path.write_text(md, encoding="utf-8")
    return cards, deltas, md


def make_run_and_score(
    rows: Mapping[str, Mapping[str, Any]],
    out_dir: Path,
    run_id: str,
    *,
    arm_modules: Mapping[str, Any] = ARM_MODULES,
    score_fn: Callable[..., dict] = score.score_predictions,
    error_retries: int = 1,
) -> variance.RunAndScore:
    """Build the ``(arm, instance_id, rep) -> resolved bool`` adapter the probe
    consumes. Each rep runs the SAME arm driver + scorer the headline uses (the
    probe measures the real pipeline's non-determinism), writing isolated
    per-rep prediction/report files under ``out_dir/probe`` so reps never share
    an appended predictions file.

    The probe gets the SAME transient-ERROR retry as the headline run (via
    ``_run_instance_with_retry``) — otherwise an infra blip during a probe rep
    would register as a false flip and inflate the ±band, which is supposed to
    measure pipeline non-determinism, not infra noise."""
    probe_dir = Path(out_dir) / "probe"

    def run_and_score(arm: str, iid: str, rep: int) -> bool:
        mod = arm_modules[arm]
        preds = probe_dir / f"probe.{arm}.{iid}.{rep}.jsonl"
        probe_dir.mkdir(parents=True, exist_ok=True)
        if preds.exists():
            preds.unlink()
        res, _attempts = _run_instance_with_retry(
            mod, arm, iid, rows, probe_dir, error_retries=error_retries
        )
        run_arm.write_prediction(preds, iid, _model_name(mod), res.model_patch)
        rep_dict = score_fn(
            preds,
            f"probe-{arm}-{iid}-{rep}-{run_id}",
            [iid],
            report_out=probe_dir / f"probe.{arm}.{iid}.{rep}.report.json",
        )
        return int(rep_dict.get("resolved", 0)) > 0

    return run_and_score


def run_variance(
    arms: Sequence[str],
    instance_ids: Sequence[str],
    rows: Mapping[str, Mapping[str, Any]],
    out_dir: Path,
    run_id: str,
    *,
    arm_modules: Mapping[str, Any] = ARM_MODULES,
    score_fn: Callable[..., dict] = score.score_predictions,
    error_retries: int = 1,
    probe_fn: Callable[..., Mapping[str, "variance.FlipRateRecord"]] = variance.run_probe,
    probe_selector: Callable[[Sequence[str]], Sequence[str]] = variance.select_probe_instances,
) -> dict[str, dict]:
    """Run the v1 flip-rate probe and return per-arm band dicts ready for the
    report (serialized via ``FlipRateRecord.to_dict()`` — report.py reads dicts,
    NOT dataclasses, so this serialization is load-bearing)."""
    probe_ids = probe_selector(instance_ids)
    run_and_score = make_run_and_score(
        rows, out_dir, run_id, arm_modules=arm_modules, score_fn=score_fn,
        error_retries=error_retries,
    )
    records = probe_fn(
        list(arms), list(probe_ids), run_and_score, full_size=len(instance_ids)
    )
    variance.write_flip_rates(Path(out_dir) / "flip_rates.json", records)
    return {arm: rec.to_dict() for arm, rec in records.items()}


def orchestrate(
    arms: str = "ABC",
    *,
    instance_ids: Sequence[str] | None = None,
    limit: int | None = None,
    rows: Mapping[str, Mapping[str, Any]] | None = None,
    out_dir: Path = HERE,
    docs_path: Path = DEFAULT_DOCS_PATH,
    run_id: str | None = None,
    arm_modules: Mapping[str, Any] = ARM_MODULES,
    score_fn: Callable[..., dict] = score.score_predictions,
    do_score: bool = True,
    do_variance: bool = False,
    error_retries: int = 1,
    flips: Mapping[str, Mapping] | None = None,
    on_progress: Callable[[str, run_arm.RunResult], None] | None = None,
) -> dict:
    """Run every requested arm over the subset, score each, render the report.

    Returns a JSON-serializable summary (per-arm scorecard counts, contamination
    ids, artifact paths). All live seams are injectable; ``main()`` wires the
    production ones.
    """
    out_dir = Path(out_dir)
    # run_id seeds the swebench harness run id (-> Docker container names). A
    # uuid suffix avoids same-second collisions across arms/re-scores.
    run_id = run_id or f"rdr006-{uuid.uuid4().hex[:8]}"
    if instance_ids is None:
        instance_ids = select_instance_ids(limit=limit)
    instance_ids = list(instance_ids)
    if rows is None:
        rows = subset.load_full_rows()

    arm_runs: list[ArmRun] = []
    for arm in arms:
        ar = run_one_arm(
            arm, instance_ids, rows, out_dir,
            arm_modules=arm_modules, error_retries=error_retries,
            on_progress=on_progress,
        )
        if do_score:
            score_one_arm(ar, run_id, instance_ids, out_dir, score_fn=score_fn)
        arm_runs.append(ar)

    # Variance band: caller-supplied flips win; else compute the v1 probe when
    # asked AND the subset is large enough to seat the frozen probe (smoke runs
    # with --limit < PROBE_SIZE skip it rather than crash select_probe_instances).
    if flips is None and do_variance and do_score:
        if len(instance_ids) >= variance.PROBE_SIZE:
            flips = run_variance(
                arms, instance_ids, rows, out_dir, run_id,
                arm_modules=arm_modules, score_fn=score_fn,
                error_retries=error_retries,
            )
        else:
            print(
                f"WARNING: subset {len(instance_ids)} < probe size "
                f"{variance.PROBE_SIZE}; skipping variance probe (no ±band).",
                file=sys.stderr,
            )

    summary: dict[str, Any] = {
        "run_id": run_id,
        "arms": list(arms),
        "n_instances": len(instance_ids),
        "instance_ids": instance_ids,
        "contaminated": {ar.arm: ar.contaminated_ids for ar in arm_runs},
        "predictions": {ar.arm: str(ar.predictions_path) for ar in arm_runs},
        "telemetry": {ar.arm: str(ar.telemetry_path) for ar in arm_runs},
        "flips": dict(flips) if flips else None,
        # Present unconditionally so programmatic callers need no do_score guard;
        # None on a --no-score run.
        "docs_path": None,
        "scorecards": None,
    }

    if do_score:
        cards, _deltas, _md = build_and_write_report(
            arm_runs, docs_path, flips=flips
        )
        summary["docs_path"] = str(docs_path)
        summary["scorecards"] = {
            c.arm: {
                "resolved": c.resolved,
                "total": c.total,
                "empty_patch": c.empty_patch,
                "non_empty": c.non_empty,
                "clean_apply": c.clean_apply,
            }
            for c in cards
        }
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(
        description="RDR-006 coding-agent eval orchestrator — run arms, score, report"
    )
    ap.add_argument("--arms", default="ABC", help="subset of arms to run, e.g. AB or C")
    ap.add_argument("--limit", type=int, default=None,
                    help="smoke run: first N instances of the frozen subset")
    ap.add_argument("--out-dir", default=str(HERE))
    ap.add_argument("--docs", default=str(DEFAULT_DOCS_PATH))
    ap.add_argument("--run-id", default=None)
    ap.add_argument("--no-score", action="store_true",
                    help="run arms + telemetry only; skip Docker scoring + report")
    ap.add_argument("--no-variance", action="store_true",
                    help="skip the v1 flip-rate ±band probe (faster; report shows no band)")
    ap.add_argument("--error-retries", type=int, default=1,
                    help="extra attempts on a per-instance ERROR (transient instant-fail); default 1")
    args = ap.parse_args()

    arms = "".join(a for a in args.arms.upper() if a in ARM_MODULES)
    if not arms:
        ap.error(f"--arms must name a subset of {''.join(ARM_MODULES)}")

    def _progress(arm: str, res: run_arm.RunResult) -> None:
        flag = " [TEST-EDIT CONTAMINATION]" if res.test_edit_contamination else ""
        print(f"[arm {arm}] {res.instance_id}: {res.outcome.value}"
              f" ({res.duration_seconds:.0f}s){flag}", file=sys.stderr)

    summary = orchestrate(
        arms=arms,
        limit=args.limit,
        out_dir=Path(args.out_dir),
        docs_path=Path(args.docs),
        run_id=args.run_id,
        do_score=not args.no_score,
        do_variance=not args.no_variance,
        error_retries=args.error_retries,
        on_progress=_progress,
    )
    # Loud contamination surfacing — these bias scoring if ignored.
    for arm, ids in summary["contaminated"].items():
        if ids:
            print(f"WARNING: arm {arm} test-edit contamination: {ids}", file=sys.stderr)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
