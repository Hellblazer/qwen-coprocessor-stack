# SPDX-License-Identifier: MIT
"""Tests for run_battery.py (bead qwen-coprocessor-stack-3su.9).

Pure stdlib (unittest, json, pathlib, tempfile, subprocess) -- no
third-party imports, no Node/npm, no live backend. The one exception is
that `run_verify` genuinely shells out to `python3 -m unittest` against
each fixture's own test suite -- that is what verify.command IS, and the
gold-path/negative tests below are meaningless if it's faked.

Every test that would otherwise touch `driver.ts` or a live backend
instead injects a stub `dispatch_fn` (mirrors driver-lib.test.ts's
injected-function style, no vi.mock / unittest.mock.patch needed for the
orchestration spine).

Run:

    python3 -m unittest discover -s extensions/qwen-toolkit/battery/tests -q
"""

from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

BATTERY_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BATTERY_DIR))

import run_battery as rb  # noqa: E402

REAL_TASKS_DIR = BATTERY_DIR / "tasks"


class TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="run-battery-test-")
        self.addCleanup(shutil.rmtree, self._tmp, ignore_errors=True)
        self.tmp = Path(self._tmp)


# ── synthetic fixture helper (isolates runner tests from fixture 001's
#    own content, so they don't drift if 001 ever changes) ──────────────


def write_synthetic_fixture(root: Path, *, buggy_value: str, solution_value: str, name: str = "synthetic") -> Path:
    """Write a minimal task.json + files/ + solution/ under root/name.

    verify checks `counter.value() == 42`. Returns the task.json path.
    """
    task_dir = root / name
    files_dir = task_dir / "files"
    solution_dir = task_dir / "solution"
    files_dir.mkdir(parents=True)
    solution_dir.mkdir(parents=True)

    (files_dir / "counter.py").write_text(f"def value():\n    return {buggy_value}\n")
    (files_dir / "test_counter.py").write_text(
        "import unittest\nfrom counter import value\n\n"
        "class T(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(value(), 42)\n"
    )
    (solution_dir / "counter.py").write_text(f"def value():\n    return {solution_value}\n")

    task_json = {
        "name": name,
        "family": "debug",
        "prompt": "fix counter.value() to return 42",
        "setup": {"copy_dir": "files"},
        "verify": {"command": [sys.executable, "-m", "unittest", "-v", "test_counter"], "expected_exit_code": 0},
        "max_tool_calls": 5,
        "timeout_ms": 5000,
    }
    task_json_path = task_dir / "task.json"
    task_json_path.write_text(json.dumps(task_json))
    return task_json_path


def add_negative_gold_variant(task_json_path: Path, label: str, value: str) -> None:
    """Add a solution-negative-<label>/counter.py variant to a fixture
    written by write_synthetic_fixture, for gold-check negative-gold
    tests."""
    variant_dir = task_json_path.parent / f"solution-negative-{label}"
    variant_dir.mkdir(parents=True)
    (variant_dir / "counter.py").write_text(f"def value():\n    return {value}\n")


class LoadTaskSpecTests(TempDirCase):
    def test_loads_real_fixture_001(self) -> None:
        task = rb.load_task_spec(REAL_TASKS_DIR / "001-interval-debug" / "task.json")
        self.assertEqual(task.name, "001-interval-debug")
        self.assertEqual(task.family, "debug")
        self.assertEqual(task.copy_dir, "files")
        self.assertEqual(task.verify.expected_exit_code, 0)
        self.assertGreater(task.max_tool_calls, 0)
        self.assertGreater(task.timeout_ms, 0)

    def test_missing_required_field_raises(self) -> None:
        task_dir = self.tmp / "broken"
        task_dir.mkdir()
        (task_dir / "task.json").write_text(json.dumps({"name": "x", "prompt": "y"}))
        with self.assertRaisesRegex(ValueError, "missing required field"):
            rb.load_task_spec(task_dir / "task.json")

    def test_missing_setup_copy_dir_raises(self) -> None:
        task_dir = self.tmp / "broken2"
        task_dir.mkdir()
        (task_dir / "task.json").write_text(
            json.dumps(
                {
                    "name": "x",
                    "prompt": "y",
                    "setup": {},
                    "verify": {"command": ["true"], "expected_exit_code": 0},
                    "max_tool_calls": 1,
                    "timeout_ms": 1,
                }
            )
        )
        with self.assertRaisesRegex(ValueError, "setup.copy_dir"):
            rb.load_task_spec(task_dir / "task.json")


