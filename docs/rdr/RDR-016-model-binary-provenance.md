---
title: "Model and runtime provenance — pinned-source fetch, hash-verified lineage, a committed manifest, and hooks/skills that make the unverified path the hard path"
id: RDR-016
type: Design
status: accepted
priority: high
author: hal
reviewed-by: self (substantive-critic x3, code-review-expert x2)
created: 2026-08-15
accepted_date: 2026-08-15
closed_date:
close_reason:
related_issues: [qwen-coprocessor-stack-tij, qwen-coprocessor-stack-c9w, qwen-coprocessor-stack-gom, qwen-coprocessor-stack-mkw, qwen-coprocessor-stack-4ed, qwen-coprocessor-stack-qdz, qwen-coprocessor-stack-f19, qwen-coprocessor-stack-rkn, qwen-coprocessor-stack-651, qwen-coprocessor-stack-ugz, qwen-coprocessor-stack-r28]
---

# RDR-016: Model and runtime provenance

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Accepted (2026-08-15; gate PASSED after one BLOCKED round folded in — T2 `RDR-016-gate-latest`).** Triggered by an audit of the Windows Defender log on
`qwentescence` (T2 `box-defender-detections-audit-2026-08-15`). Two lifetime
detections, neither a model file — a `!ml` heuristic on a llama.cpp CPU-variant
DLL (`D:\llama-b9596\ggml-cpu-ivybridge.dll`, since proven byte-identical to the
ggml-org GitHub release asset) and a heuristic on our own PowerShell diagnostic.
The finding that matters is not the detections; it is that **the b9596 hash
check on 2026-08-15 was the first time anything we serve had been compared to
its upstream**, and that **no model file on the box has ever been verified
against its Hugging Face LFS sha256**. We have been trusting whatever landed on
disk. Qwen3.8-27B (released 2026-08-14) is the first artifact that will be
acquired under this RDR.

## Problem Statement

The stack serves large binary artifacts we did not build — model weights
(tens of GB, from Hugging Face) and inference runtimes (llama.cpp Windows
release zips from GitHub, MLX wheels via pip) — on two machines, one of which
(the box) cannot download from CDNs directly, so artifacts are downloaded on the
Mac and pushed over the LAN. Today:

- **Origin is whatever repo the operator happened to type.** Third-party GGUF
  re-uploads (unsloth, bartowski, random users) are indistinguishable from the
  model author's repo in the operational record; there is no allowlist.
- **Revision is `main`.** HF repos get force-pushed and re-quantized in place;
  the same filename can be a different tensor set a week later.
- **Nothing is hash-verified.** `hf download` checks etag/size, not content.
  Nothing re-verifies after the LAN copy. The b10078 tree on the box was
  verified against GitHub for the first time on 2026-08-15 (all 52 files
  identical) — by hand.
- **No lineage record.** Which llama.cpp build produced which quant from which
  safetensors revision is not written down anywhere the keepalive or a future
  session can consult.
- **The dangerous formats are not refused.** Nothing stops a `.bin`/`.pt`/`.ckpt`
  (pickle — arbitrary code on load) or a `trust_remote_code=True` repo from
  being pulled and loaded; only convention does.
- **The unverified path is the easy path.** `hf download X` is one line; the
  careful procedure is a paragraph in someone's head.

The threat model is ordinary supply-chain risk, not a targeted adversary:
a poisoned or trojaned re-upload, a hijacked packager account, a force-pushed
revision, a corrupt LAN copy, and — most likely of all — us serving something
we cannot later account for.

## Context

- **Both machines' constraints.** Box curl stalls on unranged HTTPS GETs to
  HF/GitHub CDNs (CLAUDE.md), so the Mac is the only download point and the box
  is a *receiver*; box python is currently broken (uv trampoline), so box-side
  verification must be pure PowerShell (`Get-FileHash`). Mac has Python 3.13
  and `hf` 1.18.
