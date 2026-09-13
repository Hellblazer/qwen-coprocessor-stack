# SPDX-License-Identifier: MIT
"""Tests for scripts/ops/provenance/provenance.py (RDR-016).

No mocks of urllib: a real `http.server` fake origin (fake_server.FakeServer)
serves fake HF-API / resolve / GitHub-release-asset routes on 127.0.0.1:0,
and provenance.py is pointed at it via --hf-base/--gh-base. Deterministic,
no network, no sleeps.

Run: python3 -m unittest discover -s scripts/ops/provenance/tests
"""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import provenance as prov  # noqa: E402
from fake_server import FakeServer, Response  # noqa: E402

REAL_ALLOWLIST = str(prov.PROVENANCE_DIR / "allowlist.json")
FIXTURES = Path(__file__).resolve().parent / "fixtures"


# --------------------------------------------------------------------------
# Fixture-repo helpers
# --------------------------------------------------------------------------


def sha1_commit(seed: str) -> str:
    """A deterministic, well-formed 40-hex 'commit sha' for a fixture repo."""
    return hashlib.sha1(seed.encode()).hexdigest()


def sibling_text(path: str, content: bytes) -> dict:
    return {"rfilename": path, "blobId": prov.git_blob_sha1(content), "size": len(content)}


def sibling_weight(path: str, content: bytes) -> dict:
    sha256 = hashlib.sha256(content).hexdigest()
    return {
        "rfilename": path,
        "blobId": hashlib.sha1(content).hexdigest(),
        "size": len(content),
        "lfs": {"sha256": sha256, "size": len(content)},
    }


def tree_entry(path: str, content: bytes, security: dict | None = None) -> dict:
    sec = security or {
        "status": "safe",
        "avScan": {"status": "safe"},
        "protectAiScan": {"status": "unscanned"},
        "pickleImportScan": {"status": "unscanned"},
    }
    return {
        "type": "file",
        "oid": hashlib.sha1(content).hexdigest(),
        "size": len(content),
        "path": path,
        "securityFileStatus": sec,
    }


def register_hf_repo(
    server: FakeServer,
    repo: str,
    sha: str,
    siblings: list[dict],
    tree: list[dict],
    contents: dict[str, bytes],
    revision_suffixes: tuple[str, ...] | None = None,
) -> None:
    # Always serve the no-revision form, the 'main' branch form, and the
    # pinned-sha form (drift/register/lineage re-fetch by the exact sha).
    # Revision-scoped requests use HF's PATH form /revision/{rev} -- the
    # `?revision=` query form is ignored by the real API (answers for main),
    # so the fake must not accept it either or the tests go vacuous.
    if revision_suffixes is None:
        revision_suffixes = ("", "main", sha)
    model_body = json.dumps(
        {"sha": sha, "siblings": siblings, "securityRepoStatus": {"scansDone": True, "filesWithIssues": []}}
    ).encode()
    for rev in revision_suffixes:
        if rev == "":
            path = f"/api/models/{repo}?blobs=true&securityStatus=true"
        else:
            path = f"/api/models/{repo}/revision/{rev}?blobs=true&securityStatus=true"
        server.routes[path] = (lambda body=model_body: (lambda: Response(200, {}, body)))()

    tree_body = json.dumps(tree).encode()
    server.routes[f"/api/models/{repo}/tree/{sha}?expand=true"] = (
        lambda body=tree_body: (lambda: Response(200, {}, body))
    )()

    for path, data in contents.items():
        server.routes[f"/{repo}/resolve/{sha}/{path}"] = (lambda body=data: (lambda: Response(200, {}, body)))()


# --------------------------------------------------------------------------
# Base test case: one shared fake server + fixture repos for the whole module
# --------------------------------------------------------------------------


class ProvenanceTestCase(unittest.TestCase):
    server: FakeServer

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = FakeServer()
        cls.server.start()
        cls._register_fixtures()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.stop()

    @classmethod
    def _register_fixtures(cls) -> None:
        s = cls.server

        # -- repo-basic: clean origin repo, text + LFS weight file --------
        cls.basic_sha = sha1_commit("repo-basic")
        cls.basic_config = b'{"model_type": "fake"}'
        cls.basic_weights = b"FAKE-SAFETENSORS-BYTES-" * 2048
        register_hf_repo(
            s,
            "Qwen/repo-basic",
            cls.basic_sha,
            [sibling_text("config.json", cls.basic_config), sibling_weight("model.safetensors", cls.basic_weights)],
            [tree_entry("config.json", cls.basic_config), tree_entry("model.safetensors", cls.basic_weights)],
            {"config.json": cls.basic_config, "model.safetensors": cls.basic_weights},
        )

        # -- repo-pickle: deny-extension candidate present -----------------
        cls.pickle_sha = sha1_commit("repo-pickle")
        pickle_bytes = b"\x80\x04not-really-a-pickle"
        register_hf_repo(
            s,
            "Qwen/repo-pickle",
            cls.pickle_sha,
            [sibling_text("config.json", cls.basic_config), sibling_text("model.bin", pickle_bytes)],
            [tree_entry("config.json", cls.basic_config), tree_entry("model.bin", pickle_bytes)],
            {"config.json": cls.basic_config, "model.bin": pickle_bytes},
        )

        # -- repo-remote-code: .py present ----------------------------------
        cls.pycode_sha = sha1_commit("repo-remote-code")
        py_bytes = b"import os\nprint('hi')\n"
        register_hf_repo(
            s,
            "Qwen/repo-remote-code",
            cls.pycode_sha,
            [sibling_text("config.json", cls.basic_config), sibling_text("modeling_fake.py", py_bytes)],
            [tree_entry("config.json", cls.basic_config), tree_entry("modeling_fake.py", py_bytes)],
            {"config.json": cls.basic_config, "modeling_fake.py": py_bytes},
        )

        # -- repo-unknown-ext: unrecognized extension -----------------------
        cls.unknown_sha = sha1_commit("repo-unknown-ext")
        weird_bytes = b"who knows"
        register_hf_repo(
            s,
            "Qwen/repo-unknown-ext",
            cls.unknown_sha,
            [sibling_text("config.json", cls.basic_config), sibling_text("weird.xyz", weird_bytes)],
            [tree_entry("config.json", cls.basic_config), tree_entry("weird.xyz", weird_bytes)],
            {"config.json": cls.basic_config, "weird.xyz": weird_bytes},
        )

        # -- repo-security-unsafe: scan flags the weight file ---------------
        cls.unsafe_sha = sha1_commit("repo-security-unsafe")
        unsafe_weights = b"UNSAFE-WEIGHTS-" * 100
        unsafe_sec = {
            "status": "unsafe",
            "avScan": {"status": "unsafe"},
            "protectAiScan": {"status": "unscanned"},
            "pickleImportScan": {"status": "unscanned"},
        }
        register_hf_repo(
            s,
            "Qwen/repo-security-unsafe",
            cls.unsafe_sha,
            [sibling_weight("model.safetensors", unsafe_weights)],
            [tree_entry("model.safetensors", unsafe_weights, security=unsafe_sec)],
            {"model.safetensors": unsafe_weights},
        )

        # -- repo-security-unscanned: not blocking --------------------------
        cls.unscanned_sha = sha1_commit("repo-security-unscanned")
        unscanned_weights = b"UNSCANNED-WEIGHTS-" * 100
        unscanned_sec = {
            "status": "unscanned",
            "avScan": {"status": "unscanned"},
            "protectAiScan": {"status": "unscanned"},
            "pickleImportScan": {"status": "unscanned"},
        }
        register_hf_repo(
            s,
            "Qwen/repo-security-unscanned",
            cls.unscanned_sha,
            [sibling_weight("model.safetensors", unscanned_weights)],
            [tree_entry("model.safetensors", unscanned_weights, security=unscanned_sec)],
            {"model.safetensors": unscanned_weights},
        )

        # -- repo-lfs-mismatch: metadata sha256 does not match served bytes -
        cls.lfsmismatch_sha = sha1_commit("repo-lfs-mismatch")
        real_weights = b"REAL-WEIGHTS-" * 100
        bad_sibling = sibling_weight("model.safetensors", real_weights)
        bad_sibling["lfs"]["sha256"] = "0" * 64  # deliberately wrong
        register_hf_repo(
            s,
            "Qwen/repo-lfs-mismatch",
            cls.lfsmismatch_sha,
            [bad_sibling],
            [tree_entry("model.safetensors", real_weights)],
            {"model.safetensors": real_weights},
        )

        # -- repo-blob-mismatch: non-LFS blobId does not match served bytes -
        cls.blobmismatch_sha = sha1_commit("repo-blob-mismatch")
        cfg_bytes = b'{"a": 1}'
        bad_text_sibling = sibling_text("config.json", cfg_bytes)
        bad_text_sibling["blobId"] = "0" * 40  # deliberately wrong
        register_hf_repo(
            s,
            "Qwen/repo-blob-mismatch",
            cls.blobmismatch_sha,
            [bad_text_sibling],
            [tree_entry("config.json", cfg_bytes)],
            {"config.json": cfg_bytes},
        )

        # -- packager repo (unsloth tier) -----------------------------------
        cls.packager_sha = sha1_commit("repo-packager")
        gguf_bytes = b"GGUF-FAKE-BYTES-" * 50
        register_hf_repo(
            s,
            "unsloth/repo-packager-GGUF",
            cls.packager_sha,
            [sibling_weight("model.Q8_0.gguf", gguf_bytes)],
            [tree_entry("model.Q8_0.gguf", gguf_bytes)],
            {"model.Q8_0.gguf": gguf_bytes},
        )

    def make_manifest_path(self) -> str:
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        return str(Path(td.name) / "MANIFEST.json")

    def make_dest_dir(self) -> str:
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        return str(Path(td.name) / "dest")

    def run_main(self, argv: list[str]) -> int:
        return prov.main(argv)


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------