class DiscoverTasksTests(TempDirCase):
    def test_discovers_task_json_not_spec_json(self) -> None:
        # 3su.9's own description text names `spec.json`; the real shipped
        # contract (bead 3su.7) uses `task.json`. This proves the runner
        # matches what's actually on disk.
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="001-x")
        (self.tmp / "001-x" / "spec.json").write_text("{}")  # a decoy; must be ignored
        tasks = rb.discover_tasks(self.tmp)
        self.assertEqual([t.name for t in tasks], ["001-x"])

    def test_sorted_deterministic_order(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="002-b")
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="001-a")
        tasks = rb.discover_tasks(self.tmp)
        self.assertEqual([t.name for t in tasks], ["001-a", "002-b"])


class MaterializeTreeTests(TempDirCase):
    def test_copies_files_dir_contents(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        task = rb.load_task_spec(task_json)
        dest = self.tmp / "instance-1"
        rb.materialize_tree(task, dest)
        self.assertTrue((dest / "counter.py").exists())
        self.assertTrue((dest / "test_counter.py").exists())

    def test_refuses_to_overwrite_existing_dest(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        task = rb.load_task_spec(task_json)
        dest = self.tmp / "instance-2"
        rb.materialize_tree(task, dest)
        with self.assertRaisesRegex(FileExistsError, "fresh-tree invariant"):
            rb.materialize_tree(task, dest)

    def test_overlay_replaces_matching_file_and_skips_readme(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        task = rb.load_task_spec(task_json)
        (task.task_dir / "solution" / "README.md").write_text("never shown to the model")
        dest = self.tmp / "instance-3"
        rb.materialize_tree(task, dest, overlay_dir=task.task_dir / "solution")
        self.assertEqual((dest / "counter.py").read_text(), "def value():\n    return 42\n")
        self.assertFalse((dest / "README.md").exists())


class GoldCheckRealFixtureTests(TempDirCase):
    """Against the REAL shipped fixture 001 -- the bead's own gold-path
    requirement, run for real (no dispatch involved at all in gold-check
    mode)."""

    def test_fixture_001_gold_check_passes(self) -> None:
        task = rb.load_task_spec(REAL_TASKS_DIR / "001-interval-debug" / "task.json")
        result = rb.gold_check_task(task, self.tmp)
        self.assertTrue(result.buggy_correctly_fails, f"buggy tree unexpectedly passed (exit {result.buggy_exit_code})")
        self.assertTrue(result.gold_correctly_passes, f"gold tree unexpectedly failed (exit {result.gold_exit_code})")
        self.assertTrue(result.passed)

    def test_fixture_002_gold_check_passes_including_negative_gold(self) -> None:
        task = rb.load_task_spec(REAL_TASKS_DIR / "002-implement-tdd" / "task.json")
        result = rb.gold_check_task(task, self.tmp)
        self.assertTrue(result.buggy_correctly_fails, f"empty tree unexpectedly passed (exit {result.buggy_exit_code})")
        self.assertTrue(result.gold_correctly_passes, f"gold tree unexpectedly failed (exit {result.gold_exit_code})")
        self.assertEqual(len(result.negative_golds), 1)
        self.assertEqual(result.negative_golds[0].label, "overengineered")
        self.assertTrue(result.negative_golds[0].correctly_fails, "over-engineered variant unexpectedly passed verify")
        self.assertTrue(result.passed)

    def test_fixture_003_gold_check_passes_including_negative_gold(self) -> None:
        task = rb.load_task_spec(REAL_TASKS_DIR / "003-version-compare-debug" / "task.json")
        result = rb.gold_check_task(task, self.tmp)
        self.assertTrue(result.buggy_correctly_fails, f"buggy tree unexpectedly passed (exit {result.buggy_exit_code})")
        self.assertTrue(result.gold_correctly_passes, f"gold tree unexpectedly failed (exit {result.gold_exit_code})")
        self.assertEqual(len(result.negative_golds), 1)
        self.assertEqual(result.negative_golds[0].label, "test-weakened")
        self.assertTrue(result.negative_golds[0].correctly_fails, "test-weakened variant unexpectedly passed verify")
        self.assertTrue(result.passed)

    def test_full_battery_gold_check_all_three_fixtures(self) -> None:
        tasks = rb.discover_tasks(REAL_TASKS_DIR)
        self.assertEqual(
            [t.name for t in tasks], ["001-interval-debug", "002-implement-tdd", "003-version-compare-debug"]
        )
        results = [rb.gold_check_task(t, self.tmp) for t in tasks]
        broken = [r.task for r in results if not r.passed]
        self.assertEqual(broken, [], f"broken fixtures: {broken}")


class GoldCheckMutationTests(TempDirCase):
    """Mutation-style checks: prove gold_check_task actually catches a
    broken fixture rather than reporting a false 'fixture ok'."""

    def test_catches_a_solution_that_does_not_fix_the_bug(self) -> None:
        # solution/counter.py is IDENTICAL to the buggy files/counter.py.
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="1")
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertTrue(result.buggy_correctly_fails)
        self.assertFalse(result.gold_correctly_passes)
        self.assertFalse(result.passed)

    def test_catches_a_buggy_tree_that_is_not_actually_buggy(self) -> None:
        # files/counter.py already returns the right answer -- nothing to fix.
        task_json = write_synthetic_fixture(self.tmp, buggy_value="42", solution_value="42")
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertFalse(result.buggy_correctly_fails)
        self.assertTrue(result.gold_correctly_passes)
        self.assertFalse(result.passed)


class NegativeGoldTests(TempDirCase):
    """bead 3su.11: a fixture can ship solution-negative-* variants that
    must FAIL verify despite often being otherwise-plausible. Prove the
    mechanism runs them, labels them, and folds them into .passed
    correctly in both directions."""

    def test_negative_gold_that_correctly_fails_keeps_the_task_passed(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        add_negative_gold_variant(task_json, "wrong-value", "7")  # still wrong -- correctly fails
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertEqual(len(result.negative_golds), 1)
        self.assertEqual(result.negative_golds[0].label, "wrong-value")
        self.assertTrue(result.negative_golds[0].correctly_fails)
        self.assertTrue(result.passed)

    def test_negative_gold_that_wrongly_passes_breaks_the_task(self) -> None:
        # A fixture-authoring mistake: the "negative" variant is actually
        # correct (identical to the real solution) -- it will PASS verify,
        # which must be caught, not silently accepted as fine.
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        add_negative_gold_variant(task_json, "accidentally-correct", "42")
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertFalse(result.negative_golds[0].correctly_fails)
        self.assertFalse(result.passed)

    def test_multiple_negative_gold_variants_all_checked(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        add_negative_gold_variant(task_json, "a", "1")
        add_negative_gold_variant(task_json, "b", "2")
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertEqual({ng.label for ng in result.negative_golds}, {"a", "b"})
        self.assertTrue(result.passed)

    def test_no_negative_gold_variants_is_fine(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42")
        task = rb.load_task_spec(task_json)
        result = rb.gold_check_task(task, self.tmp)
        self.assertEqual(result.negative_golds, ())
        self.assertTrue(result.passed)


class VerifyCommandPlaceholderTests(TempDirCase):
    def test_task_dir_placeholder_is_substituted(self) -> None:
        task_json = write_synthetic_fixture(self.tmp, buggy_value="42", solution_value="42")
        task = rb.load_task_spec(task_json)
        # Override verify.command to reference a grader-only script that
        # only exists beside task.json (never under files/), using the
        # {task_dir} placeholder -- exactly tasks/002-implement-tdd's
        # pattern.
        checker = task.task_dir / "checker.py"
        checker.write_text("print('checked')\nraise SystemExit(0)\n")
        object.__setattr__(
            task,
            "verify",
            rb.VerifySpec(command=[sys.executable, "{task_dir}/checker.py"], cwd=None, expected_exit_code=0),
        )
        tree = self.tmp / "tree"
        rb.materialize_tree(task, tree)
        exit_code, stdout, _ = rb.run_verify(task, tree)
        self.assertEqual(exit_code, 0)
        self.assertIn("checked", stdout)


class FakePopen:
    """Stands in for subprocess.Popen at dispatch_via_driver's
    popen_factory seam.

    communicate() either returns (stdout, stderr) or raises
    subprocess.TimeoutExpired -- ONLY on the first call, matching real
    Popen: dispatch_via_driver's timeout handler calls communicate() a
    SECOND time (to drain output after killing), which must return
    normally rather than time out again.
    """

    def __init__(
        self,
        returncode: int = 0,
        stdout: str = "",
        stderr: str = "",
        raise_timeout: bool = False,
        pid: int = 424242,
    ) -> None:
        self.pid = pid
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr
        self._raise_timeout = raise_timeout
        self.communicate_calls = 0

    def communicate(self, input: str | None = None, timeout: float | None = None):  # noqa: A002
        self.communicate_calls += 1
        if self._raise_timeout and self.communicate_calls == 1:
            raise subprocess.TimeoutExpired(cmd="driver.ts", timeout=timeout)
        return self._stdout, self._stderr


def fake_popen_factory(fake: FakePopen) -> rb.PopenFactory:
    def factory(*args, **kwargs):
        return fake

    return factory


class DispatchViaDriverTests(TempDirCase):
    def _task(self) -> rb.TaskSpec:
        return rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))

    def test_parses_a_well_formed_result(self) -> None:
        fake = FakePopen(returncode=0, stdout=json.dumps({"ok": True, "elapsed_ms": 1234, "tool_calls": 7, "error": None}))

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", popen_factory=fake_popen_factory(fake))
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.elapsed_ms, 1234)
        self.assertEqual(outcome.tool_calls, 7)
        self.assertIsNone(outcome.error)

    def test_malformed_stdout_is_a_recorded_error_not_a_crash_or_silent_pass(self) -> None:
        fake = FakePopen(returncode=1, stdout="not json at all")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", popen_factory=fake_popen_factory(fake))
        self.assertFalse(outcome.ok)
        self.assertIsNotNone(outcome.error)
        self.assertIn("malformed driver output", outcome.error)

    def test_json_array_stdout_is_also_treated_as_malformed(self) -> None:
        # Valid JSON, but not the expected object shape.
        fake = FakePopen(returncode=0, stdout="[1,2,3]")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", popen_factory=fake_popen_factory(fake))
        self.assertFalse(outcome.ok)
        self.assertIn("malformed driver output", outcome.error)

    def test_empty_stdout_is_recorded_not_silently_passed(self) -> None:
        fake = FakePopen(returncode=137, stdout="", stderr="killed")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", popen_factory=fake_popen_factory(fake))
        self.assertFalse(outcome.ok)
        self.assertIn("killed", outcome.error)

    def test_timeout_kills_the_whole_process_group_not_just_the_child(self) -> None:
        # bead 3su.12 review (CRITICAL): a plain child-only kill leaves the
        # qwen-code CLI grandchild running against the box. Prove
        # dispatch_via_driver's timeout path resolves the CHILD's pgid and
        # kills THAT (not the pid directly) with SIGKILL.
        fake = FakePopen(raise_timeout=True, pid=999)
        killpg_calls: list[tuple[int, int]] = []
        getpgid_calls: list[int] = []

        def fake_killpg(pgid, sig):
            killpg_calls.append((pgid, sig))
            if sig == 0:
                # Liveness probe: simulate the group being gone as soon as
                # we start checking, so the poll loop resolves in one pass.
                raise ProcessLookupError

        def fake_getpgid(pid):
            getpgid_calls.append(pid)
            return 999  # new-session process group id == the child's own pid

        outcome = rb.dispatch_via_driver(
            self._task(),
            self.tmp / "tree",
            "toolkit",
            popen_factory=fake_popen_factory(fake),
            killpg=fake_killpg,
            getpgid=fake_getpgid,
        )

        self.assertFalse(outcome.ok)
        self.assertIn("timed out", outcome.error)
        self.assertIn("killed", outcome.error)
        self.assertNotIn("not confirmed dead", outcome.error)
        self.assertEqual(getpgid_calls, [999])
        # First call is the actual SIGKILL; second is the liveness probe
        # (signal 0) that confirmed the group was gone.
        self.assertEqual(killpg_calls, [(999, signal.SIGKILL), (999, 0)])
        # The drain-after-kill communicate() call must have happened too.
        self.assertEqual(fake.communicate_calls, 2)

    def test_timeout_error_flags_when_kill_could_not_be_confirmed(self) -> None:
        # killpg's signal-0 liveness probe never raises -- "still alive"
        # forever -- so _kill_process_group's poll loop must run out its
        # (default, ~2s) grace period and report unconfirmed. Real time,
        # no mocking: exercises the actual polling loop rather than a
        # stand-in for it.
        fake = FakePopen(raise_timeout=True, pid=999)

        outcome = rb.dispatch_via_driver(
            self._task(),
            self.tmp / "tree",
            "toolkit",
            popen_factory=fake_popen_factory(fake),
            killpg=lambda pgid, sig: None,
            getpgid=lambda pid: 999,
        )

        self.assertFalse(outcome.ok)
        self.assertIn("not confirmed dead", outcome.error)


class KillProcessGroupTests(unittest.TestCase):
    """Unit tests for _kill_process_group's own polling/confirmation logic,
    fully isolated from real OS process groups."""

    def test_confirms_dead_once_getpgid_raises_on_probe(self) -> None:
        probes = {"count": 0}

        def fake_killpg(pgid, sig):
            if sig == 0:
                probes["count"] += 1
                if probes["count"] >= 2:
                    raise ProcessLookupError

        result = rb._kill_process_group(
            123,
            killpg=fake_killpg,
            getpgid=lambda pid: 123,
            sleep=lambda s: None,
            now=_counting_clock(),
            grace_s=10.0,
            poll_interval_s=0.01,
        )
        self.assertTrue(result)

    def test_returns_false_when_never_confirmed_within_grace_period(self) -> None:
        result = rb._kill_process_group(
            123,
            killpg=lambda pgid, sig: None,  # never raises -- "still alive" forever
            getpgid=lambda pid: 123,
            sleep=lambda s: None,
            now=_counting_clock(),
            grace_s=0.03,
            poll_interval_s=0.01,
        )
        self.assertFalse(result)

    def test_already_gone_before_getpgid_returns_true_immediately(self) -> None:
        def raising_getpgid(pid):
            raise ProcessLookupError

        result = rb._kill_process_group(123, getpgid=raising_getpgid)
        self.assertTrue(result)

    def test_process_gone_the_instant_killpg_is_sent_returns_true(self) -> None:
        def fake_killpg(pgid, sig):
            if sig == signal.SIGKILL:
                raise ProcessLookupError

        result = rb._kill_process_group(123, killpg=fake_killpg, getpgid=lambda pid: 123)
        self.assertTrue(result)


def _counting_clock():
    """A fake monotonic clock that advances by 0.02s per call -- fast
    deterministic tests without a real sleep."""
    state = {"t": 0.0}

    def clock():
        state["t"] += 0.02
        return state["t"]

    return clock


class RealSubprocessGroupKillTests(unittest.TestCase):
    """The bead 3su.12 review's explicit ask: a REAL subprocess test, not
    just the injected-seam unit tests above -- a stub 'driver' that spawns
    its own real OS grandchild, confirm BOTH are dead after dispatch_via_driver
    times out and kills the group. No live box involved."""

    def test_real_grandchild_is_killed_on_timeout(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="killpg-real-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)

        pidfile = tmp / "grandchild.pid"
        stub = tmp / "stub_driver.py"
        stub.write_text(
            "import os, subprocess, sys, time\n"
            "grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"open({str(pidfile)!r}, 'w').write(str(grandchild.pid))\n"
            "time.sleep(60)\n"
        )

        task_json = write_synthetic_fixture(tmp, buggy_value="1", solution_value="42")
        task = rb.load_task_spec(task_json)
        object.__setattr__(task, "timeout_ms", 300)  # 0.3s -- fast test

        outcome = rb.dispatch_via_driver(
            task,
            tmp / "tree",
            "toolkit",
            tsx_bin=Path(sys.executable),
            driver_ts=stub,
            extra_timeout_s=0.2,
        )

        self.assertFalse(outcome.ok)
        self.assertIn("timed out", outcome.error)

        # Give the (already-SIGKILLed) grandchild's PID a moment to
        # actually finish exiting at the OS level -- SIGKILL is
        # unblockable but exit bookkeeping isn't instantaneous.
        grandchild_pid = int(pidfile.read_text())
        deadline = time.monotonic() + 5.0
        grandchild_dead = False
        while time.monotonic() < deadline:
            try:
                os.kill(grandchild_pid, 0)
            except ProcessLookupError:
                grandchild_dead = True
                break
            time.sleep(0.05)
        self.assertTrue(grandchild_dead, f"grandchild pid {grandchild_pid} survived the timeout kill")


class RunOneMutationTests(TempDirCase):
    """The load-bearing invariant: passed comes from verify, never from
    dispatch_fn's own `ok`. Both directions are tested so a future edit
    that starts trusting dispatch_fn.ok either way gets caught."""

    def test_dispatch_ok_true_but_bug_not_fixed_still_fails(self) -> None:
        task = rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))

        def dispatch_fn(task, tree, arm):
            return rb.DispatchOutcome(ok=True, elapsed_ms=100, tool_calls=3, error=None)  # lies

        row = rb.run_one(task, "toolkit", 1, self.tmp, dispatch_fn)
        self.assertTrue(row.dispatch_ok)
        self.assertFalse(row.passed)

    def test_dispatch_ok_false_but_bug_happens_to_be_fixed_still_passes(self) -> None:
        task = rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))

        def dispatch_fn(task, tree, arm):
            # Simulate the model fixing the bug and then the session
            # reporting an error anyway (e.g. a late disconnect).
            shutil.copy2(task.task_dir / "solution" / "counter.py", tree / "counter.py")
            return rb.DispatchOutcome(ok=False, elapsed_ms=100, tool_calls=3, error="backend disconnected")

        row = rb.run_one(task, "toolkit", 1, self.tmp, dispatch_fn)
        self.assertFalse(row.dispatch_ok)
        self.assertTrue(row.passed)

    def test_fresh_tree_per_repetition(self) -> None:
        task = rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))
        calls = []

        def dispatch_fn(task, tree, arm):
            calls.append(tree)
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None)

        rb.run_one(task, "toolkit", 1, self.tmp, dispatch_fn)
        rb.run_one(task, "toolkit", 2, self.tmp, dispatch_fn)
        self.assertEqual(len(set(calls)), 2, "each repetition must get a distinct fresh tree")

    def test_verify_stdout_is_captured_on_the_row(self) -> None:
        # 002's verify.py prints a VERIFY_DIAGNOSTICS line unconditionally
        # (bead 3su.11: "record diff size alongside pass/fail") -- prove
        # run_one surfaces it on the row, using the real fixture rather
        # than reinventing a stdout-emitting synthetic verify command
        # (plain `python3 -m unittest` writes its report to STDERR, not
        # stdout, so a synthetic fixture built on it would test nothing
        # here).
        task = rb.load_task_spec(REAL_TASKS_DIR / "002-implement-tdd" / "task.json")

        def dispatch_fn(task, tree, arm):
            shutil.copy2(task.task_dir / "solution" / "ratelimiter.py", tree / "ratelimiter.py")
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None)

        row = rb.run_one(task, "toolkit", 1, self.tmp, dispatch_fn)
        self.assertTrue(row.passed)
        self.assertIsNotNone(row.verify_stdout)
        self.assertIn("VERIFY_DIAGNOSTICS", row.verify_stdout)

    def test_resolved_extensions_echoed_from_dispatch_outcome_raw(self) -> None:
        # bead 3su.10 review finding: run-001-2026-08-22 shipped without
        # this field in the row JSON. Confirm it's threaded through now.
        task = rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))

        def dispatch_fn(task, tree, arm):
            raw = {"ok": True, "resolved_extensions": ["qwen-toolkit"] if arm == "toolkit" else "none"}
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None, raw=raw)

        toolkit_row = rb.run_one(task, "toolkit", 1, self.tmp, dispatch_fn)
        control_row = rb.run_one(task, "control", 1, self.tmp, dispatch_fn)
        self.assertEqual(toolkit_row.resolved_extensions, ["qwen-toolkit"])
        self.assertEqual(control_row.resolved_extensions, "none")

    def test_resolved_extensions_is_none_when_raw_absent(self) -> None:
        task = rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))
        row = rb.run_one(task, "toolkit", 1, self.tmp, lambda t, tr, a: rb.DispatchOutcome(True, 1, 1, None))
        self.assertIsNone(row.resolved_extensions)


