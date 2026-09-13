#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Model and runtime binary provenance tool (RDR-016).

Stdlib-only (Python 3.11+). Sanctioned acquisition path for model weights
(Hugging Face) and inference runtimes (GitHub releases): origin/packager
allowlisting, commit-sha pinning, format/pickle/remote-code refusal, HF
security-scan gating, content-hash verification, and a committed manifest
(`models/MANIFEST.json`) that records what was fetched from where and
whether it has been verified on each serving host.

Subcommands: validate, fetch, add-runtime, verify, import-listing, list,
hf-meta, drift. Run `provenance.py <command> --help` for details.

Every failure path here is fail-closed: refusal always states the sanctioned
next step (add to the allowlist, pass --allow-packager / --allow-remote-code,
narrow with --include/--exclude, or re-acquire cleanly).
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable

LOG = logging.getLogger("provenance")

# --------------------------------------------------------------------------
# Paths / constants
# --------------------------------------------------------------------------

_THIS_FILE = Path(__file__).resolve()
PROVENANCE_DIR = _THIS_FILE.parent
REPO_ROOT = PROVENANCE_DIR.parents[2]  # scripts/ops/provenance -> repo root
DEFAULT_MANIFEST_PATH = REPO_ROOT / "models" / "MANIFEST.json"
DEFAULT_SCHEMA_PATH = REPO_ROOT / "models" / "manifest.schema.json"
DEFAULT_ALLOWLIST_PATH = PROVENANCE_DIR / "allowlist.json"

DEFAULT_HF_BASE = "https://huggingface.co"
DEFAULT_GH_BASE = "https://github.com"

ALLOWED_TEXT_SUFFIXES = {".json", ".txt", ".md", ".jinja", ".model", ".tiktoken"}
ALLOWED_WEIGHT_SUFFIXES = {".safetensors", ".gguf", ".mmproj"}
DENY_SUFFIXES = {
    ".bin", ".pt", ".pth", ".pkl", ".pickle", ".ckpt", ".h5",
    ".zip", ".tar", ".tgz", ".7z",
    ".exe", ".dll", ".so", ".dylib", ".sh", ".ps1", ".bat", ".cmd",
}
DENY_MULTI_SUFFIXES = (".tar.gz",)  # checked via endswith, not Path.suffix

BLOCKING_SUBSCAN_STATUSES = {"unsafe", "suspicious", "caution", "malicious", "infected"}
SECURITY_SUBSCAN_KEYS = ("avScan", "protectAiScan", "pickleImportScan", "virusTotalScan", "jFrogScan")


class ProvenanceError(Exception):
    """Fail-closed refusal. Message must name the sanctioned next step."""


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def split_repo(repo_id: str) -> tuple[str, str]:
    if "/" not in repo_id:
        raise ProvenanceError(
            f"repo id must be 'owner/name', got {repo_id!r}. "
            "Sanctioned next step: pass the full HF repo id."
        )
    owner, name = repo_id.split("/", 1)
    return owner, name


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("utf-8")
    return hashlib.sha1(header + data).hexdigest()


def classify_extension(filename: str) -> str:
    """Classify a repo-relative filename as text | weight | code | deny | unknown."""
    lower = filename.lower()
    name = Path(filename)
    if lower.endswith(DENY_MULTI_SUFFIXES):
        return "deny"
    if name.name == ".gitattributes":
        return "text"
    if name.name.startswith("LICENSE") or name.name.startswith("NOTICE"):
        return "text"
    suffix = name.suffix.lower()
    if suffix == ".py":
        return "code"
    if suffix in ALLOWED_TEXT_SUFFIXES:
        return "text"
    if suffix in ALLOWED_WEIGHT_SUFFIXES:
        return "weight"
    if suffix in DENY_SUFFIXES:
        return "deny"
    return "unknown"


def _selected(path: str, include: list[str], exclude: list[str]) -> bool:
    if exclude and any(fnmatch.fnmatch(path, pat) for pat in exclude):
        return False
    if include:
        return any(fnmatch.fnmatch(path, pat) for pat in include)
    return True


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pat) for pat in patterns)


def validate_safe_relpath(rfilename: str, dest_dir: Path) -> None:
    """Refuse any candidate filename that could escape dest_dir on join.

    HF siblings[].rfilename is attacker-controlled the moment the origin
    account is compromised (this RDR's own named threat model) -- content
    hash verification only proves bytes match what a compromised manifest
    CLAIMS, never that the path is safe to write to. `Path('/a') / '/etc/x'`
    silently discards the left side entirely (pathlib join semantics,
    verified live), so an absolute rfilename is exactly as dangerous as a
    '../' one and must be rejected the same way, before any download.
    """
    if "\x00" in rfilename:
        raise ProvenanceError(f"refusing: NUL byte in filename {rfilename!r}")
    if "\\" in rfilename:
        raise ProvenanceError(f"refusing: backslash in filename {rfilename!r} (path separator smuggling)")
    if rfilename.startswith("/") or PurePosixPath(rfilename).is_absolute():
        raise ProvenanceError(f"refusing: absolute path in filename {rfilename!r}")
    if ".." in PurePosixPath(rfilename).parts:
        raise ProvenanceError(f"refusing: '..' path segment in filename {rfilename!r}")
    resolved = (dest_dir / rfilename).resolve()
    if not resolved.is_relative_to(dest_dir.resolve()):
        raise ProvenanceError(f"refusing: filename {rfilename!r} resolves outside the destination directory")


def security_blocks(sec: dict[str, Any] | None) -> bool:
    """True iff any of the five named HF sub-scans flagged the file.

    All five sub-scans present in HF's `securityFileStatus` shape are
    checked -- avScan, protectAiScan, pickleImportScan, virusTotalScan,
    jFrogScan (verified against tests/fixtures/qwen38-tree.json). A scan
    that has not run yet ("unscanned"/"queued") is recorded, never treated
    as a positive finding either way; only an explicit
    unsafe/suspicious/caution/malicious/infected verdict blocks.
    """
    if not sec:
        return False
    return any((sec.get(key) or {}).get("status") in BLOCKING_SUBSCAN_STATUSES for key in SECURITY_SUBSCAN_KEYS)


def _security_summary(sec: dict[str, Any] | None) -> dict[str, Any] | None:
    if not sec:
        return None
    out: dict[str, Any] = {"status": sec.get("status")}
    for key in SECURITY_SUBSCAN_KEYS:
        out[key] = (sec.get(key) or {}).get("status")
    return out


def _infer_format(paths: Iterable[str]) -> str:
    paths = list(paths)
    if any(p.lower().endswith(".safetensors") for p in paths):
        return "safetensors"
    if any(p.lower().endswith(".gguf") for p in paths):
        return "gguf"
    LOG.warning("could not infer format from selected files; defaulting to 'safetensors'")
    return "safetensors"


EXTERNAL_HF_CACHE = Path("/Volumes/Transcend Hell/hf-cache")


def default_dest_dir(owner: str, name: str, sha: str) -> Path:
    if EXTERNAL_HF_CACHE.exists():
        return EXTERNAL_HF_CACHE / "provenance" / f"{owner}__{name}" / sha
    return Path.home() / ".cache" / "qwen-provenance" / f"{owner}__{name}" / sha


def default_runtime_dest_dir(repo: str, tag: str) -> Path:
    owner, name = repo.split("/", 1)
    return Path.home() / ".cache" / "qwen-provenance" / f"{owner}__{name}" / tag


# --------------------------------------------------------------------------
# JSON-Schema draft-07 subset validator
# --------------------------------------------------------------------------
#
# Supports: type (str or list of str), required, properties,
# additionalProperties (bool), enum, pattern, items (single schema),
# minItems, minLength, $ref (local "#/..." only), allOf, if/then/else,
# dependentRequired. `format` is ignored. `oneOf`/`anyOf`/`not` are NOT
# supported.


def _check_type(instance: Any, t: str) -> bool:
    if t == "object":
        return isinstance(instance, dict)
    if t == "array":
        return isinstance(instance, list)
    if t == "string":
        return isinstance(instance, str)
    if t == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if t == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if t == "boolean":
        return isinstance(instance, bool)
    if t == "null":
        return instance is None
    return False


