# Model and runtime provenance

Design of record: [RDR-016](rdr/RDR-016-model-binary-provenance.md). Skill:
`/qwen-stack:provenance`. Tool: `scripts/ops/provenance/provenance.py`.
Manifest: `models/MANIFEST.json` (schema `models/manifest.schema.json`).

**Bright line:** a model or runtime file that is not in the manifest with a
verified upstream hash does not get served.

## Threat model (what this does and does not buy)

| Threat | Closed by | Notes |
|---|---|---|
| Pickle-based weights (`.bin/.pt/.pth/.pkl/.ckpt`) executing code on load | tool refuses the whole fetch; hook denies loading them | the actual malware vector for model files |
| `trust_remote_code` repos running arbitrary code at import | tool refuses unless `--allow-remote-code`, then records every `.py` | Qwen3.8 needs none; treat "needs remote code" as a reason to wait for native support |
| Third-party re-upload / hijacked packager account | origin allowlist (two tiers) + prefer self-quantize from origin safetensors | **the allowlist is the trust anchor** — verifying against HF's LFS sha256 proves the bytes are what *that repo at that commit* published, not that the repo is honest |
| Packager re-quantizing in place under the same filename | pinned 40-hex commit sha in the manifest; `drift` re-checks | unsloth rewrote `mmproj-BF16.gguf` between 2026-04-16 and 04-20 |
| Corrupt or substituted LAN copy | verify on the Mac at download AND on the box after `scp` (`verified_on: [mac, box]`) | box side is pure PowerShell (`Get-FileHash`) |
| Runtime binaries not what GitHub published | `add-runtime` hashes the zip and every member against a fresh GitHub download | b9596/b10078 verified 2026-08-15 |
| Serving something we cannot account for | keepalive refuses unmanifested paths; `write_state()` records the manifest ids | membership check per respawn (cheap), full re-hash on demand |
| An agent reaching for `hf download` / `curl` / `ollama pull` / `scp *.gguf` | PreToolUse hook denies with the sanctioned command in the message | **guidance-grade, not a security boundary** — it stops habit, not intent |
| Compromised upstream (HF/GitHub themselves), malicious tensors in a passive container, loader parser bugs | not addressed | out of scope; residual risk accepted |

## Trust tiers

- `origin` — model authors: `Qwen`, `openai`, `zai-org`, `moonshotai`,
  `deepseek-ai`, `google`, `meta-llama`, `mistralai`, `nvidia`.
- `packager` — re-encoders we accept with lineage: `unsloth`, `ggml-org`,
  `bartowski`, `mlx-community`. Requires `--allow-packager` and
  `--derived-from <origin repo@sha | manifest id>`.
- `self-quantized` — built by us from an `origin` entry; the entry records the
  tool, version, and exact command (`quantized_by`) and points at the origin
  entry (`derived_from`).

Everything else is refused. Adding an owner is a PR to
`scripts/ops/provenance/allowlist.json` with a reason in the commit.

## Runbook

### New model, the whole way

```bash
P="python3 scripts/ops/provenance/provenance.py"
# 1. plan — sha, per-file verdicts, HF scan status, byte count
$P fetch Qwen/Qwen3.8-27B --dry-run
# 2. fetch to the external disk; verifies every file; appends the manifest entry
$P fetch Qwen/Qwen3.8-27B
# 3. (recommended) self-quantize on the Mac, then register the output
python3 <llama.cpp>/convert_hf_to_gguf.py <safetensors dir> --outfile Qwen3.8-27B-BF16.gguf
<llama.cpp>/build/bin/llama-quantize Qwen3.8-27B-BF16.gguf Qwen3.8-27B-Q8_0.gguf Q8_0
$P register --id qwen3.8-27b-q8_0 --kind model --format gguf --trust-tier self-quantized \
   --derived-from qwen3.8-27b-safetensors@1d4bf0f2 \
   --quantized-by-tool llama-quantize --quantized-by-version b10078 \
   --quantized-by-command "llama-quantize ... Q8_0" --root <dir> --include 'Qwen3.8-27B-Q8_0.gguf'
# 4. ship to the box (marker lets the hook through), verify there, import
PROVENANCE_TRANSFER=1 scp Qwen3.8-27B-Q8_0.gguf qwentescence:D:/models/qwen3.8-27b/
ssh qwentescence powershell -NoProfile -ExecutionPolicy Bypass \
   -File D:\claude-coordination\Get-ProvenanceListing.ps1 -Root D:\models\qwen3.8-27b -Out C:\Users\sam\qwen3.8.listing
scp qwentescence:C:/Users/sam/qwen3.8.listing ./
$P verify --id qwen3.8-27b-q8_0 --listing qwen3.8.listing --host box
# 5. wire: keepalive CODER/VISION line → arch probe (load + real generation) → shakeout → backend config
```

