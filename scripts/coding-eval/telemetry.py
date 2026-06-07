# SPDX-License-Identifier: MIT
"""Unified telemetry capture for the three-arm coding eval (RDR-006 40v.7).

The three arm drivers (A=qwen-via-supervisor, B=raw qwen-code, C=claude -p)
each stuff DIFFERENT keys into ``run_arm.RunResult.telemetry`` because they
talk to different backends with different observability surfaces. This module
NORMALIZES those three shapes into ONE schema (:class:`TelemetryRecord`) so the
Phase-2 ``report.py`` consumes a single schema regardless of arm.

The three source shapes (read off the arm drivers, cited):

  * **Arm C** (``arm_c.parse_telemetry``, arm_c.py:101-124): ``claude -p
    --output-format json`` envelope. Supplies ``total_cost_usd``,
    ``num_turns``, ``duration_ms``, ``is_error``, ``subtype``, ``raw_parse_ok``.
    NO tool-call counter, NO token usage block. → cost is a REAL metered number;
    tokens / tool_calls are N/A.

  * **Arm B** (``arm_b.parse_telemetry``, arm_b.py:188-231): qwen-code
    ``-o json`` event array. Supplies ``num_turns``, ``usage`` (an
    input/output/total token dict — IF present), ``duration_ms``,
    ``duration_api_ms``, ``is_error``, ``subtype``, ``cost_usd`` PINNED to 0.0
    (local hardware, arm_b.py:206/73), ``tools``, ``mcp_servers``,
    ``telemetry_parseable``. NO tool-call counter. → cost is a real 0.0;
    tokens present iff the structured array carried a ``usage`` block, else N/A.

  * **Arm A** (``arm_a.run_instance`` telemetry dict, arm_a.py:435-440):
    supervisor poll counters. Supplies ``turns`` (from ``last_known
    .turns_completed``, arm_a.py:342 — often ``None``), ``tool_calls`` (from the
    poll ``budget``, arm_a.py:336), ``supervisor_state``, ``spawn_opts``. NO
    token usage, NO cost field, NO duration_ms (duration is on RunResult).
    → tool_calls is a REAL counter; cost is local-hardware 0.0; tokens are N/A.

N/A handling is FIRST-CLASS. A field an arm cannot supply is ``None``
(serialized as JSON ``null``; ``report.py`` renders it "N/A"). It is NEVER
silently coerced to ``0`` and NEVER a scraped guess. ``0``/``0.0`` is reserved
for a genuine measured zero (e.g. qwen's real $0 cost, or a diffstat of an
empty patch).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import run_arm

# ── diffstat ────────────────────────────────────────────────────────────────

# Unified-diff body line markers. A '+'/'-' that is NOT a '+++'/'---' file
# header counts as an added/removed line.
_FILE_HDR_RE = re.compile(r"^diff --git a/(\S+) b/(\S+)")


def diffstat(patch: str) -> dict[str, int]:
    """Parse a unified diff into ``{added, removed, files}`` line counts.

    * ``added`` — body lines beginning ``+`` (excluding the ``+++`` file header).
    * ``removed`` — body lines beginning ``-`` (excluding the ``---`` header).
    * ``files`` — distinct files touched, counted from ``diff --git`` headers.

    An empty / whitespace-only patch yields ``{0, 0, 0}`` (a genuine measured
    zero, NOT N/A — the absence of changes is itself the datum).
    """
    added = 0
    removed = 0
    files: set[str] = set()
    for line in (patch or "").splitlines():
        m = _FILE_HDR_RE.match(line)
        if m:
            files.add(m.group(2))
            continue
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
    return {"added": added, "removed": removed, "files": len(files)}


# ── unified record ──────────────────────────────────────────────────────────


@dataclass
class TelemetryRecord:
    """One normalized telemetry record, per-instance per-arm.

    Every count/cost/token field is ``Optional`` and defaults to ``None`` (the
    N/A sentinel). Fields the arm genuinely measures are populated; fields it
    cannot supply stay ``None``. ``diffstat`` and ``duration_seconds`` and
    ``outcome`` always come from the ``RunResult`` and are never N/A.

    finish_reason granularity per arm:
      * Arm C — terminal ``subtype`` ("success"/"error_max_turns"/…) from the
        single claude envelope. No per-turn breakdown. ``finish_reasons`` holds
        the one terminal value.
      * Arm B — terminal ``subtype`` from the qwen ``result`` event. Per-turn
        finish reasons are not surfaced in the parsed envelope, so
        ``finish_reasons`` holds the one terminal value (or is empty/None when
        the envelope was unparseable). This is the qwen reasoning-starvation vs
        wrong-answer signal.
      * Arm A — the supervisor ``state`` ("complete"/"error"/"idle") is the
        only terminal signal; there is no per-turn finish_reason. ``finish_reason``
        carries that state.
    """

    instance_id: str
    arm: str
    outcome: str
    duration_seconds: float
    # diffstat (always present — measured from model_patch)
    diff_added: int
    diff_removed: int
    diff_files: int
    # arm-uniform contamination flag (source patch touched test paths). Lives on
    # the unified record so report.build_taxonomy can count it; sourced from
    # RunResult.test_edit_contamination, never inferred.
    test_edit_contamination: bool = False
    # counters / cost / tokens — None means N/A (arm could not supply)
    turns: int | None = None
    tool_calls: int | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    tokens_total: int | None = None
    cost_usd: float | None = None
    finish_reason: str | None = None
    # per-turn finish reasons when an arm exposes them; else the terminal one
    finish_reasons: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serializable dict; ``None`` fields render as JSON ``null`` ("N/A")."""
        return asdict(self)


