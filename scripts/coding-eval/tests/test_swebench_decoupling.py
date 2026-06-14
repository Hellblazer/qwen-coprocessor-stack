# SPDX-License-Identifier: MIT
"""RDR-009 regression test: the SWE-bench scoring path is DECOUPLED from the
``AgentResult.patch -> artifacts`` migration (RF-3, audit MEDIUM must-do).

The invariant this pins (so a future refactor can't silently break scoring):

  * The swebench prediction's ``model_patch`` comes from the arm-uniform git
    extraction (``extract_source_patch``) and is handed to ``write_prediction``
    DIRECTLY — never via ``AgentResult`` / ``run_result_to_agent_result``.
  * The prediction JSONL carries EXACTLY the three keys the official harness
    reads (``instance_id``, ``model_name_or_path``, ``model_patch``) — none of
    the AgentResult surface (no ``artifacts``/``turns``/``outcome``/``cost``).
  * ``run_result_to_agent_result`` is a PURE projection: wrapping ``model_patch``
    into a ``{kind:"patch"}`` artifact cannot move a score, because the scorer
    never reads its output. We prove this by tampering with the ``AgentResult``
    projection AFTER the prediction is written and showing the prediction (the
    scorer's only input) is unchanged.

Offline: a real but local bare-free git repo (no network), mirroring the TS
integration test ``dispatch-base-commit.test.ts``.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_arm import (  # noqa: E402
    Outcome,
    RunResult,
    extract_source_patch,
    run_result_to_agent_result,
    write_prediction,
)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _init_repo(root: Path) -> str:
    """A repo with a source file + a test file committed at base; returns base sha."""
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "t@t.test")
    _git(root, "config", "user.name", "t")
    _git(root, "config", "commit.gpgsign", "false")
    (root / "calc.py").write_text("def add(a, b):\n    return a - b\n")
    (root / "test_calc.py").write_text("def test_add():\n    assert add(1, 2) == 3\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    return _git(root, "rev-parse", "HEAD").strip()


def test_prediction_model_patch_is_git_extraction_not_agent_result(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    base = _init_repo(repo)

    # The "agent" fixes the source AND touches a test (contamination), then commits
    # — a bare HEAD diff would be empty (the silent-zero trap), so we diff vs base.
    (repo / "calc.py").write_text("def add(a, b):\n    return a + b\n")
    (repo / "test_calc.py").write_text("def test_add():\n    assert add(1, 2) == 3  # edited\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "fix")

    # Arms pass the per-instance gold test globs (here: the touched test file)
    # so the source-only patch strips them, exactly as the eval drivers do.
    extra_test_paths = ["test_calc.py"]
    source_patch, contaminated = extract_source_patch(
        repo, extra_test_paths=extra_test_paths, base=base
    )
    # Source-only: the committed test edit is stripped, the source edit captured.
    assert "return a + b" in source_patch
    assert "test_calc.py" not in source_patch
    assert contaminated is True  # a test file WAS touched (host-internal flag)

    # Write the swebench prediction the way the arm drivers do: from the git
    # extraction DIRECTLY (arm_a.py / arm_b.py / arm_c.py: write_prediction is
    # called with model_patch, never with AgentResult).
    predictions = tmp_path / "preds.jsonl"
    write_prediction(predictions, "psf__requests-2148", "qwen-coder", source_patch)

    line = json.loads(predictions.read_text().splitlines()[0])
    # EXACTLY the three keys the official harness reads — no AgentResult surface.
    assert set(line) == {"instance_id", "model_name_or_path", "model_patch"}
    # The scorer's input is byte-identical to the git extraction.
    assert line["model_patch"] == source_patch

    # Now build the AgentResult projection and TAMPER with its patch artifact.
    # The prediction (the scorer's only input) must be unaffected — proving the
    # artifacts migration is decoupled from scoring (RF-3).
    rr = RunResult(
        instance_id="psf__requests-2148",
        arm="arm-a",
        outcome=Outcome.COMPLETED,
        model_patch=source_patch,
        base_commit=base,
    )
    agent_result = run_result_to_agent_result(rr)
    assert agent_result["artifacts"] == [
        {"kind": "patch", "diff": source_patch, "base": base}
    ]
    # Mutate the projection after the fact — the on-disk prediction does not move.
    agent_result["artifacts"][0]["diff"] = "TAMPERED"
    reread = json.loads(predictions.read_text().splitlines()[0])
    assert reread["model_patch"] == source_patch  # NOT "TAMPERED"
