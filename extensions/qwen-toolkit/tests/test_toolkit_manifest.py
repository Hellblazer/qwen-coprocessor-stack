# SPDX-License-Identifier: MIT
"""Drift guard for extensions/qwen-toolkit (bead qwen-coprocessor-stack-3su.5).

qwen-code 0.15.6 SKIPS a malformed agent file silently (parse failure never
aborts extension load) and ignores manifest keys outside its read-set — both
failure modes are invisible at runtime. This suite makes them loud.

Pure stdlib (unittest, json, re, pathlib) — no third-party imports, so the
exact working command needs no venv:

    python3 -m unittest discover -s extensions/qwen-toolkit/tests -q

(pytest also collects these tests where it is installed; there is no pytest
dependency. TOOLKIT_ROOT overrides the extension root for mutation-testing
the guards themselves.)

Deliberately NOT asserted: prose quality of QWEN.md. That is the W4 battery
A/B's job; a phrase-grep here would pass forever while meaning nothing and
freeze wording that should be free to improve.
"""
import json
import os
import re
import unittest
from pathlib import Path

ROOT = Path(os.environ.get("TOOLKIT_ROOT", Path(__file__).resolve().parent.parent))

# Manifest keys qwen-code 0.15.6 actually reads (loadExtensionConfig).
# `description` and top-level `excludeTools` are NOT in this set — they are
# inert, and their presence means someone believes they do something.
MANIFEST_READ_SET = {
    "name", "version", "mcpServers", "contextFileName", "settings", "hooks", "channels",
}

EXPECTED_AGENTS = {"debug.md", "implement-tdd.md", "docs-explain.md"}

APPROVAL_MODES = {"plan", "default", "auto-edit", "yolo"}

# qwen-code's subagent frontmatter regex requires a newline AFTER the closing
# fence; without it the file silently fails to parse and the agent vanishes.
FRONTMATTER_RE = re.compile(r"^---\n([\s\S]*?)\n---\n([\s\S]*)$")

# QWEN.md context budget: target well under 2K tokens (bead 3su.3; measured
# 353 tokens at authoring via the box /tokenize). ~4 chars/token puts a hard
# character ceiling at 8000 — trips long before the token budget does.
QWEN_MD_MAX_CHARS = 8000


def _manifest() -> dict:
    return json.loads((ROOT / "qwen-extension.json").read_text())


class TestManifest(unittest.TestCase):
    def test_parses_and_has_name(self):
        m = _manifest()
        self.assertIn("name", m)
        self.assertTrue(m["name"])

    def test_only_read_set_keys(self):
        unknown = set(_manifest()) - MANIFEST_READ_SET
        self.assertFalse(
            unknown,
            f"manifest keys not read by qwen-code 0.15.6 (inert, remove them): {sorted(unknown)}",
        )

    def test_no_mcp_servers(self):
        # RDR-002 amendment / RDR-013: stdio mcpServers launch at SDK session
        # init before permission checks; this first-party extension is
        # prompt-and-subagent only. Adding one is a tracked RDR decision.
        self.assertNotIn("mcpServers", _manifest())


class TestContextFile(unittest.TestCase):
    def test_qwen_md_exists(self):
        self.assertTrue((ROOT / "QWEN.md").is_file())

    def test_qwen_md_within_budget(self):
        size = len((ROOT / "QWEN.md").read_text())
        self.assertLessEqual(
            size, QWEN_MD_MAX_CHARS,
            f"QWEN.md is {size} chars; the contract is a permanent per-dispatch "
            f"context tax and must stay under {QWEN_MD_MAX_CHARS} chars (~2K tokens)",
        )


class TestAgents(unittest.TestCase):
    def test_exactly_expected_files_flat(self):
        agents_dir = ROOT / "agents"
        entries = [p for p in agents_dir.iterdir() if p.name != ".keep"]
        subdirs = [p.name for p in entries if p.is_dir()]
        self.assertFalse(subdirs, f"agents/ is scanned FLAT; subdirectories are invisible: {subdirs}")
        names = {p.name for p in entries if p.is_file()}
        self.assertEqual(
            names, EXPECTED_AGENTS,
            "agent file set changed — update EXPECTED_AGENTS deliberately, "
            "and remember a malformed file is skipped silently at load",
        )

    def _parsed(self):
        for fname in sorted(EXPECTED_AGENTS):
            content = (ROOT / "agents" / fname).read_text()
            m = FRONTMATTER_RE.match(content)
            yield fname, m

    def test_frontmatter_parses_with_post_fence_newline(self):
        for fname, m in self._parsed():
            self.assertIsNotNone(
                m,
                f"{fname}: frontmatter does not match qwen-code's parser regex "
                "(missing opening fence, closing fence, or the REQUIRED newline "
                "after the closing fence) — the agent would be silently skipped",
            )

    def test_required_fields_and_name_rules(self):
        for fname, m in self._parsed():
            self.assertIsNotNone(m, f"{fname}: unparseable")
            fm = m.group(1)
            name_m = re.search(r"^name:\s*(\S+)\s*$", fm, re.M)
            self.assertIsNotNone(name_m, f"{fname}: missing required 'name'")
            name = name_m.group(1)
            self.assertTrue(2 <= len(name) <= 50, f"{fname}: name length {len(name)} outside 2-50")
            self.assertRegex(name, r"^[\w-]+$", f"{fname}: invalid name chars")
            self.assertIsNotNone(
                re.search(r"^description:\s*\S", fm, re.M),
                f"{fname}: missing required 'description'",
            )

    def test_approval_mode_values(self):
        for fname, m in self._parsed():
            self.assertIsNotNone(m, f"{fname}: unparseable")
            am = re.search(r"^approvalMode:\s*(\S+)\s*$", m.group(1), re.M)
            if am:
                self.assertIn(
                    am.group(1), APPROVAL_MODES,
                    f"{fname}: approvalMode '{am.group(1)}' would THROW at load",
                )


if __name__ == "__main__":
    unittest.main()
