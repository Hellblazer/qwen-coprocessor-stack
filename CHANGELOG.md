# Changelog

All notable changes to the qwen-coprocessor-stack are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

As of 0.11.1 the supervisor ships as a published npm package
(`qwen-agent-server`); the Claude Code plugin's `mcpServers` runs it via
`npx -y qwen-agent-server@<version>`, and the marketplace installs the
plugin from a `git-subdir` source pinned to the release tag (tracked
files only — no working-tree copy). The two artifacts of interest to
operators are the **published supervisor** (`npx qwen-agent-server`) and
the **Claude Code plugin** at `.claude-plugin/plugin.json`.

## [Unreleased]

## [0.11.7] - 2026-06-12

Routes agentic coding away from the backend that crashes on it (bead `081`).

### Added

- **Backend `no_agentic` flag**: excludes a backend from the AGENTIC pool
  (`chooseBackend` → `qwen_spawn`/`qwen_oneshot`) while keeping it for
  DIRECT dispatch (`qwen_chat` by modality/role) and `qwen_tokenize`. An
  explicit `opts.backend` pin still overrides.
- **Config**: `coder-box` tagged `no_agentic: true`. Agentic coding now
  routes only to coder-mac (MLX, which survives it); coder-box continues
  serving fast direct `qwen_chat` (role="code") + tokenize.

### Notes

- `081` resolution: Coder-Next on the box (qwen3_next / Gated-Delta-Net,
  llama.cpp Vulkan) reliably crashes on the qwen-code *agentic* request
  shape. Confirmed unfixed by dropping `--cache-reuse`, by `--no-kv-unified`
  (which instead crashes warmup), by a full box reboot, AND by upgrading
  the build b9596 → **b9611** (tested 2026-06-12 — coder-box still crashed
  the agentic oneshot). A *direct* `/v1/chat/completions` to the same
  backend is fine. So the supervisor routes around it rather than waiting
  on an upstream llama.cpp Vulkan fix. coder-mac handles agentic; the box
  is fully used for direct operator dispatch + vision.

Explicit role-based routing for `qwen_chat` (bead `k8j`).

### Added

- **Backend `roles` field** + **`chooseBackendByRole`** + **`qwen_chat`
  `opts.role`**: route operator dispatch to a backend by an explicit,
  operator-assigned role rather than a hardcoded id. Resolution
  precedence in `qwen_chat`: `opts.backend` (id pin) > `opts.role` >
  default (text, multimodal fallback). `roles` is a *soft* routing hint,
  distinct from `modality` (a hard capability) — so a `vision_only`
  multimodal backend can still be reached for text via a role (it stays
  out of the agentic text pool, but role routing ignores that).
- **Config tags** (`config/coprocessor-pool-vision.json`): coder-mac /
  coder-box → `roles:["code"]`; the 35B (vision-box) → `roles:["general",
  "reasoning"]`. So `qwen_chat role="code"` hits the fast Coder-Next pool
  (bulk operator dispatch) and `role="general"/"reasoning"` hits the 35B
  (reasoning/judgment operators) — the *same already-loaded vision model*,
  no extra backend.

### Notes

- Settles `k8j` empirically: a clean direct-vs-direct A/B showed
  Coder-Next handles bulk operator tasks well and ~9× faster, while the
  35B wins on reasoning (e.g. the "9.9 vs 9.11" trap Coder-Next fails).
  Hence explicit per-call role selection rather than a single default
  model or a magic auto-router. `qwen_oneshot`/`qwen_spawn` (agentic,
  coding) are unchanged.

Adds `qwen_chat` — a direct text chat-completion dispatch path for
operator/general work, bypassing the qwen-code agentic harness.

### Added