# Canonical field order for the JSONL schema / report consumption.
SCHEMA_FIELDS: tuple[str, ...] = (
    "instance_id",
    "arm",
    "outcome",
    "duration_seconds",
    "diff_added",
    "diff_removed",
    "diff_files",
    "test_edit_contamination",
    "turns",
    "tool_calls",
    "tokens_in",
    "tokens_out",
    "tokens_total",
    "cost_usd",
    "finish_reason",
    "finish_reasons",
)


# ── token extraction ────────────────────────────────────────────────────────


def _coerce_int(value: Any) -> int | None:
    """Return an int if ``value`` is a real number, else ``None`` (N/A).

    A missing key (None), or a non-numeric value, is N/A — never 0.
    """
    if value is None:
        return None
    if isinstance(value, bool):  # bool is an int subclass; reject it explicitly
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _tokens_from_usage(usage: Any) -> tuple[int | None, int | None, int | None]:
    """Pull (in, out, total) from a qwen/claude-style ``usage`` dict.

    Tolerant of the common key spellings. Any field absent stays ``None`` (N/A,
    NOT 0). When the usage block itself is absent/not-a-dict, all three are N/A.
    ``total`` is derived from in+out ONLY when both are present and no explicit
    total key exists — a derived total from real measurements is not a guess.
    """
    if not isinstance(usage, dict):
        return None, None, None
    tin = _coerce_int(
        usage.get("input_tokens", usage.get("prompt_tokens", usage.get("input")))
    )
    tout = _coerce_int(
        usage.get(
            "output_tokens", usage.get("completion_tokens", usage.get("output"))
        )
    )
    ttotal = _coerce_int(usage.get("total_tokens", usage.get("total")))
    if ttotal is None and tin is not None and tout is not None:
        ttotal = tin + tout
    return tin, tout, ttotal


# ── normalizer ──────────────────────────────────────────────────────────────


def normalize(result: run_arm.RunResult, *, arm: str | None = None) -> TelemetryRecord:
    """Normalize a ``run_arm.RunResult`` (+ its arm-specific ``telemetry`` dict
    + ``model_patch``) into the unified :class:`TelemetryRecord`.

    ``arm`` defaults to ``result.arm``; pass it to override (e.g. tests).
    Outcome, duration, and diffstat are taken straight from the RunResult and
    are always present. Counters/cost/tokens are mapped per the arm's source
    shape; anything the arm cannot supply is left ``None`` (N/A), NEVER 0.
    """
    arm = (arm or result.arm or "").upper()
    if not arm:
        raise ValueError(
            f"arm is required for telemetry (instance {result.instance_id}): "
            "pass arm= or set RunResult.arm"
        )
    tele: dict[str, Any] = result.telemetry or {}
    ds = diffstat(result.model_patch)

    rec = TelemetryRecord(
        instance_id=result.instance_id,
        arm=arm,
        outcome=_outcome_str(result.outcome),
        duration_seconds=float(result.duration_seconds),
        diff_added=ds["added"],
        diff_removed=ds["removed"],
        diff_files=ds["files"],
        test_edit_contamination=bool(result.test_edit_contamination),
    )

    if arm == "C":
        _normalize_arm_c(rec, tele)
    elif arm == "B":
        _normalize_arm_b(rec, tele)
    elif arm == "A":
        _normalize_arm_a(rec, tele)
    else:
        # Unknown arm: carry only what is unambiguous (turns if present),
        # leave the rest N/A rather than guess a mapping.
        rec.turns = _coerce_int(tele.get("turns") or tele.get("num_turns"))

    return rec


