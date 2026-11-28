---
title: "Inkling 2 Mini on erisinky — an OpenAI-compatible endpoint in the Hellblazer fork, a source-built runtime under RDR-016, a keepalive-mac slot, and content-addressed .ikv segment reuse behind the supervisor (deferred, P4)"
id: RDR-017
type: Design
status: draft
priority: medium
author: hal
reviewed-by: none
created: 2026-11-28
related_issues: [qwen-coprocessor-stack-ijzg, qwen-coprocessor-stack-gajx]
---

# RDR-017: Inkling 2 Mini on erisinky, as a backend and with .ikv reuse

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft (2026-11-28).** Sam asked for a plan before any code, covering the
backend and `.ikv` reuse together. Bead `ijzg` recorded the measurement that
starts this: erisinky `4be5bed` with the LM Studio Q4_K_M
(`inkling-2-mini-gguf@23c938b0`, verified on mac) decodes at 79-80 tok/s on the
M4 Max at 2.4K context and 53.7 tok/s at 28.5K, against 20 tok/s for the
Unsloth llama.cpp fork with the dspark drafter that bead `gajx` served. Prefill
is 1068 tok/s at 2.4K and 762 at 28.5K. The M4 Max has no M5 neural
accelerators, so the engine falls back to its slower prefill path; upstream's
2,200 tok/s is an M5 Pro figure (`erisinky/README.md:55`, `:148`). Nothing in
this RDR is built yet. Sam's decisions on the open questions are recorded under
Decisions (2026-11-28); the RDR is ready for the gate. On 2026-11-28, after gate round 1, Sam deferred P4 (`.ikv` reuse) within this RDR; see Decision 10 and the Deferred section.

## Problem Statement

erisinky is fast on this Mac, and nothing in the stack can use it:

- It has no OpenAI-compatible endpoint. `inkling serve` is the 7-channel
  multistream web UI with custom `/api/*` routes (`erisinky/src/main.rs:683`,
  `:1096-1106`; `erisinky/src/webui.rs:490-672`). The supervisor's agentic path
  (`qwen_spawn`/`qwen_oneshot`, `qwen_dispatch`) and the battery both drive
  qwen-code, which speaks `/v1/chat/completions` with streamed tool calls.
- RDR-016 has no way to admit a runtime we compile from source. `add-runtime`
  accepts GitHub release assets from `runtime_repos` only
  (`scripts/ops/provenance/provenance.py:1456-1462`); `overlay_repos` covers one
  patched file inside an official release zip (`:1240-1300`); `register --kind
  runtime` requires Hugging Face `derived_from` lineage (`:1590-1599`). A binary
  built from `Hellblazer/erisinky` at a pinned commit fits none of them.
- keepalive-mac has no slot for it, and its reap and singleton patterns are
  port-specific by design (`scripts/ops/keepalive-mac.sh:40-42`).
- The `.ikv` cartridge speedup (14x-99x on file ingestion, `erisinky/README.md:15`)
  is implemented only inside `inkling-ikv`'s own TUI harness, which runs its own
  tool loop. Our agents read files through qwen-code tools and send the text
  back as plain message content, so the harness's interception point does not
  exist on our path.

## Context

Sources, by short name used below:

- **E**: `Hellblazer/erisinky` (Sam's fork of `Eriskii/erisinky`, GPL-3.0-or-later)
  at `4be5bed685e937e4cb6f0143bb17afa5cb51a763`, checked out at
  `/Volumes/SanHell/git/erisinky`.
- **I**: `Eriskii/inkling-ikv` at `ab18bc6`, `/Volumes/SanHell/git/inkling-ikv`.
  Sam's fork `Hellblazer/inkling-ikv` was created on 2026-11-28 (Decision 2); in the local clone `origin` is the fork and `upstream` is Eriskii's.
- **Q**: qwen-code 0.15.6, `/opt/homebrew/lib/node_modules/@qwen-code/qwen-code/cli.js`
  (the globally installed CLI; P1 re-checks against the binary the SDK spawns).
- **T**: the GGUF's own `tokenizer.chat_template` (6,868 bytes, read from the
  header of the manifested `Inkling-2-Mini-Q4_K_M.gguf`; line numbers are lines
  of that template).

What the engine is:

- One `Engine` owns the GPU buffers through `RefCell`/`Cell` fields
  (`E src/engine.rs:395-405`), so it is not `Sync`: one thread must own it. The
  web UI already uses the shape a server needs: a listener thread spawning a
  thread per connection, the engine loop on its own thread, shared state behind
  `Mutex`/`Condvar` (`E src/webui.rs:826-839`). It binds `127.0.0.1` only (`:825`).
- `Session` is single-stream. `prefill` appends tokens at `n_past`
  (`E src/session.rs:39-68`), `generate` decodes until EOS or a callback returns
  false, and after a stop the context is exactly "everything emitted so far"
  (`:70-75`). `Session::resume` restarts at a given `n_past` (`:32-35`).
  `prefill` asserts on a full context (`:45`) and the release profile is
  `panic = "abort"` (`E Cargo.toml`), so an oversized request kills the process
  unless the server checks first.
- Rollback is possible. Full-attention KV at positions below `n_past` is never
  rewritten, so truncating it is free. The rest of the state is the width-4 conv
  state and the 1,024-token SWA ring, and `Engine::snapshot`/`restore` copy
  exactly those two buffers (`E src/engine.rs:1021-1031`). Sizes from the
  allocation (`:538-540`) and constants (`:9-23`): SWA ring 40 slots x 2 x 8
  heads x 1024 x 128 x 2 B = 160 MiB; conv state 48 x 6656 x 3 x 4 B = 3.7 MiB.
  Dense FP16 full-attention KV is 8 slots x 2 x 8 x 128 x 2 B = 32 KiB per token:
  4 GiB at 128K, 8 GiB at 256K (matches `E README.md:33`).
- `batch.rs` is a paged multi-sequence engine with continuous batching and
  shared-prefix attention (`E src/batch.rs:1-7`, `:1828`), built for batch
  generation from fixed prompts. It is the long-run route to concurrent decode
  and is not used here.
