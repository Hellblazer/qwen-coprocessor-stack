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
import shutil
import subprocess
import sys
import tempfile
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


class DispatchViaDriverTests(TempDirCase):
    def _task(self) -> rb.TaskSpec:
        return rb.load_task_spec(write_synthetic_fixture(self.tmp, buggy_value="1", solution_value="42"))

    def test_parses_a_well_formed_result(self) -> None:
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(
                args=args,
                returncode=0,
                stdout=json.dumps({"ok": True, "elapsed_ms": 1234, "tool_calls": 7, "error": None}),
                stderr="",
            )

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", run=fake_run)
        self.assertTrue(outcome.ok)
        self.assertEqual(outcome.elapsed_ms, 1234)
        self.assertEqual(outcome.tool_calls, 7)
        self.assertIsNone(outcome.error)

    def test_malformed_stdout_is_a_recorded_error_not_a_crash_or_silent_pass(self) -> None:
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=args, returncode=1, stdout="not json at all", stderr="")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", run=fake_run)
        self.assertFalse(outcome.ok)
        self.assertIsNotNone(outcome.error)
        self.assertIn("malformed driver output", outcome.error)

    def test_json_array_stdout_is_also_treated_as_malformed(self) -> None:
        # Valid JSON, but not the expected object shape.
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="[1,2,3]", stderr="")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", run=fake_run)
        self.assertFalse(outcome.ok)
        self.assertIn("malformed driver output", outcome.error)

    def test_subprocess_timeout_is_a_recorded_error_not_a_crash(self) -> None:
        def fake_run(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="driver.ts", timeout=1.0)

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", run=fake_run)
        self.assertFalse(outcome.ok)
        self.assertIn("timed out", outcome.error)

    def test_empty_stdout_is_recorded_not_silently_passed(self) -> None:
        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=args, returncode=137, stdout="", stderr="killed")

        outcome = rb.dispatch_via_driver(self._task(), self.tmp / "tree", "toolkit", run=fake_run)
        self.assertFalse(outcome.ok)
        self.assertIn("killed", outcome.error)


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


if __name__ == "__main__":
    unittest.main()
