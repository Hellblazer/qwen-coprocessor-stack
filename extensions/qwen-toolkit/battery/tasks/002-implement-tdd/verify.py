#!/usr/bin/env python3
"""Grader-only verify script for 002-implement-tdd. NEVER materialized into
the model's working tree (it lives beside task.json, not under files/).

Checks, all mechanical, run against the materialized tree (argv[1], or cwd
if omitted):

1. Oracle integrity: test_ratelimiter.py is byte-identical to the pristine
   copy under files/ -- the model must not edit the grading suite.
2. Scope discipline: no files exist beyond the pristine set plus exactly
   one new file, ratelimiter.py (ignoring __pycache__/*.pyc). The task
   names exactly which file may be created; this enforces it, not just
   states it.
3. LOC ceiling: ratelimiter.py has at most LOC_CEILING physical lines.
   Calibrated empirically (bead qwen-coprocessor-stack-3su.11): the
   shipped minimal gold solution is 23 lines; the shipped deliberately
   over-engineered negative-gold solution (same correct behavior, extra
   ABC/dataclass/logging/factory-function scaffolding) is 109 lines.
   LOC_CEILING=50 sits well clear of both, so genuine minor style
   variation (an extra docstring, a couple of blank lines) doesn't
   false-fail while real over-engineering still trips it.
4. Correctness: `python3 -m unittest -v test_ratelimiter` exits 0.

Exits 0 only if ALL FOUR pass. Prints one final diagnostics line
(VERIFY_DIAGNOSTICS: <json>) unconditionally, with per-check detail and
ratelimiter.py's line count -- so a passing run's diff SIZE is still
visible to a caller, not only pass/fail (bead 3su.11: "record diff size
alongside pass/fail -- passing with 5x the necessary code is a real
finding").
"""

import json
import subprocess
import sys
from pathlib import Path

LOC_CEILING = 50
IGNORED_NAMES = {"__pycache__"}
IGNORED_SUFFIXES = {".pyc"}

TASK_DIR = Path(__file__).resolve().parent
PRISTINE_FILES_DIR = TASK_DIR / "files"
ALLOWED_NEW_FILE = "ratelimiter.py"


def _relevant_files(root: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for p in root.rglob("*"):
        if p.is_dir():
            continue
        if any(part in IGNORED_NAMES for part in p.parts):
            continue
        if p.suffix in IGNORED_SUFFIXES:
            continue
        out[str(p.relative_to(root))] = p
    return out


def main() -> int:
    tree = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    tree = tree.resolve()

    pristine = _relevant_files(PRISTINE_FILES_DIR)
    actual = _relevant_files(tree)

    diagnostics: dict = {"tree": str(tree)}
    ok = True

    # 1. Oracle integrity.
    oracle_name = "test_ratelimiter.py"
    oracle_path = actual.get(oracle_name)
    oracle_modified = True
    if oracle_path is not None and oracle_path.exists():
        oracle_modified = oracle_path.read_bytes() != pristine[oracle_name].read_bytes()
    diagnostics["oracle_modified"] = oracle_modified
    if oracle_modified:
        ok = False

    # 2. Scope discipline: actual == pristine + {ratelimiter.py}, exactly.
    expected_names = set(pristine.keys()) | {ALLOWED_NEW_FILE}
    actual_names = set(actual.keys())
    extra_files = sorted(actual_names - expected_names)
    missing_files = sorted(expected_names - actual_names - {ALLOWED_NEW_FILE})
    diagnostics["extra_files"] = extra_files
    diagnostics["missing_pristine_files"] = missing_files
    if extra_files or missing_files:
        ok = False

    # 3. LOC ceiling.
    impl_path = actual.get(ALLOWED_NEW_FILE)
    loc = None
    if impl_path is None or not impl_path.exists():
        diagnostics["ratelimiter_present"] = False
        ok = False
    else:
        diagnostics["ratelimiter_present"] = True
        loc = sum(1 for _ in impl_path.open())
        diagnostics["loc"] = loc
        diagnostics["loc_ceiling"] = LOC_CEILING
        if loc > LOC_CEILING:
            ok = False

    # 4. Correctness -- only run if ratelimiter.py exists at all, so a
    # missing-file case doesn't crash unittest's import.
    tests_exit_code = None
    if impl_path is not None and impl_path.exists():
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "-v", "test_ratelimiter"],
            cwd=str(tree),
            capture_output=True,
            text=True,
        )
        tests_exit_code = proc.returncode
        diagnostics["tests_exit_code"] = tests_exit_code
        diagnostics["tests_stderr_tail"] = proc.stderr[-800:]
        if tests_exit_code != 0:
            ok = False
    else:
        diagnostics["tests_exit_code"] = None

    diagnostics["ok"] = ok
    print(f"VERIFY_DIAGNOSTICS: {json.dumps(diagnostics)}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
