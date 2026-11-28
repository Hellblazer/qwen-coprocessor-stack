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