- **What HF exposes.** The model API with `files_metadata=true` (or the
  `/tree/{revision}?expand=true` endpoint) returns per-file `lfs.sha256` for LFS
  blobs, git blob ids for small files, the resolved commit `sha`, and per-file
  security scan status (ClamAV + Protect AI Guardian) where a scan has run.
  That is enough for content verification and revision pinning without any
  extra tooling.
- **What GitHub exposes.** ggml-org/llama.cpp releases publish assets but no
  checksum files; verification is "download the same asset again from GitHub
  and compare" — cheap (~40 MB) and what we did by hand on 2026-08-15.
- **Formats.** `.safetensors` and `.gguf` are passive tensor containers (no
  code on load; a parser bug in the loader is the residual risk). Pickle-based
  formats (`.bin`, `.pt`, `.pth`, `.pkl`, `.ckpt`) execute code on load and are
  the actual malware vector for model files. `.py` in a repo means
  `trust_remote_code`, i.e. arbitrary code at import.
- **Existing operational surface.** Keepalive (`scripts/ops/keepalive-coprocessor.sh`)
  launches models by path and already writes `write_state()` metadata per
  respawn; the `qwen-stack` plugin already carries skills
  (`plugins/qwen-stack/skills/*`) but no hooks; CI is `ci.yml` + `release.yml`
  with cost discipline rules (path filters, concurrency groups, no premium
  runners for routine work).
- **Prior art in-house.** The nexus marketplace "pinned-source release model"
  (T2 `global_directives/marketplace-pinned-source-release-model`) — same idea:
  a consumer only ever points at an immutable, verified revision.

## Decision

Make provenance a **recorded, verified, enforced property** of every model and
runtime artifact the stack serves, and make the tooling the path of least
resistance so the unverified path is the one that takes effort.

### In scope

1. **A provenance tool** (`scripts/ops/provenance/provenance.py`, Python 3
   stdlib only, runs on the Mac) with subcommands:
   - `fetch` — download from an allowlisted origin, at a resolved **commit
     sha** (a `main` argument is resolved and *recorded* as the sha; the
     manifest never contains a branch name), restricted to an **allowed file
     set** (`.safetensors`, `.gguf`, tokenizer/config/template text files),
     **refusing** pickle formats and archives outright, **refusing** any repo
     containing `*.py` unless `--allow-remote-code` is passed (and then
     listing every such file in the manifest entry), then **verifying every
     downloaded file** against HF's `lfs.sha256` / git blob id, recording HF
     security-scan status per file across all five HF sub-scans (avScan,
     protectAiScan, pickleImportScan, virusTotalScan, jFrogScan — any
     unsafe/suspicious/caution verdict blocks; absent scan is recorded as
     `unscanned`, not treated as clean), rejecting any `rfilename` that is
     absolute or escapes the destination (`..`, backslash, NUL), and
     appending a manifest entry.
   - `add-runtime` — the same for a GitHub release asset (llama.cpp zip):
     download from `ggml-org/llama.cpp` at the tagged release, hash the zip
     and every member, record.
   - `verify` — re-hash local files (a directory on the Mac, or a hash listing
     produced by the box-side script) against the manifest; exit non-zero on
     any mismatch or on any served-path not present in the manifest.
   - `hash-listing` / `import-listing` — the LAN round-trip: the box-side
     PowerShell script produces `sha256  relpath` lines; the Mac imports them
     and stamps `verified_on: ["mac","box"]`.
   - `list` — what is manifested, where, verified when.
   - `register` — hash a locally produced artifact (self-quantized GGUF/MLX)
     and record it with `derived_from` + `quantized_by`.
   - `match` — walk an HF repo's commit history to find which revision(s)
     published a given sha256 (retro-manifest of files acquired before this
     RDR; packagers re-quantize in place).
   - `adopt` — record files that ALREADY exist on a serving host (the
     retro-manifest case): match the host's hash listing against an
     allowlisted repo at a pinned revision **by LFS sha256, not filename**
     (the on-disk name may differ; recorded as `local_path`), no download;
     `verified_on: [<host>]` only.
   - `verify --allow-missing GLOB` — tolerate a member the host legitimately
     lacks (Defender quarantined `ggml-cpu-ivybridge.dll` out of the
     verified b9596 tree); the gap is recorded on the entry as
     `missing_on_host[host]` so it lives in the manifest, not in someone's
     head. It never excuses a MISMATCH.
   - `check-path` — the keepalive's cheap gate: is this path a `verified`,
     `verified_on: box` file with this byte length? No hashing.
   - `drift` — re-fetch upstream metadata/assets at the pinned revisions and
     compare (CI); prints `checked=N skipped=M`, non-vacuous.