- Metal shaders are compiled at load time from source embedded with
  `include_str!` (`E src/engine.rs:514`, `src/metal.rs:30`). The binary's hash
  therefore covers the shader source; the Metal compiler is the OS's.
- There is no `rust-toolchain` file. The `rustc` on PATH is 1.61.0; the bead `ijzg`
  bench used 1.95. `Cargo.lock` (v4) pins the five direct dependencies, nine third-party
  packages in all, with checksums.
- The default model path is LM Studio's (`E src/main.rs:12`; same in
  `I src/main.rs:8-9`), so every launch must pass `-m` explicitly.
- Upstream's own guidance: one engine process at a time, about 16.3 GiB resident
  (`E README.md:49`); native sampling temp 1.0 / top_p 0.95 / top_k 64, and greedy
  scored worse in agent loops (`:46`); dense beats sparse below about 70K
  context without `.ikv` (`:32`).

The chat template (T):

- Tools render first as `<|message_system|>tool_declare<|content_xml|>` plus the
  tool specs as compact, key-sorted JSON (T:23-38).
- A `Thinking effort level: X` system message goes before the first non-system
  message; the default is 0.9 (T:4-21, T:45-47). The CLI maps `none`..`xhigh` the
  same way (`E src/main.rs:138-144`).
- Assistant turns render reasoning as `<|message_model|><|content_thinking|>...`,
  text as `<|content_text|>`, and each tool call as
  `<|message_model|>NAME<|content_invoke_tool_json|>{"name":NAME,"args":{...}}<|end_message|>`
  with `args` re-serialized key-sorted and compact; a JSON-string `arguments` is
  rejected (T:71-120). Every assistant turn ends with
  `<|content_model_end_sampling|>` (T:124-125), which is also the EOS token
  (id 200006 in the GGUF vocab).
- Tool results render as `<|message_tool|>NAME<|content_text|>...`, with NAME
  looked up from the matching `tool_call_id` (T:51-64).
- There is no generation prompt: the model emits `<|message_model|>` itself,
  which the CLI renderer swallows (`E src/session.rs:152`).

What qwen-code sends (Q):

- `stream: true` with `stream_options: {include_usage: true}`, and `tools` when
  any are declared (Q:156816-156821).
- `max_tokens` from `QWEN_CODE_MAX_OUTPUT_TOKENS` when set, otherwise
  min(model limit, 8K) (Q:155911-155936). The supervisor forwards
  `max_output_tokens` into that variable (`mcp-bridges/qwen-agent-server/src/session.ts:266-269`);
  the battery sets 16,384 (`extensions/qwen-toolkit/battery/run_battery.py:92`).
- It reads `delta.reasoning_content` (or `reasoning`) (Q:145919) and echoes it
  back on the assistant message of the next request (Q:145617-145619). It never
  sends `reasoning_effort` (no occurrence in cli.js), so the template default 0.9
  applies unless the server overrides it.
- `read_file` does not return raw file bytes. Each line is `trimEnd()`-ed
  (Q:84712), reads stop at 1,000 lines by default (Q:291450) or at a character
  threshold, and a truncated read is prefixed with `Showing lines A-B of N total
  lines.\n\n---\n\n` (Q:142951-142957).

What the supervisor needs from a backend: `/health` at the host root or
`/v1/models` for liveness, and `/props` with a `build_info` string when
`expected_build` is set (`src/backends.ts:526-600`). The agentic path sets
`OPENAI_BASE_URL` and `QWEN_MODEL` from the backend entry (`src/session.ts:245-252`).
`pin_only` keeps a backend out of every automatic selection (`src/types.ts:107`).
A server that answers those three routes needs no supervisor code change.

What inkling-ikv does today:

- Cartridges are keyed by FNV-1a 64 over the harness's own document framing,
  `// === FILE: <rel_path> ===\n<text>\n\n` (`I src/ikv.rs:578-587`,
  `src/harness/shadow.rs:136-160`). The harness re-hashes the file on disk before
  every mount and never mounts a stale cartridge (`shadow.rs:563-591`).
- The `IKV1` header carries `content_hash` (u64), vocab size and slot layout; it
  carries no model identity (`I src/ikv.rs:605-640`, layout check `:916`). A
  cartridge packed under a different quant of the same architecture would mount.
- On a `read_file`, the harness prefills the envelope tokens live, stitches the
  cartridge at the current position, and prefills the closing tokens
  (`I src/harness/worker.rs:1425-1470`).
- `DESIGN.md` describes an OpenAI proxy that matches tool-result text to
  cartridges by content hash ("Tier A", `I DESIGN.md:141-155`), with the rule that
  a mount is never keyed by path or mtime (`:223-226`), as its Phase 2
  (`:281-286`). None of it is implemented: `I src/` has no `/v1/chat/completions`.
- The crate depends on the engine by path, `inkling = { path = "../inkling-engine" }`
  (`I Cargo.toml:9`), so it cannot be consumed as a git dependency without
  editing that line.
- Measured upstream (M5 Pro, its own harness): whole-file and slice stitching at
  mean KL 0.014-0.020 with 16/16 argmax (write-up "Hybrid slicing";
  `I README.md:74`); blind multi-file stitching KL 0.015 after the 8-token sink
  strip (write-up, attention-sinks section); WHT-KV4 on disk and in the live
  pool removed cross-file attribution blur that K3V2 showed (`E README.md:39-41`).

Prior Inkling numbers on this Mac (bead `gajx`, T2
`inkling-2-mini-mac-trial-RESULT-2026-11-21`): Unsloth llama.cpp fork b12588-mix
with the dspark drafter, UD-Q8_K_XL, ctx 131072. Battery control, 3 repeats:
9/9, median 153 s, median 5 tool calls
(`extensions/qwen-toolkit/battery/results/run-013-2026-11-20-inkling-2-mini-q8-m4max-control.json`).
SWE-bench Verified gold-clean 25 (bead `gajx` plus the `hbjw` re-score; run-013
itself is battery only): 15/25, three empty patches from context
overflow past 131072, about 39 minutes per instance. Coder-Next MLX on the same
Mac: battery median 31.6 s (run-010).

