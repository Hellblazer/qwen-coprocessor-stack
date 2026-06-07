# SPDX-License-Identifier: MIT
"""Shared run_arm spine for the three-arm coding eval (RDR-006 40v.3).

This is the fairness/validity spine. Every arm (A=qwen-via-supervisor,
B=raw qwen-code, C=claude -p) shares THESE pieces verbatim; only the
arm-specific invocation flags live in the per-arm drivers (40v.4-.6):

  * ``build_prompt`` — the single task prompt, identical across all arms.
  * ``extract_source_patch`` — the arm-uniform source-only ``git diff``.
    Test-file deltas are stripped identically for every arm (the harness
    applies the gold ``test_patch`` itself, so a model patch touching tests
    would conflict and score a false negative).
  * ``detect_test_contamination`` / ``test_globs_from_patch`` — flag and
    refine, so a test-touching model patch is recorded as
    ``test_edit_contamination`` and scored on the stripped patch.
  * ``run_with_timeout`` — a hard per-instance wall-clock cutoff that FIRES
    (kills the whole process group) and is recorded as ``timeout`` rather
    than hanging the run.
  * ``write_prediction`` — the ``{instance_id, model_name_or_path,
    model_patch}`` JSONL line the official swebench harness consumes.

Arm C note (locked): the prediction's ``model_patch`` comes from THIS git
extraction off the worktree, NEVER from ``claude -p --output-format json``'s
``model_patch`` field (that field is telemetry-only), so all three arms have
identical patch semantics.
"""

from __future__ import annotations

import enum
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

# ── Shared clean-HOME fixture (spine infrastructure). ──────────────────────
# The pinned clean qwen config used as $HOME so ~/.qwen has no nx extension and
# a fixed settings.json baseline. BOTH qwen arms use it (Arm B as the CLI's
# HOME; Arm A as the inner qwen's HOME via the supervisor's `home` spawn opt),
# so the A/B config baseline is identical. Lives on the spine (not a peer arm)
# so neither arm depends on the other for it.
_HERE = Path(__file__).resolve().parent
CLEAN_HOME = _HERE / "fixtures" / "qwen-clean"


def ephemeral_home(clean_home: Path = CLEAN_HOME) -> Path:
    """Copy the clean-HOME fixture into a fresh temp dir for one run.

    qwen-code mutates ``$HOME/.qwen`` at runtime (rewrites settings.json, writes
    installation_id, debug logs, .rustup). Pointing HOME straight at the
    committed fixture pollutes it every run — and a rewritten settings.json
    could change the tool surface mid-eval. Each run gets its own throwaway copy
    instead; the committed fixture stays pristine and concurrent runs can't race
    on it. Caller removes the returned dir."""
    dest = Path(tempfile.mkdtemp(prefix="qwen-home-"))
    shutil.copytree(clean_home, dest, dirs_exist_ok=True)
    return dest


# ── Shared per-arm controls (iso-config). Same for every arm. ──────────────
MAX_TURNS = 40
# Per-instance wall-clock cutoff. Hitting it is recorded as `timeout`,
# distinct from a wrong answer. Generous: the slowest spike instance was well
# under this; it exists to bound a hung/looping agent, not to race it.
WALL_CLOCK_SECONDS = 1800
# Qwen arms must clear the reasoning block or starvation reads as a false
# failure (RDR-006). Claude gets a comparable per-turn budget, stated in the
# report. The drivers consume this; the spine pins the shared floor.
MIN_COMPLETION_TOKENS = 16_384

# Rail instances shared by every arm's integration tests. RAIL_KNOWN is the
# Phase-0 spike instance (gold resolves; the raw qwen CLI failed it — RF-2/RF-3);
# RAIL_CLEAN is a second anchor so the rail is not pinned only to a known
# failure. Both are full Lite rows via subset.load_full_rows (not the subset).
RAIL_KNOWN_INSTANCE = "psf__requests-1963"
RAIL_CLEAN_INSTANCE = "psf__requests-2148"