class ValidateTests(ProvenanceTestCase):
    def test_valid_manifest_passes(self) -> None:
        manifest_path = self.make_manifest_path()
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": []}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def test_missing_required_field_fails(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = {"schema_version": 1, "artifacts": [{"id": "x", "kind": "model"}]}
        Path(manifest_path).write_text(json.dumps(bad))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_bad_enum_fails(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = {
            "schema_version": 1,
            "artifacts": [
                {
                    "id": "x",
                    "kind": "not-a-kind",
                    "status": "verified",
                    "source": {"host": "huggingface", "repo": "a/b", "revision": "0" * 40},
                    "format": "gguf",
                    "trust_tier": "origin",
                    "files": [{"path": "f", "sha256": "0" * 64, "size": 1}],
                    "verified_on": ["mac"],
                }
            ],
        }
        Path(manifest_path).write_text(json.dumps(bad))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_additional_property_rejected(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = {"schema_version": 1, "artifacts": [], "unexpected": True}
        Path(manifest_path).write_text(json.dumps(bad))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_empty_files_array_rejected(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = {
            "schema_version": 1,
            "artifacts": [
                {
                    "id": "x",
                    "kind": "model",
                    "status": "verified",
                    "source": {"host": "huggingface", "repo": "a/b", "revision": "0" * 40},
                    "format": "gguf",
                    "trust_tier": "origin",
                    "files": [],
                    "verified_on": ["mac"],
                }
            ],
        }
        Path(manifest_path).write_text(json.dumps(bad))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_real_shipped_manifest_and_schema_validate(self) -> None:
        rc = self.run_main(
            [
                "validate",
                "--manifest",
                str(prov.DEFAULT_MANIFEST_PATH),
                "--schema",
                str(prov.DEFAULT_SCHEMA_PATH),
            ]
        )
        self.assertEqual(rc, 0)

    def _minimal_artifact(self, **overrides) -> dict:
        base = {
            "id": "x",
            "kind": "model",
            "status": "verified",
            "source": {"host": "huggingface", "repo": "a/b", "revision": "0" * 40},
            "format": "gguf",
            "trust_tier": "origin",
            "files": [{"path": "f", "sha256": "0" * 64, "size": 1}],
            "verified_on": ["mac"],
        }
        base.update(overrides)
        return base

    def test_hf_source_with_branch_name_revision_rejected(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = self._minimal_artifact(source={"host": "huggingface", "repo": "a/b", "revision": "main"})
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": [bad]}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_github_source_missing_asset_rejected(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = self._minimal_artifact(
            kind="runtime",
            format="zip",
            source={"host": "github", "repo": "ggml-org/llama.cpp", "revision": "b10078"},
        )
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": [bad]}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_github_source_with_asset_and_valid_revision_passes(self) -> None:
        manifest_path = self.make_manifest_path()
        good = self._minimal_artifact(
            kind="runtime",
            format="zip",
            source={"host": "github", "repo": "ggml-org/llama.cpp", "revision": "b10078", "asset": "x.zip"},
        )
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": [good]}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def test_derived_from_without_derived_from_files_rejected(self) -> None:
        manifest_path = self.make_manifest_path()
        bad = self._minimal_artifact(derived_from="some/repo@" + "a" * 40)
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": [bad]}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_derived_from_with_derived_from_files_passes(self) -> None:
        manifest_path = self.make_manifest_path()
        good = self._minimal_artifact(
            derived_from="some/repo@" + "a" * 40,
            derived_from_files=[{"path": "model.safetensors", "sha256": "b" * 64, "size": 1}],
        )
        Path(manifest_path).write_text(json.dumps({"schema_version": 1, "artifacts": [good]}))
        rc = self.run_main(["validate", "--manifest", manifest_path])
        self.assertEqual(rc, 0)


# --------------------------------------------------------------------------
# fetch: allowlist
# --------------------------------------------------------------------------


class AllowlistTests(ProvenanceTestCase):
    def test_unknown_owner_refused(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "NotAllowed/repo-x",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_packager_without_flag_refused(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "unsloth/repo-packager-GGUF",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)

    def test_packager_with_flag_but_no_derived_from_refused(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "unsloth/repo-packager-GGUF",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--allow-packager",
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_packager_with_flag_and_derived_from_succeeds(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "unsloth/repo-packager-GGUF",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--allow-packager",
                "--derived-from",
                "Qwen/repo-basic@" + self.basic_sha,
            ]
        )
        self.assertEqual(rc, 0)
        manifest = prov.load_manifest(manifest_path)
        entry = manifest["artifacts"][0]
        self.assertEqual(entry["trust_tier"], "packager")
        self.assertEqual(entry["derived_from"], "Qwen/repo-basic@" + self.basic_sha)

    def test_origin_owner_needs_no_derived_from(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)


# --------------------------------------------------------------------------
# fetch: revision -> sha resolution
# --------------------------------------------------------------------------


class RevisionResolutionTests(ProvenanceTestCase):
    def test_branch_resolves_and_stores_sha(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--revision",
                "main",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["source"]["revision"], self.basic_sha)
        self.assertRegex(entry["source"]["revision"], r"^[0-9a-f]{40}$")

    def test_explicit_older_revision_is_honoured_not_main(self) -> None:
        # The repo's main is basic_sha; register an OLDER revision "oldtag" whose
        # sha differs and whose only weight file has different bytes. fetch
        # --revision oldtag must pin the OLD sha and download the OLD bytes.
        old_sha = "e" * 40
        old_weights = b"OLD-WEIGHTS-" + self.basic_weights
        old_sib = [
            {"rfilename": "model.safetensors", "blobId": "x" * 40, "size": len(old_weights),
             "lfs": {"sha256": hashlib.sha256(old_weights).hexdigest(), "size": len(old_weights)}},
        ]
        old_tree = [{"type": "file", "oid": "x" * 40, "size": len(old_weights), "path": "model.safetensors",
                     "securityFileStatus": {"status": "safe", "avScan": {"status": "safe"}}}]
        register_hf_repo(self.server, "Qwen/repo-basic", old_sha, old_sib, old_tree,
                         {"model.safetensors": old_weights}, revision_suffixes=("oldtag", old_sha))
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(["fetch", "Qwen/repo-basic", "--revision", "oldtag", "--manifest", manifest_path,
                            "--dest", dest, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["source"]["revision"], old_sha)
        self.assertEqual([f["path"] for f in entry["files"]], ["model.safetensors"])
        self.assertEqual(entry["files"][0]["sha256"], hashlib.sha256(old_weights).hexdigest())


# --------------------------------------------------------------------------
# fetch: deny / pickle refusal
# --------------------------------------------------------------------------


class DenyFormatTests(ProvenanceTestCase):
    def test_pickle_candidate_refused_and_manifest_untouched(self) -> None:
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-pickle",
                "--manifest",
                manifest_path,
                "--dest",
                dest,
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])
        self.assertFalse((Path(dest) / "model.bin").exists())

    def test_pickle_excluded_succeeds_with_note(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-pickle",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--exclude",
                "model.bin",
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertIn("model.bin", entry["notes"])
        self.assertEqual(len(entry["files"]), 1)


# --------------------------------------------------------------------------
# fetch: .py / remote code
# --------------------------------------------------------------------------


class RemoteCodeTests(ProvenanceTestCase):
    def test_py_candidate_refused_without_flag(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-remote-code",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_py_candidate_allowed_with_flag(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-remote-code",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--allow-remote-code",
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertIn("modeling_fake.py", entry["remote_code_files"])
        self.assertTrue(entry["remote_code_present"])

    def test_py_excluded_records_present_but_not_downloaded(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-remote-code",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--exclude",
                "*.py",
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["remote_code_files"], [])
        self.assertTrue(entry["remote_code_present"])


# --------------------------------------------------------------------------
# fetch: unknown extension
# --------------------------------------------------------------------------


class UnknownExtensionTests(ProvenanceTestCase):
    def test_unknown_extension_refused_by_default(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-unknown-ext",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)

    def test_unknown_extension_allowed_with_include(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-unknown-ext",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--include",
                "weird.xyz",
                "--include",
                "config.json",
            ]
        )
        self.assertEqual(rc, 0)


# --------------------------------------------------------------------------
# fetch: security scan gating
# --------------------------------------------------------------------------


class SecurityScanTests(ProvenanceTestCase):
    def test_unsafe_scan_blocks(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-security-unsafe",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_unscanned_is_recorded_not_blocking(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-security-unscanned",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        sec = entry["files"][0]["hf_security"]
        self.assertEqual(sec["status"], "unscanned")

    def test_virustotal_malicious_blocks(self) -> None:
        sha = sha1_commit("repo-security-virustotal")
        content = b"VT-FLAGGED-WEIGHTS-" * 100
        sec = {
            "status": "queued",
            "avScan": {"status": "safe"},
            "protectAiScan": {"status": "unscanned"},
            "pickleImportScan": {"status": "unscanned"},
            "virusTotalScan": {"status": "malicious"},
            "jFrogScan": {"status": "unscanned"},
        }
        register_hf_repo(
            self.server,
            "Qwen/repo-security-virustotal",
            sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content, security=sec)],
            {"model.safetensors": content},
        )
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-security-virustotal",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_jfrog_unsafe_blocks(self) -> None:
        sha = sha1_commit("repo-security-jfrog")
        content = b"JFROG-FLAGGED-WEIGHTS-" * 100
        sec = {
            "status": "queued",
            "avScan": {"status": "safe"},
            "protectAiScan": {"status": "unscanned"},
            "pickleImportScan": {"status": "unscanned"},
            "virusTotalScan": {"status": "unscanned"},
            "jFrogScan": {"status": "unsafe"},
        }
        register_hf_repo(
            self.server,
            "Qwen/repo-security-jfrog",
            sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content, security=sec)],
            {"model.safetensors": content},
        )
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-security-jfrog",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_hf_security_records_all_five_subscans(self) -> None:
        entry = prov.load_manifest(
            self._fetch_repo_basic_for_security_summary()
        )["artifacts"][0]
        sec = entry["files"][0]["hf_security"]
        for key in ("status", "avScan", "protectAiScan", "pickleImportScan", "virusTotalScan", "jFrogScan"):
            self.assertIn(key, sec)

    def _fetch_repo_basic_for_security_summary(self) -> str:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        return manifest_path


# --------------------------------------------------------------------------
# fetch: path traversal / arbitrary file write refusal
# --------------------------------------------------------------------------


class PathTraversalTests(unittest.TestCase):
    def test_relative_traversal_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest_dir = Path(td) / "dest"
            dest_dir.mkdir()
            with self.assertRaises(prov.ProvenanceError):
                prov.validate_safe_relpath("../../../etc/traversal-poc.safetensors", dest_dir)

    def test_absolute_path_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest_dir = Path(td) / "dest"
            dest_dir.mkdir()
            with self.assertRaises(prov.ProvenanceError):
                prov.validate_safe_relpath("/etc/traversal-poc.safetensors", dest_dir)

    def test_backslash_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest_dir = Path(td) / "dest"
            dest_dir.mkdir()
            with self.assertRaises(prov.ProvenanceError):
                prov.validate_safe_relpath("..\\..\\traversal-poc.safetensors", dest_dir)

    def test_nul_byte_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest_dir = Path(td) / "dest"
            dest_dir.mkdir()
            with self.assertRaises(prov.ProvenanceError):
                prov.validate_safe_relpath("ok.safetensors\x00.txt", dest_dir)

    def test_normal_filename_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest_dir = Path(td) / "dest"
            dest_dir.mkdir()
            prov.validate_safe_relpath("model-00001-of-00002.safetensors", dest_dir)
            prov.validate_safe_relpath("sub/config.json", dest_dir)


class PathTraversalFetchTests(ProvenanceTestCase):
    """End-to-end: a compromised/hijacked allowlisted repo's siblings[]
    carrying a traversal or absolute path must refuse the WHOLE fetch,
    before anything is written to disk, via the fake server (not a mock).
    """

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        s = cls.server
        cls.traversal_payload = b"MALICIOUS-PAYLOAD-BYTES"

        cls.traversal_sha = sha1_commit("repo-traversal-rel")
        rel_evil = "../../../traversal-poc.safetensors"
        register_hf_repo(
            s,
            "Qwen/repo-traversal-rel",
            cls.traversal_sha,
            [sibling_weight(rel_evil, cls.traversal_payload)],
            [tree_entry(rel_evil, cls.traversal_payload)],
            {rel_evil: cls.traversal_payload},
        )

        cls.traversal_abs_sha = sha1_commit("repo-traversal-abs")
        abs_evil = "/etc/traversal-poc.safetensors"
        register_hf_repo(
            s,
            "Qwen/repo-traversal-abs",
            cls.traversal_abs_sha,
            [sibling_weight(abs_evil, cls.traversal_payload)],
            [tree_entry(abs_evil, cls.traversal_payload)],
            {abs_evil: cls.traversal_payload},
        )

    def test_relative_traversal_fetch_refused_nothing_written(self) -> None:
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-traversal-rel",
                "--manifest",
                manifest_path,
                "--dest",
                dest,
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])
        # Refused before any download (validate_safe_relpath runs ahead of
        # the download loop) -- nothing lands anywhere, in dest_dir or out.
        self.assertFalse((Path(dest) / "traversal-poc.safetensors").exists())
        self.assertEqual(list(Path(dest).iterdir()) if Path(dest).exists() else [], [])

    def test_absolute_path_fetch_refused_nothing_written(self) -> None:
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-traversal-abs",
                "--manifest",
                manifest_path,
                "--dest",
                dest,
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])
        self.assertFalse(Path("/etc/traversal-poc.safetensors").exists())