def _resolve_schema(schema: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            raise SchemaAuthoringError(f"only local $ref supported, got {ref!r}")
        node: Any = root
        for part in ref[2:].split("/"):
            node = node[part]
        return node
    return schema


class SchemaAuthoringError(Exception):
    """Raised for malformed *schema* documents (not instance failures)."""


def validate_instance(
    instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str = "$"
) -> list[str]:
    errors: list[str] = []
    _validate(instance, schema, root, path, errors)
    return errors


def _validate(
    instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str, errors: list[str]
) -> None:
    schema = _resolve_schema(schema, root)

    if "type" in schema:
        types = schema["type"]
        if isinstance(types, str):
            types = [types]
        if not any(_check_type(instance, t) for t in types):
            errors.append(f"{path}: expected type {types}, got {type(instance).__name__} ({instance!r})")
            return

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: value {instance!r} not in enum {schema['enum']}")

    if isinstance(instance, str):
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{path}: value {instance!r} does not match pattern {schema['pattern']!r}")
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: length {len(instance)} < minLength {schema['minLength']}")

    if isinstance(instance, dict):
        props: dict[str, Any] = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in instance:
                errors.append(f"{path}: missing required property '{req}'")
        if schema.get("additionalProperties") is False:
            allowed = set(props.keys())
            for key in instance.keys():
                if key not in allowed:
                    errors.append(f"{path}: additional property '{key}' not allowed")
        for key, value in instance.items():
            if key in props:
                _validate(value, props[key], root, f"{path}.{key}", errors)
        for prop, deps in schema.get("dependentRequired", {}).items():
            if prop in instance:
                for dep in deps:
                    if dep not in instance:
                        errors.append(f"{path}: property '{prop}' present requires '{dep}'")

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: {len(instance)} item(s) < minItems {schema['minItems']}")
        if "items" in schema:
            for i, item in enumerate(instance):
                _validate(item, schema["items"], root, f"{path}[{i}]", errors)

    for sub_schema in schema.get("allOf", []):
        _validate(instance, sub_schema, root, path, errors)

    if "if" in schema:
        if not validate_instance(instance, schema["if"], root, path):
            if "then" in schema:
                _validate(instance, schema["then"], root, path, errors)
        elif "else" in schema:
            _validate(instance, schema["else"], root, path, errors)


# --------------------------------------------------------------------------
# Manifest / allowlist I/O
# --------------------------------------------------------------------------


def load_manifest(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {"schema_version": 1, "artifacts": []}
    return json.loads(p.read_text())


def save_manifest(path: str | Path, manifest: dict[str, Any]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(manifest, indent=2) + "\n")


def upsert_entry(manifest: dict[str, Any], entry: dict[str, Any]) -> None:
    artifacts = manifest.setdefault("artifacts", [])
    for i, existing in enumerate(artifacts):
        if existing.get("id") == entry["id"]:
            artifacts[i] = entry
            return
    artifacts.append(entry)


def load_allowlist(path: str | Path) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        raise ProvenanceError(
            f"allowlist not found at {p}; refusing (fail closed). "
            "Sanctioned next step: restore scripts/ops/provenance/allowlist.json."
        )
    return json.loads(p.read_text())


def check_allowlist(owner: str, allowlist: dict[str, Any], allow_packager: bool) -> str:
    if owner in allowlist.get("origin", []):
        return "origin"
    if owner in allowlist.get("packager", []):
        if not allow_packager:
            raise ProvenanceError(
                f"owner '{owner}' is packager-tier, not origin-tier. "
                "Sanctioned next step: pass --allow-packager if you accept a "
                "third-party repackaging, or prefer self-quantizing from an "
                "origin repo."
            )
        return "packager"
    raise ProvenanceError(
        f"owner '{owner}' is not in the allowlist (origin or packager tier); "
        "refusing. Sanctioned next step: add it to "
        "scripts/ops/provenance/allowlist.json after review, or use an "
        "already-allowlisted repo."
    )


def _select_entries(manifest: dict[str, Any], entry_id: str | None, select_all: bool) -> list[dict[str, Any]]:
    artifacts = manifest.get("artifacts", [])
    if entry_id:
        return [a for a in artifacts if a.get("id") == entry_id]
    if select_all:
        return list(artifacts)
    return []


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


def build_hf_headers() -> dict[str, str]:
    headers = {"User-Agent": "qwen-coprocessor-stack-provenance/1"}
    token = os.environ.get("HF_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _http_get_json(url: str, headers: dict[str, str]) -> Any:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise ProvenanceError(f"GET {url} failed: {exc}. Sanctioned next step: verify repo id / revision / network.")


def _parse_next_link(link_header: str | None) -> str | None:
    if not link_header:
        return None
    for part in link_header.split(","):
        segs = [s.strip() for s in part.split(";")]
        if len(segs) < 2:
            continue
        url_part, rel_part = segs[0], segs[1]
        if rel_part == 'rel="next"' and url_part.startswith("<") and url_part.endswith(">"):
            return url_part[1:-1]
    return None


def fetch_hf_model_meta(hf_base: str, repo: str, revision: str | None, headers: dict[str, str]) -> dict[str, Any]:
    # HF ignores a `?revision=` query parameter on /api/models/{repo} (silently
    # answers for main); the revision-scoped form is the PATH segment
    # /api/models/{repo}/revision/{rev}. Found live 2026-08-15 when `adopt
    # --revision <old sha>` came back pinned to main.
    if revision:
        url = f"{hf_base}/api/models/{repo}/revision/{urllib.parse.quote(revision, safe='')}?blobs=true&securityStatus=true"
    else:
        url = f"{hf_base}/api/models/{repo}?blobs=true&securityStatus=true"
    return _http_get_json(url, headers)


def _fetch_paginated_list(url: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    next_url: str | None = url
    while next_url:
        req = urllib.request.Request(next_url, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                page = json.loads(resp.read())
                entries.extend(page)
                link = resp.headers.get("Link")
        except urllib.error.URLError as exc:
            raise ProvenanceError(f"GET {next_url} failed: {exc}")
        next_url = _parse_next_link(link)
    return entries


def fetch_hf_tree(
    hf_base: str, repo: str, sha: str, headers: dict[str, str], recursive: bool = False
) -> list[dict[str, Any]]:
    q = "expand=true"
    if recursive:
        q += "&recursive=true"
    return _fetch_paginated_list(f"{hf_base}/api/models/{repo}/tree/{sha}?{q}", headers)


def fetch_hf_commits(hf_base: str, repo: str, headers: dict[str, str], ref: str = "main") -> list[dict[str, Any]]:
    """Commit history, newest-first (per HF API convention), paginated via Link."""
    return _fetch_paginated_list(f"{hf_base}/api/models/{repo}/commits/{ref}", headers)


def resolve_derived_from_files(hf_base: str, repo: str, sha: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    """Metadata-only snapshot of the origin weight files at a pinned sha.

    No download: uses the model API's `siblings[].lfs.sha256`, same as
    `hf-meta`. Restricted to weight-classified files (safetensors/gguf/mmproj)
    -- the files a quant is actually derived from.
    """
    meta = fetch_hf_model_meta(hf_base, repo, sha, headers)
    out: list[dict[str, Any]] = []
    for s in meta.get("siblings", []):
        path = s["rfilename"]
        if classify_extension(path) != "weight":
            continue
        lfs = s.get("lfs") or {}
        out.append({"path": path, "sha256": lfs.get("sha256"), "size": s.get("size")})
    return out


def _derived_from_repo_sha(derived_from: str) -> tuple[str, str] | None:
    """If derived_from is 'owner/repo@sha' (manifest ids never contain '/'), split it."""
    if "/" not in derived_from or "@" not in derived_from:
        return None
    repo, sha = derived_from.rsplit("@", 1)
    return repo, sha


def populate_derived_from_files(
    manifest: dict[str, Any], derived_from: str | None, hf_base: str, headers: dict[str, str]
) -> list[dict[str, Any]] | None:
    """Resolve --derived-from into a re-checkable files[] snapshot, or None.

    'owner/repo@sha' form: one metadata-only HF call. Manifest-id form:
    copies the referenced entry's own weight files verbatim (already
    hash-verified when that entry was created) -- no network call needed,
    and no silent "empty lineage" gap for entries that reference a sibling
    manifest entry (e.g. `register --derived-from <manifest-id>`, the form
    docs/MODEL_PROVENANCE.md's own worked example uses). Existence of the
    referenced entry is re-asserted independently at drift time.
    """
    if not derived_from:
        return None
    parsed = _derived_from_repo_sha(derived_from)
    if parsed is None:
        origin = next((a for a in manifest.get("artifacts", []) if a.get("id") == derived_from), None)
        if origin is None:
            LOG.warning("--derived-from %r does not match any existing manifest id yet", derived_from)
            return None
        weight_files = [
            {"path": f["path"], "sha256": f.get("sha256"), "size": f.get("size")}
            for f in origin.get("files", [])
            if classify_extension(f["path"]) == "weight"
        ]
        return weight_files or None
    repo, sha = parsed
    try:
        return resolve_derived_from_files(hf_base, repo, sha, headers)
    except ProvenanceError as exc:
        LOG.warning("could not resolve derived_from_files for %r: %s", derived_from, exc)
        return None


def download_to_path(url: str, dest_path: Path, headers: dict[str, str], chunk_size: int = 1 << 20) -> tuple[str, int]:
    """Stream url to dest_path via a `.part` temp file. Returns (sha256, size).

    Renames the temp file onto dest_path only after the full body has been
    received; the caller is responsible for deleting dest_path if a
    post-download hash comparison fails.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = dest_path.with_name(dest_path.name + ".part")
    h = hashlib.sha256()
    size = 0
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            with open(part_path, "wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    size += len(chunk)
    except urllib.error.URLError as exc:
        part_path.unlink(missing_ok=True)
        dest_path.unlink(missing_ok=True)
        raise ProvenanceError(f"download failed: {url}: {exc}") from exc
    except BaseException:
        # OSError, ProvenanceError, KeyboardInterrupt, ... -- never leave a
        # half-written .part or a stale target behind on any failure mode.
        part_path.unlink(missing_ok=True)
        dest_path.unlink(missing_ok=True)
        raise
    part_path.replace(dest_path)
    return h.hexdigest(), size


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Stop urllib from auto-following a redirect so the caller can inspect
    the Location header and decide what to forward on the next request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N803 (stdlib signature)
        return None


def download_gh_artifact_zip(url: str, dest_path: Path, headers: dict[str, str]) -> tuple[str, int]:
    """Download a GitHub Actions artifact zip (the `archive_download_url`
    from the run-artifacts API).

    That endpoint responds with a redirect to a time-limited, pre-signed
    URL on a DIFFERENT host (Azure blob storage in practice). Plain
    `download_to_path` would forward our GitHub Authorization header across
    that cross-host redirect (`urllib` does this by default, unlike `curl`,
    which strips sensitive headers on a cross-host redirect unless passed
    `--location-trusted`) -- the storage backend then rejects the GitHub
    bearer token with 401 rather than ignoring it. Confirmed live against
    run 34707921300's artifact (RDR-016 bead 9so review remediation).

    Follows the redirect manually and re-issues the download to the
    Location WITHOUT the GitHub auth header. Falls back to treating a
    non-redirect 2xx response as the artifact body directly (the shape a
    test double serves; the real API always redirects).
    """
    opener = urllib.request.build_opener(_NoRedirectHandler)
    req = urllib.request.Request(url, headers=headers)
    try:
        resp = opener.open(req, timeout=30)
    except urllib.error.HTTPError as exc:
        if exc.code in (301, 302, 303, 307, 308):
            location = exc.headers.get("Location")
            if not location:
                raise ProvenanceError(f"GET {url} redirected ({exc.code}) with no Location header")
            return download_to_path(location, dest_path, {})
        raise ProvenanceError(f"GET {url} failed: {exc}")
    except urllib.error.URLError as exc:
        raise ProvenanceError(f"GET {url} failed: {exc}")

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = dest_path.with_name(dest_path.name + ".part")
    h = hashlib.sha256()
    size = 0
    try:
        with resp:
            with open(part_path, "wb") as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    size += len(chunk)
    except BaseException:
        part_path.unlink(missing_ok=True)
        dest_path.unlink(missing_ok=True)
        raise
    part_path.replace(dest_path)
    return h.hexdigest(), size


# --------------------------------------------------------------------------
# validate
# --------------------------------------------------------------------------


def cmd_validate(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    schema_path = Path(args.schema)
    if not manifest_path.exists():
        LOG.error("manifest not found: %s", manifest_path)
        return 1
    manifest = json.loads(manifest_path.read_text())
    schema = json.loads(schema_path.read_text())
    errors = validate_instance(manifest, schema, schema)
    if errors:
        for e in errors:
            print(e, file=sys.stderr)
        return 1
    print(f"OK: {manifest_path} valid against {schema_path}")
    return 0


# --------------------------------------------------------------------------
# fetch
# --------------------------------------------------------------------------


def cmd_fetch(args: argparse.Namespace) -> int:
    allowlist = load_allowlist(args.allowlist)
    owner, name = split_repo(args.repo_id)
    tier = check_allowlist(owner, allowlist, args.allow_packager)
    if tier == "packager" and not args.derived_from:
        raise ProvenanceError(
            "refusing: packager-tier repo requires --derived-from "
            "'<manifest id or owner/repo@sha>' naming the origin weights "
            "this repackaging derives from."
        )

    headers = build_hf_headers()
    meta = fetch_hf_model_meta(args.hf_base, args.repo_id, args.revision, headers)
    sha = meta.get("sha")
    if not sha or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ProvenanceError(
            f"resolved revision is not a 40-hex commit sha: {sha!r}; refusing "
            "to record a branch/tag name in the manifest."
        )
    siblings = {s["rfilename"]: s for s in meta.get("siblings", [])}
    tree = fetch_hf_tree(args.hf_base, args.repo_id, sha, headers)
    tree_by_path = {e["path"]: e for e in tree}

    include = list(args.include or [])
    exclude = list(args.exclude or [])
    all_files = sorted(siblings.keys())
    candidates = [f for f in all_files if _selected(f, include, exclude)]
    non_candidates = [f for f in all_files if f not in candidates]

    deny_candidates = [f for f in candidates if classify_extension(f) == "deny"]
    if deny_candidates:
        raise ProvenanceError(
            f"refusing: denied file type(s) selected for download: {deny_candidates}. "
            "Sanctioned next step: narrow with --exclude, they are never fetched."
        )

    py_candidates = sorted(f for f in candidates if classify_extension(f) == "code")
    if py_candidates and not args.allow_remote_code:
        raise ProvenanceError(
            f"refusing: repo contains .py (remote code) selected for download: "
            f"{py_candidates}. Sanctioned next step: pass --allow-remote-code "
            "to accept, or --exclude '*.py' to skip them."
        )

    unknown_candidates = [f for f in candidates if classify_extension(f) == "unknown"]
    unknown_unrequested = [f for f in unknown_candidates if not _matches_any(f, include)]
    if unknown_unrequested:
        raise ProvenanceError(
            f"refusing: unrecognized file type(s) selected for download: "
            f"{unknown_unrequested}. Sanctioned next step: pass --include "
            "explicitly if this is intentional."
        )

    security_by_path: dict[str, Any] = {}
    blocked: list[str] = []
    for f in candidates:
        sec = (tree_by_path.get(f) or {}).get("securityFileStatus")
        security_by_path[f] = sec
        if security_blocks(sec):
            blocked.append(f)
    if blocked:
        raise ProvenanceError(f"refusing: HF security scan flagged file(s): {blocked}")

    notes_parts: list[str] = []
    deny_noncandidates = sorted(f for f in non_candidates if classify_extension(f) == "deny")
    if deny_noncandidates:
        notes_parts.append(f"repo also contains denied-type file(s) not downloaded: {deny_noncandidates}")
    py_noncandidates = sorted(f for f in non_candidates if classify_extension(f) == "code")
    remote_code_present = bool(py_candidates or py_noncandidates)
    if py_noncandidates:
        notes_parts.append(f"repo also contains .py file(s) not downloaded: {py_noncandidates}")
    if args.revision and args.revision != "main":
        notes_parts.append(f"as-of: fetched at revision '{args.revision}' (resolved to {sha})")
    if args.notes:
        notes_parts.append(args.notes)

    plan = {
        "repo": args.repo_id,
        "resolved_sha": sha,
        "trust_tier": tier,
        "candidates": candidates,
        "remote_code_files": py_candidates,
        "remote_code_present": remote_code_present,
        "notes": "; ".join(notes_parts),
    }
    if args.dry_run:
        print(json.dumps(plan, indent=2))
        return 0

    manifest = load_manifest(args.manifest)
    derived_from_files: list[dict[str, Any]] | None = None
    if args.derived_from:
        derived_from_files = populate_derived_from_files(manifest, args.derived_from, args.hf_base, headers)
        if not derived_from_files:
            raise ProvenanceError(
                f"refusing: could not establish re-checkable derived_from_files for "
                f"--derived-from {args.derived_from!r}. Sanctioned next step: pass an "
                "'owner/repo@sha' whose HF metadata is reachable, or a manifest id "
                "that already carries weight files."
            )

    dest_dir = Path(args.dest) if args.dest else default_dest_dir(owner, name, sha)
    for f in candidates:
        validate_safe_relpath(f, dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    file_entries: list[dict[str, Any]] = []
    for f in candidates:
        sib = siblings[f]
        url = f"{args.hf_base}/{args.repo_id}/resolve/{sha}/{f}"
        dest_path = dest_dir / f
        sha256_hex, size = download_to_path(url, dest_path, headers)

        lfs = sib.get("lfs")
        if lfs:
            expected = lfs.get("sha256")
            if expected and expected.lower() != sha256_hex.lower():
                dest_path.unlink(missing_ok=True)
                raise ProvenanceError(
                    f"hash mismatch for {f}: expected lfs sha256 {expected}, "
                    f"got {sha256_hex}; file deleted, manifest not updated."
                )
        else:
            data = dest_path.read_bytes()
            blob_sha = git_blob_sha1(data)
            expected_blob = sib.get("blobId")
            if expected_blob and expected_blob.lower() != blob_sha.lower():
                dest_path.unlink(missing_ok=True)
                raise ProvenanceError(
                    f"git-blob hash mismatch for {f}: expected {expected_blob}, "
                    f"got {blob_sha}; file deleted, manifest not updated."
                )

        file_entries.append(
            {
                "path": f,
                "sha256": sha256_hex,
                "size": size,
                "hf_security": _security_summary(security_by_path.get(f)),
            }
        )

    entry: dict[str, Any] = {
        "id": args.id or f"{name.lower()}@{sha[:8]}",
        "kind": "model",
        "status": "verified",
        "source": {
            "host": "huggingface",
            "repo": args.repo_id,
            "revision": sha,
            "url": f"{args.hf_base}/{args.repo_id}/resolve/{sha}/",
        },
        "format": _infer_format(candidates),
        "trust_tier": tier,
        "quantized_by": None,
        "remote_code_files": py_candidates,
        "remote_code_present": remote_code_present,
        "files": file_entries,
        "verified_on": ["mac"],
        "verified_at": utc_now_iso(),
        "notes": "; ".join(notes_parts),
    }
    if args.derived_from:
        entry["derived_from"] = args.derived_from
        entry["derived_from_files"] = derived_from_files

    upsert_entry(manifest, entry)
    save_manifest(args.manifest, manifest)
    LOG.info("fetched %s (%d files) -> %s", entry["id"], len(file_entries), dest_dir)
    return 0


# --------------------------------------------------------------------------
# add-runtime
# --------------------------------------------------------------------------


def hash_zip_members(zip_path: Path) -> list[dict[str, Any]]:
    members: list[dict[str, Any]] = []
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            data = zf.read(info.filename)
            members.append(
                {"path": info.filename, "sha256": hashlib.sha256(data).hexdigest(), "size": info.file_size}
            )
    return members


# --------------------------------------------------------------------------
# add-runtime --overlay-* (patched-DLL overlay on an official release zip)
# --------------------------------------------------------------------------

OVERLAY_WORKFLOW_PATH = ".github/workflows/llama-vulkan-patched.yml"
DEFAULT_GH_API_BASE = "https://api.github.com"


def build_gh_headers() -> dict[str, str]:
    """Auth headers for the GitHub API. GH_TOKEN / GITHUB_TOKEN env win when
    set; otherwise fall back to `gh auth token` (best-effort subprocess --
    `gh` is already a required tool in this repo's own workflow, see CLAUDE.md
    git steps, so shelling out to its cached credentials avoids asking an
    operator to mint and export a separate PAT just for this read-only
    Actions API call). Any failure (gh missing, not logged in, timeout)
    leaves the request unauthenticated -- GitHub's Actions API then refuses
    it itself (fail closed at the HTTP layer, not silently degraded here).
    """
    headers = {
        "User-Agent": "qwen-coprocessor-stack-provenance/1",
        "Accept": "application/vnd.github+json",
    }
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        try:
            proc = subprocess.run(
                ["gh", "auth", "token"], capture_output=True, text=True, timeout=10, check=True
            )
            token = proc.stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            token = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_gh_run_meta(gh_api_base: str, repo: str, run_id: int, headers: dict[str, str]) -> dict[str, Any]:
    return _http_get_json(f"{gh_api_base}/repos/{repo}/actions/runs/{run_id}", headers)


def fetch_gh_commit(gh_api_base: str, repo: str, sha: str, headers: dict[str, str]) -> dict[str, Any]:
    return _http_get_json(f"{gh_api_base}/repos/{repo}/commits/{sha}", headers)


def fetch_gh_run_artifacts(gh_api_base: str, repo: str, run_id: int, headers: dict[str, str]) -> dict[str, Any]:
    return _http_get_json(f"{gh_api_base}/repos/{repo}/actions/runs/{run_id}/artifacts", headers)


def parse_patched_build_txt(text: str) -> dict[str, str]:
    """Parse a PATCHED-BUILD.txt written by llama-vulkan-patched.yml.

    Tolerant `key: value` (or `key=value`) lines, one field per line; blank
    lines and '#' comments are ignored. Not a general-purpose format -- just
    enough structure to carry base_tag/base_sha/patch/dll_sha256/dll_bytes/
    built_by out of the workflow artifact.
    """
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_]+)\s*[:=]\s*(.*)$", line)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    return out


def _read_overlay_dir(overlay_dir: Path) -> tuple[Path, dict[str, str]]:
    """Return (replacement_file_path, patched_build_fields) from an extracted
    llama-vulkan-patched.yml artifact directory.

    Refuses unless the directory holds exactly PATCHED-BUILD.txt plus one
    other file (the declared replacement), and PATCHED-BUILD.txt carries all
    required fields.
    """
    if not overlay_dir.is_dir():
        raise ProvenanceError(f"--overlay-dir is not a directory: {overlay_dir}")
    entries = sorted(p for p in overlay_dir.iterdir() if p.is_file())
    manifest_txt = overlay_dir / "PATCHED-BUILD.txt"
    if manifest_txt not in entries:
        raise ProvenanceError(
            f"refusing: --overlay-dir {overlay_dir} has no PATCHED-BUILD.txt. "
            "Sanctioned next step: point --overlay-dir at the extracted "
            "llama-vulkan-patched.yml artifact, which always carries it."
        )
    others = [p for p in entries if p != manifest_txt]
    if len(others) != 1:
        raise ProvenanceError(
            f"refusing: --overlay-dir {overlay_dir} must contain exactly one "
            f"replacement file alongside PATCHED-BUILD.txt, found {len(others)}: "
            f"{[p.name for p in others]}. Sanctioned next step: extract only "
            "the workflow artifact's own files, nothing else."
        )
    fields = parse_patched_build_txt(manifest_txt.read_text())
    required = ("base_tag", "base_sha", "patch", "dll_sha256", "dll_bytes", "built_by")
    missing = [k for k in required if k not in fields]
    if missing:
        raise ProvenanceError(
            f"refusing: PATCHED-BUILD.txt at {manifest_txt} is missing field(s) "
            f"{missing}. Sanctioned next step: re-run the patched-build "
            "workflow; a hand-edited PATCHED-BUILD.txt is not sanctioned."
        )
    return others[0], fields


def _apply_overlay(
    args: argparse.Namespace, allowlist: dict[str, Any], asset: str, members: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Validate --overlay-* args against the official zip `members` (mutated
    in place to carry the replacement file's real hash/size) and return the
    manifest `overlay` object, or None if no overlay was requested.
    """
    overlay_args = (args.overlay_dir, args.overlay_repo, args.overlay_run, args.patch)
    if not any(overlay_args):
        return None
    if not all(overlay_args):
        raise ProvenanceError(
            "refusing: --overlay-dir, --overlay-repo, --overlay-run and "
            "--patch must all be given together for an overlay runtime. "
            "Sanctioned next step: supply all four, or none for a plain "
            "add-runtime."
        )

    overlay_repos = allowlist.get("overlay_repos", [])
    if args.overlay_repo not in overlay_repos:
        raise ProvenanceError(
            f"refusing: overlay repo '{args.overlay_repo}' is not in "
            f"allowlist overlay_repos {overlay_repos}. Sanctioned next step: "
            "add it to scripts/ops/provenance/allowlist.json after review."
        )
    try:
        overlay_run_id = int(args.overlay_run)
    except (TypeError, ValueError):
        raise ProvenanceError(f"--overlay-run must be numeric, got {args.overlay_run!r}")

    patch_path = Path(args.patch)
    if not patch_path.is_file():
        raise ProvenanceError(f"--patch path does not exist: {patch_path}")
    patch_sha256 = sha256_file(patch_path)

    replacement_path, fields = _read_overlay_dir(Path(args.overlay_dir))

    if fields["base_tag"] != args.tag:
        raise ProvenanceError(
            f"refusing: PATCHED-BUILD.txt base_tag {fields['base_tag']!r} "
            f"does not match --tag {args.tag!r}. Sanctioned next step: point "
            "--overlay-dir at the artifact built for this tag."
        )
    if fields["patch"] != patch_path.name:
        raise ProvenanceError(
            f"refusing: PATCHED-BUILD.txt patch {fields['patch']!r} does not "
            f"match --patch basename {patch_path.name!r}. Sanctioned next "
            "step: pass the same patch the workflow was run with."
        )

    actual_sha256 = sha256_file(replacement_path)
    actual_size = replacement_path.stat().st_size
    try:
        declared_bytes = int(fields["dll_bytes"])
    except ValueError:
        raise ProvenanceError(f"PATCHED-BUILD.txt dll_bytes is not an integer: {fields['dll_bytes']!r}")
    if actual_sha256.lower() != fields["dll_sha256"].lower() or actual_size != declared_bytes:
        raise ProvenanceError(
            f"refusing: {replacement_path.name} does not match PATCHED-BUILD.txt "
            f"(declared sha256={fields['dll_sha256']} bytes={declared_bytes}; "
            f"actual sha256={actual_sha256} bytes={actual_size}). Sanctioned "
            "next step: re-extract the workflow artifact; do not hand-edit "
            "either file."
        )

    member_by_path = {m["path"]: m for m in members}
    target_member = member_by_path.get(replacement_path.name)
    if target_member is None:
        basename_matches = [p for p in member_by_path if Path(p).name == replacement_path.name]
        if len(basename_matches) == 1:
            target_member = member_by_path[basename_matches[0]]
        elif len(basename_matches) > 1:
            raise ProvenanceError(
                f"refusing: {replacement_path.name} matches more than one "
                f"official zip member by basename ({basename_matches}); "
                "ambiguous overlay target. Sanctioned next step: disambiguate "
                "manually before recording this entry."
            )
    if target_member is None:
        raise ProvenanceError(
            f"refusing: overlay file {replacement_path.name!r} is not a "
            f"member of the official {asset}. Sanctioned next step: an "
            "overlay may only replace a file the official release already "
            "ships."
        )
    target_member["sha256"] = actual_sha256
    target_member["size"] = actual_size

    artifact_name = args.overlay_artifact or f"ggml-vulkan-{args.tag}-patched"
    verification = "offline-unverified"
    head_sha: str | None = None

    if not args.offline:
        headers = build_gh_headers()
        meta = fetch_gh_run_meta(args.gh_api_base, args.overlay_repo, overlay_run_id, headers)
        if meta.get("conclusion") != "success":
            raise ProvenanceError(
                f"refusing: workflow run {args.overlay_repo}#{overlay_run_id} "
                f"conclusion is {meta.get('conclusion')!r}, not 'success'. "
                "Sanctioned next step: point at a run that finished green."
            )
        if meta.get("path") != OVERLAY_WORKFLOW_PATH:
            raise ProvenanceError(
                f"refusing: workflow run {args.overlay_repo}#{overlay_run_id} "
                f"path is {meta.get('path')!r}, not {OVERLAY_WORKFLOW_PATH!r}. "
                "Sanctioned next step: point --overlay-run at a run of the "
                "sanctioned patched-build workflow."
            )

        head_sha = meta.get("head_sha")
        if not head_sha or not re.fullmatch(r"[0-9a-f]{40}", head_sha):
            raise ProvenanceError(
                f"refusing: workflow run {args.overlay_repo}#{overlay_run_id} has "
                f"no well-formed head_sha ({head_sha!r}); refusing to record an "
                "unverifiable base commit."
            )
        try:
            fetch_gh_commit(args.gh_api_base, args.overlay_repo, head_sha, headers)
        except ProvenanceError as exc:
            raise ProvenanceError(
                f"refusing: run {args.overlay_repo}#{overlay_run_id} head_sha "
                f"{head_sha} is not a commit on {args.overlay_repo}: {exc}"
            )

        # Tie the LOCAL --overlay-dir file to this run's own output, not just
        # to "some successful run of the right repo/workflow" -- list the
        # run's artifacts, require the named one present and unexpired, then
        # download and hash its contents against the local files.
        artifacts_meta = fetch_gh_run_artifacts(args.gh_api_base, args.overlay_repo, overlay_run_id, headers)
        artifact = next(
            (a for a in artifacts_meta.get("artifacts", []) if a.get("name") == artifact_name), None
        )
        if artifact is None:
            raise ProvenanceError(
                f"refusing: run {args.overlay_repo}#{overlay_run_id} has no "
                f"artifact named {artifact_name!r}. Sanctioned next step: pass "
                "--overlay-artifact with the run's actual artifact name."
            )
        if artifact.get("expired"):
            raise ProvenanceError(
                f"refusing: artifact {artifact_name!r} on run "
                f"{args.overlay_repo}#{overlay_run_id} has expired (GitHub "
                "Actions artifacts expire). Sanctioned next step: re-run the "
                "workflow for a fresh artifact, or pass --offline if the local "
                "--overlay-dir DLL is otherwise trusted."
            )
        download_url = artifact.get("archive_download_url")
        if not download_url:
            raise ProvenanceError(
                f"refusing: run {args.overlay_repo}#{overlay_run_id} artifact "
                f"{artifact_name!r} has no archive_download_url."
            )

        with tempfile.TemporaryDirectory() as td:
            artifact_zip = Path(td) / "artifact.zip"
            download_gh_artifact_zip(download_url, artifact_zip, headers)
            with zipfile.ZipFile(artifact_zip) as zf:
                names = zf.namelist()
                remote_dll_name = next((n for n in names if Path(n).name == replacement_path.name), None)
                if remote_dll_name is None:
                    raise ProvenanceError(
                        f"refusing: artifact {artifact_name!r} does not contain "
                        f"{replacement_path.name!r}."
                    )
                remote_dll_bytes = zf.read(remote_dll_name)
                remote_txt_name = next((n for n in names if Path(n).name == "PATCHED-BUILD.txt"), None)
                if remote_txt_name is None:
                    raise ProvenanceError(
                        f"refusing: artifact {artifact_name!r} does not contain "
                        "PATCHED-BUILD.txt."
                    )
                remote_txt_bytes = zf.read(remote_txt_name)

        remote_dll_sha = hashlib.sha256(remote_dll_bytes).hexdigest()
        if remote_dll_sha.lower() != actual_sha256.lower() or len(remote_dll_bytes) != actual_size:
            raise ProvenanceError(
                f"refusing: artifact {artifact_name!r}'s {replacement_path.name} "
                f"(sha256={remote_dll_sha} bytes={len(remote_dll_bytes)}) does not "
                f"match the local --overlay-dir file (sha256={actual_sha256} "
                f"bytes={actual_size}). Sanctioned next step: re-extract the "
                "artifact from this run; do not hand-edit the local overlay dir."
            )
        local_txt_bytes = (Path(args.overlay_dir) / "PATCHED-BUILD.txt").read_bytes()
        if hashlib.sha256(remote_txt_bytes).hexdigest().lower() != hashlib.sha256(local_txt_bytes).hexdigest().lower():
            raise ProvenanceError(
                f"refusing: artifact {artifact_name!r}'s PATCHED-BUILD.txt does "
                "not match the local --overlay-dir copy byte-for-byte. "
                "Sanctioned next step: re-extract the artifact from this run."
            )
        verification = "online-artifact-hash"

    overlay_obj: dict[str, Any] = {
        "repo": args.overlay_repo,
        "run_id": overlay_run_id,
        "artifact": artifact_name,
        "file": replacement_path.name,
        "sha256": actual_sha256,
        "bytes": actual_size,
        "base_tag": fields["base_tag"],
        "base_sha": fields["base_sha"],
        "patch_path": args.patch,
        "patch_sha256": patch_sha256,
        "verification": verification,
    }
    if head_sha:
        overlay_obj["head_sha"] = head_sha
    return overlay_obj


def cmd_add_runtime(args: argparse.Namespace) -> int:
    allowlist = load_allowlist(args.allowlist)
    runtime_repos = allowlist.get("runtime_repos", [])
    if args.repo not in runtime_repos:
        raise ProvenanceError(
            f"refusing: '{args.repo}' is not in allowlist runtime_repos "
            f"{runtime_repos}. Sanctioned next step: add it to "
            "scripts/ops/provenance/allowlist.json after review."
        )

    asset = args.asset or f"llama-{args.tag}-bin-win-vulkan-x64.zip"
    url = f"{args.gh_base}/{args.repo}/releases/download/{args.tag}/{asset}"
    dest_dir = Path(args.dest) if args.dest else default_runtime_dest_dir(args.repo, args.tag)
    dest_dir.mkdir(parents=True, exist_ok=True)
    zip_path = dest_dir / asset

    if args.from_zip:
        src = Path(args.from_zip)
        if not src.exists():
            raise ProvenanceError(f"--from-zip path does not exist: {src}")
        zip_sha256 = sha256_file(src)
        zip_size = src.stat().st_size
        if not args.offline:
            with tempfile.TemporaryDirectory() as td:
                tmp_zip = Path(td) / asset
                remote_sha, _ = download_to_path(url, tmp_zip, {})
                if remote_sha.lower() != zip_sha256.lower():
                    raise ProvenanceError(
                        f"--from-zip {src} does not match GitHub asset {url} "
                        f"(local sha256 {zip_sha256} != remote {remote_sha})."
                    )
        if src.resolve() != zip_path.resolve():
            zip_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, zip_path)
    else:
        zip_sha256, zip_size = download_to_path(url, zip_path, {})

    members = hash_zip_members(zip_path)
    overlay_entry = _apply_overlay(args, allowlist, asset, members)
    files = [{"path": f"zip:{asset}", "sha256": zip_sha256, "size": zip_size}] + members

    default_id = f"{args.repo.split('/')[-1]}@{args.tag}" + ("-patched" if overlay_entry else "")
    notes = args.notes or ""
    if overlay_entry and not notes:
        notes = (
            f"overlay runtime: official {asset} with {overlay_entry['file']} "
            f"replaced per {overlay_entry['repo']}#{overlay_entry['run_id']} "
            f"artifact {overlay_entry['artifact']}"
        )

    entry = {
        "id": args.id or default_id,
        "kind": "runtime",
        "status": "verified",
        "source": {"host": "github", "repo": args.repo, "revision": args.tag, "asset": asset, "url": url},
        "format": "zip",
        # A plain add-runtime records the official, GitHub-verified zip
        # as-is ("origin"). An overlay entry has one member replaced by an
        # artifact WE built from our own patch -- not what ggml-org shipped
        # -- so it is recorded at the same trust tier a self-quantized model
        # would be: verifiably derived, not upstream-verbatim.
        "trust_tier": "self-quantized" if overlay_entry else "origin",
        "quantized_by": None,
        "remote_code_files": [],
        "remote_code_present": False,
        "files": files,
        "verified_on": ["mac"],
        "verified_at": utc_now_iso(),
        "notes": notes,
    }
    if overlay_entry:
        entry["overlay"] = overlay_entry

    manifest = load_manifest(args.manifest)
    upsert_entry(manifest, entry)
    save_manifest(args.manifest, manifest)
    LOG.info("add-runtime %s (%d members) -> %s", entry["id"], len(members), zip_path)
    return 0


# --------------------------------------------------------------------------
# register (self-quantized, local artifacts)
# --------------------------------------------------------------------------


def _resolve_derived_from_source(derived_from: str, manifest: dict[str, Any]) -> tuple[str, str | None]:
    """Resolve --derived-from into a (repo, revision) pair for source.

    Accepts either 'owner/repo@sha' (repo contains '/'; revision after the
    first '@') or an existing manifest id, in which case the referenced
    entry's own source.repo/revision are copied.
    """
    head = derived_from.split("@", 1)[0]
    if "/" in head:
        if "@" in derived_from:
            repo, revision = derived_from.split("@", 1)
            return repo, revision
        return derived_from, None
    for a in manifest.get("artifacts", []):
        if a.get("id") == derived_from:
            src = a.get("source", {})
            return src.get("repo", derived_from), src.get("revision")
    LOG.warning("--derived-from %r did not resolve to a known manifest id; recording verbatim", derived_from)
    return derived_from, None


def cmd_register(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    repo, revision = _resolve_derived_from_source(args.derived_from, manifest)

    root = Path(args.root)
    if not root.is_dir():
        raise ProvenanceError(f"--root is not a directory: {root}")
    include = list(args.include or [])
    file_entries: list[dict[str, Any]] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if include and not _matches_any(rel, include):
            continue
        file_entries.append({"path": rel, "sha256": sha256_file(p), "size": p.stat().st_size, "hf_security": None})

    if not file_entries:
        raise ProvenanceError(f"no files found under --root {root} (after --include filtering)")

    quantized_by = None
    if args.quantized_by_tool or args.quantized_by_version or args.quantized_by_command:
        quantized_by = {
            "tool": args.quantized_by_tool or "",
            "version": args.quantized_by_version or "",
            "command": args.quantized_by_command or "",
        }

    source: dict[str, Any] = {"host": "local", "repo": repo}
    if revision:
        source["revision"] = revision

    headers = build_hf_headers()
    derived_from_files = populate_derived_from_files(manifest, args.derived_from, args.hf_base, headers)
    if not derived_from_files:
        raise ProvenanceError(
            f"refusing: could not establish re-checkable derived_from_files for "
            f"--derived-from {args.derived_from!r}; a self-quantized entry requires "
            "verifiable lineage. Sanctioned next step: pass an 'owner/repo@sha' "
            "whose HF metadata is reachable (network/--hf-base), or a manifest id "
            "that already carries weight files."
        )

    entry = {
        "id": args.id,
        "kind": args.kind,
        "status": "verified",
        "source": source,
        "format": args.format,
        "trust_tier": args.trust_tier,
        "derived_from": args.derived_from,
        "derived_from_files": derived_from_files,
        "quantized_by": quantized_by,
        "remote_code_files": [],
        "remote_code_present": False,
        "files": file_entries,
        "verified_on": ["mac"],
        "verified_at": utc_now_iso(),
        "notes": args.notes or "",
    }

    upsert_entry(manifest, entry)
    save_manifest(args.manifest, manifest)
    LOG.info("registered %s (%d files) from %s", entry["id"], len(file_entries), root)
    return 0


# --------------------------------------------------------------------------
# adopt (retro-manifest: files already on a serving host, no download)
# --------------------------------------------------------------------------


def cmd_adopt(args: argparse.Namespace) -> int:
    """Record a manifest entry for files that ALREADY exist on a host.

    No download, no path-write risk. Matches HF siblings to the box's own
    listing by LFS sha256 (not filename -- a packager repackage or a
    third-party re-upload commonly renames the file, e.g.
    lmstudio-community's `mmproj-Qwen3.6-35B-A3B-BF16.gguf`), so this is
    the sanctioned way to retro-manifest files acquired before this tool
    existed once `match` has found the pinned revision that published them.
    """
    allowlist = load_allowlist(args.allowlist)
    owner, name = split_repo(args.repo_id)
    tier = check_allowlist(owner, allowlist, args.allow_packager)
    if tier == "packager" and not args.derived_from:
        raise ProvenanceError(
            "refusing: packager-tier repo requires --derived-from "
            "'<manifest id or owner/repo@sha>' naming the origin weights "
            "this repackaging derives from."
        )

    headers = build_hf_headers()
    meta = fetch_hf_model_meta(args.hf_base, args.repo_id, args.revision, headers)
    sha = meta.get("sha")
    if not sha or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ProvenanceError(
            f"resolved revision is not a 40-hex commit sha: {sha!r}; refusing "
            "to record a branch/tag name in the manifest."
        )
    tree = fetch_hf_tree(args.hf_base, args.repo_id, sha, headers)
    tree_by_path = {e["path"]: e for e in tree}

    listing_map = parse_listing(Path(args.listing).read_text())
    hash_to_local: dict[str, str] = {}
    for relpath, h in listing_map.items():
        hash_to_local.setdefault(h, relpath)

    include = list(args.include or [])
    selected: list[dict[str, Any]] = []
    for s in meta.get("siblings", []):
        path = s["rfilename"]
        if include and not _matches_any(path, include):
            continue
        lfs = s.get("lfs") or {}
        sib_sha = (lfs.get("sha256") or "").lower()
        if not sib_sha or sib_sha not in hash_to_local:
            continue
        sec = (tree_by_path.get(path) or {}).get("securityFileStatus")
        selected.append(
            {
                "path": path,
                "sha256": lfs.get("sha256"),
                "size": s.get("size"),
                "hf_security": _security_summary(sec),
                "local_path": hash_to_local[sib_sha],
            }
        )

    if not selected:
        raise ProvenanceError(
            f"refusing: no files in --listing {args.listing} matched any LFS "
            f"sha256 in {args.repo_id}@{sha} (matched by hash, not name). "
            "Sanctioned next step: confirm the listing and revision, or run "
            "`match` first to find the revision that actually published "
            "these hashes."
        )

    manifest = load_manifest(args.manifest)
    derived_from_files: list[dict[str, Any]] | None = None
    if args.derived_from:
        derived_from_files = populate_derived_from_files(manifest, args.derived_from, args.hf_base, headers)
        if not derived_from_files:
            raise ProvenanceError(
                f"refusing: could not establish re-checkable derived_from_files for "
                f"--derived-from {args.derived_from!r}. Sanctioned next step: pass an "
                "'owner/repo@sha' whose HF metadata is reachable, or a manifest id "
                "that already carries weight files."
            )

    notes_parts = [f"adopted from existing files on {args.host} at revision {sha} (pinned; may not be current main)"]
    if args.notes:
        notes_parts.append(args.notes)

    entry: dict[str, Any] = {
        "id": args.id or f"{name.lower()}@{sha[:8]}",
        "kind": "model",
        "status": "verified",
        "source": {
            "host": "huggingface",
            "repo": args.repo_id,
            "revision": sha,
            "url": f"{args.hf_base}/{args.repo_id}/resolve/{sha}/",
        },
        "format": _infer_format(f["path"] for f in selected),
        "trust_tier": tier,
        "quantized_by": None,
        "remote_code_files": [],
        "remote_code_present": False,
        "files": selected,
        "verified_on": [args.host],
        "verified_at": utc_now_iso(),
        "notes": "; ".join(notes_parts),
    }
    if args.derived_from:
        entry["derived_from"] = args.derived_from
        entry["derived_from_files"] = derived_from_files

    upsert_entry(manifest, entry)
    save_manifest(args.manifest, manifest)
    LOG.info("adopted %s (%d files) from listing %s", entry["id"], len(selected), args.listing)
    return 0


# --------------------------------------------------------------------------
# verify / import-listing
# --------------------------------------------------------------------------


def parse_listing(text: str) -> dict[str, str]:
    """Parse `<sha256>  <relpath>` lines; tolerant of CRLF and `\\` separators."""
    result: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip("\r\n").strip()
        if not line:
            continue
        m = re.match(r"^([0-9a-fA-F]{64})\s+(.+)$", line)
        if not m:
            continue
        sha, relpath = m.group(1), m.group(2).strip()
        relpath = relpath.replace("\\", "/")
        if relpath.startswith("./"):
            relpath = relpath[2:]
        result[relpath.lower()] = sha.lower()
    return result


def hash_directory(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            result[rel.lower()] = sha256_file(p)
    return result


def cmd_check_path(args: argparse.Namespace) -> int:
    """Cheap membership+status+size gate -- the keepalive's per-respawn check.

    No hashing. `PATH` may be a Windows path; matched by normalized relative
    path or by basename against any `verified` entry's `files[]` whose
    `verified_on` includes `--host`. `--id` restricts the search to one
    artifact (e.g. a runtime entry, `llama.cpp@b10078`). `--size`, when
    given, must equal the manifested size (TOCTOU narrowing for the
    keepalive, not a substitute for `verify`).
    """
    manifest = load_manifest(args.manifest)
    target = args.path.replace("\\", "/")
    target_lower = target.lower()
    target_name = Path(target).name.lower()
    host = args.host

    artifacts = manifest.get("artifacts", [])
    if args.id:
        artifacts = [a for a in artifacts if a.get("id") == args.id]
        if not artifacts:
            raise ProvenanceError(f"no manifest entry with id {args.id!r}")

    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for entry in artifacts:
        if entry.get("status") != "verified":
            continue
        if host not in entry.get("verified_on", []):
            continue
        for f in entry.get("files", []):
            fp = f.get("path", "")
            if fp.startswith("zip:"):
                continue
            fp_norm = fp.replace("\\", "/").lower()
            local_norm = (f.get("local_path") or "").replace("\\", "/").lower()
            matched = fp_norm == target_lower or fp_norm.rsplit("/", 1)[-1] == target_name
            matched = matched or (
                local_norm and (local_norm == target_lower or local_norm.rsplit("/", 1)[-1] == target_name)
            )
            if matched:
                candidates.append((entry, f))

    if not candidates:
        raise ProvenanceError(
            f"not manifested / unverified / not verified on host {host!r}: {args.path}"
        )

    if args.size is not None:
        sized = [(e, f) for e, f in candidates if f.get("size") == args.size]
        if not sized:
            manifested_sizes = sorted({f.get("size") for _, f in candidates})
            raise ProvenanceError(
                f"size mismatch for {args.path}: manifested {manifested_sizes}, got {args.size}"
            )
        candidates = sized

    if len(candidates) > 1:
        shas = {f.get("sha256") for _, f in candidates}
        if len(shas) > 1:
            ids = sorted({e["id"] for e, _ in candidates})
            raise ProvenanceError(
                f"ambiguous match for {args.path}: candidate artifacts {ids} have "
                "different content (different sha256) for the same basename/size. "
                "Sanctioned next step: pass --id to disambiguate."
            )
        # Same content under every candidate id (e.g. a retro-match alias
        # alongside a fresh fetch) -- accept, preferring the most recently
        # verified entry.
        candidates = sorted(candidates, key=lambda ef: ef[0].get("verified_at") or "", reverse=True)

    matched_entry, _ = candidates[0]
    if args.print_id:
        print(matched_entry["id"])
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)

    listing = getattr(args, "listing", None)
    root = getattr(args, "root", None)
    if not listing and not root:
        raise ProvenanceError("verify requires --root or --listing")

    entry_id = getattr(args, "id", None)
    select_all = getattr(args, "all", False)
    if not entry_id and not select_all:
        raise ProvenanceError("verify requires --id or --all")

    entries = _select_entries(manifest, entry_id, select_all)
    if not entries:
        raise ProvenanceError(f"no manifest entries matched (id={entry_id!r})")

    if listing:
        got = parse_listing(Path(listing).read_text())
    else:
        got = hash_directory(Path(root))

    host = getattr(args, "host", None) or "mac"
    # --allow-missing GLOB: a member the host legitimately lacks (e.g. a CPU-variant
    # DLL Defender quarantined out of a verified llama.cpp tree). Recorded on the
    # entry as missing_on_host[host] so the gap is in the manifest, not in someone's
    # head; never applies to a MISMATCH.
    allow_missing = list(getattr(args, "allow_missing", None) or [])
    overall_bad = False
    for entry in entries:
        entry_bad = False
        allowed_gaps: list[str] = []
        for f in entry.get("files", []):
            path = f["path"]
            if path.startswith("zip:"):
                continue
            # Adopted entries (cmd_adopt) record the HF path in `path` but
            # the on-disk name in `local_path` -- verify against whichever
            # one is actually the served filename.
            disk_path = f.get("local_path") or path
            key = disk_path.replace("\\", "/").lower()
            actual = got.get(key)
            if actual is None:
                if any(fnmatch.fnmatch(disk_path, g) or fnmatch.fnmatch(path, g) for g in allow_missing):
                    print(f"MISSING(allowed) {entry['id']} {path}")
                    allowed_gaps.append(path)
                    continue
                print(f"MISSING {entry['id']} {path}")
                entry_bad = True
            elif actual != f["sha256"].lower():
                print(f"MISMATCH {entry['id']} {path}")
                entry_bad = True
            else:
                print(f"OK {entry['id']} {path}")
        if entry_bad:
            overall_bad = True
        else:
            vo = entry.setdefault("verified_on", [])
            if host not in vo:
                vo.append(host)
            entry["verified_at"] = utc_now_iso()
            moh = entry.setdefault("missing_on_host", {})
            if allowed_gaps:
                moh[host] = sorted(allowed_gaps)
            else:
                moh.pop(host, None)
            if not moh:
                entry.pop("missing_on_host", None)

    save_manifest(args.manifest, manifest)
    return 2 if overall_bad else 0


# --------------------------------------------------------------------------
# list
# --------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    artifacts = manifest.get("artifacts", [])
    if args.json:
        print(json.dumps(artifacts, indent=2))
        return 0

    header = ("id", "kind", "source", "trust_tier", "verified_on", "verified_at", "files")
    rows = [header]
    for a in artifacts:
        src = a.get("source", {})
        src_str = src.get("repo", "")
        if src.get("asset"):
            src_str += f"@{src['asset']}"
        rows.append(
            (
                a.get("id", ""),
                a.get("kind", ""),
                src_str,
                a.get("trust_tier", ""),
                ",".join(a.get("verified_on", [])),
                a.get("verified_at") or "",
                str(len(a.get("files", []))),
            )
        )
    widths = [max(len(r[i]) for r in rows) for i in range(len(header))]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    """`list` plus, for each `--served PATH`, whether check-path (host=box) passes."""
    cmd_list(args)
    if not args.served:
        return 0
    ok = True
    for path in args.served:
        check_args = argparse.Namespace(
            manifest=args.manifest, path=path, host="box", size=None, id=None, print_id=False
        )
        try:
            cmd_check_path(check_args)
            print(f"SERVED OK (host=box): {path}")
        except ProvenanceError as exc:
            print(f"SERVED FAIL (host=box): {path} -- {exc}")
            ok = False
    return 0 if ok else 1


# --------------------------------------------------------------------------
# hf-meta
# --------------------------------------------------------------------------


def cmd_hf_meta(args: argparse.Namespace) -> int:
    headers = build_hf_headers()
    meta = fetch_hf_model_meta(args.hf_base, args.repo_id, args.revision, headers)
    sha = meta.get("sha")
    tree = fetch_hf_tree(args.hf_base, args.repo_id, sha, headers)
    tree_by_path = {e["path"]: e for e in tree}
    files = []
    for s in meta.get("siblings", []):
        path = s["rfilename"]
        lfs = s.get("lfs") or {}
        sec = (tree_by_path.get(path) or {}).get("securityFileStatus")
        files.append(
            {
                "path": path,
                "sha256": lfs.get("sha256"),
                "size": s.get("size"),
                "security": _security_summary(sec),
            }
        )
    print(json.dumps({"repo": args.repo_id, "sha": sha, "files": files}, indent=2))
    return 0


# --------------------------------------------------------------------------
# match
# --------------------------------------------------------------------------


def cmd_match(args: argparse.Namespace) -> int:
    """Find which commit(s) of an HF repo published given sha256 content.

    Walks /commits/main (paginated, newest-first) and, for each commit,
    /tree/{commit}?recursive=true&expand=true (paginated) looking for a
    file whose LFS oid equals a requested sha256. Since commits are visited
    newest-first, the FIRST commit a hash is seen in during the walk is
    already the NEWEST one that published it -- that is what gets printed
    per hash (the most recent revision you could still re-fetch that exact
    content from). When more than one hash is requested (`--listing`), a
    final COMMON line reports the newest single revision whose tree
    contains ALL matched hashes simultaneously, if any -- real repos
    (ggml-org/gpt-oss-120b-GGUF) delete multi-shard files one at a time
    across several commits, so each shard's own newest-occurrence commit
    can differ from the newest commit that still had the whole set.
    """
    headers = build_hf_headers()
    targets: set[str] = {h.lower() for h in (args.sha256 or [])}
    if args.listing:
        targets |= set(parse_listing(Path(args.listing).read_text()).values())
    if not targets:
        raise ProvenanceError("match requires --sha256 (repeatable) and/or --listing")

    found: dict[str, tuple[str, str, str] | None] = {t: None for t in targets}
    common_commit: tuple[str, str] | None = None
    commits = fetch_hf_commits(args.hf_base, args.repo, headers)
    for commit in commits:
        commit_sha = commit.get("id") or commit.get("sha") or ""
        if not commit_sha:
            continue
        date = commit.get("date", "")
        tree = fetch_hf_tree(args.hf_base, args.repo, commit_sha, headers, recursive=True)
        present_here: set[str] = set()
        for entry in tree:
            lfs = entry.get("lfs") or {}
            oid = (lfs.get("oid") or "").lower()
            if oid and oid in targets:
                present_here.add(oid)
                if found[oid] is None:
                    found[oid] = (entry.get("path", ""), commit_sha, date)
        if common_commit is None and present_here == targets:
            common_commit = (commit_sha, date)

    all_matched = True
    for sha, hit in found.items():
        if hit:
            path, commit_sha, date = hit
            print(f"{sha} -> {path} @ {args.repo}@{commit_sha} ({date})")
        else:
            print(f"{sha} -> NO MATCH")
            all_matched = False

    if len(targets) > 1:
        if common_commit:
            commit_sha, date = common_commit
            print(f"COMMON: all {len(targets)} hashes present @ {args.repo}@{commit_sha} ({date})")
        else:
            print(f"COMMON: no single revision contains all {len(targets)} matched hashes")

    return 0 if all_matched else 1


# --------------------------------------------------------------------------
# drift
# --------------------------------------------------------------------------


def cmd_drift(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    all_artifacts = manifest.get("artifacts", [])
    if not args.id and not all_artifacts:
        # Genuine bootstrap state (RDR item 5/9): an empty manifest is not
        # an error, and CI runs `drift --all` on exactly this shape on the
        # PR that lands the tool before any entries exist. Non-vacuity only
        # kicks in once there is something that COULD have been checked.
        print("checked=0 skipped=0 (manifest empty)")
        return 0
    entries = _select_entries(manifest, args.id, args.all or not args.id)
    if not entries:
        raise ProvenanceError("no manifest entries matched for drift check")

    headers = build_hf_headers()
    bad = False
    checked = 0
    skipped = 0

    for entry in entries:
        entry_checked = False
        host = (entry.get("source") or {}).get("host")

        if entry["kind"] == "model" and host == "huggingface":
            repo = entry["source"]["repo"]
            sha = entry["source"]["revision"]
            meta = fetch_hf_model_meta(args.hf_base, repo, sha, headers)
            siblings = {s["rfilename"]: s for s in meta.get("siblings", [])}
            tree = fetch_hf_tree(args.hf_base, repo, sha, headers)
            tree_by_path = {e["path"]: e for e in tree}
            for f in entry.get("files", []):
                sib = siblings.get(f["path"])
                if not sib:
                    print(f"DRIFT {entry['id']} {f['path']}: no longer present upstream")
                    bad = True
                    entry_checked = True
                    continue
                lfs = sib.get("lfs") or {}
                remote_sha256 = lfs.get("sha256")
                if remote_sha256:
                    entry_checked = True
                    if remote_sha256.lower() != f["sha256"].lower():
                        print(f"DRIFT {entry['id']} {f['path']}: sha256 mismatch")
                        bad = True
                    else:
                        print(f"OK {entry['id']} {f['path']}")
                else:
                    print(f"SKIP {entry['id']} {f['path']}: non-LFS, metadata carries no sha256")
                sec = (tree_by_path.get(f["path"]) or {}).get("securityFileStatus")
                if security_blocks(sec):
                    print(f"SECURITY {entry['id']} {f['path']}: upstream scan now flags this file: {_security_summary(sec)}")
                    bad = True
                    entry_checked = True
        elif entry["kind"] == "runtime" and host == "github":
            repo = entry["source"]["repo"]
            tag = entry["source"]["revision"]
            asset = entry["source"]["asset"]
            url = f"{args.gh_base}/{repo}/releases/download/{tag}/{asset}"
            with tempfile.TemporaryDirectory() as td:
                tmp_zip = Path(td) / asset
                remote_sha, _ = download_to_path(url, tmp_zip, {})
            entry_checked = True
            zip_entry = next((f for f in entry.get("files", []) if f["path"] == f"zip:{asset}"), None)
            if not zip_entry:
                print(f"DRIFT {entry['id']}: no zip: entry recorded")
                bad = True
            elif zip_entry["sha256"].lower() != remote_sha.lower():
                print(f"DRIFT {entry['id']} zip:{asset}: sha256 mismatch")
                bad = True
            else:
                print(f"OK {entry['id']} zip:{asset}")
        else:
            print(f"SKIP {entry['id']}: kind={entry.get('kind')!r} host={host!r} has no upstream to re-fetch directly")

        derived_from = entry.get("derived_from")
        if derived_from:
            parsed = _derived_from_repo_sha(derived_from)
            if parsed is None:
                entry_checked = True
                if any(a.get("id") == derived_from for a in all_artifacts):
                    print(f"OK {entry['id']}: derived_from {derived_from!r} still present")
                else:
                    print(f"DRIFT {entry['id']}: derived_from manifest id {derived_from!r} no longer exists")
                    bad = True
            else:
                repo, sha = parsed
                stored = entry.get("derived_from_files") or []
                if not stored:
                    print(f"SKIP {entry['id']}: derived_from {derived_from!r} has no derived_from_files recorded")
                else:
                    try:
                        current = resolve_derived_from_files(args.hf_base, repo, sha, headers)
                    except ProvenanceError as exc:
                        print(f"DRIFT {entry['id']}: could not re-fetch derived_from metadata: {exc}")
                        bad = True
                        entry_checked = True
                    else:
                        entry_checked = True
                        current_by_path = {c["path"]: c for c in current}
                        for sf in stored:
                            cf = current_by_path.get(sf["path"])
                            if not cf:
                                print(f"DRIFT {entry['id']} derived_from:{sf['path']}: no longer present upstream")
                                bad = True
                            elif sf.get("sha256") and cf.get("sha256") and sf["sha256"].lower() != cf["sha256"].lower():
                                print(f"DRIFT {entry['id']} derived_from:{sf['path']}: sha256 mismatch")
                                bad = True
                            else:
                                print(f"OK {entry['id']} derived_from:{sf['path']}")

        if entry_checked:
            checked += 1
        else:
            skipped += 1

    print(f"checked={checked} skipped={skipped}")
    if checked == 0 and len(entries) >= 1:
        raise ProvenanceError("drift checked nothing for the selected entries (non-vacuity failure)")
    return 1 if bad else 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--manifest", default=str(DEFAULT_MANIFEST_PATH))

    net = argparse.ArgumentParser(add_help=False)
    net.add_argument("--hf-base", default=os.environ.get("PROVENANCE_HF_BASE", DEFAULT_HF_BASE))
    net.add_argument("--gh-base", default=os.environ.get("PROVENANCE_GH_BASE", DEFAULT_GH_BASE))
    net.add_argument("--gh-api-base", default=os.environ.get("PROVENANCE_GH_API_BASE", DEFAULT_GH_API_BASE))

    allow = argparse.ArgumentParser(add_help=False)
    allow.add_argument("--allowlist", default=str(DEFAULT_ALLOWLIST_PATH))

    parser = argparse.ArgumentParser(prog="provenance.py", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("validate", parents=[common], help="validate models/MANIFEST.json against its schema")
    sp.add_argument("--schema", default=str(DEFAULT_SCHEMA_PATH))
    sp.set_defaults(func=cmd_validate)

    sp = sub.add_parser("fetch", parents=[common, net, allow], help="acquire a model from an allowlisted HF repo")
    sp.add_argument("repo_id")
    sp.add_argument("--revision")
    sp.add_argument("--dest")
    sp.add_argument("--allow-packager", action="store_true")
    sp.add_argument("--allow-remote-code", action="store_true")
    sp.add_argument("--include", action="append", default=[])
    sp.add_argument("--exclude", action="append", default=[])
    sp.add_argument("--id")
    sp.add_argument("--derived-from")
    sp.add_argument("--notes", default="")
    sp.add_argument("--dry-run", action="store_true")
    sp.set_defaults(func=cmd_fetch)

    sp = sub.add_parser("add-runtime", parents=[common, net, allow], help="register a GitHub release runtime asset")
    sp.add_argument("--tag", required=True)
    sp.add_argument("--asset")
    sp.add_argument("--repo", default="ggml-org/llama.cpp")
    sp.add_argument("--dest")
    sp.add_argument("--from-zip")
    sp.add_argument("--offline", action="store_true")
    sp.add_argument("--id")
    sp.add_argument("--notes", default="")
    sp.add_argument(
        "--overlay-dir", help="extracted llama-vulkan-patched.yml artifact dir (PATCHED-BUILD.txt + one replacement file)"
    )
    sp.add_argument("--overlay-repo", help="repo that built the overlay artifact; must be in allowlist overlay_repos")
    sp.add_argument("--overlay-run", help="GitHub Actions run id that produced the overlay artifact")
    sp.add_argument("--overlay-artifact", help="artifact name (default: ggml-vulkan-<tag>-patched)")
    sp.add_argument("--patch", help="patch file applied to build the overlay (e.g. scripts/ops/patches/<file>.patch)")
    sp.set_defaults(func=cmd_add_runtime)

    sp = sub.add_parser(
        "register",
        parents=[common, net],
        help="register a local self-quantized artifact (no upstream to compare)",
    )
    sp.add_argument("--id", required=True)
    sp.add_argument("--kind", default="model", choices=["model", "runtime"])
    sp.add_argument("--format", required=True, choices=["safetensors", "gguf", "mlx", "zip"])
    sp.add_argument("--trust-tier", default="self-quantized", choices=["origin", "packager", "self-quantized"])
    sp.add_argument("--derived-from", required=True)
    sp.add_argument("--quantized-by-tool")
    sp.add_argument("--quantized-by-version")
    sp.add_argument("--quantized-by-command")
    sp.add_argument("--root", required=True)
    sp.add_argument("--include", action="append", default=[])
    sp.add_argument("--notes", default="")
    sp.set_defaults(func=cmd_register)

    sp = sub.add_parser(
        "adopt",
        parents=[common, net, allow],
        help="record files already on a serving host (matched by hash) without downloading -- retro-manifest",
    )
    sp.add_argument("repo_id")
    sp.add_argument("--revision", required=True)
    sp.add_argument("--listing", required=True)
    sp.add_argument("--host", required=True)
    sp.add_argument("--allow-packager", action="store_true")
    sp.add_argument("--derived-from")
    sp.add_argument("--id")
    sp.add_argument("--notes", default="")
    sp.add_argument("--include", action="append", default=[])
    sp.set_defaults(func=cmd_adopt)

    sp = sub.add_parser("verify", parents=[common], help="re-hash local files against the manifest")
    sp.add_argument("--id")
    sp.add_argument("--all", action="store_true")
    sp.add_argument("--root")
    sp.add_argument("--listing")
    sp.add_argument("--host", default="mac")
    sp.add_argument("--allow-missing", action="append", default=[], metavar="GLOB",
                    help="tolerate (and record as missing_on_host) members absent on this host")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("import-listing", parents=[common], help="alias of verify --listing")
    sp.add_argument("--id", required=True)
    sp.add_argument("--listing", required=True)
    sp.add_argument("--host", required=True)
    sp.add_argument("--allow-missing", action="append", default=[], metavar="GLOB")
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser(
        "check-path",
        parents=[common],
        help="cheap membership+status+size gate (no hashing) -- what the keepalive calls per respawn",
    )
    sp.add_argument("path")
    sp.add_argument("--host", default="mac")
    sp.add_argument("--size", type=int)
    sp.add_argument("--id")
    sp.add_argument("--print-id", action="store_true")
    sp.set_defaults(func=cmd_check_path)

    sp = sub.add_parser("list", parents=[common], help="list manifest entries")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser(
        "status", parents=[common], help="list + optionally check specific served paths (check-path --host box)"
    )
    sp.add_argument("--json", action="store_true")
    sp.add_argument("--served", action="append", default=[])
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("hf-meta", parents=[net], help="print resolved sha + per-file hashes/security as JSON")
    sp.add_argument("repo_id")
    sp.add_argument("--revision")
    sp.set_defaults(func=cmd_hf_meta)

    sp = sub.add_parser("drift", parents=[common, net], help="compare manifest entries to current upstream")
    sp.add_argument("--all", action="store_true")
    sp.add_argument("--id")
    sp.set_defaults(func=cmd_drift)

    sp = sub.add_parser(
        "match",
        parents=[net],
        help="walk an HF repo's commit history to find which revision published a given sha256",
    )
    sp.add_argument("--repo", required=True)
    sp.add_argument("--sha256", action="append", default=[])
    sp.add_argument("--listing")
    sp.set_defaults(func=cmd_match)

    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("PROVENANCE_LOG_LEVEL", "WARNING"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    parser = build_parser()
    args = parser.parse_args(argv)
    func: Callable[[argparse.Namespace], int] = args.func
    try:
        rc = func(args)
    except ProvenanceError as exc:
        LOG.error(str(exc))
        return 1
    return rc if isinstance(rc, int) else 0


if __name__ == "__main__":
    sys.exit(main())
