# SPDX-License-Identifier: MIT
"""report.py — merge score + telemetry + variance into the eval scorecard
(RDR-006 40v.9). Produces docs/qwen-coding-agent-eval.md, the RDR's validation
artifact.

Consumes, per arm, the artifacts the rest of the pipeline emits:
  * the normalized score report (score.py): resolved_ids/total, the verbatim
    harness summary ``raw`` (schema_version 2 list memberships: completed_ids,
    resolved_ids, empty_patch_ids, error_ids, incomplete_ids), and
    ``applied_ids`` (per-instance git-apply status parsed from the run logs);
  * the telemetry records (telemetry.py): per-instance outcome, diffstat,
    tokens/cost (N/A as null), finish_reason, test_edit_contamination;
  * the per-arm flip-rate record (variance.py): the ±band on the headline.

Load-bearing rules the RDR gate flagged (enforced here, not just documented):
  * Inconclusive zone — a pairwise resolved delta of ``<= INCONCLUSIVE_ZONE``
    is reported as "not detectable at this scale", NOT a direction.
  * Three SEPARATE counters — ``resolved`` (tests pass), ``empty_patch`` (agent
    produced no diff), and ``clean_apply`` (NON-empty patches that git-apply) —
    never conflated or double-counted.
"""

from __future__ import annotations

import warnings
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

import run_arm
import subset

# A pairwise resolved-count delta within ±this band is "not detectable".
INCONCLUSIVE_ZONE = 2

SUBSET_INTENT = (
    "40 instances, a pure function of the pinned SWE-bench_Lite snapshot, drawn "
    "proportionally by repo weight (representative-Lite, not biased to "
    "lightweight repos), >=3 repos, fixed seed, sorted by instance_id."
)


@dataclass
class ArmInputs:
    """All inputs for one arm, keyed for per-instance merge."""

    arm: str
    score: Mapping            # normalized score report from score.py
    telemetry: Sequence[Mapping]  # telemetry records from telemetry.py
    flip: Mapping | None = None   # FlipRateRecord dict from variance.py
    tool_set: str = "qwen core tools (nx extension disabled)"


@dataclass
class ArmScorecard:
    arm: str
    resolved: int
    total: int
    empty_patch: int
    non_empty: int
    clean_apply: int          # non-empty patches that applied cleanly
    clean_apply_failures: int
    band_points: float | None
    band_method: str | None
    tokens_total: int | None = None   # None -> N/A (never fabricated to 0)
    cost_usd: float | None = None
    taxonomy: dict = field(default_factory=dict)

    @property
    def resolved_pct(self) -> float:
        return 100.0 * self.resolved / self.total if self.total else 0.0

    @property
    def clean_apply_rate(self) -> float:
        # Over NON-EMPTY patches only (an empty patch is not an apply failure).
        return 100.0 * self.clean_apply / self.non_empty if self.non_empty else 0.0


def _is_empty_patch(rec: Mapping) -> bool:
    """A submission with no source diff: zero files and zero +/- lines."""
    return (
        int(rec.get("diff_files", 0) or 0) == 0
        and int(rec.get("diff_added", 0) or 0) == 0
        and int(rec.get("diff_removed", 0) or 0) == 0
    )


def _agg_optional_sum(telemetry: Sequence[Mapping], field_name: str):
    """Sum a per-instance numeric field, or None (-> N/A) if no record carries
    it. Never fabricates 0 from absent data; a genuine 0 present in records
    still sums to a real number."""
    vals = [r.get(field_name) for r in telemetry if r.get(field_name) is not None]
    return sum(vals) if vals else None