def _outcome_str(outcome: Any) -> str:
    """RunResult.outcome is an ``Outcome`` enum (a ``str`` subclass); render
    its ``.value`` defensively in case a plain string slips through."""
    return getattr(outcome, "value", outcome)


def _normalize_arm_c(rec: TelemetryRecord, tele: dict[str, Any]) -> None:
    """Arm C (claude -p): real cost, no tokens, no tool_calls.

    Source keys: ``num_turns``, ``total_cost_usd``, ``subtype``. There is no
    ``usage`` block or tool-call counter in the parsed envelope (arm_c.py:101).
    """
    rec.turns = _coerce_int(tele.get("num_turns"))
    rec.tool_calls = None  # claude envelope exposes none
    rec.tokens_in = rec.tokens_out = rec.tokens_total = None  # no usage block
    cost = tele.get("total_cost_usd")
    rec.cost_usd = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
    rec.finish_reason = tele.get("subtype")
    rec.finish_reasons = [rec.finish_reason] if rec.finish_reason is not None else None


def _normalize_arm_b(rec: TelemetryRecord, tele: dict[str, Any]) -> None:
    """Arm B (raw qwen-code): real $0 cost, tokens iff ``usage`` present.

    Source keys: ``num_turns``, ``usage`` (token dict, may be absent → N/A),
    ``cost_usd`` pinned 0.0 (arm_b.py:206), ``subtype``. No tool-call counter.
    """
    rec.turns = _coerce_int(tele.get("num_turns"))
    rec.tool_calls = None  # qwen envelope exposes no tool-call counter
    tin, tout, ttotal = _tokens_from_usage(tele.get("usage"))
    rec.tokens_in = tin
    rec.tokens_out = tout
    rec.tokens_total = ttotal
    cost = tele.get("cost_usd")
    rec.cost_usd = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
    rec.finish_reason = tele.get("subtype")
    rec.finish_reasons = [rec.finish_reason] if rec.finish_reason is not None else None


def _normalize_arm_a(rec: TelemetryRecord, tele: dict[str, Any]) -> None:
    """Arm A (qwen via supervisor): real tool_calls, no tokens, local $0 cost.

    Source keys: ``turns`` (often None), ``tool_calls``, ``supervisor_state``
    (the terminal finish signal). No token usage, no cost field in the dict —
    qwen on local hardware, so cost is a measured 0.0 (consistent with Arm B).
    """
    rec.turns = _coerce_int(tele.get("turns"))
    rec.tool_calls = _coerce_int(tele.get("tool_calls"))
    rec.tokens_in = rec.tokens_out = rec.tokens_total = None  # supervisor poll has none
    rec.cost_usd = 0.0  # qwen on local hardware (same basis as Arm B's pinned 0.0)
    rec.finish_reason = tele.get("supervisor_state")
    rec.finish_reasons = [rec.finish_reason] if rec.finish_reason is not None else None


# ── writer ──────────────────────────────────────────────────────────────────


def telemetry_path(arm: str, base_dir: Path | str = ".") -> Path:
    """Canonical ``telemetry.<arm>.jsonl`` path alongside the predictions."""
    return Path(base_dir) / f"telemetry.{str(arm).upper()}.jsonl"


def write_telemetry(path: Path, record: TelemetryRecord) -> None:
    """Append one telemetry record as a JSON line, keyed by ``instance_id``.

    Parallels ``run_arm.write_prediction``: one line per instance, the SAME
    unified schema for every arm so ``report.py`` reads one shape. ``None``
    fields serialize as ``null`` (N/A).
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record.to_dict()) + "\n")