### First run under the protocol (Qwen3.8-27B, 2026-08-15)

The recipe above was executed end-to-end for `Qwen/Qwen3.8-27B@1d4bf0f2` (bead
`qwen-coprocessor-stack-r28`, T2 `qwen3.8-27b-first-acquisition-r28-2026-08-15`).
Manifest ids: `qwen3.8-27b-safetensors@1d4bf0f2` (origin, mac),
`qwen3.8-27b-q8_0`, `qwen3.8-27b-q6_k`, `qwen3.8-27b-mmproj-f16` (self-quantized,
llama.cpp b10078, mac+box), `qwen3.8-27b-mlx-4bit` (mlx-lm 0.31.3, mac). Arch
`qwen3_5` is known to both b9596 and b10078; the b9596 probe on the box loaded with
`--mmproj`, generated (7.7 tps decode / 112 tps prompt, Q8_0 at 32K ctx, 30.5 GB GPU
dedicated) and passed `scripts/shakeout.py` 9/9. The RDR's second acceptance leg
("served through the enforced keepalive") was met by pointing `CODER_MODEL` /
`CODER_MANIFEST_ID` at `qwen3.8-27b-q8_0` in a second window: the ARMED gate itself
approved and launched it (`model=qwen3.8-27b-q8_0 runtime=llama.cpp@b9596`, UP in
59 s, state json carried the ids), then the line was reverted to Coder-Next. It is
not pooled — a manifested candidate.

Practicalities worth knowing before the next one:

- Budget ~4 h wall-clock for a 27B dense model on the external disk: fetch ~35 min,
  BF16 convert ~36 min (write-bound), each `llama-quantize` ~25 min, scp to the box
  ~14–20 MB/s (51 GB ≈ 1 h). Run the disk-heavy steps sequentially.
- The llama.cpp source checkout for `convert_hf_to_gguf.py` / `llama-quantize` is a
  plain git clone of the GitHub repo at the pinned tag
  (`/Volumes/Transcend Hell/git/llama.cpp` @ b10078); the hook only denies HF clones
  and raw release-asset downloads.
- `mlx_lm.convert` on the Metal device fails at save time for this model
  (`kIOGPUCommandBufferCallbackErrorSubmissionsIgnored`, with or without the resident
  MLX servers). Run it on the CPU device (`mx.set_default_device(mx.cpu)` before
  `convert(...)`); ~20 min for 27B, output identical in shape.
- Windows reports a stale `Length` (0) for a file `sftp-server` still holds open —
  it is not a truncated transfer; wait for the scp exit code.
- Announce the ship (sustained write) and the probe (service window) separately in
  `QWEN_SERVER_NEGOTIATION.md`; hash only the new directory on the box.
- The keepalive's first ARMED-gate launch after the window recorded
  `model=qwen3-coder-next-unsloth-gguf@ce09c67b runtime=llama.cpp@b9596`; the
  bootstrap (empty-manifest) sentinel is `unarmed:empty-manifest`, so a state file
  showing that plus `enforce=1` means "nothing to enforce yet", not a bypass.

### New llama.cpp build on the box

```bash
$P add-runtime --tag b10078            # downloads llama-b10078-bin-win-vulkan-x64.zip, hashes zip + members
PROVENANCE_TRANSFER=1 scp <zip> qwentescence:D:/
# unzip on the box to D:\llama-b10078, then:
ssh qwentescence powershell ... Get-ProvenanceListing.ps1 -Root D:\llama-b10078 -Out C:\Users\sam\b10078.listing
$P verify --id llama.cpp@b10078 --listing b10078.listing --host box
```

### Files that were already on a host before this protocol (`adopt`)

```bash
# 1. hash the tree on the box (service window!) → listing
# 2. find which revision published those hashes (packagers re-quantize in place):
$P match --repo unsloth/Qwen3-Coder-Next-GGUF --listing coder-next.listing
# 3. record, matched by sha256 not filename, no download:
$P adopt unsloth/Qwen3-Coder-Next-GGUF --revision <sha from match> --listing coder-next.listing \
   --host box --allow-packager --derived-from Qwen/Qwen3-Coder-Next@<origin sha> --id <id>
```