def _applied_cleanly(score: Mapping, iid: str) -> bool:
    """Whether the (non-empty) submitted patch applied — the RDR clean-apply
    signal, in source-of-truth precedence:

    1. ``applied_ids`` — per-instance ``APPLY_PATCH_PASS`` parsed from the run
       logs by ``score.parse_apply_status``. This is the TRUE git-apply signal
       and the only one matching the RDR definition ("fraction of non-empty
       patches that git-apply cleanly"). A patch that applies but whose test-exec
       OOMs/times-out IS counted here (it is not in ``completed_ids``).
    2. ``completed_ids`` (summary report) — proxy when apply logs are absent.
       This UNDERCOUNTS: an applied-but-test-crashed instance is excluded. Used
       only as a fallback (e.g. hand-built score dicts in tests).
    3. ``resolved_ids`` — last-resort fallback when neither is present; warns,
       since it undercounts applied-but-unresolved patches.
    """
    applied = score.get("applied_ids")
    if applied is not None:
        return iid in set(applied)
    raw = score.get("raw") or {}
    completed = raw.get("completed_ids") if isinstance(raw, Mapping) else None
    if completed is not None:
        return iid in set(completed)
    import warnings

    warnings.warn(
        "score report has neither applied_ids nor raw.completed_ids; "
        "clean-apply falls back to resolved_ids and will undercount "
        "applied-but-unresolved patches.",
        RuntimeWarning,
        stacklevel=2,
    )
    return iid in set(score.get("resolved_ids", []))


def build_scorecard(inp: ArmInputs) -> ArmScorecard:
    """Compute one arm's scorecard with the three SEPARATE counters."""
    resolved_ids = set(inp.score.get("resolved_ids", []))
    total = int(inp.score.get("total", len(inp.telemetry)))

    empty = 0
    non_empty = 0
    clean_apply = 0
    for rec in inp.telemetry:
        if _is_empty_patch(rec):
            empty += 1
            continue
        # Non-empty: it is an apply candidate, distinct from empty and resolved.
        non_empty += 1
        if _applied_cleanly(inp.score, rec.get("instance_id", "")):
            clean_apply += 1

    # `total` is the canonical instance count (from the harness score), but
    # empty/non_empty are derived from telemetry. If a telemetry write was lost
    # (crash, disk-full) the patch-accounting table would silently sum to fewer
    # than `total` rows with no signal. Surface the gap rather than letting a
    # reader puzzle over why resolved+empty+non_empty < total.
    if empty + non_empty != total:
        warnings.warn(
            f"arm {inp.arm}: telemetry rows ({empty + non_empty}) != score total "
            f"({total}); patch accounting may undercount (lost telemetry write?).",
            RuntimeWarning,
            stacklevel=2,
        )

    taxonomy = build_taxonomy(inp.telemetry)
    # clean-apply failures are a first-class taxonomy class per the RDR (a
    # non-empty patch that didn't apply), surfaced in BOTH the patch-accounting
    # table and the taxonomy.
    taxonomy["clean_apply_fail"] = non_empty - clean_apply

    card = ArmScorecard(
        arm=inp.arm,
        resolved=len(resolved_ids),
        total=total,
        empty_patch=empty,
        non_empty=non_empty,
        clean_apply=clean_apply,
        clean_apply_failures=non_empty - clean_apply,
        band_points=(inp.flip or {}).get("band_points"),
        band_method=(inp.flip or {}).get("band_method"),
        tokens_total=_agg_optional_sum(inp.telemetry, "tokens_total"),
        cost_usd=_agg_optional_sum(inp.telemetry, "cost_usd"),
        taxonomy=taxonomy,
    )
    return card


def build_taxonomy(telemetry: Sequence[Mapping]) -> dict[str, int]:
    """Failure-class counts, reported regardless of N (rich even at N=40).

    Reasoning-starvation is inferred from finish_reason for the qwen arms
    (e.g. a length/empty terminal reason on an unresolved run); behavioural
    classes (the RF-3 //-in-Python class) are qualitative and surfaced as a
    review note, not auto-counted.
    """
    tax: dict[str, int] = {
        "timeout": 0,
        "turn_limit": 0,
        "error": 0,
        "test_edit_contamination": 0,
        "empty_patch": 0,
        "reasoning_starvation": 0,
    }
    for rec in telemetry:
        outcome = rec.get("outcome")
        if outcome == run_arm.Outcome.TIMEOUT.value:
            tax["timeout"] += 1
        elif outcome == run_arm.Outcome.TURN_LIMIT.value:
            tax["turn_limit"] += 1
        elif outcome == run_arm.Outcome.ERROR.value:
            tax["error"] += 1
        if rec.get("test_edit_contamination"):
            tax["test_edit_contamination"] += 1
        if _is_empty_patch(rec):
            tax["empty_patch"] += 1
        fr = (rec.get("finish_reason") or "").lower()
        if fr in {"length", "max_tokens", "max_output_tokens"}:
            tax["reasoning_starvation"] += 1
    return tax