## Decision

Serve Inkling 2 Mini from an OpenAI-compatible server written into the
Hellblazer fork of erisinky, admit the binary under RDR-016 as a reproducible
source build, hold it in a new keepalive-mac slot as a `pin_only` backend, and
measure it on the battery before any `.ikv` work. The `.ikv` segment cache is deferred within this RDR
(Decision 10); its entry conditions and gates are under Deferred: .ikv segment
reuse (P4).

### In scope

1. **`inkling serve-openai`** in `Hellblazer/erisinky` (`src/openai.rs`, exported
   from `lib.rs`; a new subcommand so the existing `serve` is untouched).
   - Routes: `POST /v1/chat/completions` (streaming and not), `GET /v1/models`,
     `GET /health`, `GET /props` with `build_info` = `erisinky-<12-hex commit>`.
     Binds `127.0.0.1` by default; the supervisor is on the same Mac.
   - Threading as in `webui.rs`: accept thread, a thread per connection for
     HTTP parsing, one engine thread that owns `Engine`, `Tokenizer` and the
     session, a FIFO job queue. While a request waits in the queue, a streaming
     response sends SSE comment lines so a client timer does not see a dead
     connection.
   - A Rust renderer for exactly T: tool declaration, effort placement, tool
     result headers, assistant reasoning, content, canonical tool-call `args`,
     the closing `<|content_model_end_sampling|>`. Incoming `arguments` strings
     are parsed and re-emitted key-sorted, which is what T requires (T:106-117).
   - Output parsing: thinking becomes `delta.reasoning_content`, text becomes
     `delta.content`, each `<|content_invoke_tool_json|>` block becomes one
     `tool_calls` entry whose `arguments` is the `args` object re-serialized
     exactly as T will render it back, so the next request re-tokenizes to the
     same ids. `finish_reason` is `tool_calls`, `stop` or `length`; the last chunk
     carries `usage`. `<|content_invoke_tool_text|>` (id 200057) is surfaced as
     text with a logged warning until a sample shows its format.
   - Sampling: request `temperature`/`top_p`/`top_k`/`seed`, defaulting to
     1.0/0.95/64. `max_tokens` is honored and includes thinking tokens. Effort:
     request `reasoning_effort` or `reasoning.effort` when present, else the
     server's `--effort` flag.
   - Prefix reuse: the engine thread keeps the committed token list. Each
     request is rendered and tokenized, the longest common prefix with the
     committed list is found, and only the suffix is prefilled. Two checkpoints
     per live context (end of the last prompt, end of the last generation) hold
     `Engine::snapshot()` output (about 164 MiB each); a request that diverges
     inside the last turn restores the latest checkpoint at or before the
     divergence and prefills from there. Rollbacks are logged with their depth,
     so a template mismatch shows up as a rate, not a silent slowdown.
   - Guards: a request whose rendered length plus `max_tokens` exceeds the
     context gets a 400 `context_length_exceeded` before any prefill; a client
     disconnect stops generation at the next token.
   - Context `-c 131072` (what `gajx` ran), dense FP16 KV. No `--kv8`, no
     `--kv-disk`, no sparse pool in this cycle.
   - New dependencies: none if `multistream::parse_json` (already used by
     `webui.rs:11-14`) handles OpenAI request bodies. If it does not, add
     `serde_json` with its checksum in `Cargo.lock`; either way the dependency set
     is part of what item 2 pins.

2. **Source-build runtime provenance** (RDR-016 extension, in this repo).
   - Allowlist key `source_repos: ["Hellblazer/erisinky"]` (`Hellblazer/inkling-ikv` is added at P4 entry; see Deferred), distinct from
     `runtime_repos` (release assets) and `overlay_repos`.
   - Schema: `trust_tier` gains `self-built`; a `build` object records repo,
     40-hex commit, `rustc -vV`, `cargo -V`, `Cargo.lock` sha256, `RUSTFLAGS`,
     the build command, macOS SDK and linker (`ld -v`) versions, Command Line
     Tools versions, and `reproduced_on`.
   - `provenance.py add-source-build --repo --commit --worktree --binary`
     refuses unless: the worktree `HEAD` equals the commit and `git status
     --porcelain` is empty; the commit exists on GitHub for that repo (so we
     run code that is published on the fork); `rust-toolchain.toml` at that
     commit pins `1.95.0` and `rustc -V` matches; the build was `cargo fetch
     --locked` then `cargo build --release --locked --offline` with `RUSTFLAGS`
     holding the two `--remap-path-prefix` flags (worktree and `CARGO_HOME`) and
     `-C link-arg=-Wl,-S`, and with `--target-dir` set to the pinned path
     `/tmp/erisinky-build/target` (inferred, not read: any fixed path works; this
     one is named here). `add-source-build` refuses unless the recorded RUSTFLAGS
     contain `-Wl,-S` and the recorded target-dir equals the pinned path. It
     records the binary's sha256 and size as `files[]`.
   - Reproducibility: the same commit built on hellmini
     (`ssh hellmini /usr/local/bin/lab-run -c lab-mac-m -- ...`) must produce the
     same sha256; that host is then added to `reproduced_on`. The two hosts
     must run the same Command Line Tools (macOS SDK and ld) for the hashes to
     match; the Mach-O header records both versions (017-research-12). The
     debug-map paths are the second host-specific stamp (017-research-13).
   - The verified binary is copied to
     `~/.qwen-coprocessor-stack/runtimes/erisinky-<sha12>/inkling` on internal
     storage and served from there. A later `cargo build` in the erisinky
     checkout then cannot change what the keepalive runs.
   - Unit tests in the RDR-016 style: stdlib `unittest`, a fake GitHub API on
     port 0, a throwaway git repo as the worktree, no network.

