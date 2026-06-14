# SPDX-License-Identifier: MIT
"""Official-harness scoring wrapper for the coding-agent eval (RDR-006 40v.8).

This module does NOT reinvent scoring. It wraps the *official* SWE-bench
harness (``python -m swebench.harness.run_evaluation``) and parses its output
report into a normalized dict. The proven invocation shape (RF-1, from bd
memory ``coding-agent-eval-phase0-spike-2026-06-06``)::

    python -m swebench.harness.run_evaluation \
        --dataset_name princeton-nlp/SWE-bench_Lite \
        --predictions_path <preds>.jsonl \
        --run_id <id> \
        --max_workers 1 \
        --instance_ids <ids...> \
        --namespace '' \
        --cache_level instance

Load-bearing flags (verified against swebench 4.1.0 source):

  * ``--namespace ''`` (the empty string) is MANDATORY on arm64 (M-series Mac).
    ``swebench.harness.utils.optional_str("")`` maps the empty string to
    ``None``; ``run_evaluation.main`` then takes the ``namespace is None``
    branch (``build_env_images`` + a LOCAL image build) instead of pulling the
    published, x86-only ``swebench/...`` namespaced images. Without it the run
    pulls x86_64 images that cannot execute under the arm64 Docker VM. The
    ``x86_64`` token still appears inside the locally-built image *tag* (it is
    baked into the SWE-bench image-naming convention) but the image is built
    locally for the host arch — that tag string is cosmetic, not a pull target.

  * ``--cache_level instance`` keeps the per-instance image cached so a re-run
    of the same instance skips the (slow, ~minutes) base/env rebuild.

  * ``--max_workers 1`` — serial; the M4 build is the bottleneck, not CPU.

Dataset revision pinning. ``subset.SNAPSHOT_REVISION`` pins the Lite snapshot
for subset *selection* (``subset.py``). The ``run_evaluation`` CLI in swebench
4.1.0 exposes **no** ``--revision`` / dataset-pin parameter (verified against
the argparse definition in ``run_evaluation.py``): it loads the HuggingFace
default revision. We therefore record ``subset.SNAPSHOT_REVISION`` in the
normalized report for provenance but cannot pass it to the harness. The
instance set scored is still pinned because the caller passes the exact
``instance_ids`` selected at the pinned revision.

Report location & shape (verified against swebench 4.1.0
``reporting.make_run_report`` and the Phase-0 spike artifact
``gold.spike-gold.json``). The harness writes its summary report to a file named
``<model_name_or_path>.<run_id>.json`` (``/`` in the model name replaced with
``__``) in the *current working directory* — ``make_run_report`` builds the path
as ``Path(model + "." + run_id + ".json")``, a cwd-relative name, regardless of
``--report_dir``. The file contains ``resolved_ids`` / ``unresolved_ids`` /
``resolved_instances`` etc. (schema_version 2). We locate that file, parse it,
and normalize.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from collections.abc import Callable, Sequence
from pathlib import Path

import subset

# Dataset name the harness consumes. Same family as ``subset.DATASET``; the
# canonical published name is the ``princeton-nlp`` mirror used in the spike.
DATASET_NAME = "princeton-nlp/SWE-bench_Lite"

# Per-instance apply markers the harness writes to run_instance.log
# (swebench.harness.constants APPLY_PATCH_PASS / APPLY_PATCH_FAIL). This is the
# TRUE git-apply signal — distinct from the summary report's ``completed_ids``,
# which additionally requires the test run to finish. A patch that applies but
# whose test-exec OOMs/times-out is absent from completed_ids yet has
# APPLY_PATCH_PASS in its log.
APPLY_PASS_MARKER = ">>>>> Applied Patch"
APPLY_FAIL_MARKER = ">>>>> Patch Apply Failed"


def instance_log_dir(cwd: Path, run_id: str, model_name: str) -> Path:
    """Where the harness writes per-instance logs for this run."""
    return Path(cwd) / "logs" / "run_evaluation" / run_id / model_name


def parse_apply_status(
    log_dir: Path, instance_ids: Sequence[str]
) -> dict[str, bool | None]:
    """Read each instance's run_instance.log for the apply marker.

    Returns ``{iid: True}`` if the patch applied (``APPLY_PATCH_PASS``),
    ``False`` if it failed (``APPLY_PATCH_FAIL``), ``None`` if the log is missing
    or carries neither marker (e.g. empty-patch instances the harness skips, or
    a harness crash before the apply step). ``None`` is first-class — the caller
    must not coerce it to a clean-apply verdict.

    Caveat: the harness tries ``git apply`` then a ``patch --fuzz=5`` fallback
    and logs ``APPLY_PATCH_PASS`` for either. So True means "the harness applied
    it" (possibly fuzzy), the closest available proxy for the RDR's "git-apply
    cleanly" — a small overcount vs strict, far better than the completed_ids
    undercount it replaces.
    """
    out: dict[str, bool | None] = {}
    for iid in instance_ids:
        log = Path(log_dir) / iid / "run_instance.log"
        if not log.exists():
            out[iid] = None
            continue
        txt = log.read_text(encoding="utf-8", errors="replace")
        if APPLY_PASS_MARKER in txt:
            out[iid] = True
        elif APPLY_FAIL_MARKER in txt:
            out[iid] = False
        else:
            out[iid] = None
    return out

# The runner seam: a callable ``(argv, cwd) -> int`` that executes the harness
# and returns its exit code. The production runner shells out to the swebench
# module; tests inject a fake that writes a canned report and returns 0 WITHOUT
# touching Docker.
Runner = Callable[[Sequence[str], Path], int]


def build_argv(
    predictions_path: str | Path,
    run_id: str,
    instance_ids: Sequence[str],
    *,
    dataset: str = DATASET_NAME,
    max_workers: int = 1,
) -> list[str]:
    """Construct the official harness argv (RF-1 proven shape).

    The ``--namespace`` value is the EMPTY STRING — load-bearing on arm64
    (forces a local build; see module docstring). ``--cache_level instance`` is
    pinned. ``--max_workers`` defaults to 1 (the headline scores one arm's full
    subset; 1 keeps the cold env-image builds race-free and deterministic). The
    batched variance probe raises it to evaluate many instances' (cached-image)
    test runs concurrently — the dominant cost once images are built. Instance
    IDs are passed explicitly so the harness scores exactly the requested set.
    """
    argv = [
        sys.executable,
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        dataset,
        "--predictions_path",
        str(predictions_path),
        "--run_id",
        run_id,
        "--max_workers",
        str(max_workers),
        "--namespace",
        "",  # MANDATORY empty string -> optional_str -> None -> local arm64 build
        "--cache_level",
        "instance",
    ]
    if instance_ids:
        argv.append("--instance_ids")
        argv.extend(instance_ids)
    return argv


def model_name_from_predictions(predictions_path: str | Path) -> str:
    """Read the ``model_name_or_path`` from the first prediction line.

    The harness derives the report filename from this field (with ``/`` -> ``__``).
    """
    p = Path(predictions_path)
    with p.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            name = rec.get("model_name_or_path")
            if not name:
                raise ValueError(
                    f"prediction line missing model_name_or_path in {predictions_path}"
                )
            return str(name)
    raise ValueError(f"no prediction lines in {predictions_path}")


def report_path(predictions_path: str | Path, run_id: str, cwd: Path) -> Path:
    """Path the harness writes its summary report to (cwd-relative).

    Mirrors ``reporting.make_run_report``: ``<model>.<run_id>.json`` with ``/``
    in the model name replaced by ``__``.
    """
    model = model_name_from_predictions(predictions_path).replace("/", "__")
    return cwd / f"{model}.{run_id}.json"


def parse_report(
    report_file: Path,
    instance_ids: Sequence[str],
    *,
    run_id: str,
    dataset: str = DATASET_NAME,
) -> dict:
    """Parse the harness report into a normalized dict.

    Returns::

        {
          "dataset": ..., "snapshot_revision": ..., "run_id": ...,
          "resolved": int, "total": int,
          "per_instance": {iid: "resolved"|"unresolved"},
          "resolved_ids": [...], "unresolved_ids": [...],
          "raw": <verbatim harness report>,
        }

    An instance present in ``instance_ids`` but absent from the harness report's
    ``resolved_ids`` is counted as **unresolved** (no crash) — covering the
    error / empty-patch / incomplete cases the harness records separately.
    ``total`` is ``len(instance_ids)`` (what we asked to be scored), so the
    accounting is per the requested subset, not the harness's view.
    """
    raw = json.loads(report_file.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        # A well-formed harness report is a JSON object. A bare array / string /
        # null would make raw.get(...) raise an opaque AttributeError; fail with
        # a message that names the file and the actual shape instead.
        raise ValueError(
            f"harness report {report_file} is not a JSON object "
            f"(got {type(raw).__name__}); cannot parse resolved_ids"
        )
    resolved_set = set(raw.get("resolved_ids", []))

    per_instance: dict[str, str] = {}
    resolved_ids: list[str] = []
    unresolved_ids: list[str] = []
    for iid in instance_ids:
        if iid in resolved_set:
            per_instance[iid] = "resolved"
            resolved_ids.append(iid)
        else:
            per_instance[iid] = "unresolved"
            unresolved_ids.append(iid)

    return {
        "dataset": dataset,
        "snapshot_revision": subset.SNAPSHOT_REVISION,
        "run_id": run_id,
        "resolved": len(resolved_ids),
        "total": len(instance_ids),
        "per_instance": per_instance,
        "resolved_ids": resolved_ids,
        "unresolved_ids": unresolved_ids,
        "raw": raw,
    }


# Outer bound on ONE arm's whole scoring subprocess. The first cold scoring of
# the 40-instance subset builds ~37 per-(repo,version) env images on the host
# (no published arm64 images) AND evaluates 40 instances at --max_workers 1 —
# empirically ~2h40m cold on an M-series Mac. The old 2h cap killed it mid-eval
# (exit 124, no report). 6h gives cold scoring ample headroom; warm re-scores
# (cached images) finish in well under an hour. Override per call via
# score_predictions(harness_timeout=...).
DEFAULT_HARNESS_TIMEOUT_SECONDS = 21600


def _make_default_runner(timeout_seconds: float) -> "Runner":
    """Build the production runner: execute the harness as a subprocess in
    ``cwd`` (where it writes its report), streaming output, bounded by
    ``timeout_seconds`` so a hung Docker build can't wedge the run forever."""
    import os
    import signal
    import subprocess

    def runner(argv: Sequence[str], cwd: Path) -> int:
        # start_new_session so the harness (which spawns Docker build/run
        # children) is a process-group leader we can signal as a whole. A bare
        # subprocess.run(timeout=) raises TimeoutExpired but does NOT kill the
        # child, orphaning the harness and its Docker containers to compete for
        # host resources for the rest of the eval (mirrors run_arm._kill_group).
        proc = subprocess.Popen(list(argv), cwd=str(cwd), start_new_session=True)
        try:
            return proc.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            # Reap so we don't leave a zombie; bounded so the cutoff can't hang.
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            # Surface as a distinct nonzero code so score_predictions warns.
            return 124

    return runner