- **`qwen_chat` MCP tool** (bead `5h5`): POSTs `system`+`user` straight to
  a backend's `/v1/chat/completions` (the text twin of
  `qwen_oneshot_vision`) — no `@qwen-code/sdk`, no agentic preamble, no
  tools. For operator dispatch (extract/summarize/classify/judge/answer).
  Supports `json_schema` (→ `response_format`, parsed into `result.parsed`),
  GBNF `grammar` passthrough, `system`, `no_think` (default true),
  `temperature`, `max_tokens`, and thread `continuation_id` (shared store
  with `qwen_oneshot`/`_vision`). Routes to a `text` backend (multimodal
  fallback); pin a general-instruct model via `opts.backend`.

  Rationale (beads `081`/`k8j`): routing simple operator tasks through the
  qwen-code agentic harness was the root cause of three problems measured
  2026-06-12 — ~20 s latency (preamble prefill) vs ~3–5 s direct;
  prompt-echo on terse instructions; and the coder-box crash (`081`, which
  is the agentic request, not direct chat). `qwen_chat` sidesteps all
  three and is backend-agnostic. `qwen_oneshot`/`qwen_spawn` remain the
  agentic path for real coding-agent work. Verified end-to-end against the
  live 35B (`general-box`): `qwen_chat` → "Tokyo" in 4.6 s.