@dataclass
class DeltaVerdict:
    label: str
    a_resolved: int
    b_resolved: int
    delta: int
    detectable: bool
    statement: str


def classify_delta(
    label_a: str,
    a_resolved: int,
    label_b: str,
    b_resolved: int,
    zone: int = INCONCLUSIVE_ZONE,
) -> DeltaVerdict:
    """Apply the inconclusive-zone rule to a pairwise resolved delta.

    |delta| <= zone -> "not detectable at this scale" (NO direction reported).
    Otherwise report the direction. This is the gate-flagged spec point; it is
    ENFORCED here, not merely documented.
    """
    delta = a_resolved - b_resolved
    if abs(delta) <= zone:
        return DeltaVerdict(
            label=f"{label_a} vs {label_b}",
            a_resolved=a_resolved,
            b_resolved=b_resolved,
            delta=delta,
            detectable=False,
            statement=(
                f"{label_a} vs {label_b}: |Δ|={abs(delta)} ≤ {zone} — "
                "not detectable at this scale."
            ),
        )
    winner, loser = (
        (label_a, label_b) if delta > 0 else (label_b, label_a)
    )
    return DeltaVerdict(
        label=f"{label_a} vs {label_b}",
        a_resolved=a_resolved,
        b_resolved=b_resolved,
        delta=delta,
        detectable=True,
        statement=(
            f"{label_a} vs {label_b}: Δ={delta:+d} — "
            f"{winner} resolves more than {loser}."
        ),
    )


def _band_str(card: ArmScorecard) -> str:
    if card.band_points is None:
        return ""
    method = card.band_method or "flip-rate-projection"
    return f" ±{card.band_points} pp ({method}; not a CI)"


def _tokens_cell(rec_field) -> str:
    return "N/A" if rec_field is None else str(rec_field)