class RunBatteryGoldPathTests(TempDirCase):
    """The bead's own literal requirement: run the runner against fixture
    001's INCLUDED gold solution with dispatch stubbed out; must report
    pass. Plus the negative: a deliberately-unfixed tree must report
    fail."""

    def _stub_dispatch_apply_solution(self, task: rb.TaskSpec, tree: Path, arm: str) -> rb.DispatchOutcome:
        solution_dir = task.task_dir / "solution"
        for item in solution_dir.rglob("*"):
            if item.is_dir() or item.name == "README.md":
                continue
            rel = item.relative_to(solution_dir)
            shutil.copy2(item, tree / rel)
        return rb.DispatchOutcome(ok=True, elapsed_ms=42, tool_calls=11, error=None)

    def _stub_dispatch_noop(self, task: rb.TaskSpec, tree: Path, arm: str) -> rb.DispatchOutcome:
        return rb.DispatchOutcome(ok=True, elapsed_ms=42, tool_calls=1, error=None)

    def test_gold_solution_stubbed_dispatch_reports_pass(self) -> None:
        tasks = [t for t in rb.discover_tasks(REAL_TASKS_DIR) if t.name == "001-interval-debug"]
        self.assertEqual(len(tasks), 1)
        doc = rb.run_battery(tasks, ["toolkit"], 1, self.tmp, self._stub_dispatch_apply_solution)
        self.assertEqual(doc["broken_fixtures"], [])
        self.assertEqual(len(doc["rows"]), 1)
        self.assertTrue(doc["rows"][0]["passed"], doc["rows"][0])
        self.assertEqual(doc["summary"]["toolkit"]["passed"], 1)

    def test_unfixed_tree_reports_fail(self) -> None:
        tasks = [t for t in rb.discover_tasks(REAL_TASKS_DIR) if t.name == "001-interval-debug"]
        doc = rb.run_battery(tasks, ["toolkit"], 1, self.tmp, self._stub_dispatch_noop)
        self.assertEqual(len(doc["rows"]), 1)
        self.assertFalse(doc["rows"][0]["passed"])


