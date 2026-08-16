---
name: provenance
description: Acquire, verify, and record model weights and llama.cpp runtimes for the qwen-stack under RDR-016 — pinned-revision fetch from an allowlisted origin, sha256 verification against upstream on the Mac AND the box, and an entry in models/MANIFEST.json. Use when the user types `/qwen-stack:provenance ...`, or asks to "download / get / pull / install a model", "put <model> on the box", "grab the new llama.cpp build", "verify the models", "is this GGUF legit", or anything else that would otherwise reach for `hf download`, `curl`, `ollama pull`, or `scp *.gguf`. Nothing gets served that is not in the manifest with a verified upstream hash.
argument-hint: fetch <owner/repo> [--revision sha] [--include glob] | add-runtime --tag bNNNNN | register ... | adopt <owner/repo> --revision sha --listing FILE --host box | verify --id <id> [--host mac|box] | ship --id <id> | check-path PATH | list | drift | match | status
allowed-tools: Bash, Read, Grep
---

# /qwen-stack:provenance

The only sanctioned way to get a model or a llama.cpp build onto a machine that
serves for this stack. Design of record: `docs/rdr/RDR-016-model-binary-provenance.md`;
runbook: `docs/MODEL_PROVENANCE.md`. Tool: `scripts/ops/provenance/provenance.py`
(Python 3 stdlib, runs on the Mac). Box side: `scripts/ops/win/*.ps1` (pure
PowerShell — box python is broken).

## Why this exists (read once)

Until 2026-08-15 nothing the stack served had ever been compared to its
upstream; the box's Defender log showed a heuristic hit on a llama.cpp DLL and
nobody could say whether the zip it came from was the real one (it was — but
that took a by-hand hash comparison to establish). The dangerous parts of the
model supply chain are: pickle-based formats (`.bin/.pt/.pth/.pkl/.ckpt` execute
code on load), `trust_remote_code` repos (arbitrary code at import), packager
repos that re-quantize **in place** under the same filename (unsloth did this to
`mmproj-BF16.gguf` between 2026-04-16 and 04-20), and a LAN copy nobody
re-hashed. The manifest + this workflow close all four.

## Rules (the tool enforces; you do not get to relax them)

1. **Origin allowlist** (`scripts/ops/provenance/allowlist.json`). Tier `origin`
   = model authors (Qwen, openai, …). Tier `packager` (unsloth, ggml-org,
   bartowski, mlx-community) needs `--allow-packager` and a `derived_from`.
   Anything else is refused — do not add to the allowlist inside a task; that
   is a PR with a reason.
2. **Prefer self-quantizing from origin safetensors** over taking a packager's
   GGUF. Record the output with `register --trust-tier self-quantized --derived-from <origin id> --quantized-by-tool/-version/-command`.
3. **Pinned revision.** The manifest stores a 40-hex commit sha, never `main`.
   Passing `--revision main` is fine — the tool resolves and records the sha.
4. **Formats.** `.safetensors` / `.gguf` only for weights. Pickle formats and
   archives are refused for the whole fetch. `.py` in the repo needs
   `--allow-remote-code` and gets listed in the entry.
5. **Verify on both ends.** `verified_on` must contain the host that serves the
   file. The Mac verifies at download; the box verifies after transfer via the
   PowerShell listing; the Mac imports the listing and stamps `box`.
6. **Never bulk-hash `D:\models` against a live mmap-served model.** The box's
   D: NVMe has surprise-removed under sustained read (2026-08-01/07/15) and
   takes llama-server with it. Announce a service window in
   `D:\claude-coordination\QWEN_SERVER_NEGOTIATION.md` or hash one file at a
   time while the served model is on `--no-mmap` (b10078 config).
7. **Escape hatch** `QWEN_PROVENANCE_ENFORCE=0` exists for the keepalive; using
   it is a logged, reviewable event, not a convenience.

## Sub-commands

### `fetch <owner/repo> [--revision REV] [--include GLOB ...] [--allow-packager] [--allow-remote-code] [--dry-run]`

Always start with `--dry-run`: it prints the resolved sha, the allow/deny
verdict per file, HF security-scan status, and what will be downloaded — show
that to the user before spending bandwidth on 50 GB.

```bash
python3 scripts/ops/provenance/provenance.py fetch Qwen/Qwen3.8-27B --dry-run
python3 scripts/ops/provenance/provenance.py fetch Qwen/Qwen3.8-27B \
    --dest "/Volumes/Transcend Hell/hf-cache/provenance/Qwen__Qwen3.8-27B"
# GGUF from a packager, one quant only:
python3 scripts/ops/provenance/provenance.py fetch unsloth/Qwen3.6-35B-A3B-GGUF \
    --allow-packager --include '*UD-Q8_K_XL*' --include 'mmproj-BF16.gguf' \
    --derived-from Qwen/Qwen3.6-35B-A3B@<sha>
```

