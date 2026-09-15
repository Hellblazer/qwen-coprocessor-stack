# SPDX-License-Identifier: MIT
"""Stdlib-Python battery runner/grader (bead qwen-coprocessor-stack-3su.9).

For each task under ``tasks/*/task.json`` (the bead 3su.7 contract; note
this is the real on-disk filename -- 3su.9's own description text says
``spec.json``, which does not exist anywhere in this tree; matching what
3su.7 actually shipped, not the bead's typo) and each arm
(``toolkit``/``control``): materialize a fresh working tree from
``setup.copy_dir``, invoke ``driver.ts`` (bead 3su.8) as a subprocess with
the task spec on stdin, then run the task's OWN ``verify`` command against
the resulting tree and compare its exit code to ``expected_exit_code``.
Emit one JSON document: a gold self-check per task, one row per
task/arm/repetition, and a per-arm summary.

Pure stdlib -- no pip, no venv, no third-party imports.

## The grader decides, never the model

``RunRow.passed`` is computed from ``verify``'s exit code alone --
NEVER from the driver's own ``ok`` field (see ``run_one`` below: the exit
code is read in the same unconditional step regardless of what the
dispatch returned). ``ok: true`` from ``driver.ts`` means the session
produced a final turn within budget; it says nothing about whether the
task was actually solved.

## Gold self-check (fail loudly, not noisily)

A fixture is only trustworthy if its own gold solution (``solution/``)
scores 100%. ``gold_check_task`` runs BEFORE any dispatch for a task:
materializes the pristine ``files/`` tree (must FAIL verify) and a second
tree with ``solution/``'s files overlaid on top (must PASS verify,
skipping ``solution/README.md`` -- documentation, not code -- see
``battery/README.md``'s Gold self-check section). ``run_battery`` skips
ALL dispatch for a task whose gold-check fails and reports it in
``broken_fixtures`` -- a broken fixture must not silently measure noise.

## Serial dispatch (bead qwen-coprocessor-stack-7i1)

The box's llama-server serves a shared 64K unified-KV pool across its
n_parallel slots; two concurrent big agentic requests can starve or kill
BOTH. ``run_battery``'s task/arm/repetition loops are plain sequential
Python `for` loops -- there is no thread pool, no asyncio, no
subprocess fan-out here. Do not "helpfully" parallelize them.

## Testability

``dispatch_fn`` (the thing that actually shells out to ``driver.ts``, and
through it may reach a live backend) is always an injected parameter --
production code passes ``dispatch_via_driver``; tests pass a hand-built
stub. This means the WHOLE orchestration spine (gold-check gating,
fresh-tree-per-arm, pass/fail-from-verify-only, summary aggregation) is
exercised by ``tests/test_run_battery.py`` with zero Node/npm/live-backend
dependency -- only ``run_verify``'s own subprocess calls (running the
FIXTURE's stdlib test suite, e.g. ``python3 -m unittest``) are real, and
those need nothing beyond the system ``python3``.

Test command (same stdlib-vs-pytest resolution as bead 3su.7 -- pytest is
NOT stdlib and is not guaranteed present; tests are unittest.TestCase so
this needs no venv):

    python3 -m unittest discover -s extensions/qwen-toolkit/battery/tests -q

(pytest also collects these tests where it happens to be installed; there
is no pytest dependency either way.)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

BATTERY_DIR = Path(__file__).resolve().parent
REPO_ROOT = BATTERY_DIR.parents[2]  # battery -> qwen-toolkit -> extensions -> repo root
SUPERVISOR_DIR = REPO_ROOT / "mcp-bridges" / "qwen-agent-server"
TSX_BIN = SUPERVISOR_DIR / "node_modules" / ".bin" / "tsx"
DRIVER_TS = BATTERY_DIR / "driver.ts"
DEFAULT_TASKS_DIR = BATTERY_DIR / "tasks"

# Eval-methodology finding (CLAUDE.md "Eval methodology" §4 / RDR-006): too
# low a generation cap truncates a tool call mid-write, which reads as a
# stall rather than a failure. Generous but bounded.
DEFAULT_MAX_OUTPUT_TOKENS = 16384

# Safety margin (seconds) added on top of the task's own timeout_ms for the
# Python-side subprocess timeout on the driver.ts process itself. driver.ts
# already self-enforces spec.timeout_ms internally (polls until its own
# deadline, stops the session, exits) -- this is a backstop in case the
# driver process itself hangs past that, not the primary timeout mechanism.
DRIVER_TIMEOUT_SLACK_S = 60.0

DOCUMENTATION_OVERLAY_NAMES = {"README.md"}


# ── task-spec model (bead 3su.7 task.json contract) ─────────────────────


@dataclass(frozen=True)
class VerifySpec:
    command: list[str]
    cwd: str | None
    expected_exit_code: int


@dataclass(frozen=True)
class TaskSpec:
    task_dir: Path
    name: str
    family: str | None
    prompt: str
    copy_dir: str
    verify: VerifySpec
    max_tool_calls: int
    timeout_ms: int
    notes: str | None


def load_task_spec(task_json_path: Path) -> TaskSpec:
    data = json.loads(task_json_path.read_text())
    task_dir = task_json_path.parent

    for required in ("name", "prompt", "setup", "verify", "max_tool_calls", "timeout_ms"):
        if required not in data:
            raise ValueError(f"{task_json_path}: missing required field '{required}'")

    setup = data["setup"]
    if not isinstance(setup, dict) or "copy_dir" not in setup:
        raise ValueError(f"{task_json_path}: setup.copy_dir is required")

    verify_raw = data["verify"]
    for vf in ("command", "expected_exit_code"):
        if not isinstance(verify_raw, dict) or vf not in verify_raw:
            raise ValueError(f"{task_json_path}: verify.{vf} is required")

    verify = VerifySpec(
        command=list(verify_raw["command"]),
        cwd=verify_raw.get("cwd"),
        expected_exit_code=int(verify_raw["expected_exit_code"]),
    )

    return TaskSpec(
        task_dir=task_dir,
        name=data["name"],
        family=data.get("family"),
        prompt=data["prompt"],
        copy_dir=setup["copy_dir"],
        verify=verify,
        max_tool_calls=int(data["max_tool_calls"]),
        timeout_ms=int(data["timeout_ms"]),
        notes=data.get("notes"),
    )


def discover_tasks(tasks_dir: Path) -> list[TaskSpec]:
    """Sorted (deterministic iteration order) list of task specs.

    Globs ``*/task.json`` -- the real fixture filename shipped by bead
    3su.7 -- not ``*/spec.json`` (3su.9's own description text names that,
    but no such file exists on disk anywhere in this tree).
    """
    paths = sorted(tasks_dir.glob("*/task.json"))
    return [load_task_spec(p) for p in paths]


# ── working-tree materialization ─────────────────────────────────────────


def materialize_tree(task: TaskSpec, dest: Path, overlay_dir: Path | None = None) -> None:
    """Copy ``task.copy_dir``'s contents into ``dest`` (must not exist yet).

    When ``overlay_dir`` is given (the gold ``solution/`` directory), every
    file under it is then copied on top of ``dest`` at the same relative
    path -- EXCEPT a top-level ``README.md`` (documentation, not code; see
    ``battery/README.md``'s Gold self-check section and
    ``tasks/001-interval-debug/solution/README.md``).

    Raises ``FileExistsError`` if ``dest`` already exists -- materializing
    into a tree that already has content would silently violate the
    fresh-tree-per-arm invariant (bead 3su.9's own "no reuse" rule) rather
    than reusing state from a previous dispatch.
    """
    if dest.exists():
        raise FileExistsError(f"materialize_tree: destination already exists (fresh-tree invariant): {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = task.task_dir / task.copy_dir
    shutil.copytree(src, dest)

    if overlay_dir is not None:
        for item in sorted(overlay_dir.rglob("*")):
            if item.is_dir():
                continue
            rel = item.relative_to(overlay_dir)
            if str(rel) in DOCUMENTATION_OVERLAY_NAMES:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)


def _resolve_verify_command(task: TaskSpec) -> list[str]:
    """Substitute the ``{task_dir}`` placeholder in ``verify.command`` with
    the task's own directory, resolved absolute.

    Grader-only helper scripts (e.g. tasks/002-implement-tdd/verify.py)
    live beside task.json, NOT under files/ -- they are never materialized
    into the model's working tree. task.json itself must stay portable
    (no absolute path baked in for a specific checkout), so a command
    element containing the literal token ``{task_dir}`` is resolved here,
    at run time, against ``task.task_dir`` -- not embedded in the spec.
    The subprocess's cwd is still the MATERIALIZED TREE (or verify.cwd),
    independent of this substitution, so a script invoked this way must
    take the tree to check as an explicit argument (by convention, ".",
    which resolves correctly against the subprocess's own cwd).
    """
    task_dir = str(task.task_dir)
    return [part.replace("{task_dir}", task_dir) for part in task.verify.command]


def run_verify(task: TaskSpec, tree: Path) -> tuple[int, str, str]:
    """Run the task's OWN verify command against ``tree``. Grader-run only."""
    cwd = tree if not task.verify.cwd or task.verify.cwd == "." else tree / task.verify.cwd
    command = _resolve_verify_command(task)
    proc = subprocess.run(command, cwd=str(cwd), capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


# ── gold self-check ──────────────────────────────────────────────────────

# A task directory may ship additional NEGATIVE-gold variants alongside the
# one positive `solution/` -- each a sibling directory matching this glob,
# overlaid the same way `solution/` is, but expected to FAIL verify despite
# often passing the task's own test suite (bead 3su.11: "Gold self-check
# must include a deliberately over-engineered solution that FAILS verify,
# alongside the minimal one that passes -- proving the fixture can actually
# catch the failure mode"). The directory name after the prefix becomes the
# variant's label (e.g. `solution-negative-overengineered` -> "overengineered").
NEGATIVE_GOLD_GLOB = "solution-negative-*"
NEGATIVE_GOLD_PREFIX = "solution-negative-"


@dataclass(frozen=True)
class NegativeGoldResult:
    label: str
    exit_code: int
    correctly_fails: bool


@dataclass(frozen=True)
class GoldCheckResult:
    task: str
    buggy_exit_code: int
    buggy_correctly_fails: bool
    gold_exit_code: int
    gold_correctly_passes: bool
    negative_golds: tuple[NegativeGoldResult, ...] = ()

    @property
    def passed(self) -> bool:
        return (
            self.buggy_correctly_fails
            and self.gold_correctly_passes
            and all(ng.correctly_fails for ng in self.negative_golds)
        )


def gold_check_task(task: TaskSpec, work_root: Path) -> GoldCheckResult:
    """Validate the fixture ITSELF, before burning any model time.

    The pristine ``files/`` tree must FAIL verify (the seeded defect(s)
    reproduce, or -- for an implement-from-spec task -- the feature simply
    doesn't exist yet); ``files/`` with ``solution/`` overlaid must PASS
    verify at ``expected_exit_code``. Any ``solution-negative-*`` variant
    (see NEGATIVE_GOLD_GLOB) must FAIL verify too -- proving an objective
    check (scope discipline, a LOC ceiling, oracle-tamper detection, ...)
    actually catches the failure mode it exists for, not just that tests
    happen to pass. A fixture failing any of these is broken and its
    numbers would be noise, not signal.
    """
    buggy_dir = work_root / task.name / "gold-check" / "buggy"
    materialize_tree(task, buggy_dir)
    buggy_exit, _, _ = run_verify(task, buggy_dir)

    gold_dir = work_root / task.name / "gold-check" / "gold"
    solution_dir = task.task_dir / "solution"
    materialize_tree(task, gold_dir, overlay_dir=solution_dir)
    gold_exit, _, _ = run_verify(task, gold_dir)

    negative_golds: list[NegativeGoldResult] = []
    for variant_dir in sorted(task.task_dir.glob(NEGATIVE_GOLD_GLOB)):
        if not variant_dir.is_dir():
            continue
        label = variant_dir.name[len(NEGATIVE_GOLD_PREFIX) :]
        variant_tree = work_root / task.name / "gold-check" / f"negative-{label}"
        materialize_tree(task, variant_tree, overlay_dir=variant_dir)
        variant_exit, _, _ = run_verify(task, variant_tree)
        negative_golds.append(
            NegativeGoldResult(
                label=label,
                exit_code=variant_exit,
                correctly_fails=(variant_exit != task.verify.expected_exit_code),
            )
        )

    return GoldCheckResult(
        task=task.name,
        buggy_exit_code=buggy_exit,
        buggy_correctly_fails=(buggy_exit != task.verify.expected_exit_code),
        gold_exit_code=gold_exit,
        gold_correctly_passes=(gold_exit == task.verify.expected_exit_code),
        negative_golds=tuple(negative_golds),
    )


def gold_check_to_dict(g: GoldCheckResult) -> dict:
    return {
        "task": g.task,
        "buggy_exit_code": g.buggy_exit_code,
        "buggy_correctly_fails": g.buggy_correctly_fails,
        "gold_exit_code": g.gold_exit_code,
        "gold_correctly_passes": g.gold_correctly_passes,
        "negative_golds": [
            {"label": ng.label, "exit_code": ng.exit_code, "correctly_fails": ng.correctly_fails}
            for ng in g.negative_golds
        ],
        "passed": g.passed,
    }


# ── dispatch (bead 3su.8's driver.ts contract) ───────────────────────────


@dataclass(frozen=True)
class DispatchOutcome:
    """A dispatch RECORD, not a grade -- mirrors driver.ts's DispatchResult.

    ``ok`` means the session produced a final turn within budget; it is
    NEVER used to compute ``RunRow.passed`` (see ``run_one``).
    """

    ok: bool
    elapsed_ms: int
    tool_calls: int
    error: str | None
    raw: dict | None = None


DispatchFn = Callable[[TaskSpec, Path, str], DispatchOutcome]
PopenFactory = Callable[..., subprocess.Popen]
KillpgFn = Callable[[int, int], None]
GetpgidFn = Callable[[int], int]

# Grace period + poll cadence for confirming a killed process group actually
# died. SIGKILL cannot be blocked, so this should resolve almost instantly
# in practice; it exists to make "nothing survived" a checked fact in the
# error message, not an assumption.
KILL_GROUP_GRACE_S = 2.0
KILL_GROUP_POLL_INTERVAL_S = 0.05


def _kill_process_group(
    pid: int,
    *,
    killpg: KillpgFn = os.killpg,
    getpgid: GetpgidFn = os.getpgid,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
    grace_s: float = KILL_GROUP_GRACE_S,
    poll_interval_s: float = KILL_GROUP_POLL_INTERVAL_S,
) -> bool:
    """SIGKILL the entire process group rooted at ``pid``, then confirm.

    bead qwen-coprocessor-stack-3su.12 review (CRITICAL): a plain
    ``subprocess`` timeout-kill reaches only the immediate child (the
    node/tsx process running driver.ts). driver.ts's inner
    ``@qwen-code/sdk`` spawns the real qwen-code CLI as a further OS
    grandchild (session.ts's ``pathToQwenExecutable``), and
    ``QwenSession.stop()`` is cooperative-only -- so on a hard timeout the
    grandchild survives, unreaped, still talking to the box. That is
    exactly the bead-7i1 failure mode this battery exists to avoid
    causing. Killing the whole PROCESS GROUP (not just ``pid``) reaches
    it: ``dispatch_via_driver`` launches with ``start_new_session=True``
    so the child's pgid equals its own pid, and every process it spawns
    inherits that same group unless it explicitly detaches.

    Returns True once the group is confirmed gone (or was already gone);
    False if something was still alive after ``grace_s`` -- best-effort,
    surfaced in the caller's error message rather than silently assumed.
    """
    try:
        pgid = getpgid(pid)
    except ProcessLookupError:
        return True  # already gone before we got here

    try:
        killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return True

    deadline = now() + grace_s
    while now() < deadline:
        try:
            killpg(pgid, 0)  # signal 0: liveness probe, no actual delivery
        except ProcessLookupError:
            return True
        except PermissionError:
            # Observed on macOS: a process group whose leader was JUST
            # SIGKILLed can report EPERM (not ESRCH) on a signal-0 probe
            # for a brief window before fully reaping -- the target's
            # existence is ambiguous here, not confirmed gone. Keep
            # polling rather than treating this as either "confirmed
            # dead" or a crash.
            pass
        sleep(poll_interval_s)
    return False


def dispatch_via_driver(
    task: TaskSpec,
    tree: Path,
    arm: str,
    *,
    tsx_bin: Path = TSX_BIN,
    driver_ts: Path = DRIVER_TS,
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS,
    extra_timeout_s: float = DRIVER_TIMEOUT_SLACK_S,
    popen_factory: PopenFactory = subprocess.Popen,
    killpg: KillpgFn = os.killpg,
    getpgid: GetpgidFn = os.getpgid,
) -> DispatchOutcome:
    """Production ``dispatch_fn``: spec on stdin -> driver.ts -> result JSON.

    Malformed/absent driver output is a RECORDED error
    (``DispatchOutcome(ok=False, ...)``), never a crash and never a silent
    pass -- ``popen_factory``/``killpg``/``getpgid`` are injected so tests
    can exercise every failure branch (timeout-and-kill, non-JSON stdout,
    non-object JSON) without Node installed.

    Launches in its own process group (``start_new_session=True``) so a
    timeout can reap the WHOLE tree (driver.ts's node process and the
    qwen-code CLI grandchild it spawns), not just the immediate child --
    see ``_kill_process_group``.
    """
    envelope: dict = {
        "name": task.name,
        "prompt": task.prompt,
        "max_tool_calls": task.max_tool_calls,
        "timeout_ms": task.timeout_ms,
        "cwd": str(tree),
        "max_output_tokens": max_output_tokens,
    }
    if task.family is not None:
        envelope["family"] = task.family

    timeout_s = (task.timeout_ms / 1000.0) + extra_timeout_s
    proc = popen_factory(
        [str(tsx_bin), str(driver_ts), "--arm", arm],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(input=json.dumps(envelope), timeout=timeout_s)
        returncode = proc.returncode
    except subprocess.TimeoutExpired:
        all_dead = _kill_process_group(proc.pid, killpg=killpg, getpgid=getpgid)
        try:
            # Drain whatever output already landed and let Popen finish
            # reaping the (now-killed) child; SIGKILL is unblockable so
            # this should return almost immediately.
            proc.communicate(timeout=5.0)
        except subprocess.TimeoutExpired:
            pass
        survival_note = "" if all_dead else " (WARNING: process group not confirmed dead after kill)"
        return DispatchOutcome(
            ok=False,
            elapsed_ms=0,
            tool_calls=0,
            error=f"driver subprocess (and its process group) timed out after {timeout_s:.0f}s and was killed{survival_note}",
        )

    stdout = (stdout or "").strip()
    try:
        parsed = json.loads(stdout) if stdout else None
    except json.JSONDecodeError:
        parsed = None

    if not isinstance(parsed, dict):
        detail = stdout[:500] if stdout else (stderr or "")[:500]
        return DispatchOutcome(
            ok=False,
            elapsed_ms=0,
            tool_calls=0,
            error=f"malformed driver output (exit {returncode}): {detail}",
        )

    return DispatchOutcome(
        ok=bool(parsed.get("ok", False)),
        elapsed_ms=int(parsed.get("elapsed_ms") or 0),
        tool_calls=int(parsed.get("tool_calls") or 0),
        error=parsed.get("error"),
        raw=parsed,
    )


# ── one task/arm/repetition ──────────────────────────────────────────────


@dataclass(frozen=True)
class RunRow:
    task: str
    arm: str
    repetition: int
    passed: bool
    verify_exit_code: int
    dispatch_ok: bool
    elapsed_ms: int
    tool_calls: int
    error: str | None
    # Echoed from DispatchOutcome.raw["resolved_extensions"] (driver.ts's
    # own real resolveExtensions() result -- see driver.ts's dispatchOne
    # docstring) when the production dispatch_via_driver populated it.
    # None when a stub dispatch_fn didn't set `raw`, or the driver failed
    # before resolution. Lets a run's own JSON answer "did the toolkit arm
    # actually get qwen-toolkit and the control arm actually get 'none'?"
    # directly, per row, without a separate out-of-band check (bead
    # 3su.10 review finding: run-001-2026-08-22 shipped without this
    # field -- confirmed correct for that run via a standalone
    # resolveExtensions() dry-check instead; this closes the gap for
    # every run after it).
    resolved_extensions: object = None
    # verify's own stdout, truncated. A fixture's verify command can print
    # diagnostics beyond bare pass/fail (bead 3su.11: "record diff size
    # alongside pass/fail -- passing with 5x the necessary code is a real
    # finding" -- see tasks/002-implement-tdd/verify.py's
    # VERIFY_DIAGNOSTICS line). None for fixtures whose verify prints
    # nothing meaningful; never required.
    verify_stdout: str | None = None


VERIFY_STDOUT_MAX_CHARS = 2000


def run_row_to_dict(r: RunRow) -> dict:
    return {
        "task": r.task,
        "arm": r.arm,
        "repetition": r.repetition,
        "passed": r.passed,
        "verify_exit_code": r.verify_exit_code,
        "dispatch_ok": r.dispatch_ok,
        "elapsed_ms": r.elapsed_ms,
        "tool_calls": r.tool_calls,
        "error": r.error,
        "resolved_extensions": r.resolved_extensions,
        "verify_stdout": r.verify_stdout,
    }


def run_one(task: TaskSpec, arm: str, repetition: int, work_root: Path, dispatch_fn: DispatchFn) -> RunRow:
    """One materialize -> dispatch -> verify cycle. A fresh tree every time."""
    tree = work_root / task.name / arm / f"rep-{repetition:02d}"
    materialize_tree(task, tree)

    outcome = dispatch_fn(task, tree, arm)

    # Unconditional: verify's exit code is read regardless of `outcome.ok`.
    # This IS the "grader decides, never the model" invariant -- there is
    # no branch here that skips verify or substitutes outcome.ok for it.
    exit_code, verify_stdout, _ = run_verify(task, tree)
    passed = exit_code == task.verify.expected_exit_code

    resolved_extensions = outcome.raw.get("resolved_extensions") if outcome.raw else None
    verify_stdout_trimmed = verify_stdout[:VERIFY_STDOUT_MAX_CHARS] if verify_stdout else None

    return RunRow(
        task=task.name,
        arm=arm,
        repetition=repetition,
        passed=passed,
        verify_exit_code=exit_code,
        dispatch_ok=outcome.ok,
        elapsed_ms=outcome.elapsed_ms,
        tool_calls=outcome.tool_calls,
        error=outcome.error,
        resolved_extensions=resolved_extensions,
        verify_stdout=verify_stdout_trimmed,
    )


# ── full battery ──────────────────────────────────────────────────────────


def _median(values: Sequence[int]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    if len(s) % 2 == 1:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def summarize(rows: Sequence[RunRow]) -> dict:
    """Per-arm totals. A/B semantics: the control arm is the only valid
    baseline (bead 3su.9 audit fix 3) -- this function makes no reference
    to, and accepts no threshold from, the 2026-08-16 calibration run.
    """
    by_arm: dict[str, dict] = {}
    for r in rows:
        s = by_arm.setdefault(r.arm, {"n": 0, "passed": 0, "dispatch_ok": 0, "tool_calls": [], "elapsed_ms": []})
        s["n"] += 1
        if r.passed:
            s["passed"] += 1
        if r.dispatch_ok:
            s["dispatch_ok"] += 1
        s["tool_calls"].append(r.tool_calls)
        s["elapsed_ms"].append(r.elapsed_ms)

    out: dict = {}
    for arm, s in sorted(by_arm.items()):
        n = s["n"]
        out[arm] = {
            "n": n,
            "passed": s["passed"],
            "pass_rate": (s["passed"] / n) if n else None,
            "dispatch_ok": s["dispatch_ok"],
            "median_tool_calls": _median(s["tool_calls"]),
            "median_elapsed_ms": _median(s["elapsed_ms"]),
        }
    return out


HealthCheckFn = Callable[[], bool]


def make_url_health_check(url: str, timeout_s: float = 5.0) -> HealthCheckFn:
    """Production health check: GET url, True iff it returns HTTP 200.

    Kept out of the stdlib module's hardcoded assumptions about WHICH url
    (backends are config-driven, not code-driven -- see CLAUDE.md
    "Conventions & Patterns") -- the caller supplies the url (e.g. the
    coder-box's own /health endpoint) via --health-url.
    """
    import urllib.request

    def check() -> bool:
        try:
            with urllib.request.urlopen(url, timeout=timeout_s) as resp:  # noqa: S310
                return resp.status == 200
        except Exception:
            return False

    return check


def run_battery(
    tasks: Sequence[TaskSpec],
    arms: Sequence[str],
    repeats: int,
    work_root: Path,
    dispatch_fn: DispatchFn,
    health_check_fn: HealthCheckFn | None = None,
) -> dict:
    """The full A/B run: gold-check gate, then serial dispatch loops.

    Serial by construction (bead qwen-coprocessor-stack-7i1: the box's
    shared 64K unified-KV pool cannot take concurrent big requests) -- the
    task/arm/repetition loops below are plain sequential `for` loops, no
    thread pool, no asyncio, no subprocess fan-out. Do not parallelize
    this.

    When ``health_check_fn`` is given, it is called immediately before
    EVERY dispatch (bead 3su.10: "if the BOX goes unhealthy... STOP the
    run and report immediately rather than hammering it"). On the first
    ``False``, the run stops immediately -- no further dispatch calls at
    all, not even for the current arm/task -- and the returned doc carries
    ``aborted_reason`` naming exactly where it stopped. A server-side
    error from an individual dispatch (a 500, a context-exceeded) is NOT
    a health-check failure -- that is a normal recorded DispatchOutcome
    and the run continues; only the health probe itself failing halts
    everything.
    """
    gold_results = [gold_check_task(t, work_root) for t in tasks]
    broken = {g.task for g in gold_results if not g.passed}

    # Compute total dispatch count once before loops (planned, not actual)
    total = (len(tasks) - len(broken)) * len(arms) * repeats

    rows: list[RunRow] = []
    aborted_reason: str | None = None
    completed: int = 0

    for task in tasks:
        if aborted_reason is not None:
            break
        if task.name in broken:
            # Fail loudly, not noisily: a broken fixture gets ZERO dispatch
            # calls (see broken_fixtures in the emitted doc), not a silent
            # pass/fail row that would look like a real measurement.
            continue
        for arm in arms:
            if aborted_reason is not None:
                break
            for rep in range(1, repeats + 1):
                if health_check_fn is not None and not health_check_fn():
                    aborted_reason = f"health check failed before {task.name}/{arm}/rep{rep} -- run stopped"
                    print(f"[battery] ABORTED: {aborted_reason}", file=sys.stderr, flush=True)
                    break
                row = run_one(task, arm, rep, work_root, dispatch_fn)
                rows.append(row)
                completed += 1
                # Progress line to stderr only
                status = "PASS" if row.passed else "FAIL"
                line = f"[battery] {completed}/{total} {row.task}/{row.arm}/rep{row.repetition} {status} elapsed_ms={row.elapsed_ms} tool_calls={row.tool_calls}"
                if row.error is not None:
                    line += f" error={row.error}"
                print(line, file=sys.stderr, flush=True)

    doc: dict = {
        "gold_check": [gold_check_to_dict(g) for g in gold_results],
        "broken_fixtures": sorted(broken),
        "rows": [run_row_to_dict(r) for r in rows],
        "summary": summarize(rows),
    }
    if aborted_reason is not None:
        doc["aborted_reason"] = aborted_reason
    return doc


# ── CLI ────────────────────────────────────────────────────────────────


def _emit(doc: dict, out_path: Path | None) -> None:
    text = json.dumps(doc, indent=2, sort_keys=True)
    if out_path is not None:
        out_path.write_text(text + "\n")
    print(text)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tasks-dir", type=Path, default=DEFAULT_TASKS_DIR)
    parser.add_argument(
        "--work-root",
        type=Path,
        default=None,
        help="Reuse this directory instead of a fresh tempfile.mkdtemp() one. "
        "An explicitly-given --work-root is NEVER auto-deleted (it's the caller's directory, not ours to clean up).",
    )
    parser.add_argument(
        "--keep-work",
        action="store_true",
        help="Keep the (default, tempfile.mkdtemp()-created) work root after the run instead of deleting it -- for inspecting a materialized tree after a confusing row.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--gold-check",
        action="store_true",
        help="Validate fixtures only (buggy tree fails, gold tree passes). No dispatch, no box/backend contact.",
    )
    mode.add_argument(
        "--dispatch",
        action="store_true",
        help="Run the full A/B battery. Touches a live backend via driver.ts -- serial, one dispatch at a time.",
    )
    parser.add_argument("--arms", default="toolkit,control")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--task", action="append", dest="task_filter", default=None, help="Repeatable; limit to this task name.")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--max-output-tokens", type=int, default=DEFAULT_MAX_OUTPUT_TOKENS)
    parser.add_argument(
        "--health-url",
        default=None,
        help="URL checked (HTTP GET, expect 200) before every dispatch; the run stops immediately on the first failure. Recommended for --dispatch against a live production box (bead 3su.10).",
    )
    args = parser.parse_args(argv)

    tasks = discover_tasks(args.tasks_dir)
    if args.task_filter:
        wanted = set(args.task_filter)
        tasks = [t for t in tasks if t.name in wanted]
    if not tasks:
        print(f"no tasks found under {args.tasks_dir}", file=sys.stderr)
        return 2

    # Cleanup-on-exit by default (bead 3su.12 review, Important): the
    # default tempfile.mkdtemp() work root was never removed, so every
    # real run leaked materialized trees into /tmp forever. An explicitly
    # given --work-root is the CALLER's directory -- never auto-deleted,
    # regardless of --keep-work. Only the default (ours, tempfile-created)
    # root is subject to cleanup, and --keep-work opts back out of that
    # for debugging a confusing row's materialized tree.
    work_root_is_ours = args.work_root is None
    work_root = args.work_root if args.work_root is not None else Path(tempfile.mkdtemp(prefix="qwen-battery-"))
    work_root.mkdir(parents=True, exist_ok=True)
    should_cleanup = work_root_is_ours and not args.keep_work

    try:
        if args.gold_check:
            results = [gold_check_task(t, work_root) for t in tasks]
            broken = [r.task for r in results if not r.passed]
            _emit({"gold_check": [gold_check_to_dict(r) for r in results], "broken_fixtures": broken}, args.out)
            if broken:
                print(f"BROKEN FIXTURE(S): {', '.join(broken)}", file=sys.stderr)
                return 1
            return 0

        arms = [a.strip() for a in args.arms.split(",") if a.strip()]

        def dispatch_fn(task: TaskSpec, tree: Path, arm: str) -> DispatchOutcome:
            return dispatch_via_driver(task, tree, arm, max_output_tokens=args.max_output_tokens)

        health_check_fn = make_url_health_check(args.health_url) if args.health_url else None

        doc = run_battery(tasks, arms, args.repeats, work_root, dispatch_fn, health_check_fn=health_check_fn)
        _emit(doc, args.out)
        if doc.get("aborted_reason"):
            print(f"RUN ABORTED: {doc['aborted_reason']}", file=sys.stderr)
            return 3
        if doc["broken_fixtures"]:
            print(f"BROKEN FIXTURE(S), skipped -- see gold_check in the output: {', '.join(doc['broken_fixtures'])}", file=sys.stderr)
            return 1
        return 0
    finally:
        if should_cleanup:
            shutil.rmtree(work_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