# Default test-path patterns excluded from every arm's source patch. Refined
# per-instance from the gold test_patch target paths via test_globs_from_patch.
TEST_PATTERNS: tuple[str, ...] = (
    "test/**",
    "tests/**",
    "**/test_*.py",
    "**/*_test.py",
    "**/conftest.py",
    "conftest.py",
)

# Single shared task prompt. Used VERBATIM by all three arms — only invocation
# flags differ. Do not branch this string per arm.
PROMPT_TEMPLATE = """\
You are fixing a bug in the `{repo}` repository. The repository is checked out \
in your current working directory.

Resolve the issue described below by editing the project's SOURCE files. Make \
the smallest change that correctly fixes the issue. Do NOT modify, add, or \
delete test files — the evaluation supplies its own tests; editing tests will \
not help and may invalidate your run. Save all edits to disk before finishing.

--- ISSUE ---
{problem_statement}
"""


class Outcome(str, enum.Enum):
    """Terminal state of an arm run (independent of resolved/unresolved,
    which the scoring harness decides separately)."""

    COMPLETED = "completed"      # agent finished on its own
    TIMEOUT = "timeout"          # wall-clock cutoff fired (spine)
    TURN_LIMIT = "turn_limit"    # agent hit MAX_TURNS (driver-classified)
    ERROR = "error"              # nonzero exit / invocation failure


@dataclass
class RunResult:
    """One arm's result for one instance. Telemetry fields are filled by the
    per-arm drivers; the spine owns outcome + patch + contamination."""

    instance_id: str
    arm: str
    outcome: Outcome
    model_patch: str = ""
    test_edit_contamination: bool = False
    duration_seconds: float = 0.0
    returncode: int | None = None
    telemetry: dict = field(default_factory=dict)


def build_prompt(problem_statement: str, repo: str) -> str:
    """The shared task prompt. Identical for all arms by construction."""
    return PROMPT_TEMPLATE.format(repo=repo, problem_statement=problem_statement)


# ── Patch extraction (arm-uniform) ─────────────────────────────────────────


def gold_test_globs(test_patch: str) -> list[str]:
    """Extract every file path the gold ``test_patch`` touches.

    The scoring harness applies the gold ``test_patch`` itself, overwriting
    exactly these files — so the model's edits to any of them are moot and
    would only cause apply conflicts (a false negative). Excluding the full set
    is therefore correct, not over-broad. By SWE-bench construction the gold
    ``test_patch`` touches only test/fixture files (disjoint from the gold
    source ``patch``), and this also catches test files that don't match the
    generic name patterns (e.g. ``requests/tests/test_x.py``). Parsed from
    ``diff --git a/<p> b/<p>`` headers.
    """
    paths: list[str] = []
    for m in re.finditer(r"^diff --git a/(\S+) b/(\S+)", test_patch, re.MULTILINE):
        paths.append(m.group(2))
    # De-dup, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _exclude_pathspecs(extra: Sequence[str]) -> list[str]:
    return [f":(exclude){p}" for p in (*TEST_PATTERNS, *extra)]


def _test_pathspecs(extra: Sequence[str]) -> list[str]:
    """Positive pathspecs matching test files (for the contamination query)."""
    return list((*TEST_PATTERNS, *extra))


def _git_diff(worktree: Path, pathspecs: Sequence[str], base: str) -> str:
    # Diff against `base` (the instance base_commit), NOT a bare HEAD: if the
    # agent commits its changes, `git diff HEAD` is empty and the run would
    # score zero silently. `git diff <base_commit>` captures committed + staged
    # + unstaged changes since base. No positive "." pathspec: git applies
    # exclude-only pathspecs against the full set (verified), and a "." would
    # defeat the include-only contamination query by matching everything.
    cmd = ["git", "-C", str(worktree), "diff", base, "--", *pathspecs]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return proc.stdout