3. **keepalive-mac slot `inkling-mac` on :8086**, modelled on coder-mac:
   - `INKLING_ENABLED` (default 0 until P3 passes), an off-file
     `~/.qwen-coprocessor-stack/inkling-mac.off`, a port-specific end-anchored
     pattern on the install path (`.../erisinky-<sha12>/inkling serve-openai .*--port 8086( |$)`),
     `reap_pat`/`guard_single` (`keepalive-mac.sh:74-108`), adoption of a server
     that outlived the previous keepalive (`:279-284`), reaping in the shutdown
     trap (`:275`).
   - Provenance gate: `check-path` for the binary
     (`--id erisinky@<sha12>`) and for the GGUF (`--id inkling-2-mini-gguf@23c938b0`),
     each with `--size`, plus a count assert of 2, as `coder_prov_ok` does
     (`:124-136`). Same `QWEN_PROVENANCE_ENFORCE=0` escape hatch, logged.
   - Readiness: `/health`, plus a one-token completion until the first success
     after a spawn (the `coder_up` pattern, `:143-151`).
   - Memory backstop `INKLING_MIN_FREE_GB=26`: 16.3 GiB weights, 4 GiB KV at
     128K, up to about 1.6 GiB prefill scratch (0.4 MiB/token at a 4,096-token
     chunk, `I DESIGN.md:16`), and the parked-context cap from item 4.
   - Backend entry: `id inkling-mac`, `url http://localhost:8086/v1`,
     `tier remote`, `capacity heavy`, `weight 1`, `ctx_size 131072`,
     `modality text`, `pin_only true`, `expected_build erisinky-<sha12>`,
     `no_schema true`, `no_tokenize true`. Written to the live config and an
     example under `config/`.

4. **Parked contexts** for interleaved sessions. With one live context, two
   qwen-code sessions alternating on the server would each re-prefill their
   whole history on every switch (28K tokens at 762 tok/s is 37 s). The engine
   thread keeps an LRU of parked contexts, each a copy of full-attention KV
   `[0, n_past)`, its checkpoint and its token list, capped by bytes (default
   4 GiB, about three 32K contexts). A request whose prefix matches a parked
   context swaps it in by copy instead of re-prefilling. The match is by token
   prefix, not by any session id, so it needs nothing from the client.

5. **Battery measurement** under the CLAUDE.md eval rules: control arm, 3
   repeats, serial, coder-mac off, `max_output_tokens` 16,384, a session config
   whose only eligible text backend is `inkling-mac` (the battery has no backend
   pin: `driver.ts` and `run_battery.py` pass none).

6. `.ikv` segment reuse: deferred; see Deferred: .ikv segment reuse (P4).

### Out of scope

- Running `inkling-ikv`'s TUI harness as a dispatch `agentKind` (considered in
  the Deferred section). It may still be tried by hand; it is not the integration.
- Pre-packing cartridges from the worktree's files (considered in the Deferred section). It may come
  back later as a cache warmer if P4's hit rate shows a need.
- The sparse `Kv256kPool` backend. It is deferred, not dropped. Revive it when
  SWE-bench shows context overflow past 131072 costing resolved instances (three
  of 25 did under `gajx`), or for work above about 100K context, where dense
  decode drops below sparse (`E README.md:32-33`). Its own gate would be the KL
  and argmax checks of P4 plus `effort >= 0.1`, which upstream says sparse
  multi-hop retrieval needs (`E README.md:45`).
- Concurrent decode through `batch.rs`, TokenDance/KVCOMM sharing
  (`kv_share.rs`), multistream and persona adapters.
- The box. The engine is Metal-only.
- Any pull request to `Eriskii/erisinky` or `Eriskii/inkling-ikv`. Pushing to
  the Hellblazer forks is fine; an upstream PR needs Sam's go for that PR.

### Bright line

Nothing serves on :8086 unless both the binary and the GGUF are in
`models/MANIFEST.json`, verified on host `mac`, at their manifested sizes. The
keepalive refuses otherwise, through the same logged escape hatch as every other
slot. The binary that serves is the copy in the install directory, never a path
inside a build tree. A cached KV segment is mounted only under a key computed
from the exact bytes in the current request and the served GGUF's sha256.

### Approach

Phases run in order; each has entry criteria, a gate, and the result that
falsifies it. A gate that fails stops the plan at that phase, and the result is
recorded on the bead.

**P0: Fork preparation (Hellblazer/erisinky).** Add `rust-toolchain.toml`
pinning 1.95.0; capture three real qwen-code request bodies by pointing one
`qwen_oneshot` at a logging stub. That settles what this CLI version actually
sends (tools, stream, `max_tokens`, reasoning fields) before the renderer is
written. Exit: the captures are committed to the fork as test fixtures.

**P1: Endpoint (fork, item 1).** Test-first: template-render fixtures, output
parser fixtures, SSE framing, the prefix and rollback logic against a fake
engine trait, then the real engine. Gates:

- G1a, template parity. On at least 50 fixture conversations (the P0 captures
  plus synthetic ones covering reasoning, multiple tool calls per turn, tool
  errors, non-ASCII arguments), the Rust renderer's token ids equal the ids of
  T rendered by a reference Jinja implementation that supports T's
  `{% generation %}` tag (`transformers` in a throwaway venv on the laptop) and
  tokenized by `Tokenizer::encode`. Falsified by any mismatch.
- G1b, server equals CLI. For one rendered agent prompt, greedy decode through
  `serve-openai` and through `inkling run --raw --greedy -f` produces identical
  tokens for 256 positions. Falsified by any difference. A second check,
  `inkling check --ref` (`E src/main.rs:245-309`) against a llama.cpp reference
  dump, applies, since `llama.cpp@b12649-macos-arm64` loads the Q4_K_M (Key
  discovery, 017-research-7); its
  bound is upstream's published parity (61/61 argmax, worst KL 0.0026 on decode;
  25/25, worst 0.0069 after a 2,379-token prefill; `E README.md:150`).
- G1c, prefix reuse. On a captured 10-turn conversation, decoding after
  incremental prefill (including one forced rollback) and after full re-prefill
  agree on argmax at 63 of 64 positions or better, worst KL at most 0.01. The two
  paths chunk the prefill differently, so exact equality is not expected.
  Falsified below either bound.
