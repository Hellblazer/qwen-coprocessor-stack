# SPDX-License-Identifier: MIT
"""Tests for unified telemetry capture (RDR-006 40v.7).

All OFFLINE (no integration marker) — pure dataclass + diff-parsing logic, no
backends, no network. The central invariant under test: a field an arm cannot
supply is the explicit ``None`` sentinel (serialized ``null`` / rendered "N/A"),
NEVER silently 0.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import run_arm  # noqa: E402
import telemetry  # noqa: E402

# ── diffstat parsing ─────────────────────────────────────────────────────────

SINGLE_FILE_DIFF = """\
diff --git a/src/foo.py b/src/foo.py
index 1111111..2222222 100644
--- a/src/foo.py
+++ b/src/foo.py
@@ -1,3 +1,4 @@
 import os
-x = 1
+x = 2
+y = 3
 z = 4
"""

MULTI_FILE_DIFF = """\
diff --git a/a.py b/a.py
index 1111111..2222222 100644
--- a/a.py
+++ b/a.py
@@ -1,2 +1,2 @@
-old_a
+new_a
diff --git a/b.py b/b.py
index 3333333..4444444 100644
--- a/b.py
+++ b/b.py
@@ -1,1 +1,2 @@
 keep
+added_b
"""

ADDITIONS_ONLY_DIFF = """\
diff --git a/new.py b/new.py
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/new.py
@@ -0,0 +1,3 @@
+line1
+line2
+line3
"""

DELETIONS_ONLY_DIFF = """\
diff --git a/gone.py b/gone.py
deleted file mode 100644
index 2222222..0000000
--- a/gone.py
+++ /dev/null
@@ -1,2 +0,0 @@
-bye1
-bye2
"""


def test_diffstat_single_file():
    ds = telemetry.diffstat(SINGLE_FILE_DIFF)
    assert ds == {"added": 2, "removed": 1, "files": 1}


def test_diffstat_multi_file():
    ds = telemetry.diffstat(MULTI_FILE_DIFF)
    # a.py: +1/-1 ; b.py: +1/-0  => added 2, removed 1, files 2
    assert ds == {"added": 2, "removed": 1, "files": 2}


def test_diffstat_additions_only():
    ds = telemetry.diffstat(ADDITIONS_ONLY_DIFF)
    assert ds == {"added": 3, "removed": 0, "files": 1}


def test_diffstat_deletions_only():
    ds = telemetry.diffstat(DELETIONS_ONLY_DIFF)
    assert ds == {"added": 0, "removed": 2, "files": 1}


def test_diffstat_empty_patch():
    assert telemetry.diffstat("") == {"added": 0, "removed": 0, "files": 0}
    assert telemetry.diffstat("   \n  ") == {"added": 0, "removed": 0, "files": 0}


def test_diffstat_excludes_file_headers():
    # The +++/--- header lines must NOT be counted as added/removed body lines.
    ds = telemetry.diffstat(SINGLE_FILE_DIFF)
    assert ds["added"] == 2  # not 3 (would include +++ header)
    assert ds["removed"] == 1  # not 2 (would include --- header)


# ── helpers ──────────────────────────────────────────────────────────────────


def _result(arm, telemetry_dict, *, patch=SINGLE_FILE_DIFF, outcome=None):
    return run_arm.RunResult(
        instance_id="psf__requests-1963",
        arm=arm,
        outcome=outcome or run_arm.Outcome.COMPLETED,
        model_patch=patch,
        duration_seconds=12.5,
        returncode=0,
        telemetry=telemetry_dict,
    )


# ── N/A fallback ─────────────────────────────────────────────────────────────


def test_na_when_tokens_absent_is_none_not_zero():
    # Arm B with NO usage block — tokens must be None (N/A), not 0.
    rec = telemetry.normalize(
        _result("B", {"num_turns": 5, "usage": None, "cost_usd": 0.0, "subtype": "success"})
    )
    assert rec.tokens_in is None
    assert rec.tokens_out is None
    assert rec.tokens_total is None
    # explicit: NOT zero
    assert rec.tokens_total != 0


def test_na_serializes_as_null():
    rec = telemetry.normalize(_result("B", {"num_turns": 5, "usage": None}))
    d = rec.to_dict()
    blob = json.loads(json.dumps(d))
    assert blob["tokens_total"] is None
    assert blob["tokens_in"] is None


def test_na_tool_calls_for_qwen_b_and_claude_c():
    # Neither Arm B nor Arm C exposes a tool-call counter -> N/A, not 0.
    rec_b = telemetry.normalize(_result("B", {"num_turns": 3}))
    rec_c = telemetry.normalize(_result("C", {"num_turns": 3, "total_cost_usd": 0.5}))
    assert rec_b.tool_calls is None
    assert rec_c.tool_calls is None


def test_missing_counter_is_none():
    # Arm A poll where turns_completed was never reported (common: None).
    rec = telemetry.normalize(_result("A", {"turns": None, "tool_calls": 7, "supervisor_state": "complete"}))
    assert rec.turns is None
    assert rec.tool_calls == 7  # real measured counter survives


def test_arm_required_raises_when_absent():
    # A telemetry record with no arm is a programming error, not a null arm
    # silently serialized into the merged schema.
    import pytest

    with pytest.raises(ValueError):
        telemetry.normalize(_result("", {"num_turns": 1}))


# ── schema completeness ──────────────────────────────────────────────────────


def test_schema_completeness_all_fields_present():
    rec = telemetry.normalize(
        _result("C", {"num_turns": 4, "total_cost_usd": 0.71, "subtype": "success"})
    )
    d = rec.to_dict()
    for fieldname in telemetry.SCHEMA_FIELDS:
        assert fieldname in d, f"missing schema field {fieldname}"


def test_schema_field_types():
    rec = telemetry.normalize(
        _result("C", {"num_turns": 4, "total_cost_usd": 0.71, "subtype": "success"})
    )
    d = rec.to_dict()
    assert isinstance(d["instance_id"], str)
    assert isinstance(d["arm"], str)
    assert isinstance(d["outcome"], str)
    assert isinstance(d["duration_seconds"], float)
    assert isinstance(d["diff_added"], int)
    assert isinstance(d["diff_removed"], int)
    assert isinstance(d["diff_files"], int)
    # nullable counters: int or None
    for k in ("turns", "tool_calls", "tokens_in", "tokens_out", "tokens_total"):
        assert d[k] is None or isinstance(d[k], int)
    assert d["cost_usd"] is None or isinstance(d["cost_usd"], float)
    assert d["finish_reason"] is None or isinstance(d["finish_reason"], str)
    assert d["finish_reasons"] is None or isinstance(d["finish_reasons"], list)


def test_outcome_and_duration_carried_from_runresult():
    rec = telemetry.normalize(
        _result("C", {"num_turns": 4}, outcome=run_arm.Outcome.TIMEOUT)
    )
    assert rec.outcome == "timeout"
    assert rec.duration_seconds == 12.5
    assert rec.to_dict()["outcome"] == "timeout"


# ── per-arm mapping ──────────────────────────────────────────────────────────


def test_arm_c_maps_cost_from_total_cost_usd():
    # Shaped like arm_c.parse_telemetry output.
    tele = {
        "total_cost_usd": 0.717387,
        "num_turns": 4,
        "duration_ms": 15894,
        "is_error": False,
        "subtype": "success",
        "raw_parse_ok": True,
    }
    rec = telemetry.normalize(_result("C", tele))
    assert rec.cost_usd == 0.717387
    assert rec.turns == 4
    assert rec.finish_reason == "success"
    assert rec.finish_reasons == ["success"]
    # claude exposes no tokens / tool_calls
    assert rec.tokens_total is None
    assert rec.tool_calls is None


def test_arm_b_cost_is_zero_and_tokens_present_when_usage_carries_them():
    # Shaped like arm_b.parse_telemetry output WITH a usage block.
    tele = {
        "num_turns": 6,
        "usage": {"input_tokens": 1200, "output_tokens": 800, "total_tokens": 2000},
        "duration_ms": 9000,
        "duration_api_ms": 8000,
        "is_error": False,
        "subtype": "success",
        "cost_usd": 0.0,
        "tools": ["read_file", "edit"],
        "mcp_servers": [],
        "telemetry_parseable": True,
    }
    rec = telemetry.normalize(_result("B", tele))
    assert rec.cost_usd == 0.0  # real measured $0 (local hardware), NOT N/A
    assert rec.cost_usd is not None
    assert rec.tokens_in == 1200
    assert rec.tokens_out == 800
    assert rec.tokens_total == 2000
    assert rec.turns == 6
    assert rec.finish_reason == "success"


def test_arm_b_tokens_na_when_usage_absent():
    # Shaped like arm_b.parse_telemetry when the structured array lacked usage.
    tele = {
        "num_turns": 6,
        "usage": None,
        "cost_usd": 0.0,
        "subtype": "success",
        "telemetry_parseable": True,
    }
    rec = telemetry.normalize(_result("B", tele))
    assert rec.tokens_total is None
    assert rec.cost_usd == 0.0  # still a real measured zero


def test_arm_b_total_derived_when_only_in_out_present():
    tele = {
        "num_turns": 2,
        "usage": {"input_tokens": 100, "output_tokens": 50},  # no total key
        "cost_usd": 0.0,
    }
    rec = telemetry.normalize(_result("B", tele))
    assert rec.tokens_total == 150  # derived from real in+out, not a guess


def test_arm_a_maps_tool_calls_and_local_zero_cost():
    # Shaped like the arm_a.run_instance telemetry dict.
    tele = {
        "turns": 8,
        "tool_calls": 23,
        "supervisor_state": "complete",
        "spawn_opts": {"write_authority": True},
    }
    rec = telemetry.normalize(_result("A", tele))
    assert rec.tool_calls == 23
    assert rec.turns == 8
    assert rec.cost_usd == 0.0  # qwen local hardware
    assert rec.tokens_total is None  # supervisor poll has no token usage
    assert rec.finish_reason == "complete"


def test_arm_explicit_override():
    # arm kwarg overrides result.arm.
    rec = telemetry.normalize(_result("B", {"num_turns": 1}), arm="C")
    assert rec.arm == "C"


def test_bool_not_coerced_as_int():
    # is_error is a bool — must never bleed into an int counter as 1/0.
    rec = telemetry.normalize(_result("C", {"num_turns": True, "total_cost_usd": 0.1}))
    assert rec.turns is None  # True rejected, not coerced to 1


# ── writer ───────────────────────────────────────────────────────────────────


def test_writer_emits_one_json_line_per_instance(tmp_path):
    path = telemetry.telemetry_path("C", tmp_path)
    r1 = telemetry.normalize(_result("C", {"num_turns": 4, "total_cost_usd": 0.5, "subtype": "success"}))
    r2 = telemetry.normalize(
        run_arm.RunResult(
            instance_id="psf__requests-2148",
            arm="C",
            outcome=run_arm.Outcome.COMPLETED,
            model_patch=MULTI_FILE_DIFF,
            duration_seconds=3.0,
            telemetry={"num_turns": 2, "total_cost_usd": 0.3, "subtype": "success"},
        )
    )
    telemetry.write_telemetry(path, r1)
    telemetry.write_telemetry(path, r2)

    lines = path.read_text().splitlines()
    assert len(lines) == 2
    rec0 = json.loads(lines[0])
    rec1 = json.loads(lines[1])
    assert rec0["instance_id"] == "psf__requests-1963"
    assert rec1["instance_id"] == "psf__requests-2148"
    # schema keys present on every line
    for line in lines:
        blob = json.loads(line)
        for fieldname in telemetry.SCHEMA_FIELDS:
            assert fieldname in blob


def test_writer_path_naming(tmp_path):
    assert telemetry.telemetry_path("a", tmp_path).name == "telemetry.A.jsonl"
    assert telemetry.telemetry_path("B", tmp_path).name == "telemetry.B.jsonl"