A member the host legitimately lacks (Defender quarantined a CPU-variant DLL
out of a verified llama.cpp tree) is tolerated with
`verify --allow-missing <glob>` and recorded on the entry as
`missing_on_host` — the gap is in the manifest, not in someone's head. It never
excuses a hash mismatch.

Retro results (2026-08-15) are in the manifest notes; the one file NOT
manifested is the box mmproj (`lmstudio-community`, not allowlisted — see
RDR-016 F7). Do not add lmstudio-community to the allowlist to make that go
away; re-acquire from an allowlisted packager if the box ever needs it.

### Re-verify after a disk event

`$P verify --id <id> --root <dir> --host mac` on the Mac; on the box
`Test-Provenance.ps1 -Manifest <MANIFEST.json> -Id <id> -Root D:\models\... -TargetHost box`
or a listing + `verify --listing`. **Do not bulk-hash `D:\models` while a
model is being served with mmap** — the box's D: NVMe (OWC Aura Ultra IV) has
surprise-removed under sustained read three times (2026-08-01/07/15) and takes
`llama-server` with it (`0xc0000006`). Announce a service window in
`D:\claude-coordination\QWEN_SERVER_NEGOTIATION.md`, or hash one file at a
time with the served model on `--no-mmap`.

### Drift and CI

`$P drift --all` re-fetches HF metadata at each pinned sha and re-downloads
GitHub assets, comparing to the manifest. `.github/workflows/provenance.yml`
runs schema validation, the tool's tests, the hook tests, and `drift` on PRs
that touch `models/**` or the tool. No schedule (cost discipline).

## Enforcement points

- **Tool** — fail-closed at every step; refusals say what the sanctioned next
  step is.
- **Hook** — `plugins/qwen-stack/hooks/provenance-guard.sh` (`PreToolUse` on
  `Bash`; wired in the plugin and in the repo's `.claude/settings.json` so it is
  live before the next plugin release). Denies raw acquisition, unmarked
  weight transfers, pickle loads, `trust_remote_code`; asks on
  `QWEN_PROVENANCE_ENFORCE=0`.
- **Keepalive** — `scripts/ops/keepalive-coprocessor.sh` calls
  `provenance.py check-path <model> --host box` before every launch and refuses
  unmanifested/unverified paths (and refuses if the manifest is malformed or
  `python3` is missing — only a well-formed empty manifest is "bootstrap");
  `write_state()` records the manifest ids. The keepalive log line starts
  with `REFUSING to launch coder-box —` and names the reason.
  **3 a.m. escape hatch:** the keepalive runs under launchd, so an env var in
  your shell does nothing — either `launchctl setenv QWEN_PROVENANCE_ENFORCE 0`
  then `launchctl kickstart -k gui/$(id -u)/com.qwen.coprocessor-keepalive`,
  or add `<key>EnvironmentVariables</key>` with `QWEN_PROVENANCE_ENFORCE=0` to
  `~/Library/LaunchAgents/com.qwen.coprocessor-keepalive.plist` and
  bootout/bootstrap it. Every bypassed launch logs
  `PROVENANCE BYPASS (QWEN_PROVENANCE_ENFORCE=0)`; undo it when the manifest
  is fixed (`launchctl unsetenv QWEN_PROVENANCE_ENFORCE`).
- **CI** — see above.

## Files

| Path | Role |
|---|---|
| `models/MANIFEST.json` | the record; edited only by the tool |
| `models/manifest.schema.json` | schema (draft-07 subset) |
| `scripts/ops/provenance/provenance.py` | tool (Mac, stdlib) |
| `scripts/ops/provenance/allowlist.json` | trust tiers |
| `scripts/ops/provenance/tests/` | unit tests (fake HF/GitHub server on port 0) |
| `scripts/ops/win/Get-ProvenanceListing.ps1` | box: hash a tree → listing |
| `scripts/ops/win/Test-Provenance.ps1` | box: verify a manifest entry in place |
| `scripts/ops/win/Get-ProvenanceCheckPath.ps1` | box: cheap membership check |
| `plugins/qwen-stack/hooks/` | the guard hook + tests |
| `plugins/qwen-stack/skills/provenance/` | the skill |
| `.github/workflows/provenance.yml` | CI |