- G1d, qwen-code end to end. Three `qwen_oneshot` runs pinned to a hand-launched
  server each complete a task that reads, edits and tests a file, with every
  tool call parsed, no `upstream_api_error`, and a rollback rate under one in
  ten requests. Falsified by a parse failure, an API error, or more rollbacks.

**P2: Provenance and keepalive (this repo, items 2-4).**

Entry condition: the hellmini Command Line Tools update and the user-level Rust install happen only after Sam has approved them to the labrun session directly and labrun has scheduled them in a held-pool window. The labrun reply is recorded on bead `qwen-coprocessor-stack-ijzg` before G2a runs.

Gates:

- G2a, reproducible build. Laptop and hellmini builds of the same commit have
  the same sha256. Both hosts must match on: Rust 1.95.0; `--locked`; the same
  RUSTFLAGS (the two `--remap-path-prefix` flags and `-C link-arg=-Wl,-S`); the
  same pinned target-dir path; and the same Command Line Tools, compared by full
  package version (`pkgutil --pkg-info=com.apple.pkg.CLTools_Executables`) and
  `ld -v`, not by the marketing number (017-research-12, 017-research-13). A
  mismatch in SDK or ld version is a setup error to fix before comparing, not a
  pass or fail of the build. Falsified by a difference with all of the above
  equal; then the binary is recorded as a single-host `self-built` entry and the
  cross-host route goes back to Sam, who picks between a CI build in the fork
  verified online, as overlays are, and that single-host record (inferred, not
  read: this is the existing fallback wording made explicit).
- G2b, refusal. The keepalive refuses a binary with one byte changed, a GGUF
  of the wrong size, and a missing file, logging `REFUSING` each time; with
  `QWEN_PROVENANCE_ENFORCE=0` it logs the bypass and launches. Falsified by a
  launch without a log line.
- G2c, unattended start. Under launchd, not a login shell, a cold start reads
  the GGUF from `/Volumes/SanHell` and serves within `LOAD_BUDGET`. This is the
  TCC check: Full Disk Access is granted to `/bin/bash`, and it is not yet known
  whether a plain Mach-O exec'd by bash needs a grant of its own, the way
  `Python.app` did. Falsified by `Operation not permitted` or a silent hang.
- G2d, supervisor. `qwen_backends` lists `inkling-mac` healthy with
  `expected_build`; the same server started from a different commit reports
  unhealthy. No supervisor source change. Falsified if either probe result is
  wrong or a code change turns out to be needed (then that change gets its own
  bead).
- G2e, interleaving. Two concurrent `qwen_spawn` sessions pinned to
  `inkling-mac`: after each session's first request, no request prefills more
  than its new suffix plus 2,048 tokens. Falsified by a full re-prefill on a
  switch.
- G2f, coexistence. With vision-mac, embed and rerank up and a 128K context
  filled, peak memory and `free_gb` are recorded, and the backstop defers a
  respawn when it should. This is a recorded measurement, not pass/fail; the
  number feeds Decision 6.

**P3: Battery (item 5).** Arm A uses effort 0.9, the template default that
`gajx` ran under, so the comparison with run-013 isolates the runtime. Arm B,
at effort 0.1, runs if A passes, or once if A fails (Decision 5). For
each dispatch, record wall time, tool calls, prompt seconds, decode tok/s, peak
context and rollbacks. Gates:

- G3a, pass rate 9/9. Falsified at 8/9 or below: the stop applies after arm B
  (if arm A failed and arm B also fails at 8/9 or below, stop, record, not
  adopted).
- G3b, speed. The median must be below 134 s, the best Inkling battery measured
  (bead `ssea`: Unsloth fork b12651-mix, Q4 + dspark), or the faster runtime
  bought nothing on the loop that matters. Falsified at or above 134 s.