Fixes the agentic tools (`qwen_oneshot` / `qwen_spawn`) failing in the
published package. They spawn the qwen CLI through
`scripts/qwen-extensions-wrapper.sh`, but `package.json` `files: ["dist"]`
excluded it from the npm tarball — so the published supervisor failed with
`Invalid pathToQwenExecutable: … qwen-extensions-wrapper.sh not found`. The
direct-dispatch tools (embed/rerank/tokenize/extensions/backends) were
unaffected (they don't spawn the CLI), which is why it surfaced only on a
full shakeout. Audited all out-of-`dist` runtime file resolutions; the
wrapper is the only one.

### Fixed

- **Publish the wrapper script**: `files: ["dist", "scripts"]` so
  `scripts/qwen-extensions-wrapper.sh` ships in the npm tarball. Verified
  via `npm pack --dry-run`. Server republished; npx pins `@0.11.4`.

## [0.11.3] - 2026-06-11

Fixes the supervisor never starting under npx/bin launch. 0.11.1/0.11.2
wired `mcpServers` to `npx -y qwen-agent-server`, but the server's
main-module guard was `process.argv[1].endsWith("server.js")` — false for
every symlinked launch (`npx`, `npm i -g`, `node_modules/.bin/...`), where
argv[1] is the bin symlink (".../qwen-agent-server"). So `main()` never
ran, the process exited 0 silently, and the MCP client reported "Failed to
connect". The earlier `node ${CLAUDE_PLUGIN_ROOT}/.../dist/server.js`
launch masked it (argv[1] ended in `server.js`); the npx switch exposed it.
Every in-process unit test passed throughout (they import the module, which
correctly skips `main()`), so nothing caught it.

### Fixed

- **Entrypoint detection is now symlink-robust** (`src/server.ts`): resolve
  `realpath(process.argv[1])` and compare to this module's own realpath,
  with a name-suffix fallback. Works for `node server.js`, npx, global
  install, and `.bin` symlink launches.
- **Regression test** `tests/entrypoint.test.ts` spawns the built server
  through a symlink named `qwen-agent-server` and asserts it answers
  `initialize` — the exact production launch path, which no prior test
  exercised.

Versions bumped `0.11.2 → 0.11.3` in lockstep (server republished).

## [0.11.2] - 2026-06-11

Fixes the plugin source so installs are scratch-immune. 0.11.1 pointed
the marketplace at a `git-subdir` source with `path: "."`, but Claude
Code's `git-subdir` only resolves a plugin living in a **subdirectory** —
`"."` sparse-checks out just the repo's top-level files, omitting
`.claude-plugin/`, so the plugin had no manifest. (Plain `git` is an
unsupported source type.)

### Changed

- **Plugin relocated to `plugins/qwen-stack/`** (manifest + the five
  skills: `backends`, `budget`, `defaults`, `extensions`, `status`),
  matching the ecosystem layout. `marketplace.json` plugin source is now
  `git-subdir` with `path: "plugins/qwen-stack"`, `ref: v0.11.2` — installs
  clone only that subtree.
- **Supervisor republished as `qwen-agent-server@0.11.2`** (no code change
  from 0.11.1; version bumped only to keep the strict parity gate —
  `SUPERVISOR_VERSION` == plugin == marketplace — passing). Plugin
  `mcpServers` pins `npx -y qwen-agent-server@0.11.2`.

## [0.11.1] - 2026-06-11

Packaging release: make the plugin installable without copying the
working tree. Previously the marketplace used a directory source, so
`plugin install` recursively copied the entire repo — including
gitignored runtime weights and eval scratch (24 GB+ at worst) — and hung.

### Changed

- **Supervisor distributed via npm.** `mcp-bridges/qwen-agent-server`
  `package.json` un-`private`d, gains `bin` + `files: ["dist"]`, drops
  the dev-only `postinstall: tsc` (replaced by `prepublishOnly`), and the
  entrypoint gains a `#!/usr/bin/env node` shebang. The plugin's
  `supervisor` MCP server now runs `npx -y qwen-agent-server@0.11.1`
  instead of `node ${CLAUDE_PLUGIN_ROOT}/.../dist/server.js`. Rationale:
  `@qwen-code/sdk` self-locates and spawns its own on-disk CLI, so the
  server cannot be bundled into a single file — `npx` lets the registry
  resolve the 56 MB SDK + deps at run time (bead `7e1`).
- **Marketplace plugin source → `git-subdir` @ `v0.11.1`.** Installs now
  clone only tracked files; `models/`, `node_modules/`, and eval scratch
  are never copied.
- **bge embed/rerank models relocated out of the repo.**
  `start-embed-server.sh` / `start-rerank-server.sh` default `MODELS_DIR`
  to `~/.qwen-coprocessor-stack/models` (legacy `$ROOT/models` fallback),
  keeping the plugin source tree small.

## [0.11.0] - 2026-05-21

A consolidated minor release covering everything since 0.10.0. The
intermediate `0.10.1` in `plugin.json` was an in-tree bump that never
shipped as a git tag — its sole fix (`61j`) is folded in below.

### Added

- **`qwen_embed`, `qwen_rerank`, `qwen_tokenize` MCP tools** with
  progress notifications (`515ece0`, bead `q42`). Routed by declared
  backend modality (`embedding` / `rerank` / `text`) via
  `chooseBackendByModality`; bypass the SDK/Qwen-CLI pipeline and POST
  to backend `/v1/...` directly.
- **`continuation_id` threading** across `qwen_oneshot` and
  `qwen_oneshot_vision` (`63fe8fc`, bead `25f`). 3 h TTL, 20-turn cap,
  in-process only. Cross-tool threading supported — vision can
  continue an oneshot thread (prior images replaced with
  `[image attached in prior turn]` placeholders, v1 limitation).
- **GBNF grammar passthrough** on `qwen_oneshot_vision`
  (`974ed32`) via `opts.grammar`. Strictly stronger than
  `json_schema`; emitted as llama-server's `grammar` field for
  token-by-token constrained decoding.
- **Backend `modality` field** plus `active_sessions` count and
  `qwen_oneshot.elapsed_ms` reporting (`0511afa`). Backends can declare
  `text` / `multimodal` / `embedding` / `rerank`.

### Changed

- **Shared OpenAI-compat dispatch helper** factored out of the vision
  and embedding paths (`e6ea649`, bead `zaz`); also adds optional
  `auth` / `headers` fields to `Backend` for backends that need bearer
  tokens or custom headers.
- **README setup uses `hf` rather than the deprecated
  `huggingface-cli`** (`bfebbd8`, bead `q42`).

### Fixed

- **`chooseBackend` modality filter** (bead `w63`). The chat-dispatch
  router (`qwen_spawn`, `qwen_oneshot`) ignored `Backend.modality`,
  letting chat tasks land on embedding/rerank backends — those don't
  implement `/v1/chat/completions` and the call failed immediately.
  `qwen_oneshot_vision` shared the bug and would route to embed/rerank
  backends, then waste a roundtrip before failing with
  `backend_no_mmproj`. `chooseBackend` now restricts the candidate
  pool to `modality ∈ {text, multimodal, unset}` after the explicit-
  pin step (pin still bypasses the filter — caller authority); the
  local-fallback step uses the same filter.
  `qwen_oneshot_vision` switched to `chooseBackendByModality("multimodal")`
  for correct selection and fast-failure when no multimodal backend is
  configured.

- **Upstream API error detection in `qwen_oneshot`** (bead `61j`,
  originally bumped `plugin.json` to 0.10.1 but never tagged — folded
  into 0.11.0). The Qwen CLI surfaces upstream HTTP / streaming / tool
  failures by writing a bracketed sentinel (`[API Error: ...]`,
  `[Stream Error: ...]`, `[Tool Error: ...]`) to stdout and exiting 0.
  The supervisor was treating that as a successful turn.
  `matchUpstreamCliError()` now detects the sentinels once the session
  reaches idle/complete and sets `error.code='upstream_api_error'`
  without retrying.

## [0.10.0] - 2026-05-17

### Added

- **`qwen_oneshot_vision` MCP tool** — stateless multimodal dispatch.
  Accepts `{task, images, opts?}` where `images` is an array of
  `{path}` / `{url}` / `{base64, mime}` discriminated-union entries.
  Bypasses the `@qwen-code/sdk` pipeline (which is text-only — the
  SDK's `ContentBlock` union has no `ImageBlock`) and POSTs OpenAI-
  compatible content arrays directly to the chosen backend's
  `/v1/chat/completions` endpoint. Returns a `VisionOneshotResult`
  with `ok` / `result` / `parsed` / `usage` / `elapsed_ms` /
  `backend_id` / `error` parity with `qwen_oneshot`.

  Backend selection mirrors `qwen_spawn`'s `chooseBackend` logic;
  `opts.backend` pins to a specific backend id. `opts.json_schema`
  emits `response_format.json_schema` with `strict: true`.
  `opts.no_think` defaults to true (prepends `/no_think` to the user
  message to suppress thinking-mode reasoning that would otherwise
  eat the token budget on vision tasks).

  Error code `backend_no_mmproj` is set when the backend rejects the
  request with the llama-server hint *"image input is not supported
  - hint: if this is unexpected, you may need to provide the
  mmproj"*. Callers can route around or fail cleanly.

- **`scripts/start-stack.sh` and `scripts/launch-llama-vulkan.cmd`
  enable multimodal via `--mmproj`.** The Mac/Metal local backend
  picks up an optional `MMPROJ_FILE` env var (defaults to
  `mmproj-Qwen3.6-27B-F16.gguf` in `models/`) and prints which mode
  it lands in. The Windows / Strix Halo launch hard-wires the BF16
  35B-A3B projector at `D:\models\mmproj-Qwen3.6-35B-A3B-BF16.gguf`.

  **Prerequisite for operators** wanting multimodal: download the
  matching `mmproj-*.gguf` from the same HuggingFace repo as the LM
  weights, place it alongside the model file (matching name pattern),
  and restart `llama-server`. `/v1/models` reports `capabilities`
  including `'multimodal'` once the projector is loaded.

### Notes for integrators

- Existing `qwen_oneshot` and the rest of the SDK-backed tool surface
  remain text-only and unchanged. `qwen_oneshot_vision` is a separate
  code path that does not affect the supervisor's session pool or
  KV-cache affinity (the multimodal call is stateless per-request).
- `cache-reuse` is silently disabled by `llama-server` in multimodal
  mode, per upstream behaviour. The launch flag stays set on the
  Strix Halo box; the downgrade is logged at model-load time.

## [0.9.0] - 2026-05-16

### Fixed

- **Supervisor pino loggers redirected to stderr** ([#1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1)).
  Default pino destination is stdout; the supervisor is an MCP stdio
  server, so log lines were interleaving with the JSON-RPC protocol
  channel. Claude Code's MCP plugin tolerated the noise; the reference
  Python MCP SDK rejected it with strict `JSONRPCMessage` pydantic
  validation. Discovered when running nexus's spike-D tier-B bench
  through a Python `mcp.ClientSession`. New shared `createLogger(name)`
  factory in `mcp-bridges/qwen-agent-server/src/log.ts` binds every
  logger to `pino.destination(2)`. Subprocess-level regression test
  asserts stdout is empty + stderr contains pino lines.

### Added

- **`docs/integrations/`** — durable record of downstream consumers.
  - `qwen-dispatch-nexus.md`: design sketch + shipped-state record for
    the nexus integration across operator dispatch, aspect extractor,
    and tier-B agentic tools.
  - `qwen-offload-audit-2026-05-14.md`: ranked candidate audit of
    nexus `claude_dispatch` / `claude -p` call sites.
  - `qwen-offload-2026-05-session-summary.md`: comprehensive
    session-end record (17 PRs, bench results, end-state per call
    site, what we know about Qwen3.6-35B-A3B as a coprocessor).
- **README "Downstream integrations" section** documenting the three
  nexus integration tiers, the `nx` Qwen Code extension prerequisite
  for tier-B routing, and the MCP-stdio protocol note about #1.

### Notes for integrators

Any third-party MCP-stdio client connecting to a pre-0.9.0 supervisor
binary will hit the `JSONRPCMessage` validation error described under
[Fixed]. Rebuild from `main` (or use 0.9.0+) before wiring in.

## [0.8.1] - 2026-05-09

### Fixed

- `qwen_oneshot` strips markdown code fences from JSON-conforming
  responses; the model occasionally wraps schema-valid JSON in
  ` ```json ... ``` ` despite the system-prompt directive.
- Bench harness: extract Claude answer from `structured_output`
  envelope key (prior versions walked `iterations[].message.content[]`,
  which is metadata only).

## [0.8.0] - 2026-05-09

### Added

- **`qwen_oneshot` MCP tool** — stateless single-turn dispatch:
  spawn → wait until idle → optional JSON parse + retry → stop.
  Drop-in shape for `claude -p --json-schema` operator dispatch.
- `SpawnOpts.thinking_mode` (default false; Qwen3.6 ships with
  thinking ON, causes ~6× output bloat on dispatch workloads).
- `SpawnOpts.json_schema` — passed through to the inner Qwen CLI for
  schema-constrained generation.
- `scripts/bench/` — A/B harness comparing `qwen_oneshot` against
  `claude -p --json-schema` across operator-shaped prompts.

## [0.7.0] - 2026-05-08

### Added

- Backend-derived `session_budget` defaults: `max_context_tokens`
  default is now `floor(0.85 × backend.ctx_size)` when the backend
  declares one.
- `qwen_sessions` MCP tool — live overview of pooled sessions
  (task_id, backend, state, last-poll, turns, budget counters).

## [0.6.0] - 2026-05-07

### Added

- Live `budget` field on every `qwen_poll` response carrying
  `est_tokens / max_tokens / tool_calls / max_tool_calls`. Event-only
  pressure-threshold callers were missing early warning when a single
  oversized tool_result tripped multiple thresholds on one iteration.

## [0.5.0] - 2026-05-06

### Added

- `/qwen-stack:budget` slash command — operator-facing surface for
  the `session_budget` caps stored in
  `~/.qwen-coprocessor-stack/config.json`.

## [0.4.0] - 2026-05-06

### Added

- **Session budget guardrail** — caps on accumulated tool_result
  context and tool_call count abort a runaway session cleanly before
  the HTTP layer crashes with `ECONNRESET`. Two caps:
  `max_context_tokens` (chars/4 estimate, default 111k) and
  `max_tool_calls` (default 0 = unlimited).
- `context_pressure` event fires once each at 50 / 75 / 90 % of
  `max_context_tokens` for long-running pollers that want to wind
  down gracefully.

## [0.3.1] - 2026-05-05

### Fixed

- Drop dead `currentTarget` reference; strip the `Type` suffix from
  `info.source` event payloads.

## [0.3.0] - 2026-05-05

### Added

- `/qwen-stack:extensions` and `/qwen-stack:defaults` skills — list
  installed Qwen Code extensions; manage the session-default extension
  list applied when a spawn doesn't specify `opts.extensions.only`.
- Plugin renamed from `qwen-coprocessor-stack` to `qwen-stack`.

### Removed

- Admin gate. Slash commands no longer require an opt-in flag; they
  enforce their own scope.

## [0.2.1] - 2026-05-05

### Added

- `/qwen-status` overview slash command — plugin version, supervisor
  process, build freshness, backends + health, env overrides, red flags.

## [0.2.0] - 2026-05-04

### Added

- `/qwen-stack:backends` slash command — backend lifecycle management,
  edits `~/.qwen-coprocessor-stack/config.json` in place; supervisor
  hot-applies on next spawn.
- Hot reload of the config file (mtime-cached) — no supervisor
  restart needed on config edits.

## [0.1.0] - 2026-05-04

### Added

- Initial release as a Claude Code plugin
  (`.claude-plugin/plugin.json`).
- MCP supervisor exposing `qwen_spawn / qwen_poll / qwen_send /
  qwen_stop / qwen_backends`.
- Multi-backend pool with KV-cache affinity per task_id.
- Per-spawn extension loadout (RDR-002): `opts.extensions: {enable?,
  disable?, only?}` wired through the qwen-extensions wrapper script.
