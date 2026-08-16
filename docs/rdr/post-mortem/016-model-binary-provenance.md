<!-- SPDX-License-Identifier: MIT -->
# Post-mortem: RDR-016 — Model and runtime provenance

**Closed:** 2026-08-15 · **Reason:** implemented · **Type:** Design ·
**Epic:** `qwen-coprocessor-stack-tij` · **PR:** #85 (branch `feature/rdr-016-provenance`, head `a23f511`)

## What shipped

Every model weight and llama.cpp runtime the stack serves is now in `models/MANIFEST.json`
with upstream identity (HF repo@40-hex sha / GitHub asset@tag), sha256, byte length, lineage
to origin weights, and `verified_on` per host — and the box keepalive refuses to launch
anything that is not.

- `scripts/ops/provenance/provenance.py` (stdlib, py3.9+, 93 tests against a real fake HF/GitHub
  server): `fetch / add-runtime / register / adopt / verify / check-path / match / drift /
  status / list`; origin/packager allowlist; `.safetensors`/`.gguf` only; pickle/archive
  refusal; `.py`/`trust_remote_code` gated; path-traversal guard; non-vacuous drift.
- `models/MANIFEST.json` + `manifest.schema.json`: retro entries for everything on the box
  (all byte-identical to upstream), plus the acceptance run below.
- `scripts/ops/win/*.ps1` (listing / verify / check-path; PS 5.1) executed on the box.
- `plugins/qwen-stack/hooks/provenance-guard.sh` (44 tests): PreToolUse deny of `hf download`,
  `curl huggingface.co`, HF `git clone`, `ollama pull/run`, raw release-asset downloads,
  unmarked `scp` of weights, pickle loads. Guidance-grade, wired in plugin + repo settings.
- Keepalive gate in `keepalive-coprocessor.sh` (`prov_gate`): membership + `status: verified` +
  host + byte length, `CODER_MANIFEST_ID` pinned; unarmed only for a well-formed EMPTY manifest,
  fail-closed on malformed; `QWEN_PROVENANCE_ENFORCE=0` is a logged bypass; `write_state()`
  records the manifest ids.
- CI `provenance.yml` (path-filtered, ubuntu, py3.9+3.12), `/qwen-stack:provenance` skill,
  `docs/MODEL_PROVENANCE.md`, CLAUDE.md paragraph, T2/T3/auto-memory entries.
- **Acceptance run (item 10):** `Qwen/Qwen3.8-27B@1d4bf0f2` fetched from origin, self-quantized
  on the Mac (llama.cpp b10078: BF16 → Q8_0 / Q6_K + F16 mmproj; mlx-lm 0.31.3 4-bit), shipped
  under `PROVENANCE_TRANSFER=1`, hashed and verified on the box (`verified_on: [mac, box]`),
  arch-probed on the production b9596 (`qwen3_5` known to b9596 and b10078; shakeout 9/9 incl.
  vision/OCR/tools), and **served through the ARMED gate** (`model=qwen3.8-27b-q8_0
  runtime=llama.cpp@b9596`) in an announced window before reverting to Coder-Next.

## Scope cross-walk (RDR §Approach → delivered)

Phase-review gate PASSED 11/11 (2026-08-15): Item1=c9w, Item2=gom, Item3=mkw, Item4=4ed,
Item5=qdz, Item6=f19, Item7=rkn, Item8=651, Item9=ugz, Item10=r28, Item11=17t (registered
follow-up: `keepalive-mac.sh` MLX refuse-to-launch check — the RDR's Out-of-scope section names
it explicitly; MLX weights ARE manifested). New follow-up filed at close: `jqq` (split a
transient box-stat ssh failure from an explicit check-path denial in `prov_gate`).

## What went well

- **The tool found a real bug the RDR did not predict:** HF silently ignores `?revision=`; the
  first cut pinned `main`. Caught by a discriminating fixture (older revision, different bytes)
  after a reviewer's PoC. Fixtures that mirror the wrong URL are vacuous — the lesson is now in
  the runbook.
- **The gate did what it was for, twice, on day one.** Its first armed launch approved the
  pooled Coder-Next by manifest id; its second approved Qwen3.8 by id; a transient ssh failure
  in between refused once and backed off without touching a healthy server.
- **Two-way channel with the box-side instance paid off** — its D: investigation reframed the
  "NVMe dropout" as a USB4-enclosure tunnel drop with two wrong power settings, and it caught
  the ambiguous bootstrap sentinel in the state file (renamed `unarmed:empty-manifest`).
- **Stacked reviewers earned their keep again:** code-review-expert approved the acceptance
  commit; substantive-critic caught that "served through the enforced keepalive" had not
  literally happened (the probe was a manual load) — fixed with a second window before close.

## What was harder than expected

- **Time on the external disk.** ~4 h wall-clock for one 27B model (fetch 35 min, BF16 write
  36 min, two quantizes ~50 min, scp to the box ~1 h at 14–20 MB/s). Disk-heavy steps contend;
  run them sequentially. Recorded in the runbook.
- **`mlx_lm.convert` on Metal fails at save** for this model regardless of co-residency; the
  CPU device works (~20 min). The Mac keepalive churned during the CPU run (vision-mac blew its
  load budget under disk contention) — pause it for the next one.
- **The hook is literal-minded.** Any Bash string with `scp` + a weight suffix is denied,
  including heredocs that merely mention `.gguf`, and a docs edit that mentions the denied
  phrase. Split commands; use Write/Edit for text.
- **A full-tree hash of `D:\models` crashed serving** (surprise-removal, `0xc0000006`) — the
  box-side verification is a service-window operation. Bead `jxu`; powercfg fix under a 2–3 week
  observation window since 2026-08-15 15:45.

## Divergences from the accepted design

- Arch probe ran on **b9596** (production pin), not "b10078+" as the bead text said. Both builds
  carry `LLM_ARCH_QWEN35`; b10078 has an unresolved carve regression on this box (bead `iuq`).
  Judged a legitimate substitution by the critic; recorded, not silent.
- Qwen3.8-27B is **not pooled** — the RDR asked for the probe "before wiring into the pool";
  wiring is a routing decision, not a provenance one, and stays with the operator.

## Follow-ups (open beads)

`17t` MLX keepalive gate · `jqq` prov_gate transient-vs-denial · `jxu` box D: enclosure dropout
(observation) · `iuq` b10078 carve regression (pre-existing).
