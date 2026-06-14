# SPDX-License-Identifier: MIT
"""Python-host conformance against the RDR-007 §4 golden fixtures.

The SAME fixture files in ``docs/contracts/fixtures/`` are asserted by the TS
host (``mcp-bridges/qwen-agent-server/tests/contract-conformance.test.ts``).
The cross-host fixtures (classify-outcome, agent-shapes) are the cross-language
drift tripwire (RDR-007 Consequence Negative-1). prompt-render is Python-host-
scoped (TS dispatch receives the prompt; it has no renderer) — see the host-
scope table in ``docs/contracts/agent-dispatch-contract.md``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from run_arm import (  # noqa: E402
    Outcome,
    build_agent_task,
    build_prompt,
    classify_outcome,
    run_result_to_agent_result,
)
from run_arm import (  # noqa: E402
    RunResult,
)

# Repo-root-relative shared fixture dir (tests/ -> coding-eval -> scripts -> root).
FIXTURES = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ── cross-host: classify-outcome rule ───────────────────────────────────────


def test_classify_outcome_matches_golden_fixture():
    fx = _load("classify-outcome.json")
    assert fx["cases"], "fixture must be non-empty"
    for case in fx["cases"]:
        # `null` in the fixture means "signal not supplied" -> None on Python.
        turns = case["turnsUsed"]
        got = classify_outcome(
            case["returncode"],
            turns_used=turns,
            max_turns=case["maxTurns"],
        )
        assert got.value == case["expected"], f"{case['name']}: {got.value} != {case['expected']}"


# ── cross-host: AgentTask / AgentResult / AgentOutcome shapes ────────────────


def test_agent_outcome_values_match_golden_fixture():
    fx = _load("agent-shapes.json")
    assert {o.value for o in Outcome} == set(fx["agentOutcomeValues"])


def test_agent_task_shape_and_example_match_golden_fixture():
    fx = _load("agent-shapes.json")["agentTask"]
    ex = fx["example"]
    built = build_agent_task(ex["prompt"], ex["worktree"])
    # Key set matches the published contract.
    assert set(built) == set(fx["requiredKeys"])
    # The Python host reproduces the canonical example byte-for-byte (defaults
    # pin maxTurns/minTokens/timeout-in-ms).
    assert built == ex


def test_agent_result_shape_matches_golden_fixture():
    fx = _load("agent-shapes.json")["agentResult"]
    ex = fx["example"]
    # RDR-009: the result carries a single {kind:"patch"} artifact wrapping the
    # git extraction; the Python host reproduces the canonical example byte-for-byte.
    patch_artifact = ex["artifacts"][0]
    rr = RunResult(
        instance_id="psf__requests-2148",
        arm="arm-x",
        outcome=Outcome(ex["outcome"]),
        model_patch=patch_artifact["diff"],
        base_commit=patch_artifact["base"],
        telemetry={"num_turns": ex["turns"], "total_cost_usd": ex["cost"]},
    )
    projected = run_result_to_agent_result(rr)
    assert set(projected) == set(fx["requiredKeys"])
    assert projected == ex


def test_artifact_union_kinds_match_golden_fixture():
    # RDR-009: the four-kind union is the cross-host contract. Each example
    # carries its discriminant; the eval host emits the `patch` kind.
    fx = _load("agent-shapes.json")["artifact"]
    assert fx["kinds"] == ["patch", "value", "entity", "tier"]
    for kind in fx["kinds"]:
        assert fx["examples"][kind]["kind"] == kind


# ── Python-host-scoped: prompt render ────────────────────────────────────────


def test_prompt_render_matches_golden_fixture():
    fx = _load("prompt-render.json")
    assert fx["cases"], "fixture must be non-empty"
    for case in fx["cases"]:
        got = build_prompt(case["problemStatement"], case["repo"])
        assert got == case["expected"], f"{case['name']}: prompt render drifted"