Downloads go to the external disk (`/Volumes/Transcend Hell/hf-cache/...`),
never the internal SSD (CLAUDE.md). On success the entry is appended to
`models/MANIFEST.json` with `verified_on: ["mac"]`. Any hash mismatch deletes
the file and leaves the manifest untouched — report that verbatim, do not retry
in a loop.

### `add-runtime --tag bNNNNN [--asset NAME]`

llama.cpp Windows release zip from `ggml-org/llama.cpp`, hashed as a whole and
per member. `--from-zip PATH` registers an already-downloaded zip and (unless
`--offline`) re-downloads to prove it matches.

### `adopt <owner/repo> --revision SHA --listing FILE --host box [--allow-packager --derived-from REF] [--id ID]`

For files that were ALREADY on a host before this protocol. Hash the host tree
in a service window (`Get-ProvenanceListing.ps1`), run `match --repo … --listing`
to learn which historical revision published those hashes, then `adopt` at that
sha: it records the files matched **by sha256, not filename** (`local_path`
keeps the on-disk name), no download, `verified_on: [box]`. This is how the
2026-08-15 retro entries (Coder-Next, Qwen3.6, gpt-oss) were made.

### `ship --id <id>` (procedure, not a subcommand — three steps)

1. Transfer with the marker so the hook lets it through:
   `PROVENANCE_TRANSFER=1 scp "<local file>" qwentescence:D:/models/<subdir>/`
2. On the box, produce a listing (this is a read of ONLY the new files, not
   the whole tree):
   `ssh qwentescence powershell -NoProfile -ExecutionPolicy Bypass -File D:\claude-coordination\Get-ProvenanceListing.ps1 -Root D:\models\<subdir> -Out C:\Users\sam\<id>.listing`
   then `scp qwentescence:C:/Users/sam/<id>.listing ./`
3. Import: `python3 scripts/ops/provenance/provenance.py verify --id <id> --listing <id>.listing --host box`
   → stamps `verified_on: ["mac","box"]`. Only now may the keepalive serve it.

### `verify --id <id> --root DIR --host mac` / `verify --all` / `verify --listing FILE --host box [--allow-missing GLOB]`

Re-hash locally, or import a host listing. Use after anything touched the
files (disk event, move, suspected corruption). `--allow-missing GLOB`
tolerates a member the host legitimately lacks (a Defender-quarantined DLL) and
records it on the entry as `missing_on_host`; it never excuses a MISMATCH.

### `check-path PATH --host box [--size N] [--id ID] [--print-id]`

The cheap gate the keepalive calls per respawn (no hashing): the path must
match a `status: verified` entry verified on that host, with that byte length.
Ambiguous matches (two entries, same basename+size, different sha256) fail
closed — pass `--id`. The keepalive pins `CODER_MANIFEST_ID` for exactly this.

### `list [--json]` / `drift --all` / `status --served PATH ...` / `match`

`list` = the manifest as a table. `drift --all` = re-fetch upstream metadata at
the pinned revisions (and `derived_from_files`) and compare — what CI runs;
prints `checked=N skipped=M`. `status --served <path> ...` = `list` plus
whether each served path (the `CODER_MODEL`/`LL` values in
`scripts/ops/keepalive-coprocessor.sh`) passes `check-path` for `box`; anything
failing is a red flag. `match --repo owner/repo --listing FILE` = for files
acquired before this RDR, find which historical revision published each
sha256 (packagers re-quantize in place; a miss against `main` is not final).

## Landing a new model end to end (the acceptance path)

fetch (dry-run → real) → optional self-quantize (`convert_hf_to_gguf.py` +
`llama-quantize`, then `register` with `--derived-from` + `--quantized-by-*`) →
`ship` → keepalive `CODER=`/`VISION=` line update → **arch probe** (load + one
real generation on the box build before pooling — CLAUDE.md rule) →
`scripts/shakeout.py` → backend config. Commit the manifest change with the
bead reference; CI re-checks drift.

## What to say when refused

Quote the tool's message. Do not work around it with `curl`, `hf download`,
`ollama pull`, or by editing the manifest by hand — the PreToolUse hook denies
those and the reason is the same one the tool gave. If the allowlist is the
blocker, that is a decision for the human: state which owner, which tier, why.