class RunBatteryOrchestrationTests(TempDirCase):
    def test_broken_fixture_gets_zero_dispatch_calls(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="1", name="broken-task")  # solution doesn't fix it
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="good-task")
        tasks = rb.discover_tasks(self.tmp)

        calls: list[str] = []

        def dispatch_fn(task, tree, arm):
            calls.append(task.name)
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None)

        doc = rb.run_battery(tasks, ["toolkit"], 1, self.tmp / "work", dispatch_fn)

        self.assertEqual(doc["broken_fixtures"], ["broken-task"])
        self.assertNotIn("broken-task", calls, "a broken fixture must get zero dispatch calls")
        self.assertIn("good-task", calls)
        self.assertEqual(len(doc["rows"]), 1)  # only good-task's row

    def test_per_arm_repetition_count_and_summary(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)

        def dispatch_fn(task, tree, arm):
            # toolkit always fixes it; control never does -- a clean, fake
            # A/B signal to prove per-arm aggregation is wired correctly.
            if arm == "toolkit":
                shutil.copy2(task.task_dir / "solution" / "counter.py", tree / "counter.py")
            return rb.DispatchOutcome(ok=True, elapsed_ms=100, tool_calls=5, error=None)

        doc = rb.run_battery(tasks, ["toolkit", "control"], 3, self.tmp / "work", dispatch_fn)

        self.assertEqual(len(doc["rows"]), 6)  # 1 task * 2 arms * 3 repeats
        self.assertEqual(doc["summary"]["toolkit"]["n"], 3)
        self.assertEqual(doc["summary"]["toolkit"]["passed"], 3)
        self.assertEqual(doc["summary"]["toolkit"]["pass_rate"], 1.0)
        self.assertEqual(doc["summary"]["control"]["n"], 3)
        self.assertEqual(doc["summary"]["control"]["passed"], 0)
        self.assertEqual(doc["summary"]["control"]["pass_rate"], 0.0)
        self.assertEqual(doc["summary"]["toolkit"]["median_tool_calls"], 5.0)

    def test_summary_does_not_reference_the_2026_08_16_calibration(self) -> None:
        # Audit fix 3: the calibration run is not a baseline. The summary
        # must contain no such reference or threshold -- control is the
        # only comparison.
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)
        doc = rb.run_battery(tasks, ["toolkit"], 1, self.tmp / "work", lambda t, tr, a: rb.DispatchOutcome(True, 1, 1, None))
        blob = json.dumps(doc)
        self.assertNotIn("2026-08-16", blob)
        self.assertNotIn("baseline", blob.lower())