- G3c, SWE-bench trigger. At 9/9, a median at or below 67 s (half of 134 s, decided (Decision 7)
  as the "large gain" in Sam's earlier rule) triggers the gold-clean 25
  rerun under the existing protocol, compared with `gajx`'s 15/25. Above 67 s,
  no SWE-bench run.
- Pooling follows Decision 6: `pin_only` stays unless 9/9 at a median within 1.5x of
  Coder-Next MLX (about 47 s), then pooled with `roles: ["code"]`.

**P4 (`.ikv` segment cache): deferred by Sam on 2026-11-28 (gate round 1, finding S7). Entry conditions and gates are in the Deferred section.**

**Options considered for where the server lives.**

- A module in the erisinky fork (chosen). P1-P3 touch one repo, and nothing is
  moved when the deferred P4 starts.
- A sidecar that drives the `inkling` CLI. Rejected: `run` loads the 16 GiB
  engine per call (`E src/main.rs:156-158`), and `chat` holds a session but
  exposes no tool parsing or sampling control over stdin.
- A crate in this repo. Rejected: the server links GPL-3.0 code and this repo
  is MIT.
- Everything in an inkling-ikv fork from P1. It would work, but it puts the
  pinning of two repos and the `../inkling-engine` path fix on the critical path
  before anything shows Inkling is worth serving.

## Research Findings

- **F1 (2026-11-28, bead ijzg).** erisinky `4be5bed`, Rust 1.95, Q4_K_M,
  M4 Max: prefill 1064-1074 tok/s at 2,394 tokens on the fallback path
  ("unexpected tensor accumulator layout"), decode 78.9-79.9 tok/s over 4 reps,
  84.5 short greedy; at 28.5K, prefill 762 and decode 53.7.
- **F2 (2026-11-28).** The GGUF header: arch `inkling2_loop`, context length
  1,048,576, sliding window 1,024, `rope.dimension_count = 0`,
  `general.sampling.temp = 1.0`, EOS 200006 =
  `<|content_model_end_sampling|>`, 15 non-unused special tokens, template as
  summarized above.
- **F3 (2026-11-28).** qwen-code 0.15.6 request shape and `read_file` transform
  as cited in Context. Not yet checked against the CLI binary that the SDK
  spawns through the RDR-002 wrapper; P0 does that.
- **F4 (2026-11-28).** `inkling-ikv` keys cartridges by FNV-1a 64 of its own
  document framing and records no model identity; its OpenAI proxy exists only
  in `DESIGN.md`.
- **F5 (2026-11-20/24, beads gajx, ssea).** The comparison numbers: the `gajx`
  trial (b12588-mix, UD-Q8_K_XL + dspark) scored battery 9/9 at median 153 s
  (run-013); the `ssea` re-measure (b12651-mix, Q4 + dspark, decode median
  20.0 tok/s) scored 9/9 at median 134 s, the best Inkling battery on record and
  the baseline here (T2 `inkling-2-mini-unsloth-1p9x-claim-check-2026-11-24`).
  SWE-bench for `gajx` is 15/25 after the `hbjw` re-score (see Key
  discoveries); bead `ijzg`'s description still says 14/25.

Key discoveries (2026-11-28, T2 `qwen-coprocessor-stack_rdr/017-research-1..13`).
These settle every item the draft left to "discover at implementation" except
whether the model ever emits `<|content_invoke_tool_text|>`.

- **✅ Verified** (source search) — The agentic path runs the global qwen-code
  0.15.6 `cli.js` through the RDR-002 wrapper, not the SDK's bundled CLI, so F3
  holds for the binary that runs. `QWEN_CODE_MAX_OUTPUT_TOKENS` is ignored when
  `contentGeneratorConfig.samplingParams` is set.
  *Source: supervisor `src/extensions.ts:60-100`, `src/session.ts:260-299`; cli.js:155912-155914*
- **✅ Verified** (source search) — qwen-code's 120 s client timeout covers only
  the wait for response headers, per attempt, with 3 retries; there is no stream
  idle timeout and SSE comment lines are ignored. A server that queues must send
  `200` and `text/event-stream` headers first, then `: ping` comments. Holding
  the headers past 120 s makes qwen-code retry and queue duplicate requests.
  *Source: cli.js:147117-147118, 149652, 155458-155475, 155788-155797*
- **✅ Verified** (source search) — `multistream::parse_json` handles nested
  JSON, surrogate pairs, exponents and literals, but needs a depth cap, a
  trailing-data check, an error on lone surrogates and rejection of unknown
  escapes before it takes OpenAI bodies; `webui.rs` silently truncates bodies over
  1 MiB. Tool-call `arguments` must be parsed to objects before templating, so the
  parser is on the critical path.
  *Source: E src/multistream.rs:276-471, src/webui.rs:476-482; template lines 107-109*
- **✅ Verified** (source search) — The template renders tool calls only as
  `<|content_invoke_tool_json|>`; `<|content_invoke_tool_text|>` has no render
  path. inkling-ikv's harness parses both the same way; erisinky parses neither.
  Whether the model emits the text form is still open and needs a live capture.
  *Source: template line 113; I src/harness/worker.rs:844, 856; E src/persona.rs:1095*
- **✅ Verified** (source search) — `gajx` SWE-bench is 15/25. The first scoring
  resolved 14, with `django__django-17087` crashing under emulation; it resolves
  on the `hbjw` re-score. run-013 holds battery data only.
  *Source: scripts/coding-eval/work/inkling-2-mini-q8.inkling-ns.json, work/ink-r2-hbjw/inkling-2-mini-q8.ink-r2-hbjw.json*
- **✅ Verified** (spike) — The build reproduces bit-for-bit across two checkouts
  at different paths (three builds, sha256 `6896d3bc...`) when four things are
  pinned: Rust 1.95.0, `--locked`, `RUSTFLAGS` remapping the source path to
  `/build/erisinky` and `$CARGO_HOME` to `/cargo`, and the same `--target-dir`
  path. Without the remap, or with different target directories, the hashes
  differ, because the release profile's `debug = 1` embeds source and object-file
  paths. G2a pins the list in Item 2 and G2a: Rust 1.95.0, `--locked`, the RUSTFLAGS (remaps and `-Wl,-S`), the pinned target-dir path, and the same Command Line Tools (017-research-13). The test covered one machine; across two machines
  the SDK and linker versions stamped in the Mach-O header must also match
  (017-research-12).
  *Source: builds in the session scratchpad, 2026-11-28*
- **✅ Verified** (spike) — Mainline llama.cpp b12649 (manifest
  `llama.cpp@b12649-macos-arm64`, tarball sha256 matches) loads the Q4_K_M and
  answers correctly on the M4 Max at 33.5 tok/s decode, so G1b can dump reference
  logits with a manifested runtime. erisinky decodes about 2.4x faster on the same
  machine.
  *Source: `llama-completion -m <Q4_K_M> -p "The capital of France is" -n 12 --temp 0`*
- **✅ Verified** (spike) — `inkling-ikv check -n 32 -c 8192`, run from the repo
  root, reproduces upstream's stitching KL on the M4 Max: naive FP16 stitch mean
  0.0289 (worst 0.476), prefix-conditioned 0.0170 (worst 0.247), time to first
  token 12.7x lower than full prefill. Seam 16 lowered mean KL in all three
  pairings, against the write-up's advice. Run from another directory, the check
  silently substitutes generated Rust and reports 0.062.
  *Source: I src/ikv.rs:3347-3372; check logs in the session scratchpad*
- **✅ Verified** (spike) — `inkling-ikv task-bench --with-kv4 --effort 0.1 -n 1024`:
  raw prefill 25/25, `.ikv` K3V2 17/25, `.ikv` KV4 19/25. The losses are
  multi-file binding tasks (RULER variable tracking and multi-needle; KV4 also
  two multi-hop code tasks). Time to first token falls 38x on the 34K code suite
  and 28x on the 15K RULER suite. With the README's default `-n 256`, every
  failure is a token-cap truncation (raw 11/25). The sparse pool is skipped on
  M4 ("requires M5 fp16 tensor path"). G4's KL thresholds alone would pass a
  configuration that loses a quarter of these tasks, so P4 needs a task gate too.
  *Source: task-bench JSON in the session scratchpad*
- **✅ Verified** (source search) — Cartridges carry an attention-temperature
  mismatch that grows with mount offset: their global-layer queries ran at
  tau = 1.0, but a live mount at offset p uses tau = 1 + 0.1 ln(p/8192), which is
  1.14 at 32K, 1.25 at 100K and 1.35 at 256K. Every upstream check runs at 8K or
  less, where tau = 1. Its effect at real agent offsets has not been measured.
  *Source: E src/prefill.metal:460, 498, 502; src/kv256k.rs:2301*
- **✅ Verified** (spike) — hellmini is an M5 Pro (24 GB, Command Line Tools 27.0
  only, no Rust). The M5 tensor path and the sparse pool should run there, but the
  engine's 16.3 GiB resident set does not fit beside the 14 GB CI pool, and the GPU
  wired limit is the default. No Metal compiler is needed (shaders compile at
  load), so for running benchmarks the laptop build can be copied there. For the
  reproducibility check, Rust 1.95.0 will be installed user-level and the Command
  Line Tools will be updated to 27.2 before G2a (Decision 3, P2 entry).
  *Source: `ssh hellmini sysctl/sw_vers/df`, 2026-11-28*
- **✅ Verified** (source search) — The Mach-O header of the build records the macOS SDK (27.2) and the linker version (27106.1) of the machine that built it; hellmini has SDK 27.0 and ld-27037.1. A cross-machine match therefore needs the same Command Line Tools on both hosts.
  *Source: `otool -l target/release/inkling` (LC_BUILD_VERSION); `ld -v` and the SDK list on both hosts, 2026-11-28 (017-research-12)*
- **✅ Verified** (spike) — The binary also carries absolute object-file paths in its linker debug map (N_OSO entries): the Rust toolchain install path and the target directory. `--remap-path-prefix` does not change them. With only the toolchain install path changed, the hash changed; with `-C link-arg=-Wl,-S` both builds gave the same hash (8a0cdf4497b9e278) and no debug-map entries.
  *Source: `nm -a target/release/inkling`; gate round 2 spike, 2026-11-28 (017-research-13)*

## Consequences

### Positive

- Inkling becomes reachable from every existing path (`qwen_spawn`,
  `qwen_dispatch`, the battery) with no supervisor change, because the server
  answers the routes the health probe already uses.
- The runtime gets the same accounting as every other served artifact: a commit,
  a toolchain, a lockfile hash, a binary hash reproduced on a second machine once both hosts run the same
  Command Line Tools (Decision 3) and the pinned build flags.
- The source-build path is generic. Any later source-built runtime goes through
  `add-source-build` and `source_repos` instead of a one-off exception.
- The `.ikv` work is deferred (see the Deferred section) until P3 passes and a
  repair design exists, and the cache design cannot serve stale content by
  construction.

### Negative

- We maintain a fork with a server upstream does not have; each upstream sync
  re-runs G1a-G1c.
- A single-stream engine behind a round-robin pool queues concurrent sessions.
  Parked contexts remove the re-prefill cost of switching, not the wait. That is
  one reason `pin_only` stays until P3.
- The renderer is a second implementation of T, and T may change with a new
  GGUF. G1a is the guard and must run on any GGUF change.
- `.ikv` mounting is an approximation by construction: a segment's KV was
  computed without the prefix it is mounted after. The logit-parity gate in the
  Deferred section bounds the error and cannot remove it.
- Effort 0.9 thinking counts against `max_tokens`; a low cap would truncate tool
  calls mid-write (eval rule 4). The battery's 16,384 covers it; ad hoc callers
  may not.

### Neutral

- GPL-3.0 obligations attach to distribution; the binary is built and run
  locally. The MIT repo holds only config, keepalive and provenance changes.
- The M4 Max runs prefill on the fallback path, so prefill-heavy numbers here
  will trail upstream's M5 figures. Decode is the measured win.
- erisinky and coder-mac fit in memory together (about 26 GiB plus about 45 GB)
  but share 546 GB/s of bandwidth, so both slow down under concurrent load.
  Measurements in this RDR run with coder-mac off.

## Deferred: .ikv segment reuse (P4)

Deferred by Sam on 2026-11-28 (gate round 1, finding S7). P4 starts only when both hold: P3 has passed (G3a and G3b), and a design exists for a stitching repair (for example selective recompute of cross-file tokens) that is expected to meet G4e. On 2026-11-28 the unrepaired stitch scored 17/25 (K3V2) and 19/25 (KV4) against 25/25 for full prefill (Key discoveries), so G4e cannot pass without one. The fork `Hellblazer/inkling-ikv` already exists and is kept; nothing else for P4 is built or allowlisted before entry.

At P4 entry the server gains a `SegmentSource` hook (a trait with a no-op default) so that cached segments can be supplied without forking the server.

6. **`.ikv` segment cache (P4, only if P3 passes).** A `SegmentSource`
   implementation in the existing Hellblazer fork `Hellblazer/inkling-ikv` (Decision 2), which already holds the
   codecs, stitching and preemptible packing, with its engine dependency changed
   from the `../inkling-engine` path to a pinned git revision of
   `Hellblazer/erisinky`. The binary `inkling-ikv serve-openai` calls the server
   in E's library with that source.
   - Segments: the content of `tool` and `user` messages at or above 1,024
     tokens. The template puts a special token on both sides of message content
     (T:76), so the content tokenizes the same alone as in place.
   - Key: sha256 of the exact content bytes from the request, plus the GGUF
     sha256 from the manifest, a framing id (`msg-content:v1`), and the codec.
     Never a path or mtime. A miss can never mount a different version of a file.
   - Fill: tee-on-miss. When a segment is prefilled live, its global KV is
     quantized to WHT-KV4 and written in the background between requests. The
     offline 8-token sink-prefix packing applies to segments packed outside a
     request.
   - Use: a segment that falls outside the live prefix (a re-read of an
     unchanged file, a context rebuilt after a parked context was evicted,
     another spawn over the same worktree) is stitched instead of prefilled. If
     the segment sits within the final 1,024 tokens, its last 1,024 tokens are
     prefilled raw to rebuild exact SWA and conv state, as the harness's
     mid-file path does.
   - Store: out of tree (`~/Library/Caches/qwen-coprocessor-stack/ikv/`, internal
     storage), LRU byte cap, `F_NOCACHE` reads as upstream does.

**P4: `.ikv` segment cache (entry: P3 has passed (G3a and G3b) and a stitching repair design exists;
P4 builds on the existing `Hellblazer/inkling-ikv` fork).** The thresholds below are declared now, before any
data; changing them needs Sam.

- G4a, logit parity. On 20 request sequences captured during P3, for the first
  32 generated positions with segments mounted against fully prefilled: mean KL
  at most 0.02, and argmax agreement at least 31/32 in the median sequence.
  Upstream measured 0.014-0.020 with 16/16 on slices. Falsified above either
  bound: the cache does not ship.
  Measured at mount offsets of 8K, 32K and 100K tokens, not only at 8K or less,
  because the log-position temperature mismatch is zero below 8K (Key
  discoveries); each offset must pass on its own.
- G4b, task non-inferiority. Battery with the cache on, 3 repeats: pass count
  at least that of the cache-off run (9/9), and no failure traced to a file
  mix-up in the transcript. Falsified by a lower pass count.
- G4c, benefit. On replayed SWE-bench trajectories from P3 or `gajx`, the sum of
  prefill seconds per instance drops by at least 30% and wall time does not rise.
  Falsified below 30%: the cache is removed rather than kept as complexity
  without payoff.
- G4d, staleness. A fuzz run that edits a file between two reads of it never
  mounts the old content's segment (checked by key in the server log).
  Falsified by one stale mount.
- G4e, task parity. `inkling-ikv task-bench --with-kv4 -n 1024` from the repo
  root, cache mode against raw prefill: the stitched mode scores at least 24/25
  where raw prefill scores 25/25. Falsified at 23/25 or below. On 2026-11-28 the
  unrepaired stitch scored 17/25 (K3V2) and 19/25 (KV4), so P4 does not pass
  without a repair such as selective recompute of cross-file tokens.

**Options considered for `.ikv` on our path.**

- K1, a server-side content-addressed segment cache (chosen). It works on
  whatever text qwen-code sends, needs no client change, and keys on bytes, so
  qwen-code's line trimming, 1,000-line cap and truncation header are part of
  the key rather than a mismatch. Its hits are limited to segments that fall
  outside the live prefix. Within one session the prefix cache already holds
  every earlier tool result, so the gain shows on re-reads, on evicted
  contexts, and across spawns over the same tree, not on a short battery task.
  G4c measures whether that is enough.
- K2, `inkling-ikv` as a dispatch agentKind. It is measured upstream (M9: 6/6
  rubric, `E README.md:159`) and needs no server. But it is a TUI with its own
  seven tools (`I src/harness/tools.rs:560-573`) and its own sandbox, so its
  results would not compare with qwen-code arms. It has no headless task mode
  or harvest envelope (RDR-009). It writes `.shadow-ikv/` inside the working
  tree by default (`--shadow` default `<dir>/.shadow-ikv`), which would land in
  patches, and its header carries no model identity.
- K3, pre-packing the worktree's files. A cartridge of a file's raw bytes
  matches what qwen-code sends only for files of at most 1,000 lines with no
  trailing whitespace (Q:84712, Q:291450). Matching more means reproducing
  qwen-code's read transform, which couples the cache to one CLI version.

## Decisions (Sam, 2026-11-28)

Each was put to Sam one at a time in session pyrrho with the options and the
recommendation the draft carried; his choice is recorded as given.

1. **Where the server code lives:** in `Hellblazer/erisinky`, as `src/openai.rs`
   and an `inkling serve-openai` subcommand, for P1-P3. P4 draws cartridge code
   from the inkling-ikv fork.
2. **Forking `Eriskii/inkling-ikv`:** fork now, not at P4 entry.
3. **How the runtime is verified:** a reproducible build whose sha256 must match
   on the laptop and on hellmini. The binary records the SDK and linker versions
   (017-research-12), so hellmini's Command Line Tools are first updated to the
   laptop's 27.2, and Rust 1.95.0 is installed user-level under `hhildebrand`
   (re-decided by Sam on 2026-11-28 after gate round 1; both are installs on a
   shared CI host, approved by Sam in session pyrrho; labrun also needs his word directly). The labrun session replied on 2026-11-28 that no
   mac CI job pins CLT 27.0, but the mac-signing-rehearsal job and the hellmini
   release builds will see the new toolchain, so the install waits for Sam's
   direct approval to labrun. The pinned build also links with
   `-C link-arg=-Wl,-S` and a fixed target-dir path, because the binary's debug
   map records the toolchain and target paths (017-research-13; found in gate
   round 2).
4. **Allowlist and schema change:** approved. `source_repos` admits
   `Hellblazer/erisinky` now and `Hellblazer/inkling-ikv` at P4 entry (amended
   2026-11-28 by Decision 10); trust tier `self-built`; reason of record: this
   RDR.
5. **Effort for agentic requests:** P3 arm A at 0.9; arm B at 0.1 only if A
   passes, or once if A fails.
6. **Pool policy after P3:** stays `pin_only` unless the battery is 9/9 at a
   median within 1.5x of Coder-Next MLX (about 47 s); then pooled with
   `roles: ["code"]`, and coexistence with coder-mac is decided at that point.
7. **SWE-bench trigger:** a battery median at or below 67 s at 9/9.
8. **Baseline:** 134 s from bead `ssea`; 153 s (`gajx`) kept for reference.
9. **P4 gates:** tightened. G4a is measured at mount offsets 8K, 32K and 100K;
   G4e (task parity, at least 24/25 against raw 25/25) is added. G4b-G4d stand.
10. **P4 scope:** deferred within this RDR (2026-11-28, after gate round 1
    finding S7). Entry conditions and the gate text are under Deferred:
    .ikv segment reuse (P4); Decision 9's tightened gates apply there.