2. **A committed manifest** `models/MANIFEST.json` validated by
   `models/manifest.schema.json` (JSON Schema draft-07, validated by a stdlib
   validator — no dependency). One entry per artifact: `id`, `kind`
   (`model` | `runtime`), `source` (`host`, `repo`, `revision` — full sha or
   release tag, `asset`), `files[]` (`path`, `sha256`, `size`, `hf_security`),
   `format`, `trust_tier` (`origin` | `packager` | `self-quantized`),
   `status` (`verified` — hash matched upstream, or locally hashed for
   `self-quantized` | `unverified` — recorded, no upstream match; never
   servable), `derived_from` (a manifest id, or `owner/repo@sha` of the origin
   weights), **`derived_from_files[]`** (the origin weight files' `path`,
   `sha256`, `size` captured from HF metadata at that sha — no download — so
   lineage is *re-checkable*, not a bare pointer), `quantized_by` (`tool`,
   `version`, `command`) when self-quantized, `verified_at`, `verified_on[]`,
   `notes`.
3. **An origin allowlist** (`scripts/ops/provenance/allowlist.json`), two
   tiers: **origin** (model authors: `Qwen`, `openai`, `zai-org`, `moonshotai`,
   `deepseek-ai`, …) and **packager** (`unsloth`, `ggml-org`, `bartowski`,
   `mlx-community`). Anything not listed is refused. Packager repos require
   `--allow-packager` and a `derived_from` origin reference; the recommended
   path is **self-quantize** from origin safetensors (`convert_hf_to_gguf.py`
   / `llama-quantize` on the Mac, `mlx_lm.convert` for MLX), which removes the
   third-party-GGUF trust class and is recorded via `quantized_by`.