class HealthCheckAbortTests(TempDirCase):
    """Bead 3su.10 box discipline: 'if the BOX goes unhealthy... STOP the
    run and report immediately rather than hammering it.' A health-check
    failure must halt ALL further dispatch, not just skip one row."""

    def test_unhealthy_before_first_dispatch_runs_zero_dispatches(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)
        calls: list[str] = []

        def dispatch_fn(task, tree, arm):
            calls.append(arm)
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None)

        doc = rb.run_battery(
            tasks, ["toolkit", "control"], 3, self.tmp / "work", dispatch_fn, health_check_fn=lambda: False
        )

        self.assertEqual(calls, [])
        self.assertEqual(doc["rows"], [])
        self.assertIn("health check failed", doc["aborted_reason"])

    def test_unhealthy_partway_through_stops_immediately(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)
        calls: list[int] = []
        # Healthy for the first 2 checks, then unhealthy from the 3rd on.
        health_sequence = [True, True, False, False, False, False]
        health_iter = iter(health_sequence)

        def dispatch_fn(task, tree, arm):
            calls.append(1)
            return rb.DispatchOutcome(ok=True, elapsed_ms=1, tool_calls=1, error=None)

        doc = rb.run_battery(
            tasks, ["toolkit"], 5, self.tmp / "work", dispatch_fn, health_check_fn=lambda: next(health_iter)
        )

        self.assertEqual(len(calls), 2, "only the 2 dispatches whose health check passed should have run")
        self.assertEqual(len(doc["rows"]), 2)
        self.assertIn("rep3", doc["aborted_reason"])

    def test_healthy_throughout_never_aborts(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)
        doc = rb.run_battery(
            tasks,
            ["toolkit", "control"],
            2,
            self.tmp / "work",
            lambda t, tr, a: rb.DispatchOutcome(True, 1, 1, None),
            health_check_fn=lambda: True,
        )
        self.assertNotIn("aborted_reason", doc)
        self.assertEqual(len(doc["rows"]), 4)

    def test_no_health_check_fn_never_aborts(self) -> None:
        write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42", name="t")
        tasks = rb.discover_tasks(self.tmp)
        doc = rb.run_battery(
            tasks, ["toolkit"], 1, self.tmp / "work", lambda t, tr, a: rb.DispatchOutcome(True, 1, 1, None)
        )
        self.assertNotIn("aborted_reason", doc)


