# SPDX-License-Identifier: MIT
"""Arm C driver — ``claude -p`` (sonnet) (RDR-006 40v.4).

Arm C runs Anthropic's Claude (sonnet) headlessly via ``claude -p`` inside the
same per-instance worktree every arm gets, against the same verbatim task
prompt (``run_arm.build_prompt``). Only the *invocation flags* are arm-specific;
the fairness/validity spine (prompt, patch extraction, timeout, outcome
classification, prediction writer) is shared verbatim with arms A and B.

Iso-config / fairness notes (stated in the report):

  * **Iso-prompt.** The prompt is ``run_arm.build_prompt`` verbatim — never
    branched per arm.
  * **Per-turn budget.** The qwen arms must clear a >=16K
    (``run_arm.MIN_COMPLETION_TOKENS``) reasoning/output floor or starvation
    reads as a false failure — that floor is a *server-side generation cap* the
    qwen drivers set. The installed ``claude`` CLI exposes no equivalent
    per-turn output-token knob (only ``--max-budget-usd`` and ``--max-turns``;
    verified against ``claude --help``), so Claude is NOT artificially capped:
    it receives the model's full default per-turn output budget, which sits
    above the qwen floor. The report states this explicitly — the parity is
    "Claude uncapped >= qwen floor", not an equal numeric cap. Turn count is
    pinned to the shared ``run_arm.MAX_TURNS`` via ``--max-turns`` so the
    turn-budget *is* identical across arms.

Patch provenance (locked): the prediction's ``model_patch`` comes from
``run_arm.extract_source_patch`` off the worktree — the arm-uniform ``git diff``
against ``base_commit`` — NEVER from any ``model_patch`` field of the
``claude -p --output-format json`` envelope. That envelope is **telemetry
only** (cost / turns / duration). All three arms therefore have identical patch
semantics.

claude -p json envelope shape (verified against the Phase-0 spike artifact
``claude_run.json`` / bd memory ``coding-agent-eval-phase0-spike-2026-06-06``):
a SINGLE JSON object, e.g.::

    {"type":"result","subtype":"success","is_error":false,
     "duration_ms":15894,"num_turns":4,"result":"...",
     "total_cost_usd":0.717387, "usage":{...}, ...}

There is no top-level ``model_patch`` key in the real envelope; telemetry is
parsed defensively (missing keys tolerated). ``num_turns`` feeds
``classify_outcome``; ``total_cost_usd`` / ``duration_ms`` are recorded.
"""

from __future__ import annotations

import json
from pathlib import Path

import materialize
import run_arm

ARM = "C"
MODEL_NAME = "claude-sonnet.arm-c"
DEFAULT_PREDICTIONS_PATH = Path("predictions.C.jsonl")


def build_argv(prompt: str) -> list[str]:
    """The arm-specific ``claude -p`` invocation.

    ``--dangerously-skip-permissions`` matches the RF-2 spike (the agent must
    edit files non-interactively). ``--output-format json`` yields the
    telemetry envelope. ``--model sonnet`` pins the arm's model. ``--max-turns``
    pins the turn budget to the shared ``run_arm.MAX_TURNS`` so the turn budget
    is identical across arms.

    Note on the per-turn OUTPUT budget: the qwen arms set a >=16K server-side
    generation floor (``run_arm.MIN_COMPLETION_TOKENS``); the claude CLI exposes
    no equivalent per-turn output-token cap (verified via ``claude --help`` —
    only ``--max-budget-usd`` / ``--max-turns``), so Claude is left UNCAPPED
    (full default per-turn output, above the qwen floor). The report states
    this parity ("Claude uncapped >= qwen floor", iso-prompt, iso-turn-budget)
    explicitly. We deliberately do NOT invent a flag the CLI rejects.

    The prompt is passed as the ``-p`` argument (verbatim shared prompt).
    """
    return [
        "claude",
        "-p",
        prompt,
        "--model",
        "sonnet",
        "--output-format",
        "json",
        "--max-turns",
        str(run_arm.MAX_TURNS),
        "--dangerously-skip-permissions",
    ]