# Back-compat default-timeout runner instance (tests may reference it).
_default_runner = _make_default_runner(DEFAULT_HARNESS_TIMEOUT_SECONDS)


def score_predictions(
    predictions_path: str | Path,
    run_id: str,
    instance_ids: Sequence[str],
    *,
    runner: Runner | None = None,
    harness_timeout: float = DEFAULT_HARNESS_TIMEOUT_SECONDS,
    dataset: str = DATASET_NAME,
    cwd: Path | None = None,
    report_out: Path | None = None,
    max_workers: int = 1,
) -> dict:
    """Score ``predictions_path`` via the official harness; return normalized dict.

    Builds the RF-1 argv, runs it through the injectable ``runner`` (default: a
    real subprocess bounded by ``harness_timeout``; tests inject a fake), locates
    the harness report, parses it, writes the normalized result to ``report_out``
    (default ``<cwd>/report.json``), and returns it.

    ``harness_timeout`` applies only to the default runner; an injected ``runner``
    owns its own bounding.
    """
    if runner is None:
        runner = _make_default_runner(harness_timeout)
    cwd = Path(cwd) if cwd is not None else Path.cwd()
    instance_ids = list(instance_ids)

    argv = build_argv(
        predictions_path, run_id, instance_ids, dataset=dataset, max_workers=max_workers
    )
    rc = runner(argv, cwd)

    rep_file = report_path(predictions_path, run_id, cwd)
    if not rep_file.exists():
        raise FileNotFoundError(
            f"harness report not found at {rep_file} (runner exit code {rc}). "
            "Did the harness run to completion?"
        )

    # A nonzero exit with a (possibly partial) report on disk would otherwise be
    # parsed silently and undercount resolved — biasing the arm comparison.
    # Warn loudly so the caller cannot consume partial counts unaware.
    if rc != 0:
        warnings.warn(
            f"swebench harness exited {rc} but a report exists at {rep_file}; "
            "scored counts may be partial. Check harness_exit_code.",
            RuntimeWarning,
            stacklevel=2,
        )

    normalized = parse_report(
        rep_file, instance_ids, run_id=run_id, dataset=dataset
    )
    normalized["harness_exit_code"] = rc

    # Per-instance git-apply status from the run logs — the TRUE clean-apply
    # signal (the summary report has none). report.py prefers applied_ids over
    # the completed_ids proxy.
    model_name = model_name_from_predictions(predictions_path)
    log_dir = instance_log_dir(cwd, run_id, model_name)
    apply_status = parse_apply_status(log_dir, instance_ids)
    normalized["applied_ids"] = [i for i, v in apply_status.items() if v is True]
    normalized["apply_failed_ids"] = [i for i, v in apply_status.items() if v is False]
    normalized["apply_unknown_ids"] = [i for i, v in apply_status.items() if v is None]

    out = Path(report_out) if report_out is not None else cwd / "report.json"
    out.write_text(json.dumps(normalized, indent=2) + "\n", encoding="utf-8")
    normalized["report_out"] = str(out)
    return normalized


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Score predictions via the official SWE-bench harness (RDR-006)."
    )
    ap.add_argument("--predictions_path", required=True)
    ap.add_argument("--run_id", required=True)
    ap.add_argument(
        "--instance_ids",
        nargs="+",
        required=True,
        help="Instance IDs to score (space separated).",
    )
    ap.add_argument("--dataset", default=DATASET_NAME)
    ap.add_argument(
        "--report_out",
        default=None,
        help="Where to write the normalized report.json (default: ./report.json).",
    )
    args = ap.parse_args()

    result = score_predictions(
        args.predictions_path,
        args.run_id,
        args.instance_ids,
        dataset=args.dataset,
        report_out=Path(args.report_out) if args.report_out else None,
    )
    print(
        f"resolved {result['resolved']}/{result['total']} "
        f"(report: {result['report_out']})"
    )


if __name__ == "__main__":
    main()