class MakeUrlHealthCheckTests(unittest.TestCase):
    def test_returns_false_for_an_unreachable_url(self) -> None:
        check = rb.make_url_health_check("http://127.0.0.1:1", timeout_s=1.0)
        self.assertFalse(check())


class SummarizeTests(unittest.TestCase):
    def test_empty_rows(self) -> None:
        self.assertEqual(rb.summarize([]), {})

    def test_median_odd_and_even(self) -> None:
        self.assertEqual(rb._median([3, 1, 2]), 2.0)
        self.assertEqual(rb._median([4, 1, 2, 3]), 2.5)
        self.assertIsNone(rb._median([]))


class CLITests(TempDirCase):
    def test_gold_check_mode_exit_0_on_real_fixture(self) -> None:
        out = self.tmp / "out.json"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = rb.main(
                ["--tasks-dir", str(REAL_TASKS_DIR), "--work-root", str(self.tmp / "work"), "--gold-check", "--out", str(out)]
            )
        self.assertEqual(code, 0, stderr.getvalue())
        doc = json.loads(out.read_text())
        self.assertEqual(doc["broken_fixtures"], [])

    def test_gold_check_mode_exit_1_on_broken_fixture(self) -> None:
        write_synthetic_fixture(self.tmp / "tasks", buggy_value="1", solution_value="1", name="broken")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = rb.main(["--tasks-dir", str(self.tmp / "tasks"), "--work-root", str(self.tmp / "work"), "--gold-check"])
        self.assertEqual(code, 1)
        self.assertIn("BROKEN FIXTURE", stderr.getvalue())

    def test_dispatch_mode_with_unreachable_health_url_aborts_before_any_dispatch(self) -> None:
        # Real --dispatch code path, but the health check fails before
        # dispatch_via_driver is ever reached -- no Node, no box needed.
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = rb.main(
                [
                    "--tasks-dir",
                    str(REAL_TASKS_DIR),
                    "--work-root",
                    str(self.tmp / "work"),
                    "--dispatch",
                    "--health-url",
                    "http://127.0.0.1:1",
                ]
            )
        self.assertEqual(code, 3)
        self.assertIn("RUN ABORTED", stderr.getvalue())
        doc = json.loads(stdout.getvalue())
        self.assertEqual(doc["rows"], [])

    def test_requires_gold_check_or_dispatch(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as ctx:
            rb.main(["--tasks-dir", str(REAL_TASKS_DIR)])
        self.assertEqual(ctx.exception.code, 2)

    def test_no_tasks_found_exits_2(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = rb.main(["--tasks-dir", str(self.tmp / "empty"), "--gold-check"])
        self.assertEqual(code, 2)


class WorkRootCleanupTests(TempDirCase):
    """bead 3su.12 review (Important): the default tempfile.mkdtemp() work
    root was never cleaned up -- every real run leaked materialized trees
    into /tmp forever."""

    def _run_with_mkdtemp_capture(self, extra_args: list[str]) -> tuple[int, list[str]]:
        created: list[str] = []
        original_mkdtemp = tempfile.mkdtemp

        def capturing_mkdtemp(*args, **kwargs):
            d = original_mkdtemp(*args, **kwargs)
            created.append(d)
            return d

        tempfile.mkdtemp = capturing_mkdtemp
        try:
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = rb.main(["--tasks-dir", str(REAL_TASKS_DIR), "--task", "001-interval-debug", *extra_args])
        finally:
            tempfile.mkdtemp = original_mkdtemp
        return code, created

    def test_default_work_root_is_deleted_after_gold_check(self) -> None:
        code, created = self._run_with_mkdtemp_capture(["--gold-check"])
        self.assertEqual(code, 0)
        self.assertEqual(len(created), 1)
        self.assertFalse(Path(created[0]).exists(), "default work root was not cleaned up")

    def test_keep_work_flag_preserves_the_default_work_root(self) -> None:
        code, created = self._run_with_mkdtemp_capture(["--gold-check", "--keep-work"])
        self.assertEqual(code, 0)
        self.assertEqual(len(created), 1)
        try:
            self.assertTrue(Path(created[0]).exists(), "--keep-work should have preserved the work root")
        finally:
            shutil.rmtree(created[0], ignore_errors=True)

    def test_explicit_work_root_is_never_deleted(self) -> None:
        explicit_root = self.tmp / "my-own-work-root"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = rb.main(
                [
                    "--tasks-dir",
                    str(REAL_TASKS_DIR),
                    "--task",
                    "001-interval-debug",
                    "--work-root",
                    str(explicit_root),
                    "--gold-check",
                ]
            )
        self.assertEqual(code, 0)
        self.assertTrue(explicit_root.exists(), "an explicitly-given --work-root must never be auto-deleted")

    def test_default_work_root_is_deleted_even_on_broken_fixture(self) -> None:
        # Cleanup must fire on every return path, not just the happy one.
        broken_tasks_dir = self.tmp / "tasks"
        write_synthetic_fixture(broken_tasks_dir, buggy_value="1", solution_value="1", name="broken")
        created: list[str] = []
        original_mkdtemp = tempfile.mkdtemp

        def capturing_mkdtemp(*args, **kwargs):
            d = original_mkdtemp(*args, **kwargs)
            created.append(d)
            return d

        tempfile.mkdtemp = capturing_mkdtemp
        try:
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = rb.main(["--tasks-dir", str(broken_tasks_dir), "--gold-check"])
        finally:
            tempfile.mkdtemp = original_mkdtemp

        self.assertEqual(code, 1)
        self.assertEqual(len(created), 1)
        self.assertFalse(Path(created[0]).exists())


if __name__ == "__main__":
    unittest.main()