def detect_test_contamination(
    worktree: Path,
    extra_test_paths: Sequence[str] = (),
    base: str = "HEAD",
) -> bool:
    """True if the worktree has a non-empty delta in any test file since base."""
    diff = _git_diff(worktree, _test_pathspecs(extra_test_paths), base)
    return diff.strip() != ""


def extract_source_patch(
    worktree: Path,
    extra_test_paths: Sequence[str] = (),
    base: str = "HEAD",
) -> tuple[str, bool]:
    """Return ``(source_only_patch, test_edit_contamination)`` — arm-uniform.

    The source patch excludes every test path (generic patterns + the
    per-instance ``extra_test_paths`` from ``gold_test_globs``).
    ``test_edit_contamination`` records whether the agent touched any test
    file; the run is still scored on the stripped source-only patch.

    Drivers MUST pass ``base=<instance base_commit>`` so a change the agent
    *committed* is still captured (a bare HEAD diff would miss it and score a
    silent zero). ``base`` defaults to ``"HEAD"`` only for the no-commit case.
    """
    source = _git_diff(worktree, _exclude_pathspecs(extra_test_paths), base)
    contaminated = detect_test_contamination(worktree, extra_test_paths, base)
    return source, contaminated


def classify_outcome(
    returncode: int | None,
    *,
    turns_used: int | None = None,
    max_turns: int = MAX_TURNS,
) -> Outcome:
    """Shared, arm-uniform classification of a completed (non-timeout) run.

    All arms funnel through this ONE rule so turn-limit exhaustion is reported
    identically (a fairness requirement). ``run_with_timeout`` owns ``TIMEOUT``;
    this owns the post-completion split. Drivers supply the arm-specific
    ``turns_used`` (e.g. claude's ``num_turns``); the *rule* is shared, the
    *signal* is arm-specific.
    """
    if returncode != 0:
        return Outcome.ERROR
    if turns_used is not None and turns_used >= max_turns:
        return Outcome.TURN_LIMIT
    return Outcome.COMPLETED


# ── Wall-clock cutoff runner ───────────────────────────────────────────────


def run_with_timeout(
    cmd: Sequence[str],
    timeout_seconds: float = WALL_CLOCK_SECONDS,
    cwd: Path | None = None,
    env: dict | None = None,
    input_text: str | None = None,
) -> tuple[Outcome, int | None, str, str, float]:
    """Run ``cmd`` with a hard wall-clock cutoff.

    On timeout the ENTIRE process group is killed (agent CLIs spawn children;
    killing only the direct child would leak the inference subprocess and hang
    the eval). Returns ``(outcome, returncode, stdout, stderr, duration)``.
    The cutoff always fires — it never hangs the run.
    """
    full_env = {**os.environ, **(env or {})}
    start = time.monotonic()
    # start_new_session => the child is a process-group leader, so we can
    # signal the whole group on timeout.
    proc = subprocess.Popen(
        list(cmd),
        cwd=str(cwd) if cwd else None,
        env=full_env,
        stdin=subprocess.PIPE if input_text is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        out, err = proc.communicate(input=input_text, timeout=timeout_seconds)
        duration = time.monotonic() - start
        outcome = Outcome.COMPLETED if proc.returncode == 0 else Outcome.ERROR
        return outcome, proc.returncode, out, err, duration
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        # Bound the drain too: if the kill somehow didn't land, the cutoff must
        # still NOT hang the run (the whole point of the wall-clock guard).
        try:
            out, err = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        duration = time.monotonic() - start
        return Outcome.TIMEOUT, proc.returncode, out or "", err or "", duration


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL the child's whole process group; fall back to killing the child."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


# ── Prediction writer ──────────────────────────────────────────────────────


def write_prediction(
    path: Path,
    instance_id: str,
    model_name_or_path: str,
    model_patch: str,
) -> None:
    """Append one swebench prediction line: the harness reads exactly these
    three keys. ``model_patch`` is the arm-uniform git extraction."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {
            "instance_id": instance_id,
            "model_name_or_path": model_name_or_path,
            "model_patch": model_patch,
        }
    )
    with path.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