4. **Box-side verification** — `scripts/ops/win/Get-ProvenanceListing.ps1`
   (pure PowerShell): hash a tree, emit the listing; and
   `scripts/ops/win/Test-Provenance.ps1`: given a manifest and a root, verify
   in place and exit non-zero on mismatch. Both copied to
   `D:\claude-coordination\` alongside the existing coordination files.
5. **Keepalive enforcement** — before launching a model, the keepalive checks
   the model path (and mmproj) is a manifested file with `status: verified`
   and `verified_on` including `box`, **and that the box file's current byte
   length equals the manifested `size`** (`provenance.py check-path PATH
   --host box --size N`, N read via a one-line PowerShell `(Get-Item).Length`);
   refuses to launch otherwise (`QWEN_PROVENANCE_ENFORCE=0` is the documented
   escape hatch, logged on every launch it bypasses). `write_state()` records
   the manifest ids of the model and the runtime being served. This is
   deliberately NOT a re-hash per respawn (50–100 GB per launch is not
   acceptable) — so it has a TOCTOU window: a file replaced in place after
   box verification with identical length would launch. Accepted, because an
   adversary who can rewrite `D:\models` already owns the box; what the check
   closes is the accidental class (wrong file, partial copy, silent
   re-download, stale quant). Full re-hash is `verify`, run on demand, after
   every LAN copy, and after any D: disk event (see F6). Enforcement is
   **blocked on the retroactive manifest landing** (bead dependency, not
   prose): the current serving paths must be `verified_on: box` before the
   check is turned on, else the first respawn takes production down. Belt
   and braces in the mechanism itself: an **empty** manifest is the bootstrap
   state — the gate stays UNARMED (launches, logs "unarmed" every launch)
   until the manifest has ≥1 artifact, so the keepalive script and the
   manifest can land in the same PR without a refuse-on-restart window; the
   retro entries (runtime + Coder-Next, box-verified) are added in one
   commit so the gate arms complete. Only a well-formed manifest with zero
   artifacts is "empty" — a missing/malformed manifest or a missing `python3`
   is a gate failure (refuse), never bootstrap. The keepalive pins the model's
   manifest id (`CODER_MANIFEST_ID`) so two entries sharing a basename+size
   (a re-quantized packager file next to its predecessor) cannot satisfy the
   gate ambiguously; `check-path` itself fails closed on ambiguity unless all
   candidates share one sha256. The runtime leg passes the box byte length of
   `llama-server.exe` the same way.
6. **Retroactive manifest** — every model file currently on the box
   (`D:\models\**`) and the two llama.cpp trees (`b9596` verified 2026-08-15,
   `b10078` verified 2026-08-15) get entries. Model files: identify the
   upstream repo (unsloth GGUFs, ggml-org gpt-oss GGUF), pull LFS sha256s,
   hash on the box, compare. **Packagers re-quantize in place under the same
   filename**, so a mismatch against the repo's current `main` is expected,
   not final: the tool's `match` walks the repo's commit history and matches
   the file's sha256 against every historical revision's LFS oid; a hit is
   recorded as "matches `<repo>@<sha>` (as of `<commit date>`, not current
   main)" with that sha pinned. Only a file that matches **no** revision of an
   allowlisted repo is recorded as `unverified` — and is not servable under
   enforcement. That is the correct outcome, not a gap to paper over: the
   remedy is to re-acquire it through `fetch` in an announced service window
   before enforcement is switched on (the bead dependency guarantees the
   order). Known at write time (F3): the mmproj on the box matches
   `lmstudio-community` (not on the allowlist) by name and size — expect it to
   land `unverified` unless the allowlist decision is taken explicitly.
7. **Hooks** in the `qwen-stack` plugin (`plugins/qwen-stack/hooks/hooks.json`
   + `hooks/provenance-guard.sh`), `PreToolUse` on `Bash`:
   - **block** raw acquisition that bypasses the tool: `hf download`,
     `huggingface-cli download`, `snapshot_download(`/`hf_hub_download(`,
     `ollama pull`, `git clone …huggingface.co…`, `curl`/`wget` against
     `huggingface.co` or `github.com/*/releases/download`, `gh release
     download` of llama.cpp assets, and `scp`/`rsync` of `.gguf`/`.safetensors`
     toward the box — with a message naming the sanctioned command;
   - **block** loading pickle formats (`--model *.bin|.pt|.pth|.pkl|.ckpt`,
     `torch.load(` without `weights_only=True`) and `trust_remote_code=True`;
   - the hook is a deny-list on the command string; the tool itself is the
     positive path. It is registered twice on purpose — in the plugin
     (`hooks/hooks.json`, ships at the next plugin release) and in the repo's
     `.claude/settings.json` (live now for sessions in this checkout); when
     both are active a Bash call is evaluated twice, which is harmless
     (deny∨deny) and cheap. `provenance.py fetch` is invoked *through* the hook (it is
     a `python3 scripts/ops/provenance/provenance.py …` command, not a
     blocked pattern).
8. **A skill** `plugins/qwen-stack/skills/provenance/SKILL.md`
   (`/qwen-stack:provenance fetch|verify|list|add-runtime|status`) that
   carries the workflow, the rules, and the "why", so an agent that is asked
   "get Qwen3.8-27B onto the box" runs the sanctioned sequence: fetch on Mac
   → verify → scp → box listing → import → keepalive picks it up.
9. **CI** — `provenance.yml`: on PRs touching `models/**` or
   `scripts/ops/provenance/**` (path-filtered, concurrency-grouped, ubuntu
   only): validate manifest against schema, run the tool's unit tests, and
   **upstream drift check** — for every `model` entry re-fetch HF file
   metadata at the pinned revision and compare sha256s to the manifest
   (metadata-only, no weight downloads); for every `runtime` entry re-download
   the GitHub asset (~40 MB) and compare; for entries with `derived_from`
   re-check `derived_from_files` the same way (metadata only). `drift` prints
   `checked=N skipped=M` and **fails if it checked nothing while the manifest
   is non-empty** (non-vacuity — CLAUDE.md gate rule). `workflow_dispatch`
   for on-demand. No schedule (cost discipline; drift is checked when the
   manifest changes, and on demand).
10. **Documentation and memory** — `docs/MODEL_PROVENANCE.md` (the protocol,
    the threat model, the runbook), a CLAUDE.md section, README pointer; T2
    `bd remember` protocol summary; T3 `store_put` of the protocol as
    cross-project knowledge; auto-memory feedback entry.

### Out of scope

- Cryptographic signatures / Sigstore attestation of our own quants (HF and
  ggml-org do not sign; we would only be signing our own hashes — the manifest
  in git already gives that, with git history as the audit log). Revisit if
  HF ships model signing.
- Sandboxing `llama-server` itself on the box (Windows job objects / AppContainer).
  Different RDR; residual loader-parser risk is accepted.
- Refuse-to-launch enforcement in `keepalive-mac.sh` (MLX). MLX weights ARE
  manifested (`self-quantized`/`packager` entries) — coverage is in scope,
  the Mac-side launch check is a registered follow-up bead (`qwen-coprocessor-stack-17t`), not dropped.
- Per-respawn re-hash of served files (TOCTOU window accepted; see item 5).
- Scanning tensors for embedded payloads (steganography in weights) — not a
  realistic threat for a passive container; out.

### Bright line

**A model or runtime file that is not in `models/MANIFEST.json` with a
verified upstream hash does not get served by the box keepalive
(`keepalive-coprocessor.sh`).** That is the enforced statement this cycle. The
manifest *covers* everything the stack serves on both machines (MLX weights on
the Mac are manifested as `self-quantized`/`packager` entries like any other),
but the Mac/MLX launch path (`keepalive-mac.sh`) gets no refuse-to-launch check
this cycle — registered below as follow-up, not silently dropped. The tool is
the only sanctioned acquisition path; the hook turns habit into a denial with a
message; the box keepalive turns an unmanifested launch into a refusal.
Convenience is never a reason to bypass — the escape hatch exists, is logged,
and is a reviewable event.

**What verification does and does not buy (TOFU, stated plainly).** Matching a
file's sha256 to HF's LFS metadata proves the bytes are exactly what *that repo
at that commit* published — it does not prove the repo is honest. Legitimacy
comes from the **origin allowlist**, which is the real trust anchor and is
therefore edited only by PR with a stated reason. Self-quantizing from an
`origin` repo shrinks the trusted set to the model author + our own toolchain.

**The hook is guidance-grade, not a security boundary.** It denies the habitual
commands inside Claude Code sessions in this repo/plugin. It does not see a
Python one-liner, a shell script, a `qwen_spawn`/`qwen_oneshot` coprocessor
session (RDR-013 — the inner qwen agent runs its own shell, unhooked), or a
human at a terminal. The manifest + keepalive refusal are the enforcement; the
hook exists so the *easy* path is the verified one.

### Approach

1. **Manifest schema + validator** (`models/manifest.schema.json`,
   `provenance.py validate`) with unit tests (stdlib `unittest`, seeded/fixed
   fixtures, no network) — item 2.
2. **`provenance.py fetch` / `add-runtime` / `verify` / listing round-trip**
   with the allowlist and format rules; unit tests use a fake HF API server on
   port 0 (real HTTP, no mocks of `urllib`) — items 1, 3.
3. **Box-side PowerShell** listing + verify, deployed to
   `D:\claude-coordination\` — item 4.
4. **Retroactive manifest** for `D:\models\**`, `D:\llama-b9596`,
   `D:\llama-b10078` (b9596/b10078 hashes already captured 2026-08-15) —
   item 6.
5. **Keepalive enforcement** + `write_state()` manifest id — item 5.
6. **Hooks** in the plugin — item 7.
7. **Skill** — item 8.
8. **CI workflow** — item 9.
9. **Docs + memories** — item 10.
10. **First real acquisition under the protocol: Qwen3.8-27B** — origin
    safetensors from `Qwen/Qwen3.8-27B` at a pinned sha, self-quantized
    (Q8/Q6 GGUF for the box, MLX for the Mac), llama.cpp arch-support probe
    before wiring into the pool (CLAUDE.md rule) — this is the **acceptance
    test of the whole path**: the RDR does not close (`close_reason:
    implemented`) until this bead is closed with the Qwen3.8-27B entry
    `verified_on: [mac, box]` and served through the enforced keepalive.
11. **Follow-up registered (not this cycle):** `keepalive-mac.sh` launch check
    (MLX) — bead `qwen-coprocessor-stack-17t`. (The PowerShell scripts were execution-tested on the box itself on
    2026-08-15 against the live manifest — check-path pass/refuse cases,
    Test-Provenance 52/52 for b10078 and the expected single MISSING for
    b9596 — so "logic-reviewed only" no longer applies.)

## Research Findings

- **F1 (2026-08-15).** `D:\llama-b9596.zip` sha256
  `46bf6ee71b3d9c842aaadee2f6e51da6e8d9139dc3d8b931e5615150521f8f71` ==
  GitHub `ggml-org/llama.cpp` release `b9596` asset
  `llama-b9596-bin-win-vulkan-x64.zip` (38,406,519 bytes). Defender's
  `Trojan:Script/Phonzy.B!ml` on `ggml-cpu-ivybridge.dll` from that zip is a
  heuristic false positive on an upstream CI artifact.
- **F2 (2026-08-15).** All 52 files in `D:\llama-b10078` are byte-identical to
  GitHub asset `llama-b10078-bin-win-vulkan-x64.zip`. Verified file-by-file
  (`shasum -a 256` on Mac vs `Get-FileHash` on box, CRLF-normalised diff).
- **F3 (2026-08-15).** Box inventory: `D:\models\{gpt-oss-120b-mxfp4-0000{1,2,3}-of-00003.gguf,
  mmproj-Qwen3.6-35B-A3B-BF16.gguf, Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf,
  Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf}` and `D:\models\qwen3-coder-next\{Qwen3-Coder-Next-Q6_K-0000{1,2}-of-00003.gguf,
  Qwen3-Coder-Next-UD-Q4_K_XL.gguf}` — none verified against upstream; the
  Q6_K shard set is incomplete (2 of 3 present). Presumed origins: `unsloth/*-GGUF`
  (UD quants, mmproj), `ggml-org/gpt-oss-120b-GGUF`. To be confirmed by hash
  match in Approach step 4.
- **F4 (2026-08-15).** Box python is unusable (`uv trampoline failed to spawn
  Python child process`); box-side verification must be PowerShell.
- **F7 (2026-08-15).** Retro-manifest results (Approach step 4, executed
  in an announced service window with the keepalive paused and
  llama-server stopped; 63 files hashed, no D: dropout): Coder-Next
  UD-Q4_K_XL (the served model) and Q6_K shards 1–2 == `unsloth/Qwen3-Coder-Next-GGUF@ce09c67b`;
  Qwen3.6-35B-A3B UD-Q4_K_XL/UD-Q8_K_XL == `unsloth/Qwen3.6-35B-A3B-GGUF@a483e9e6`;
  gpt-oss-120b 3 shards == `ggml-org/gpt-oss-120b-GGUF@3d7350377f` (an
  OLD revision — upstream deleted the shards one at a time on 2026-07-16
  and now ships a single file; found via `match`'s common-revision line);
  `D:\llama-b9596` == release asset minus the quarantined ivybridge DLL
  (`missing_on_host`); `D:\llama-b10078` == release asset. **The box mmproj
  (`mmproj-Qwen3.6-35B-A3B-BF16.gguf`, 902,822,016 B, sha256 e5c205ce…) is a
  `lmstudio-community` file** — not on the allowlist, deliberately NOT
  manifested; vision serves from the Mac now, so nothing on the box needs
  it. Re-acquire from `unsloth` via `fetch` if the box ever needs a
  mmproj; do not add lmstudio-community to the allowlist to make this go
  away.
- **F8 (2026-08-15).** HF's `/api/models/{repo}?revision=X` query form is
  **silently ignored** (answers for `main`); the revision-scoped form is the
  path `/api/models/{repo}/revision/{X}`. Found live when `adopt --revision
  <old sha>` came back pinned to main; the tool's helper and the test
  fixture were both using the query form (a vacuous test). Fixed; a
  discriminating test (older revision with different bytes) now guards it.
- **F6 (2026-08-15).** A full `Get-FileHash` pass over `D:\models` from
  ssh caused **Disk 1 (OWC Aura Ultra IV NVMe = D:) to surprise-remove**
  (System log `disk` 157 at 12:20:36; also 2026-08-01 and 2026-08-07 without
  us) and `llama-server` (b9596, mmap) died with `0xc0000006`; the keepalive
  respawned it. Consequence for this RDR: box-side verification is a
  service-window operation (announce in `QWEN_SERVER_NEGOTIATION.md`) or
  one-file-at-a-time with the served model on `--no-mmap`; the keepalive's
  per-launch check must stay cheap (no hashing). Bead filed; T2
  `box-nvme-d-drive-surprise-removal`.
- **F5 (2026-08-15).** Qwen3.8-27B: `Qwen/Qwen3.8-27B` on HF, Apache 2.0,
  27.8B dense, hybrid Gated DeltaNet + Gated Attention, 262K ctx, multimodal,
  thinking on by default; recommended non-thinking sampling
  `temp 0.7 / top_p 0.8 / top_k 20`. llama.cpp arch support for its
  attention + vision tower must be probed on b10078 or newer before pooling.

## Consequences

### Positive

- Every served artifact has an upstream identity (repo@sha, asset@tag), a
  content hash verified on both machines, and a lineage line to the origin
  weights. A future Defender hit, a bad eval number, or a "which quant is
  this?" question has an answer in git.
- The dangerous formats and the trust-anyone paths are refused by tooling, not
  by memory. New agents/sessions inherit the discipline through the hook and
  the skill.
- Self-quantizing from origin safetensors removes the packager trust class for
  new models and makes the quant reproducible (`quantized_by` records the
  exact command and llama.cpp version).

### Negative

- Acquisition gets slower: hashing 50–100 GB on both ends and self-quantizing
  add minutes to hours per model. Accepted — it is a one-time cost per
  artifact, and the alternative is the status quo.
- Enforcement in the keepalive is a new way for serving to fail (unmanifested
  path). Mitigated by the retroactive manifest landing before enforcement is
  turned on, the loud escape hatch, and the path check being cheap.
- The hook is bypassable by construction (guidance-grade); the RDR says so
  and puts enforcement in the keepalive + manifest instead.
- The hook's deny-list will have false positives (a `curl` to HF for a README,
  say). The message names the escape (run the tool, or the operator runs the
  command outside the agent). Tune the patterns; never widen the allow side to
  make the hook quiet.
- Files on the box that cannot be matched to an allowlisted upstream become
  unservable under enforcement. That is the intended outcome; if we want them,
  we re-acquire them properly.

### Neutral

- Windows-side verification is a second implementation (PowerShell) of the
  hash-and-compare step. It is ~40 lines and the listing format
  (`sha256  relpath`) is the contract between the two; a contract test on the
  Mac side parses a fixture produced by the PowerShell script.
- CI cost is bounded: ubuntu-only, path-filtered, metadata-only for models,
  ~40 MB downloads for runtimes, no schedule.