def parse_telemetry(stdout: str) -> dict:
    """Parse the ``claude -p --output-format json`` envelope into a telemetry
    dict. The envelope is telemetry ONLY — never a patch source.

    Robust to envelope-shape drift: a single JSON object is expected, but if
    stdout is empty / not JSON / a JSON array, we degrade to an empty-ish
    telemetry dict rather than raising (a malformed envelope must not crash the
    run — the git-extracted patch is the source of truth regardless).
    """
    telemetry: dict = {
        "total_cost_usd": None,
        "num_turns": None,
        "duration_ms": None,
        "is_error": None,
        "subtype": None,
        "raw_parse_ok": False,
    }
    text = (stdout or "").strip()
    if not text:
        return telemetry
    try:
        env = json.loads(text)
    except (ValueError, TypeError):
        return telemetry
    if not isinstance(env, dict):
        return telemetry
    telemetry["raw_parse_ok"] = True
    telemetry["total_cost_usd"] = env.get("total_cost_usd")
    telemetry["num_turns"] = env.get("num_turns")
    telemetry["duration_ms"] = env.get("duration_ms")
    telemetry["is_error"] = env.get("is_error")
    telemetry["subtype"] = env.get("subtype")
    return telemetry


def run_instance(
    instance_id: str,
    *,
    rows: dict | None = None,
    runner=run_arm.run_with_timeout,
    predictions_path: Path = DEFAULT_PREDICTIONS_PATH,
    model_name: str = MODEL_NAME,
) -> run_arm.RunResult:
    """Run Arm C (``claude -p`` sonnet) for one instance, end to end.

    ``runner`` is injectable (defaults to ``run_arm.run_with_timeout``) so unit
    tests inject a fake returning a canned envelope + leave a real worktree git
    repo to extract from — no live ``claude`` call, no network.

    Returns a ``run_arm.RunResult`` and writes the swebench prediction line.
    """
    if rows is None:
        from subset import load_full_rows  # local import: network on first use

        rows = load_full_rows()

    row = rows[instance_id]
    repo = row["repo"]
    base_commit = row["base_commit"]
    extra_test_paths = run_arm.gold_test_globs(row["test_patch"])
    prompt = run_arm.build_prompt(row["problem_statement"], repo)
    argv = build_argv(prompt)

    worktree = materialize.materialize(instance_id, repo, base_commit)
    try:
        outcome, returncode, stdout, _stderr, duration = runner(
            argv,
            timeout_seconds=run_arm.WALL_CLOCK_SECONDS,
            cwd=worktree,
        )

        telemetry = parse_telemetry(stdout)

        # model_patch comes from the arm-uniform git extraction off the
        # worktree (against base_commit) — NOT from the json envelope.
        model_patch, contaminated = run_arm.extract_source_patch(
            worktree,
            extra_test_paths=extra_test_paths,
            base=base_commit,
        )

        # The spine's runner owns TIMEOUT. For any non-timeout terminal state,
        # funnel through the shared classify_outcome with claude's num_turns.
        if outcome is not run_arm.Outcome.TIMEOUT:
            outcome = run_arm.classify_outcome(
                returncode,
                turns_used=telemetry.get("num_turns"),
            )

        run_arm.write_prediction(
            predictions_path, instance_id, model_name, model_patch
        )

        return run_arm.RunResult(
            instance_id=instance_id,
            arm=ARM,
            outcome=outcome,
            model_patch=model_patch,
            test_edit_contamination=contaminated,
            duration_seconds=duration,
            returncode=returncode,
            telemetry=telemetry,
        )
    finally:
        materialize.cleanup(instance_id, repo)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Arm C (claude -p sonnet) driver")
    ap.add_argument("instance_id")
    ap.add_argument("--predictions", default=str(DEFAULT_PREDICTIONS_PATH))
    args = ap.parse_args()

    result = run_instance(
        args.instance_id, predictions_path=Path(args.predictions)
    )
    print(
        json.dumps(
            {
                "instance_id": result.instance_id,
                "arm": result.arm,
                "outcome": result.outcome.value,
                "test_edit_contamination": result.test_edit_contamination,
                "duration_seconds": result.duration_seconds,
                "returncode": result.returncode,
                "telemetry": result.telemetry,
                "patch_bytes": len(result.model_patch),
            }
        )
    )


if __name__ == "__main__":
    main()