# --------------------------------------------------------------------------
# download_to_path: .part / target cleanup on any exception
# --------------------------------------------------------------------------


class DownloadCleanupTests(ProvenanceTestCase):
    def test_cleans_up_part_file_on_download_failure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "sub" / "file.bin"
            with self.assertRaises(prov.ProvenanceError):
                prov.download_to_path(f"{self.server.base_url}/does/not/exist", dest, {})
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_name(dest.name + ".part").exists())

    def test_removes_stale_target_on_download_failure(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "file.bin"
            dest.write_bytes(b"stale leftover content from a previous attempt")
            with self.assertRaises(prov.ProvenanceError):
                prov.download_to_path(f"{self.server.base_url}/does/not/exist", dest, {})
            self.assertFalse(dest.exists())

    def test_cleans_up_on_non_url_exception(self) -> None:
        # An OSError raised mid-write (e.g. disk full) must also trigger
        # cleanup, not just urllib.error.URLError -- exercise the generic
        # BaseException branch directly against a real download in flight.
        content = b"X" * (1 << 16)
        self.server.routes["/download-cleanup/ok.bin"] = lambda body=content: Response(200, {}, body)
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td) / "sub" / "file.bin"

            class _BoomFile:
                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, *exc):
                    return False

                def write(self_inner, data):
                    raise OSError("simulated disk full")

            original_open = open

            def _boom_open(path, mode="r", *a, **kw):
                if str(path).endswith(".part"):
                    return _BoomFile()
                return original_open(path, mode, *a, **kw)

            import builtins

            builtins_open = builtins.open
            builtins.open = _boom_open
            try:
                with self.assertRaises(OSError):
                    prov.download_to_path(f"{self.server.base_url}/download-cleanup/ok.bin", dest, {})
            finally:
                builtins.open = builtins_open
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_name(dest.name + ".part").exists())


# --------------------------------------------------------------------------
# fetch: hash verification (LFS sha256 + non-LFS git blob sha1)
# --------------------------------------------------------------------------


class HashVerificationTests(ProvenanceTestCase):
    def test_lfs_sha256_match_succeeds(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        weight_file = next(f for f in entry["files"] if f["path"] == "model.safetensors")
        self.assertEqual(weight_file["sha256"], hashlib.sha256(self.basic_weights).hexdigest())

    def test_lfs_sha256_mismatch_deletes_file_and_leaves_manifest_untouched(self) -> None:
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-lfs-mismatch",
                "--manifest",
                manifest_path,
                "--dest",
                dest,
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])
        self.assertFalse((Path(dest) / "model.safetensors").exists())
        self.assertFalse((Path(dest) / "model.safetensors.part").exists())

    def test_non_lfs_git_blob_sha1_match_succeeds(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)

    def test_non_lfs_git_blob_sha1_mismatch_refuses(self) -> None:
        manifest_path = self.make_manifest_path()
        dest = self.make_dest_dir()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-blob-mismatch",
                "--manifest",
                manifest_path,
                "--dest",
                dest,
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])
        self.assertFalse((Path(dest) / "config.json").exists())