def render_markdown(
    cards: Sequence[ArmScorecard],
    deltas: Sequence[DeltaVerdict],
    *,
    tool_sets: Mapping[str, str],
    snapshot_revision: str = subset.SNAPSHOT_REVISION,
) -> str:
    """Render the scorecard markdown (docs/qwen-coding-agent-eval.md)."""
    lines: list[str] = []
    lines.append("# Coding-agent evaluation — Qwen vs Claude (SWE-bench Lite)")
    lines.append("")
    lines.append("## Headline — pass@1 resolved")
    lines.append("")
    lines.append("| Arm | resolved | total | resolved% (pass@1) |")
    lines.append("| --- | ---: | ---: | --- |")
    for c in cards:
        lines.append(
            f"| {c.arm} | {c.resolved} | {c.total} | "
            f"{c.resolved_pct:.1f}%{_band_str(c)} |"
        )
    lines.append("")
    lines.append(
        "Bands are a flip-rate projection from the v1 variance probe "
        "(~10 instances × 3 reps), NOT a statistical confidence interval."
    )
    lines.append("")

    lines.append("## Pairwise deltas (inconclusive-zone gated)")
    lines.append("")
    for d in deltas:
        lines.append(f"- {d.statement}")
    lines.append("")
    lines.append(
        f"The inconclusive zone is ±{INCONCLUSIVE_ZONE} resolved instances; a "
        "delta inside it is a valid 'not detectable' outcome, not a tie to spin."
    )
    lines.append("")

    lines.append("## Patch accounting (separate counters)")
    lines.append("")
    lines.append(
        "| Arm | resolved | empty-patch | non-empty | clean-apply | "
        "clean-apply-fail | clean-apply rate |"
    )
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | --- |")
    for c in cards:
        lines.append(
            f"| {c.arm} | {c.resolved} | {c.empty_patch} | {c.non_empty} | "
            f"{c.clean_apply} | {c.clean_apply_failures} | "
            f"{c.clean_apply_rate:.1f}% |"
        )
    lines.append("")
    lines.append(
        "*resolved* = tests pass; *empty-patch* = agent produced no source "
        "diff; *clean-apply rate* = fraction of NON-empty patches that "
        "git-apply cleanly against base. These are distinct — an empty patch "
        "is not an apply failure, and applying is not resolving."
    )
    lines.append("")

    lines.append("## Cost & tokens")
    lines.append("")
    lines.append("| Arm | total tokens | total cost (USD) |")
    lines.append("| --- | --- | --- |")
    for c in cards:
        lines.append(
            f"| {c.arm} | {_tokens_cell(c.tokens_total)} | {_tokens_cell(c.cost_usd)} |"
        )
    lines.append("")
    lines.append(
        "N/A = the arm's CLI does not emit that counter (not zero). The qwen "
        "arms run on local hardware so cost is $0 at the margin; Claude cost is "
        "from the `--output-format json` envelope."
    )
    lines.append("")

    lines.append("## Failure taxonomy")
    lines.append("")
    labels = sorted({k for c in cards for k in c.taxonomy})
    header = "| Arm | " + " | ".join(labels) + " |"
    lines.append(header)
    lines.append("| --- | " + " | ".join("---:" for _ in labels) + " |")
    for c in cards:
        cells = " | ".join(str(c.taxonomy.get(k, 0)) for k in labels)
        lines.append(f"| {c.arm} | {cells} |")
    lines.append("")
    lines.append(
        "Counts are per-class-per-instance and NOT mutually exclusive (one "
        "instance can be both a timeout and an empty-patch), so a row does not "
        "sum to the arm total. Behavioural classes (e.g. the RF-3 "
        "`//`-comment-in-Python class) are qualitative and noted in review, "
        "not auto-counted."
    )
    lines.append("")

    lines.append("## Reproducibility")
    lines.append("")
    lines.append(f"- Dataset: `{subset.DATASET}` @ `{snapshot_revision}` (pinned).")
    lines.append(f"- Subset: {SUBSET_INTENT}")
    lines.append(
        f"- Iso-prompt: one shared task prompt verbatim across arms; per-turn "
        f"output floor {run_arm.MIN_COMPLETION_TOKENS} tokens; max-turns "
        f"{run_arm.MAX_TURNS}; per-instance wall-clock {run_arm.WALL_CLOCK_SECONDS}s."
    )
    for arm, ts in sorted(tool_sets.items()):
        lines.append(f"- Arm {arm} tool surface: {ts}")
    lines.append("")
    return "\n".join(lines)


def build_report(
    arms: Sequence[ArmInputs],
    *,
    zone: int = INCONCLUSIVE_ZONE,
) -> tuple[list[ArmScorecard], list[DeltaVerdict], str]:
    """Full pipeline: scorecards + all pairwise deltas + rendered markdown."""
    if len({a.arm for a in arms}) != len(arms):
        raise ValueError("arm names must be distinct")
    # Tool-surface parity is the whole point of A vs B; if two arms claim the
    # SAME tool_set string the reproducibility section silently misrepresents
    # them. Require distinct strings (A disables nx via the supervisor opt, B
    # via the HOME fixture — genuinely different mechanisms).
    if len({a.tool_set for a in arms}) != len(arms):
        raise ValueError("each arm must declare a distinct tool_set string")

    cards = [build_scorecard(a) for a in arms]
    deltas: list[DeltaVerdict] = []
    for i in range(len(cards)):
        for j in range(i + 1, len(cards)):
            a, b = cards[i], cards[j]
            deltas.append(
                classify_delta(a.arm, a.resolved, b.arm, b.resolved, zone=zone)
            )
    tool_sets = {a.arm: a.tool_set for a in arms}
    md = render_markdown(cards, deltas, tool_sets=tool_sets)
    return cards, deltas, md
