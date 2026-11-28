"""Tests for classify_requests (bead z7dk). Stdlib only, offline."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify_requests as cr  # noqa: E402

TOOLS = [{"type": "function", "function": {"name": "read_file", "parameters": {}}}]
SIDE_TOOLS = [{"type": "function", "function": {"name": "other", "parameters": {}}}]
SYS = {"role": "system", "content": "You are the agent."}
U1 = {"role": "user", "content": "fix it"}
A1 = {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]}
T1 = {"role": "tool", "tool_call_id": "c1", "content": "ok"}
A2 = {"role": "assistant", "content": "done"}
SIDE_SYS = {"role": "system", "content": "Summarize the conversation into a state snapshot."}


def line(seq, messages, tools=None, **extra):
    body = {"model": "m", "messages": messages, "stream": True}
    if tools is not None:
        body["tools"] = tools
    body.update(extra)
    return {"seq": seq, "ts": 0.0, "method": "POST", "path": "/v1/chat/completions", "body": body}


def synthetic():
    """main, main extends, side (own system, no tools), main rewriting A1."""
    a1_rewritten = dict(A1, reasoning_content="thought")
    return [
        line(1, [SYS, U1], TOOLS),
        line(2, [SYS, U1, A1, T1], TOOLS),
        line(3, [SIDE_SYS, {"role": "user", "content": "go"}], []),
        line(4, [SYS, U1, a1_rewritten, T1, A2, T1], TOOLS),
    ]


class GroupKeyTest(unittest.TestCase):
    def test_missing_and_empty_tools_are_same_group(self):
        a = cr.group_key(line(1, [SYS, U1])["body"])
        b = cr.group_key(line(1, [SYS, U1], [])["body"])
        self.assertEqual(a, b)

    def test_tools_change_changes_group(self):
        a = cr.group_key(line(1, [SYS, U1], TOOLS)["body"])
        b = cr.group_key(line(1, [SYS, U1], SIDE_TOOLS)["body"])
        self.assertNotEqual(a, b)

    def test_key_order_does_not_matter(self):
        t1 = [{"b": 1, "a": 2}]
        t2 = [{"a": 2, "b": 1}]
        self.assertEqual(cr.group_key(line(1, [SYS], t1)["body"]),
                         cr.group_key(line(1, [SYS], t2)["body"]))


class SyntheticRunTest(unittest.TestCase):
    def setUp(self):
        self.r = cr.analyze_run("synthetic", synthetic())

    def test_counts_and_groups(self):
        self.assertEqual(self.r["total"], 4)
        self.assertEqual(self.r["main"], 3)
        self.assertEqual(self.r["side"], 1)
        self.assertEqual(len(self.r["groups"]), 2)
        self.assertEqual(self.r["side_by_kind"], {"compression": 1})

    def test_labels(self):
        labels = [(q["label"], q["kind"]) for q in self.r["requests"]]
        self.assertEqual(labels, [("main", None), ("main", None),
                                  ("side", "compression"), ("main", None)])

    def test_no_prefix_transitions(self):
        self.assertEqual(self.r["no_prefix"]["total"], 2)
        self.assertEqual(self.r["no_prefix"]["main_to_side"], 1)
        self.assertEqual(self.r["no_prefix"]["side_to_main"], 1)
        self.assertEqual(self.r["no_prefix"]["main_to_main"], 0)

    def test_extension_vs_previous_main(self):
        ext = [q["extends_prev_main"] for q in self.r["requests"]]
        # first main has no predecessor; second extends; side n/a; fourth rewrites index 2.
        self.assertEqual(ext, [None, True, None, False])
        self.assertEqual(self.r["non_extending"]["count"], 1)
        ev = self.r["non_extending"]["events"][0]
        self.assertEqual(ev["seq"], 4)
        self.assertEqual(ev["first_diff_index"], 2)
        self.assertEqual(ev["fields"], ["reasoning_content"])

    def test_side_request_with_different_nonempty_tools(self):
        log = synthetic()
        log[2] = line(3, [SYS, U1], SIDE_TOOLS)
        r = cr.analyze_run("x", log)
        self.assertEqual(r["side"], 1)
        self.assertEqual(r["side_by_kind"], {"unknown": 1})


SYS2 = {"role": "system", "content": "You are the agent, revised prompt."}


def split_main_run():
    """Main tools, system prompt changes mid-run (3 + 2 requests); a subagent with
    its own tools issues 4 requests, more than either (tools, system) main group."""
    sub = lambda s, n: line(s, [{"role": "system", "content": "sub"}, {"role": "user", "content": str(n)}], SIDE_TOOLS)
    return [
        line(1, [SYS, U1], TOOLS),
        sub(2, 1), sub(3, 2),
        line(4, [SYS, U1, A1, T1], TOOLS),
        line(5, [SYS, U1, A1, T1, A2], TOOLS),
        sub(6, 3), sub(7, 4),
        line(8, [SYS2, U1, A1, T1, A2], TOOLS),
        line(9, [SYS2, U1, A1, T1, A2, U1], TOOLS),
    ]


class MainLoopLabelTest(unittest.TestCase):
    def setUp(self):
        self.r = cr.analyze_run("split", split_main_run())

    def test_main_is_the_dominant_tools_hash_not_the_dominant_group(self):
        labels = [q["label"] for q in self.r["requests"]]
        self.assertEqual(labels, ["main", "side", "side", "main", "main", "side", "side",
                                  "main-system-changed", "main-system-changed"])
        self.assertEqual((self.r["main"], self.r["main_system_changed"], self.r["side"]), (3, 2, 4))

    def test_system_change_is_a_main_loop_prefix_break_not_a_side_request(self):
        # a changed system prompt invalidates the whole prefix: the main-loop
        # chain shows it as non-extending at message 0
        ev = self.r["non_extending"]["events"]
        self.assertEqual([(e["seq"], e["first_diff_index"]) for e in ev], [(8, 0)])
        self.assertEqual(self.r["side_by_kind"], {"unknown": 4})

    def test_run_without_any_tools_has_no_main_loop(self):
        r = cr.analyze_run("x", [line(1, [SYS, U1]), line(2, [SYS, U1, A2], [])])
        self.assertEqual((r["main"], r["main_system_changed"], r["side"]), (0, 0, 2))

    def test_side_kinds_are_marked_unvalidated(self):
        self.assertIn("kind guesses unvalidated against real qwen-code side requests", cr.KIND_NOTE)
        report = cr.build_report([self.r])
        self.assertEqual(report["kind_note"], cr.KIND_NOTE)
        self.assertIn(cr.KIND_NOTE, cr.render_text(report))


class CommonWithPrevTest(unittest.TestCase):
    def test_summary_by_transition(self):
        r = cr.analyze_run("synthetic", synthetic())
        s = r["common_with_prev"]
        # req2 extends req1 by two messages; main->side and side->main share nothing
        self.assertEqual(s["main_to_main"], {"n": 1, "min": 2, "median": 2, "max": 2})
        self.assertEqual(s["main_to_side"]["max"], 0)
        self.assertEqual(s["side_to_main"]["max"], 0)
        self.assertNotIn("side_to_side", s)

    def test_text_reports_it(self):
        r = cr.analyze_run("synthetic", synthetic())
        out = cr.render_text(cr.build_report([r]))
        self.assertIn("leading messages shared with previous request", out)
        self.assertIn("main->main is 0 by construction", out)


class SurrogateAndEncodingTest(unittest.TestCase):
    LONE = "\ud83d"

    def test_group_key_survives_lone_surrogate(self):
        body = line(1, [{"role": "system", "content": "a" + self.LONE}, U1], TOOLS)["body"]
        self.assertEqual(len(cr.group_key(body)), 64)

    def test_analyze_run_survives_lone_surrogate_in_a_message(self):
        log = [line(1, [SYS, U1], TOOLS), line(2, [SYS, U1, {"role": "user", "content": self.LONE}], TOOLS)]
        self.assertEqual(cr.analyze_run("x", log)["main"], 2)

    def test_cli_reads_escaped_surrogate_and_raw_utf8_under_ascii_locale(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classify_requests.py")
        with tempfile.TemporaryDirectory() as d:
            rows = [line(1, [SYS, {"role": "user", "content": "café ☃"}], TOOLS),
                    line(2, [SYS, {"role": "user", "content": "café ☃"}, A2, {"role": "user", "content": self.LONE}], TOOLS)]
            with open(os.path.join(d, "run-1.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps(rows[0], ensure_ascii=False) + "\n")  # raw UTF-8 bytes
                f.write(json.dumps(rows[1], ensure_ascii=True) + "\n")  # \ud83d escape
            env = dict(os.environ, LC_ALL="C", LANG="C", PYTHONUTF8="0", PYTHONCOERCECLOCALE="0")
            p = subprocess.run([sys.executable, script, d], capture_output=True, text=True, env=env)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("requests: 2", p.stdout)


class LoadRowsDiagnosticsTest(unittest.TestCase):
    def load(self, data):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run-1.jsonl")
            with open(path, "wb") as f:
                f.write(data)
            try:
                return cr.load_rows(path), path
            except SystemExit as e:
                return str(e), path

    def test_bad_json_names_file_and_line(self):
        msg, path = self.load(b'{"a": 1}\n\n{"a": \n')
        self.assertIn(f"{path}:3:", msg)

    def test_non_object_row_names_file_and_line(self):
        msg, path = self.load(b'{"a": 1}\n[1, 2]\n')
        self.assertIn(f"{path}:2:", msg)
        self.assertIn("not a JSON object", msg)

    def test_invalid_utf8_names_file_and_line(self):
        msg, path = self.load(b'{"a": 1}\n{"a": "\xff"}\n')
        self.assertIn(f"{path}:2:", msg)
        self.assertIn("UTF-8", msg)

    def test_good_rows_load(self):
        rows, _ = self.load(b'{"a": 1}\n\n{"b": "caf\xc3\xa9"}\n')
        self.assertEqual(rows, [{"a": 1}, {"b": "café"}])


class HelpUnderOOTest(unittest.TestCase):
    def test_help_works_under_python_OO(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classify_requests.py")
        p = subprocess.run([sys.executable, "-OO", script, "--help"], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("--json", p.stdout)


class DiffFieldTest(unittest.TestCase):
    def check(self, a, b, fields):
        self.assertEqual(cr.differing_fields(a, b), fields)

    def test_fields(self):
        self.check({"role": "user", "content": "a"}, {"role": "user", "content": "b"}, ["content"])
        self.check({"role": "user", "content": "a"}, {"role": "tool", "content": "a"}, ["role"])
        self.check({"role": "assistant", "tool_calls": [1]}, {"role": "assistant", "tool_calls": [2]},
                   ["tool_calls"])
        self.check({"role": "tool", "tool_call_id": "a"}, {"role": "tool", "tool_call_id": "b"}, ["other"])
        self.check({"role": "assistant", "content": "a"},
                   {"role": "assistant", "content": "b", "reasoning_content": "r"},
                   ["content", "reasoning_content"])


class ShorterAndKindTest(unittest.TestCase):
    def test_shorter_request_is_non_extending(self):
        log = [line(1, [SYS, U1, A1, T1], TOOLS), line(2, [SYS, U1], TOOLS)]
        r = cr.analyze_run("x", log)
        self.assertEqual(r["non_extending"]["count"], 1)
        self.assertEqual(r["non_extending"]["events"][0]["first_diff_index"], 2)

    def test_json_schema_response_format_kind(self):
        log = [line(1, [SYS, U1], TOOLS),
               line(2, [{"role": "system", "content": "Decide."}, U1], [],
                    response_format={"type": "json_schema", "json_schema": {}}),
               line(3, [SYS, U1], TOOLS)]
        r = cr.analyze_run("x", log)
        self.assertEqual(r["side_by_kind"], {"structured-json": 1})


class CombinedAndCliTest(unittest.TestCase):
    def write_fixture(self, d):
        for name, log in (("run-1.jsonl", synthetic()), ("run-2.jsonl", synthetic()[:2])):
            with open(os.path.join(d, name), "w") as f:
                for rec in log:
                    f.write(json.dumps(rec) + "\n")

    def test_combined(self):
        runs = [cr.analyze_run("a", synthetic()), cr.analyze_run("b", synthetic()[:2])]
        c = cr.combine(runs)
        self.assertEqual(c["total"], 6)
        self.assertEqual(c["main"], 5)
        self.assertEqual(c["side"], 1)
        self.assertEqual(c["no_prefix"]["total"], 2)
        self.assertEqual(c["non_extending"]["count"], 1)

    def test_cli_text_and_json(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classify_requests.py")
        with tempfile.TemporaryDirectory() as d:
            self.write_fixture(d)
            out = subprocess.run([sys.executable, script, d], capture_output=True, text=True, check=True).stdout
            self.assertIn("proxy", out)
            self.assertIn("run-1", out)
            self.assertIn("ALL RUNS", out)
            js = json.loads(subprocess.run([sys.executable, script, "--json", d],
                                           capture_output=True, text=True, check=True).stdout)
            self.assertEqual([r["run"] for r in js["runs"]], ["run-1", "run-2"])
            self.assertEqual(js["combined"]["total"], 6)

    def test_cli_rejects_empty_dir(self):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "classify_requests.py")
        with tempfile.TemporaryDirectory() as d:
            p = subprocess.run([sys.executable, script, d], capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)

    def test_get_and_bodyless_rows_skipped(self):
        log = synthetic()
        log.insert(1, {"seq": 9, "ts": 0, "method": "GET", "path": "/v1/models", "body": None})
        r = cr.analyze_run("x", log)
        self.assertEqual(r["total"], 4)
        self.assertEqual(r["skipped"], 1)


if __name__ == "__main__":
    unittest.main()