# --------------------------------------------------------------------------
# add-runtime
# --------------------------------------------------------------------------


def _build_zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


class AddRuntimeTests(ProvenanceTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.runtime_members = {"ggml-base.dll": b"BASE-DLL-BYTES", "llama-server.exe": b"SERVER-EXE-BYTES"}
        cls.runtime_zip_bytes = _build_zip(cls.runtime_members)
        cls.runtime_asset = "llama-bTEST-bin-win-vulkan-x64.zip"
        cls.server.routes[f"/ggml-org/llama.cpp/releases/download/bTEST/{cls.runtime_asset}"] = (
            lambda body=cls.runtime_zip_bytes: (lambda: Response(200, {}, body))
        )()

    def test_add_runtime_hashes_zip_and_members(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "add-runtime",
                "--tag",
                "bTEST",
                "--asset",
                self.runtime_asset,
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--gh-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["kind"], "runtime")
        by_path = {f["path"]: f for f in entry["files"]}
        self.assertIn(f"zip:{self.runtime_asset}", by_path)
        self.assertEqual(by_path[f"zip:{self.runtime_asset}"]["sha256"], hashlib.sha256(self.runtime_zip_bytes).hexdigest())
        for name, data in self.runtime_members.items():
            self.assertEqual(by_path[name]["sha256"], hashlib.sha256(data).hexdigest())

    def test_add_runtime_refuses_unlisted_repo(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "add-runtime",
                "--tag",
                "bTEST",
                "--repo",
                "not-allowed/llama.cpp",
                "--asset",
                self.runtime_asset,
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--gh-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 1)

    def test_add_runtime_from_zip_matching_remote_succeeds(self) -> None:
        manifest_path = self.make_manifest_path()
        with tempfile.TemporaryDirectory() as td:
            local_zip = Path(td) / "local.zip"
            local_zip.write_bytes(self.runtime_zip_bytes)
            rc = self.run_main(
                [
                    "add-runtime",
                    "--tag",
                    "bTEST",
                    "--asset",
                    self.runtime_asset,
                    "--from-zip",
                    str(local_zip),
                    "--manifest",
                    manifest_path,
                    "--dest",
                    self.make_dest_dir(),
                    "--gh-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)

    def test_add_runtime_from_zip_mismatching_remote_refused(self) -> None:
        manifest_path = self.make_manifest_path()
        with tempfile.TemporaryDirectory() as td:
            local_zip = Path(td) / "local.zip"
            local_zip.write_bytes(_build_zip({"different.dll": b"NOT THE SAME BYTES"}))
            rc = self.run_main(
                [
                    "add-runtime",
                    "--tag",
                    "bTEST",
                    "--asset",
                    self.runtime_asset,
                    "--from-zip",
                    str(local_zip),
                    "--manifest",
                    manifest_path,
                    "--dest",
                    self.make_dest_dir(),
                    "--gh-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])


# --------------------------------------------------------------------------
# add-runtime --overlay-* (patched-DLL overlay on an official release zip)
# --------------------------------------------------------------------------


class AddRuntimeOverlayTests(ProvenanceTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.overlay_dll_bytes = b"OFFICIAL-VULKAN-DLL-BYTES"
        cls.overlay_other_bytes = b"SERVER-EXE-BYTES"
        cls.overlay_members = {
            "ggml-vulkan.dll": cls.overlay_dll_bytes,
            "llama-server.exe": cls.overlay_other_bytes,
        }
        cls.overlay_zip_bytes = _build_zip(cls.overlay_members)
        cls.overlay_asset = "llama-boverlay-bin-win-vulkan-x64.zip"
        cls.patched_dll_bytes = b"PATCHED-VULKAN-DLL-BYTES-DIFFERENT-LENGTH"

    def _write_patch(self, td: Path) -> Path:
        patch_path = td / "vulkan-uma-honor-disable-host-visible-vidmem.patch"
        patch_path.write_bytes(b"--- a/ggml-vulkan.cpp\n+++ b/ggml-vulkan.cpp\n")
        return patch_path

    def _write_overlay_dir(
        self,
        td: Path,
        *,
        dll_bytes: bytes,
        dll_filename: str = "ggml-vulkan.dll",
        field_overrides: dict | None = None,
        omit_fields: list[str] | None = None,
        extra_file: bool = False,
        skip_manifest_txt: bool = False,
    ) -> Path:
        overlay_dir = td / "overlay"
        overlay_dir.mkdir()
        (overlay_dir / dll_filename).write_bytes(dll_bytes)
        fields = {
            "base_tag": "boverlay",
            "base_sha": "deadbeef" * 5,
            "patch": "vulkan-uma-honor-disable-host-visible-vidmem.patch",
            "dll_sha256": hashlib.sha256(dll_bytes).hexdigest(),
            "dll_bytes": str(len(dll_bytes)),
            "built_by": "ci",
        }
        if field_overrides:
            fields.update(field_overrides)
        if omit_fields:
            for k in omit_fields:
                fields.pop(k, None)
        if not skip_manifest_txt:
            text = "\n".join(f"{k}: {v}" for k, v in fields.items())
            (overlay_dir / "PATCHED-BUILD.txt").write_text(text)
        if extra_file:
            (overlay_dir / "extra.bin").write_bytes(b"unexpected")
        return overlay_dir

    def _run_overlay(
        self,
        manifest_path: str,
        local_zip: Path,
        overlay_dir: Path,
        patch_path: Path,
        *,
        overlay_repo: str = "Hellblazer/qwen-coprocessor-stack",
        overlay_run: str = "34707921300",
        extra_args: list[str] | None = None,
    ) -> int:
        argv = [
            "add-runtime",
            "--tag",
            "boverlay",
            "--asset",
            self.overlay_asset,
            "--from-zip",
            str(local_zip),
            "--offline",
            "--manifest",
            manifest_path,
            "--dest",
            self.make_dest_dir(),
            "--gh-base",
            self.server.base_url,
            "--overlay-dir",
            str(overlay_dir),
            "--overlay-repo",
            overlay_repo,
            "--overlay-run",
            overlay_run,
            "--patch",
            str(patch_path),
        ]
        if extra_args:
            argv += extra_args
        return self.run_main(argv)

    def test_overlay_success_swaps_hash_and_records_overlay_object(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["id"], "llama.cpp@boverlay-patched")
        self.assertEqual(entry["trust_tier"], "self-quantized")
        by_path = {f["path"]: f for f in entry["files"]}
        self.assertEqual(by_path["ggml-vulkan.dll"]["sha256"], hashlib.sha256(self.patched_dll_bytes).hexdigest())
        self.assertEqual(by_path["ggml-vulkan.dll"]["size"], len(self.patched_dll_bytes))
        self.assertEqual(by_path["llama-server.exe"]["sha256"], hashlib.sha256(self.overlay_other_bytes).hexdigest())
        overlay = entry["overlay"]
        self.assertEqual(overlay["repo"], "Hellblazer/qwen-coprocessor-stack")
        self.assertEqual(overlay["run_id"], 34707921300)
        self.assertEqual(overlay["artifact"], "ggml-vulkan-boverlay-patched")
        self.assertEqual(overlay["file"], "ggml-vulkan.dll")
        self.assertEqual(overlay["sha256"], hashlib.sha256(self.patched_dll_bytes).hexdigest())
        self.assertEqual(overlay["base_tag"], "boverlay")

    def test_overlay_entry_validates_against_schema(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 0)
        rc = self.run_main(["validate", "--manifest", manifest_path, "--schema", str(prov.DEFAULT_SCHEMA_PATH)])
        self.assertEqual(rc, 0)

    def test_overlay_refuses_unlisted_overlay_repo(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(
                manifest_path, local_zip, overlay_dir, patch_path, overlay_repo="not-allowed/qwen-coprocessor-stack"
            )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_incomplete_overlay_args(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "add-runtime",
                    "--tag",
                    "boverlay",
                    "--asset",
                    self.overlay_asset,
                    "--from-zip",
                    str(local_zip),
                    "--offline",
                    "--manifest",
                    manifest_path,
                    "--dest",
                    self.make_dest_dir(),
                    "--gh-base",
                    self.server.base_url,
                    "--overlay-dir",
                    str(overlay_dir),
                    # --overlay-repo / --overlay-run / --patch deliberately omitted
                ]
            )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_missing_patched_build_txt(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes, skip_manifest_txt=True)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_extra_unexpected_file_in_overlay_dir(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes, extra_file=True)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_dll_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(
                td, dll_bytes=self.patched_dll_bytes, field_overrides={"dll_sha256": "0" * 64}
            )
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_dll_bytes_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(
                td, dll_bytes=self.patched_dll_bytes, field_overrides={"dll_bytes": "1"}
            )
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_base_tag_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(
                td, dll_bytes=self.patched_dll_bytes, field_overrides={"base_tag": "bWRONG"}
            )
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_patch_name_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(
                td, dll_bytes=self.patched_dll_bytes, field_overrides={"patch": "some-other.patch"}
            )
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_file_not_official_zip_member(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(
                td, dll_bytes=self.patched_dll_bytes, dll_filename="not-a-member.dll"
            )
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_refuses_missing_patch_file(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, td / "does-not-exist.patch")
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_overlay_verify_patched_dll_ok_official_dll_mismatches(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            local_zip = td / "local.zip"
            local_zip.write_bytes(self.overlay_zip_bytes)
            patch_path = self._write_patch(td)
            overlay_dir = self._write_overlay_dir(td, dll_bytes=self.patched_dll_bytes)
            manifest_path = self.make_manifest_path()
            rc = self._run_overlay(manifest_path, local_zip, overlay_dir, patch_path)
            self.assertEqual(rc, 0)
            entry_id = prov.load_manifest(manifest_path)["artifacts"][0]["id"]

            served_dir = td / "served-patched"
            served_dir.mkdir()
            (served_dir / "ggml-vulkan.dll").write_bytes(self.patched_dll_bytes)
            (served_dir / "llama-server.exe").write_bytes(self.overlay_other_bytes)
            rc = self.run_main(
                ["verify", "--manifest", manifest_path, "--id", entry_id, "--root", str(served_dir)]
            )
            self.assertEqual(rc, 0)

            official_dir = td / "served-official"
            official_dir.mkdir()
            (official_dir / "ggml-vulkan.dll").write_bytes(self.overlay_dll_bytes)
            (official_dir / "llama-server.exe").write_bytes(self.overlay_other_bytes)
            rc = self.run_main(
                ["verify", "--manifest", manifest_path, "--id", entry_id, "--root", str(official_dir)]
            )
            self.assertEqual(rc, 2)


# --------------------------------------------------------------------------
# verify / import-listing / --check-path
# --------------------------------------------------------------------------


class VerifyTests(ProvenanceTestCase):
    def _fetched_manifest(self) -> tuple[str, dict]:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        return manifest_path, prov.load_manifest(manifest_path)["artifacts"][0]

    def test_verify_with_listing_crlf_and_backslashes_ok(self) -> None:
        manifest_path, entry = self._fetched_manifest()
        cfg_sha = hashlib.sha256(self.basic_config).hexdigest()
        weights_sha = hashlib.sha256(self.basic_weights).hexdigest()
        listing_text = f"{cfg_sha}  config.json\r\n{weights_sha}  model.safetensors\r\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 0)
        updated = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertIn("box", updated["verified_on"])
        self.assertIn("mac", updated["verified_on"])

    def test_verify_backslash_relpath_normalizes(self) -> None:
        manifest_path, entry = self._fetched_manifest()
        cfg_sha = hashlib.sha256(self.basic_config).hexdigest()
        weights_sha = hashlib.sha256(self.basic_weights).hexdigest()
        listing_text = f"{cfg_sha}  .\\config.json\r\n{weights_sha}  .\\model.safetensors\r\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            rc = self.run_main(
                ["import-listing", "--id", entry["id"], "--listing", str(listing_path), "--host", "box", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 0)

    def test_verify_missing_member_exits_2_unless_allowed_and_records_gap(self) -> None:
        # Listing lacks config.json entirely (the Defender-quarantined-DLL case).
        manifest_path, entry = self._fetched_manifest()
        weights_sha = hashlib.sha256(self.basic_weights).hexdigest()
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(f"{weights_sha}  model.safetensors\n")
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box", "--manifest", manifest_path]
            )
            self.assertEqual(rc, 2)
            self.assertNotIn("box", prov.load_manifest(manifest_path)["artifacts"][0].get("verified_on", []))
            # A non-matching --allow-missing glob does not help.
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box",
                 "--manifest", manifest_path, "--allow-missing", "*.dll"]
            )
            self.assertEqual(rc, 2)
            # A matching glob stamps the host AND records the gap on the entry.
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box",
                 "--manifest", manifest_path, "--allow-missing", "config.json"]
            )
        self.assertEqual(rc, 0)
        updated = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertIn("box", updated["verified_on"])
        self.assertEqual(updated["missing_on_host"], {"box": ["config.json"]})
        self.assertEqual(self.run_main(["validate", "--manifest", manifest_path]), 0)
        # A MISMATCH is never excused by --allow-missing.
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(f"{'0' * 64}  model.safetensors\n")
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box",
                 "--manifest", manifest_path, "--allow-missing", "*"]
            )
        self.assertEqual(rc, 2)

    def test_verify_mismatch_exits_2_and_does_not_stamp(self) -> None:
        manifest_path, entry = self._fetched_manifest()
        listing_text = f"{'0' * 64}  config.json\r\n{hashlib.sha256(self.basic_weights).hexdigest()}  model.safetensors\r\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 2)
        updated = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertNotIn("box", updated["verified_on"])

    def test_verify_missing_file_exits_2(self) -> None:
        manifest_path, entry = self._fetched_manifest()
        listing_text = f"{hashlib.sha256(self.basic_config).hexdigest()}  config.json\r\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--listing", str(listing_path), "--host", "box", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 2)

    def test_verify_with_root_directory(self) -> None:
        manifest_path, entry = self._fetched_manifest()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "config.json").write_bytes(self.basic_config)
            (root / "model.safetensors").write_bytes(self.basic_weights)
            rc = self.run_main(["verify", "--id", entry["id"], "--root", str(root), "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def _verified_on_box(self) -> tuple[str, dict]:
        manifest_path, entry = self._fetched_manifest()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "config.json").write_bytes(self.basic_config)
            (root / "model.safetensors").write_bytes(self.basic_weights)
            rc = self.run_main(["verify", "--id", entry["id"], "--root", str(root), "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 0)
        return manifest_path, entry

    def test_check_path_verified_host_present(self) -> None:
        manifest_path, _entry = self._verified_on_box()
        rc = self.run_main(["check-path", "model.safetensors", "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def test_check_path_windows_style_path_matches_basename(self) -> None:
        manifest_path, _entry = self._verified_on_box()
        rc = self.run_main(
            ["check-path", r"D:\models\qwen\model.safetensors", "--host", "box", "--manifest", manifest_path]
        )
        self.assertEqual(rc, 0)

    def test_check_path_print_id_outputs_matched_artifact_id(self) -> None:
        import contextlib

        manifest_path, entry = self._verified_on_box()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                ["check-path", "model.safetensors", "--host", "box", "--print-id", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(buf.getvalue().strip(), entry["id"])

    def test_check_path_size_match_ok(self) -> None:
        manifest_path, _entry = self._verified_on_box()
        rc = self.run_main(
            [
                "check-path",
                "model.safetensors",
                "--host",
                "box",
                "--size",
                str(len(self.basic_weights)),
                "--manifest",
                manifest_path,
            ]
        )
        self.assertEqual(rc, 0)

    def test_check_path_size_mismatch_fails(self) -> None:
        manifest_path, _entry = self._verified_on_box()
        rc = self.run_main(
            ["check-path", "model.safetensors", "--host", "box", "--size", "1", "--manifest", manifest_path]
        )
        self.assertEqual(rc, 1)

    def test_check_path_id_restricts_search(self) -> None:
        manifest_path, entry = self._verified_on_box()
        rc = self.run_main(
            ["check-path", "model.safetensors", "--host", "box", "--id", entry["id"], "--manifest", manifest_path]
        )
        self.assertEqual(rc, 0)
        rc = self.run_main(
            ["check-path", "model.safetensors", "--host", "box", "--id", "not-a-real-id", "--manifest", manifest_path]
        )
        self.assertEqual(rc, 1)

    def test_check_path_host_absent_fails(self) -> None:
        manifest_path, _entry = self._fetched_manifest()
        rc = self.run_main(["check-path", "model.safetensors", "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_check_path_unverified_status_fails(self) -> None:
        manifest_path, _entry = self._fetched_manifest()
        manifest = prov.load_manifest(manifest_path)
        manifest["artifacts"][0]["status"] = "unverified"
        manifest["artifacts"][0]["verified_on"] = ["mac", "box"]
        prov.save_manifest(manifest_path, manifest)
        rc = self.run_main(["check-path", "model.safetensors", "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def test_check_path_unknown_path_fails(self) -> None:
        manifest_path, _entry = self._fetched_manifest()
        rc = self.run_main(["check-path", "nonexistent.gguf", "--host", "mac", "--manifest", manifest_path])
        self.assertEqual(rc, 1)

    def _two_entries_same_basename_size(self, same_sha256: bool) -> str:
        manifest_path = self.make_manifest_path()
        manifest = {"schema_version": 1, "artifacts": []}
        for i, tag in enumerate(("stale", "fresh")):
            sha = ("a" if same_sha256 else str(i)) * 64
            manifest["artifacts"].append(
                {
                    "id": f"model-{tag}@local",
                    "kind": "model",
                    "status": "verified",
                    "source": {"host": "huggingface", "repo": "Qwen/repo-basic", "revision": "0" * 40},
                    "format": "gguf",
                    "trust_tier": "origin",
                    "files": [{"path": "Qwen3-Coder-Next-UD-Q4_K_XL.gguf", "sha256": sha, "size": 12345}],
                    "verified_on": ["box"],
                    "verified_at": f"2026-08-{10 + i:02d}T00:00:00Z",
                }
            )
        prov.save_manifest(manifest_path, manifest)
        return manifest_path

    def test_check_path_ambiguous_same_content_accepts_newest(self) -> None:
        manifest_path = self._two_entries_same_basename_size(same_sha256=True)
        buf = io.StringIO()
        import contextlib

        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                [
                    "check-path",
                    "Qwen3-Coder-Next-UD-Q4_K_XL.gguf",
                    "--host",
                    "box",
                    "--print-id",
                    "--manifest",
                    manifest_path,
                ]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(buf.getvalue().strip(), "model-fresh@local")

    def test_check_path_ambiguous_different_content_refuses(self) -> None:
        manifest_path = self._two_entries_same_basename_size(same_sha256=False)
        rc = self.run_main(
            ["check-path", "Qwen3-Coder-Next-UD-Q4_K_XL.gguf", "--host", "box", "--manifest", manifest_path]
        )
        self.assertEqual(rc, 1)


# --------------------------------------------------------------------------
# drift
# --------------------------------------------------------------------------


class DriftTests(ProvenanceTestCase):
    def test_drift_all_on_empty_manifest_is_ok_bootstrap(self) -> None:
        manifest_path = self.make_manifest_path()  # never written to -> load_manifest default = empty
        buf = io.StringIO()
        import contextlib

        with contextlib.redirect_stdout(buf):
            rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)
        self.assertIn("checked=0 skipped=0 (manifest empty)", buf.getvalue())

    def test_drift_id_against_empty_manifest_still_errors(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            ["drift", "--id", "nonexistent@local", "--manifest", manifest_path, "--hf-base", self.server.base_url]
        )
        self.assertEqual(rc, 1)

    def test_drift_nonempty_manifest_checked_zero_is_nonzero_exit(self) -> None:
        # A register-only (host=local) entry with no derived_from has
        # nothing drift can re-fetch -- checked must stay 0 for it, and the
        # non-vacuity guard must fire since the manifest IS non-empty.
        manifest_path = self.make_manifest_path()
        manifest = {
            "schema_version": 1,
            "artifacts": [
                {
                    "id": "orphan@local",
                    "kind": "model",
                    "status": "verified",
                    "source": {"host": "local", "repo": "nowhere/nothing"},
                    "format": "gguf",
                    "trust_tier": "self-quantized",
                    "files": [{"path": "x.gguf", "sha256": "a" * 64, "size": 1}],
                    "verified_on": ["mac"],
                }
            ],
        }
        prov.save_manifest(manifest_path, manifest)
        buf = io.StringIO()
        import contextlib

        with contextlib.redirect_stdout(buf):
            rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertNotEqual(rc, 0)
        self.assertIn("checked=0 skipped=1", buf.getvalue())

    def test_model_drift_ok_when_unchanged(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)

    def test_model_drift_detects_upstream_sha256_change(self) -> None:
        # A dedicated repo/sha so re-registering its metadata does not affect
        # other tests sharing the class-level server.
        drift_sha = sha1_commit("repo-drift-model")
        content = b"DRIFT-WEIGHTS-" * 100
        register_hf_repo(
            self.server,
            "Qwen/repo-drift-model",
            drift_sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content)],
            {"model.safetensors": content},
        )
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-drift-model",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)

        # Re-register the same repo@sha with different upstream content bytes
        # (same path/sha but a re-pushed blob under the pin -- simulates drift).
        new_content = b"DRIFTED-WEIGHTS-CHANGED-" * 100
        register_hf_repo(
            self.server,
            "Qwen/repo-drift-model",
            drift_sha,
            [sibling_weight("model.safetensors", new_content)],
            [tree_entry("model.safetensors", new_content)],
            {"model.safetensors": new_content},
        )
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 1)

    def test_runtime_drift_ok_and_detects_change(self) -> None:
        asset = "llama-bDRIFT-bin-win-vulkan-x64.zip"
        original_zip = _build_zip({"a.dll": b"ORIGINAL"})
        self.server.routes[f"/ggml-org/llama.cpp/releases/download/bDRIFT/{asset}"] = (
            lambda body=original_zip: (lambda: Response(200, {}, body))
        )()
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "add-runtime",
                "--tag",
                "bDRIFT",
                "--asset",
                asset,
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--gh-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--gh-base", self.server.base_url])
        self.assertEqual(rc, 0)

        changed_zip = _build_zip({"a.dll": b"CHANGED-CONTENT"})
        self.server.routes[f"/ggml-org/llama.cpp/releases/download/bDRIFT/{asset}"] = (
            lambda body=changed_zip: (lambda: Response(200, {}, body))
        )()
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--gh-base", self.server.base_url])
        self.assertEqual(rc, 1)


# --------------------------------------------------------------------------
# register (self-quantized local artifacts)
# --------------------------------------------------------------------------


class RegisterTests(ProvenanceTestCase):
    def test_register_local_artifact_owner_repo_form(self) -> None:
        manifest_path = self.make_manifest_path()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "model.Q8_0.gguf").write_bytes(b"QUANTIZED-BYTES" * 10)
            rc = self.run_main(
                [
                    "register",
                    "--id",
                    "qwen-repo-basic-q8@local",
                    "--format",
                    "gguf",
                    "--derived-from",
                    "Qwen/repo-basic@" + self.basic_sha,
                    "--quantized-by-tool",
                    "llama-quantize",
                    "--quantized-by-version",
                    "b10078",
                    "--quantized-by-command",
                    "llama-quantize model.safetensors model.Q8_0.gguf Q8_0",
                    "--root",
                    str(root),
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(entry["trust_tier"], "self-quantized")
        self.assertEqual(entry["source"]["host"], "local")
        self.assertEqual(entry["source"]["repo"], "Qwen/repo-basic")
        self.assertEqual(entry["source"]["revision"], self.basic_sha)
        self.assertEqual(entry["quantized_by"]["tool"], "llama-quantize")
        self.assertEqual(len(entry["files"]), 1)
        self.assertEqual(entry["files"][0]["sha256"], hashlib.sha256(b"QUANTIZED-BYTES" * 10).hexdigest())
        dff = {f["path"]: f for f in entry["derived_from_files"]}
        self.assertIn("model.safetensors", dff)
        self.assertEqual(dff["model.safetensors"]["sha256"], hashlib.sha256(self.basic_weights).hexdigest())

    def test_register_derived_from_existing_manifest_id_copies_source(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--id",
                "repo-basic-origin",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "model.Q6_K.gguf").write_bytes(b"Q6-QUANTIZED-BYTES" * 10)
            rc = self.run_main(
                [
                    "register",
                    "--id",
                    "repo-basic-q6@local",
                    "--format",
                    "gguf",
                    "--derived-from",
                    "repo-basic-origin",
                    "--root",
                    str(root),
                    "--manifest",
                    manifest_path,
                ]
            )
        self.assertEqual(rc, 0)
        artifacts = prov.load_manifest(manifest_path)["artifacts"]
        new_entry = next(a for a in artifacts if a["id"] == "repo-basic-q6@local")
        self.assertEqual(new_entry["source"]["repo"], "Qwen/repo-basic")
        self.assertEqual(new_entry["source"]["revision"], self.basic_sha)

    def test_register_written_entry_validates_against_schema(self) -> None:
        manifest_path = self.make_manifest_path()
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "model.gguf").write_bytes(b"BYTES" * 20)
            rc = self.run_main(
                [
                    "register",
                    "--id",
                    "schema-check@local",
                    "--format",
                    "gguf",
                    "--derived-from",
                    "Qwen/repo-basic@" + self.basic_sha,
                    "--root",
                    str(root),
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        rc = self.run_main(["validate", "--manifest", manifest_path, "--schema", str(prov.DEFAULT_SCHEMA_PATH)])
        self.assertEqual(rc, 0)


# --------------------------------------------------------------------------
# lineage: derived_from_files population + drift re-check
# --------------------------------------------------------------------------


class LineageTests(ProvenanceTestCase):
    def test_packager_fetch_populates_derived_from_files(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "unsloth/repo-packager-GGUF",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--allow-packager",
                "--derived-from",
                "Qwen/repo-basic@" + self.basic_sha,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        dff = {f["path"]: f for f in entry["derived_from_files"]}
        self.assertIn("model.safetensors", dff)
        self.assertEqual(dff["model.safetensors"]["sha256"], hashlib.sha256(self.basic_weights).hexdigest())

    def test_drift_detects_derived_from_files_change(self) -> None:
        derived_sha = sha1_commit("repo-lineage-drift")
        content = b"LINEAGE-ORIGIN-WEIGHTS-" * 100
        register_hf_repo(
            self.server,
            "Qwen/repo-lineage-drift",
            derived_sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content)],
            {"model.safetensors": content},
        )
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "unsloth/repo-packager-GGUF",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
                "--allow-packager",
                "--derived-from",
                "Qwen/repo-lineage-drift@" + derived_sha,
            ]
        )
        self.assertEqual(rc, 0)
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)

        changed = b"LINEAGE-ORIGIN-WEIGHTS-CHANGED-" * 100
        register_hf_repo(
            self.server,
            "Qwen/repo-lineage-drift",
            derived_sha,
            [sibling_weight("model.safetensors", changed)],
            [tree_entry("model.safetensors", changed)],
            {"model.safetensors": changed},
        )
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 1)

    def test_drift_asserts_manifest_id_derived_from_still_exists(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--id",
                "origin-entry",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "model.gguf").write_bytes(b"Q-BYTES" * 20)
            rc = self.run_main(
                [
                    "register",
                    "--id",
                    "derived-entry@local",
                    "--format",
                    "gguf",
                    "--derived-from",
                    "origin-entry",
                    "--root",
                    str(root),
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)

        rc = self.run_main(["drift", "--id", "derived-entry@local", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)

        manifest = prov.load_manifest(manifest_path)
        manifest["artifacts"] = [a for a in manifest["artifacts"] if a["id"] != "origin-entry"]
        prov.save_manifest(manifest_path, manifest)

        rc = self.run_main(["drift", "--id", "derived-entry@local", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 1)


# --------------------------------------------------------------------------
# drift: checked/skipped summary, non-vacuity, security re-check
# --------------------------------------------------------------------------


class DriftSummaryTests(ProvenanceTestCase):
    def test_drift_summary_line_and_nonzero_on_security_flag(self) -> None:
        import contextlib

        drift_sha = sha1_commit("repo-drift-summary")
        content = b"SUMMARY-WEIGHTS-" * 100
        register_hf_repo(
            self.server,
            "Qwen/repo-drift-summary",
            drift_sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content)],
            {"model.safetensors": content},
        )
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-drift-summary",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)
        self.assertIn("checked=1 skipped=0", buf.getvalue())

        # re-register with a scan that now flags the file -- metadata-only re-check
        unsafe_sec = {
            "status": "unsafe",
            "avScan": {"status": "unsafe"},
            "protectAiScan": {"status": "unscanned"},
            "pickleImportScan": {"status": "unscanned"},
        }
        register_hf_repo(
            self.server,
            "Qwen/repo-drift-summary",
            drift_sha,
            [sibling_weight("model.safetensors", content)],
            [tree_entry("model.safetensors", content, security=unsafe_sec)],
            {"model.safetensors": content},
        )
        rc = self.run_main(["drift", "--all", "--manifest", manifest_path, "--hf-base", self.server.base_url])
        self.assertEqual(rc, 1)


# --------------------------------------------------------------------------
# match
# --------------------------------------------------------------------------


class MatchTests(ProvenanceTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        s = cls.server
        cls.match_repo = "Qwen/repo-match-history"
        # Oldest -> newest commit chain: v1 introduces content_a, v2 replaces
        # it with content_b (v1's content_a is no longer in the current tree,
        # only reachable by walking history).
        cls.match_content_a = b"MATCH-HISTORY-CONTENT-A-" * 50
        cls.match_content_b = b"MATCH-HISTORY-CONTENT-B-" * 50
        commit_v1 = sha1_commit("match-repo-v1")
        commit_v2 = sha1_commit("match-repo-v2")
        cls.match_commit_v1 = commit_v1
        cls.match_commit_v2 = commit_v2

        commits_body = json.dumps(
            [
                {"id": commit_v2, "title": "v2", "date": "2026-08-14T00:00:00.000Z"},
                {"id": commit_v1, "title": "v1", "date": "2026-08-01T00:00:00.000Z"},
            ]
        ).encode()
        s.routes[f"/api/models/{cls.match_repo}/commits/main"] = (
            lambda body=commits_body: (lambda: Response(200, {}, body))
        )()

        def _tree_with_lfs(path: str, content: bytes) -> bytes:
            entry = tree_entry(path, content)
            entry["lfs"] = {"oid": hashlib.sha256(content).hexdigest(), "size": len(content)}
            return json.dumps([entry]).encode()

        tree_v2_body = _tree_with_lfs("model.safetensors", cls.match_content_b)
        tree_v1_body = _tree_with_lfs("model.safetensors", cls.match_content_a)
        s.routes[f"/api/models/{cls.match_repo}/tree/{commit_v2}?expand=true&recursive=true"] = (
            lambda body=tree_v2_body: (lambda: Response(200, {}, body))
        )()
        s.routes[f"/api/models/{cls.match_repo}/tree/{commit_v1}?expand=true&recursive=true"] = (
            lambda body=tree_v1_body: (lambda: Response(200, {}, body))
        )()

    def test_match_finds_current_and_historical_content(self) -> None:
        import contextlib

        sha_b = hashlib.sha256(self.match_content_b).hexdigest()
        sha_a = hashlib.sha256(self.match_content_a).hexdigest()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                ["match", "--repo", self.match_repo, "--sha256", sha_b, "--sha256", sha_a, "--hf-base", self.server.base_url]
            )
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn(f"{sha_b} -> model.safetensors @ {self.match_repo}@{self.match_commit_v2}", out)
        self.assertIn(f"{sha_a} -> model.safetensors @ {self.match_repo}@{self.match_commit_v1}", out)

    def test_match_no_match_reports_and_exits_nonzero(self) -> None:
        import contextlib

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                ["match", "--repo", self.match_repo, "--sha256", "0" * 64, "--hf-base", self.server.base_url]
            )
        self.assertEqual(rc, 1)
        self.assertIn("NO MATCH", buf.getvalue())

    def test_match_via_listing_file(self) -> None:
        import contextlib

        sha_b = hashlib.sha256(self.match_content_b).hexdigest()
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(f"{sha_b}  model.safetensors\n")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = self.run_main(
                    ["match", "--repo", self.match_repo, "--listing", str(listing_path), "--hf-base", self.server.base_url]
                )
        self.assertEqual(rc, 0)
        self.assertIn(f"{sha_b} -> model.safetensors", buf.getvalue())

    def test_match_reports_newest_occurrence_and_common_revision(self) -> None:
        # gpt-oss-120b-GGUF-shaped scenario: two shard files, one is deleted
        # in the newest commit -- the newest occurrence of each shard can
        # differ, and the COMMON line must report the newest commit where
        # BOTH were still present together.
        import contextlib

        repo = "Qwen/repo-match-shards"
        shard1 = b"SHARD-ONE-CONTENT-" * 40
        shard2 = b"SHARD-TWO-CONTENT-" * 40
        sha1_hex = hashlib.sha256(shard1).hexdigest()
        sha2_hex = hashlib.sha256(shard2).hexdigest()

        commit_v3 = sha1_commit("shards-v3-newest")  # shard2 removed here
        commit_v2 = sha1_commit("shards-v2-both-present")
        commit_v1 = sha1_commit("shards-v1-oldest")

        commits_body = json.dumps(
            [
                {"id": commit_v3, "title": "v3", "date": "2026-08-15T00:00:00.000Z"},
                {"id": commit_v2, "title": "v2", "date": "2026-08-10T00:00:00.000Z"},
                {"id": commit_v1, "title": "v1", "date": "2026-08-01T00:00:00.000Z"},
            ]
        ).encode()
        self.server.routes[f"/api/models/{repo}/commits/main"] = (
            lambda body=commits_body: (lambda: Response(200, {}, body))
        )()

        def _tree(entries: list[dict]) -> bytes:
            return json.dumps(entries).encode()

        def _lfs_entry(path: str, content: bytes) -> dict:
            e = tree_entry(path, content)
            e["lfs"] = {"oid": hashlib.sha256(content).hexdigest(), "size": len(content)}
            return e

        self.server.routes[f"/api/models/{repo}/tree/{commit_v3}?expand=true&recursive=true"] = (
            lambda body=_tree([_lfs_entry("shard1.gguf", shard1)]): (lambda: Response(200, {}, body))
        )()
        self.server.routes[f"/api/models/{repo}/tree/{commit_v2}?expand=true&recursive=true"] = (
            lambda body=_tree([_lfs_entry("shard1.gguf", shard1), _lfs_entry("shard2.gguf", shard2)]): (
                lambda: Response(200, {}, body)
            )
        )()
        self.server.routes[f"/api/models/{repo}/tree/{commit_v1}?expand=true&recursive=true"] = (
            lambda body=_tree([_lfs_entry("shard1.gguf", shard1), _lfs_entry("shard2.gguf", shard2)]): (
                lambda: Response(200, {}, body)
            )
        )()

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                ["match", "--repo", repo, "--sha256", sha1_hex, "--sha256", sha2_hex, "--hf-base", self.server.base_url]
            )
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn(f"{sha1_hex} -> shard1.gguf @ {repo}@{commit_v3}", out)
        self.assertIn(f"{sha2_hex} -> shard2.gguf @ {repo}@{commit_v2}", out)
        self.assertIn(f"COMMON: all 2 hashes present @ {repo}@{commit_v2}", out)

    def test_match_common_revision_absent_when_no_overlap(self) -> None:
        import contextlib

        sha_a = hashlib.sha256(self.match_content_a).hexdigest()
        sha_b = hashlib.sha256(self.match_content_b).hexdigest()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                [
                    "match",
                    "--repo",
                    self.match_repo,
                    "--sha256",
                    sha_a,
                    "--sha256",
                    sha_b,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        self.assertIn("COMMON: no single revision contains all 2 matched hashes", buf.getvalue())

    def test_match_commits_pagination_follows_link_header(self) -> None:
        import contextlib

        repo = "Qwen/repo-match-paginated"
        old_content = b"PAGINATED-OLD-CONTENT-" * 40
        old_sha = hashlib.sha256(old_content).hexdigest()
        commit_new = sha1_commit("paginated-newest")
        commit_old = sha1_commit("paginated-oldest-page2")

        page2_url_path = f"/api/models/{repo}/commits/main?cursor=page2"
        page1_body = json.dumps([{"id": commit_new, "date": "2026-08-15T00:00:00.000Z"}]).encode()
        page2_body = json.dumps([{"id": commit_old, "date": "2026-08-01T00:00:00.000Z"}]).encode()

        self.server.routes[f"/api/models/{repo}/commits/main"] = (
            lambda body=page1_body, link=f"<{self.server.base_url}{page2_url_path}>; rel=\"next\"": (
                lambda: Response(200, {"Link": link}, body)
            )
        )()
        self.server.routes[page2_url_path] = (lambda body=page2_body: (lambda: Response(200, {}, body)))()

        def _lfs_entry(path: str, content: bytes) -> dict:
            e = tree_entry(path, content)
            e["lfs"] = {"oid": hashlib.sha256(content).hexdigest(), "size": len(content)}
            return e

        # newest commit's tree has nothing matching -- only page 2 (oldest)
        # carries the target content, so a correct implementation MUST
        # follow the Link header to find it.
        self.server.routes[f"/api/models/{repo}/tree/{commit_new}?expand=true&recursive=true"] = (
            lambda body=json.dumps([]).encode(): (lambda: Response(200, {}, body))
        )()
        self.server.routes[f"/api/models/{repo}/tree/{commit_old}?expand=true&recursive=true"] = (
            lambda body=json.dumps([_lfs_entry("old.gguf", old_content)]).encode(): (
                lambda: Response(200, {}, body)
            )
        )()

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(["match", "--repo", repo, "--sha256", old_sha, "--hf-base", self.server.base_url])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn(f"{old_sha} -> old.gguf @ {repo}@{commit_old}", out)


# --------------------------------------------------------------------------
# adopt (retro-manifest: no download, matched by hash against a listing)
# --------------------------------------------------------------------------


class AdoptTests(ProvenanceTestCase):
    def test_adopt_matches_by_hash_not_name(self) -> None:
        # The box's local filename differs from the HF path -- exactly the
        # lmstudio-community mmproj-renaming scenario cited in the RDR.
        listing_text = (
            f"{hashlib.sha256(self.basic_weights).hexdigest()}  D:\\models\\renamed-on-box.gguf\r\n"
            f"{'0' * 64}  D:\\models\\unrelated-file-not-in-repo.bin\r\n"
        )
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "adopt",
                    "Qwen/repo-basic",
                    "--revision",
                    self.basic_sha,
                    "--listing",
                    str(listing_path),
                    "--host",
                    "box",
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        self.assertEqual(len(entry["files"]), 1)
        f = entry["files"][0]
        self.assertEqual(f["path"], "model.safetensors")
        self.assertEqual(f["local_path"], "d:/models/renamed-on-box.gguf")
        self.assertEqual(entry["status"], "verified")
        self.assertEqual(entry["verified_on"], ["box"])
        self.assertIn("adopted from existing files on box", entry["notes"])

    def test_adopt_no_matching_hashes_refused(self) -> None:
        listing_text = f"{'f' * 64}  some-file.gguf\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "adopt",
                    "Qwen/repo-basic",
                    "--revision",
                    self.basic_sha,
                    "--listing",
                    str(listing_path),
                    "--host",
                    "box",
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 1)
        self.assertEqual(prov.load_manifest(manifest_path)["artifacts"], [])

    def test_adopted_entry_check_path_matches_local_path(self) -> None:
        listing_text = f"{hashlib.sha256(self.basic_weights).hexdigest()}  renamed-on-box.gguf\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "adopt",
                    "Qwen/repo-basic",
                    "--revision",
                    self.basic_sha,
                    "--listing",
                    str(listing_path),
                    "--host",
                    "box",
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        rc = self.run_main(["check-path", "renamed-on-box.gguf", "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 0)
        rc = self.run_main(["check-path", "model.safetensors", "--host", "box", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def test_adopted_entry_validates_against_schema(self) -> None:
        listing_text = f"{hashlib.sha256(self.basic_weights).hexdigest()}  renamed-on-box.gguf\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "adopt",
                    "Qwen/repo-basic",
                    "--revision",
                    self.basic_sha,
                    "--listing",
                    str(listing_path),
                    "--host",
                    "box",
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 0)
        rc = self.run_main(["validate", "--manifest", manifest_path, "--schema", str(prov.DEFAULT_SCHEMA_PATH)])
        self.assertEqual(rc, 0)

    def test_adopt_packager_requires_derived_from(self) -> None:
        listing_text = f"{hashlib.sha256(self.basic_weights).hexdigest()}  some.gguf\n"
        with tempfile.TemporaryDirectory() as td:
            listing_path = Path(td) / "listing.txt"
            listing_path.write_text(listing_text)
            manifest_path = self.make_manifest_path()
            rc = self.run_main(
                [
                    "adopt",
                    "unsloth/repo-packager-GGUF",
                    "--revision",
                    self.packager_sha,
                    "--listing",
                    str(listing_path),
                    "--host",
                    "box",
                    "--allow-packager",
                    "--manifest",
                    manifest_path,
                    "--hf-base",
                    self.server.base_url,
                ]
            )
        self.assertEqual(rc, 1)


# --------------------------------------------------------------------------
# status (list + --served check-path host=box)
# --------------------------------------------------------------------------


class StatusTests(ProvenanceTestCase):
    def test_status_served_ok_and_fail(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        entry = prov.load_manifest(manifest_path)["artifacts"][0]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "config.json").write_bytes(self.basic_config)
            (root / "model.safetensors").write_bytes(self.basic_weights)
            rc = self.run_main(
                ["verify", "--id", entry["id"], "--root", str(root), "--host", "box", "--manifest", manifest_path]
            )
        self.assertEqual(rc, 0)

        buf = io.StringIO()
        import contextlib

        with contextlib.redirect_stdout(buf):
            rc = self.run_main(
                [
                    "status",
                    "--manifest",
                    manifest_path,
                    "--served",
                    "model.safetensors",
                    "--served",
                    "nonexistent.gguf",
                ]
            )
        out = buf.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("SERVED OK (host=box): model.safetensors", out)
        self.assertIn("SERVED FAIL (host=box): nonexistent.gguf", out)

    def test_status_no_served_is_just_list(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(["status", "--manifest", manifest_path])
        self.assertEqual(rc, 0)


# --------------------------------------------------------------------------
# list / hf-meta
# --------------------------------------------------------------------------


class ListAndHfMetaTests(ProvenanceTestCase):
    def test_list_json_reflects_fetched_entry(self) -> None:
        manifest_path = self.make_manifest_path()
        rc = self.run_main(
            [
                "fetch",
                "Qwen/repo-basic",
                "--manifest",
                manifest_path,
                "--dest",
                self.make_dest_dir(),
                "--hf-base",
                self.server.base_url,
            ]
        )
        self.assertEqual(rc, 0)
        rc = self.run_main(["list", "--json", "--manifest", manifest_path])
        self.assertEqual(rc, 0)

    def test_hf_meta_prints_resolved_sha(self) -> None:
        import contextlib

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.run_main(["hf-meta", "Qwen/repo-basic", "--hf-base", self.server.base_url])
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        self.assertEqual(out["sha"], self.basic_sha)
        paths = {f["path"] for f in out["files"]}
        self.assertIn("model.safetensors", paths)


if __name__ == "__main__":
    unittest.main()
