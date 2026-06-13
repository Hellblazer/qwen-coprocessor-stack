# qwen-coprocessor-stack

Locally-hosted Qwen 3.6 wired into Claude Code as an MCP coprocessor.
Claude Code runs unmodified with normal subscription auth; Qwen is
exposed as a small set of MCP tools that Claude can call to delegate
cheap or bulk work to long-lived, supervised inference sessions.

The supervisor is a TypeScript MCP server
([`mcp-bridges/qwen-agent-server`](mcp-bridges/qwen-agent-server)) that
manages session lifecycle, backend routing, KV-cache affinity, and
permission gating on top of [`@qwen-code/sdk`](https://www.npmjs.com/package/@qwen-code/sdk).
Any OpenAI-compatible endpoint serving a Qwen 3.6 GGUF works as a
backend; the standard deployments are llama.cpp Metal on Apple Silicon
(Qwen 3.6 27B) and llama.cpp Vulkan on AMD Strix Halo (Qwen 3.6 35B-A3B).

Full design rationale: [`docs/rdr/RDR-001`](docs/rdr/RDR-001-qwen-coprocessor-mcp-server.md).

## Requirements

- **For the supervisor (the Mac running Claude Code):** Node.js 24+,
  `npm`, and [Claude Code](https://docs.anthropic.com/claude/docs/claude-code)
  installed and signed in. Portable; not Apple-specific.
- **For at least one inference backend** (any OpenAI-compatible endpoint
  serving a Qwen 3.6 GGUF):
    - The bundled local-Mac path (`scripts/setup-mac-host.sh`,
      `scripts/start-stack.sh`) builds `llama.cpp` with Metal and runs
      Qwen 3.6 27B at `localhost:8080`. Apple Silicon, ~25 GB free disk.
    - Or a remote backend you provision separately — e.g. llama.cpp
      Vulkan on a Strix Halo box exposing the model at `host:port/v1`,
      reached over Tailscale or any other network you trust.

## Quick start

```bash
# 1. Build llama.cpp with Metal support and download Qwen 3.6 27B (~25 GB).
./scripts/setup-mac-host.sh

# 2. Start llama-server (cold start: ~5 min off external SSD, ~5 s off NVMe).
./scripts/start-stack.sh

# 3. Build the supervisor (compiles dist/server.js — postinstall runs tsc).
( cd mcp-bridges/qwen-agent-server && npm install )

# 4. Register the supervisor with Claude Code. Either:
#    a) install as a plugin (recommended — see "Install as a plugin" below), or
#    b) run ./scripts/setup-qwen-agent-server.sh (legacy `claude mcp add` path).

# 5. Run Claude Code anywhere — the qwen_* tools are now available.
claude
```

To shut down the local llama-server: `./scripts/stop-stack.sh`.

## Install as a plugin

This repo doubles as a Claude Code plugin (`qwen-stack`). After `npm install`
in step 3:

```bash
# From any shell with the claude CLI on PATH:
claude plugin marketplace add /path/to/this/repo
claude plugin install qwen-stack@qwen-stack
# Then reload from any CC session: /reload-plugins
```

The plugin manifest at `.claude-plugin/plugin.json` registers the supervisor's
MCP server with `${CLAUDE_PLUGIN_ROOT}` resolved to the plugin install
location, so paths stay portable.

> **Migrating from the old `qwen-coprocessor-stack` plugin name** (pre-0.3.0):
> ```
> claude plugin uninstall qwen-coprocessor-stack
> claude plugin marketplace remove qwen-coprocessor-stack
> claude plugin marketplace add /path/to/this/repo
> claude plugin install qwen-stack@qwen-stack
> ```

## Slash commands

State lives at `~/.qwen-coprocessor-stack/config.json` (object form,
forward-extensible — `backends`, `default_extensions` today).

| Command | Purpose |
|---|---|
| `/qwen-stack:status` | One-glance overview — plugin version, supervisor process, build freshness, backends + health, env overrides, red flags |
| `/qwen-stack:backends list \| add \| remove \| test` | Backend lifecycle — edits config file in place; supervisor hot-applies on next spawn |
| `/qwen-stack:extensions list \| info <name>` | Read-only listing of installed Qwen Code extensions with version, source, enabled state, declared commands/skills/agents/MCP servers |
| `/qwen-stack:defaults list \| set <a,b,c> \| set --none \| clear` | Manage the session-default extension list applied when a spawn doesn't specify `opts.extensions.only` |
| `/qwen-stack:budget list \| set [--max-context-tokens N] [--max-tool-calls M] \| clear [field]` | Manage the `session_budget` caps that abort a runaway session before the HTTP layer panics |

Resolution priorities (env > file > default):

- **Backends:** `QWEN_BACKENDS` env → `config.backends` → built-in single-local default.
- **Default extensions:** `QWEN_DEFAULT_EXTENSIONS` env → `config.default_extensions` → CLI defaults from `extension-enablement.json`.

Existing in-flight sessions stay pinned to their backend and resolved
extension set (RDR-001 §Q3, RDR-002 §drain semantics) — config edits
affect new spawns only.


## Session budget

The inner Qwen has no automatic mid-flight compaction; an open-ended task
that reads dozens of files can accumulate tool_result payload past the
backend's context window and crash the HTTP layer with `ECONNRESET`. v0.4
adds a guardrail that aborts the session cleanly before that happens.

Two caps, both per session:

- `max_context_tokens` — a `chars / 4` estimate over accumulated
  tool_result content. Default `111000` (≈85 % of the operator's
  qwentescence `--ctx-size 131072`). Set to `0` to disable.
- `max_tool_calls` — count of tool_use messages. Default `0` (no cap).

Hitting either fires `state="error"` with `error.code="context_exceeded"`
and a one-line message that includes both counters.

Pre-abort, a `context_pressure` event fires once each at 50 / 75 / 90 %
of `max_context_tokens` so a long-running poller can wind a session down
gracefully instead of being surprised. Every `qwen_poll` response also
carries a live `budget: { est_tokens, max_tokens, tool_calls, max_tool_calls }`
field so the orchestrator can react between thresholds — the v0.5 smoke
test showed that one oversized tool_result can trip 50 / 75 / 90 % on
the same iteration, leaving event-only callers no early-warning window.
Event data:

```json
{ "level": "warn|high|critical",
  "est_tokens": 525, "max_tokens": 1000,
  "tool_calls": 3,   "max_tool_calls": 0 }
```

Resolution priority for `max_context_tokens`: per-spawn opts → `QWEN_MAX_CONTEXT_TOKENS`
env → `config.session_budget.max_context_tokens` → `floor(0.85 * backend.ctx_size)`
when the chosen backend declares one → hardcoded 111000.

Resolution priority for `max_tool_calls`: per-spawn opts → `QWEN_MAX_TOOL_CALLS` env →
`config.session_budget.max_tool_calls` → hardcoded 0 (unlimited; tool-call count
is not a function of ctx_size).

```json
{
  "backends": [...],
  "default_extensions": [...],
  "session_budget": {
    "max_context_tokens": 111000,
    "max_tool_calls": 0
  }
}
```

Operator-facing surface: `/qwen-stack:budget list | set [--max-context-tokens N]
[--max-tool-calls M] | clear [max-context-tokens | max-tool-calls]` (v0.5).
Config-file edits hot-apply on the next spawn — no supervisor restart.


## MCP tools

| Tool             | Purpose |
|------------------|---------|
| `qwen_spawn`     | Start a supervised Qwen session for a task. Returns `task_id` and the chosen backend immediately; inference runs asynchronously. |
| `qwen_poll`      | Read the current state and recent events for a session. Cursor-paginated. |
| `qwen_send`      | Push the next user message into a session — answers a clarifying question or starts a follow-up turn. |
| `qwen_stop`      | Cancel and remove a session. Idempotent. |
| `qwen_backends`  | List configured backends and their cached health. |
| `qwen_sessions`  | Live overview of pooled sessions — task_id, backend, state, last-poll timestamp, turns completed, live budget counters. Read-only. |
| `qwen_oneshot`   | Stateless single-turn dispatch: spawn → wait → optional JSON parse + retry → stop. Schema-aware where `opts.json_schema` is supplied. Drop-in for `claude -p --json-schema`-style operator dispatch. Accepts `opts.continuation_id` to thread prior turns (3 h TTL, 20-turn cap, in-process; cross-tool with `qwen_oneshot_vision`). |
| `qwen_oneshot_vision` | Stateless **multimodal** dispatch (image+text → text). Bypasses the SDK (which is text-only) and POSTs OpenAI-compat content arrays directly to a backend's `/v1/chat/completions`. Image inputs as `{path}` / `{url}` / `{base64,mime}`. Routes to backends with `modality:"multimodal"`; requires `--mmproj` loaded — see [Multimodal support](#multimodal-support-vision). Supports `opts.grammar` (GBNF passthrough) and `opts.continuation_id` (cross-tool threading with `qwen_oneshot`; images from prior turns become `[image attached in prior turn]` placeholders in v1). |
| `qwen_embed`     | Direct embedding dispatch — POSTs to `/v1/embeddings` on a backend declared `modality:"embedding"` (e.g. bge-m3). Bypasses the SDK; emits progress notifications. Inputs as `{texts:[...]}`. |
| `qwen_rerank`    | Direct rerank dispatch — POSTs to `/v1/rerank` on a backend declared `modality:"rerank"` (e.g. bge-reranker-v2-m3). Bypasses the SDK; emits progress notifications. Inputs as `{query, documents:[...]}`. |
| `qwen_tokenize`  | Direct tokenize dispatch — POSTs to llama-server's `/tokenize` (NOT under `/v1`) on a text/multimodal backend; tokenizer is colocated with the loaded model. Returns `{tokens, count}` without consuming a generation slot. Inputs as `{content: "..."}`. |

## Multimodal support (vision)

The Qwen 3.6 model family is `image-text-to-text` capable. To enable
image inputs on your llama-server backend, load the matching vision
projector (`mmproj-*.gguf`) alongside the LM weights:

1. **Download the projector** from the same HuggingFace repo as your
   LM weights. Pick the BF16 or F16 variant (~0.85 GB each); F32 is
   only worth it if you have spare VRAM. For unsloth quantizations:
   - `unsloth/Qwen3.6-35B-A3B-GGUF` → `mmproj-BF16.gguf`
   - `unsloth/Qwen3.6-27B-GGUF` → `mmproj-F16.gguf`
2. **Place it next to the LM weights** in your `models/` directory.
3. **Restart `llama-server` with `--mmproj <path>`.** The bundled
   `scripts/start-stack.sh` (Mac/Metal) and
   `scripts/launch-llama-vulkan.cmd` (Strix Halo) already include
   this flag — it activates when the file is present and is
   gracefully omitted when not.
4. **Verify**: `curl http://<backend>/v1/models` should report
   `capabilities` including `'multimodal'`.

Once enabled, call `qwen_oneshot_vision` with one or more image
inputs alongside your text prompt. The supervisor's session pool
and KV-cache machinery are **not** involved — multimodal dispatch
is stateless and per-request (each call is independent of any
other session). If you call against a backend that doesn't have
`--mmproj` loaded, the supervisor returns
`error.code = 'backend_no_mmproj'` cleanly rather than crashing.

Note: `llama-server` silently disables `cache-reuse` in multimodal
mode (upstream behaviour). The flag stays set in the launch
scripts; the downgrade is logged at model-load time.

**Image-input safety** (bead `mtt`). `{path}` inputs are realpath'd
and rejected if the canonical path escapes the allowed roots —
`os.homedir()` and `os.tmpdir()` by default. Extend with
`QWEN_VISION_IMAGE_PATHS=path1:path2` if you store images elsewhere.
Symlink escapes (`/tmp/link -> /etc/hostname`) fail because realpath
runs before the allowlist check. `{url}` inputs are restricted to
`http://`, `https://`, and `data:` schemes; `file:` and others are
rejected at the supervisor. Pinning a non-multimodal backend via
`opts.backend` now returns `error.code = 'wrong_modality'` upfront
instead of round-tripping to fail with the misleading
`backend_no_mmproj`.

## Architecture

```
Claude Code (unmodified, subscription auth)
    │  MCP stdio
    ▼
qwen-agent-server  (Node + TypeScript, mcp-bridges/qwen-agent-server)
    │  - per-task session pool with LRU eviction and idle reaper
    │  - multi-backend router with KV-cache affinity per task_id
    │  - multi-turn input via streamInput async generator
    │  - permission gating (write tools require explicit authority)
    │
    │  uses @qwen-code/sdk (pinned to exact 0.1.7)
    ▼
llama-server  (Qwen 3.6, OpenAI-compatible /v1, e.g. localhost:8080
                or a remote Strix Halo at host:1234)
```

Each `task_id` is pinned to one backend at spawn time and kept there for
the life of the session, keeping `llama-server`'s prefix cache warm
across turns. Soak runs see ≈98% prefix-cache hit rate on the second turn
within a session.

The supervisor excludes `ask_user_question` from the inner Qwen's tool
surface; clarifying questions surface as plain text in the model's
response and are answered by the caller via `qwen_send`. Empirical
rationale and SDK behaviors that pin this design are in RDR-001 §Q1.

## Configuration

Primary surface is `~/.qwen-coprocessor-stack/config.json`. A starting
template is committed at [`config.example.json`](config.example.json) —
copy it, edit the backends to match your llama-server deployment(s),
and the slash commands (`/qwen-stack:backends`, `/qwen-stack:defaults`,
`/qwen-stack:budget`) will manage the file from there. Edits hot-apply
on the next `qwen_spawn` (mtime-cached); no supervisor restart needed.

Backends carry an optional `modality` field — one of `text` (default
when unset), `multimodal`, `embedding`, or `rerank`. The chat router
(`qwen_spawn`, `qwen_oneshot`) only considers `text` / `multimodal`
backends; `qwen_oneshot_vision` requires `multimodal`; `qwen_embed` and
`qwen_rerank` require their matching modality. Declaring modality
correctly is what makes a mixed pool (e.g. a chat backend + bge-m3 +
bge-reranker) safely auto-routable.

Remote OpenAI-compatible backends that need bearer auth (OpenRouter,
Together, Fireworks, etc.) take an `api_key_env` field naming the env
var to read at request time — rotations apply on the next request
without a restart, and the literal key never lands in the config file.
Use `api_key` only when an env var is impractical. Additional per-
backend `headers` (provider attribution like OpenRouter's `HTTP-Referer`
/ `X-Title`) merge after the supervisor's built-ins. Auth values are
never logged. See [`config.example.json`](config.example.json) for a
worked example.

Environment variables (`QWEN_BACKENDS`, `QWEN_DEFAULT_EXTENSIONS`,
`QWEN_MAX_CONTEXT_TOKENS`, `QWEN_MAX_TOOL_CALLS`) are honoured and
take precedence over the file when set. See
[`mcp-bridges/qwen-agent-server/README.md`](mcp-bridges/qwen-agent-server/README.md#configuration)
for the full reference.

## Downstream integrations

This stack ships the MCP supervisor; downstream applications wire
their dispatch layers through it. A reference integration was
designed and benched against
[nexus](https://github.com/Hellblazer/nexus) — operator dispatch,
aspect extraction, and tier-B agentic tools as the three call-site
tiers. **The integration work is currently parked on an
[exploration branch](https://github.com/Hellblazer/nexus/tree/exploration/qwen-offload-2026-05-15-2026-05-16)
in nexus** (reverted from `main` via nexus#821 on 2026-05-16); the
design and bench evidence below document what was attempted and what
was learned. The supervisor-side fix in this repo
([PR #1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1),
pino → stderr) is the only piece of that exploration that shipped in
production — see the protocol note below.

Three integration tiers were validated, each documented in
[`docs/integrations/qwen-dispatch-nexus.md`](docs/integrations/qwen-dispatch-nexus.md):

- **Operator dispatch** (oneshot, JSON-schema-bounded): nexus reaches
  llama-server directly via OpenAI-compat httpx — `qwen_oneshot` and
  the full supervisor pool are bypassed for this hot path. 10
  bundleable operators + 2 named call sites (`topic_labeler`,
  `plan_miss_planner`) validated against claude with 1.03× latency
  parity on schema-bounded prompts.

- **Aspect extractor** (large-context oneshot, 30-120k input tokens
  per call): same direct-llama path. Drives a per-document
  scholarly-paper extraction on ingest; 5-12× slower than claude but
  cost-savings dominate at corpus scale. Paired with a v2 prompt
  revision tightened against a Grossberg cognitive-modeling corpus.

- **Tier-B agentic tools** (multi-turn with MCP tool use): nexus
  routes through this stack's supervisor via `qwen_oneshot` with
  `opts.extensions: {only: ["nx"]}`. **This requires an `nx` Qwen
  Code extension** at `~/.qwen/extensions/nx/qwen-extension.json`
  wiring nexus's `nx-mcp` server into qwen CLI sessions — the full
  install snippet is in the linked doc. Without it the supervisor
  spawns sessions without nexus tool access and tier-B routing
  degrades.

Bench evidence backing each routing decision lives at
[`docs/integrations/qwen-offload-2026-05-session-summary.md`](docs/integrations/qwen-offload-2026-05-session-summary.md).

### Protocol notes for any MCP-stdio client

The supervisor's pino loggers were redirected to **stderr** in
[PR #1](https://github.com/Hellblazer/qwen-coprocessor-stack/pull/1)
so the stdout channel stays clean for JSON-RPC frames. Earlier
versions emitted pino lines on stdout, which Claude Code's MCP plugin
tolerated but the reference Python MCP SDK rejected with strict
`JSONRPCMessage` pydantic validation. Any third-party MCP client
connecting to a pre-#1 supervisor binary will hit the same parse
errors — rebuild from `main` or use a build that includes #1.

## Development

```bash
cd mcp-bridges/qwen-agent-server

npm test                    # unit tests (no backend required)
npm run test:integration    # integration tests (requires llama-server on :8080)
npm run build               # tsc → dist/
```

Three integration tests pin SDK behaviors that the supervisor relies on
(`tests/integration/sdk-behavior.test.ts`). They must pass before any
`@qwen-code/sdk` version bump — see the SDK pin policy in the
qwen-agent-server README.

## Repository layout

```
docs/rdr/                    Decision records (RDR-001 = primary design doc)
docs/contracts/              Published cross-host contracts + golden fixtures
                             (agent-dispatch-contract.md — RDR-007)
mcp-bridges/
  qwen-agent-server/         MCP supervisor (TypeScript)
extensions/                  Qwen Code extensions surface (see RDR-002)
scripts/
  setup-mac-host.sh          Build llama.cpp + download Qwen 3.6 27B (Mac/Metal)
  setup-qwen-agent-server.sh Build + register the supervisor
  start-stack.sh             Start the local llama-server (Mac/Metal)
  stop-stack.sh              Stop the local llama-server (Mac/Metal)
  launch-llama-vulkan.cmd    Windows/Vulkan launcher — runs llama-server with
                             tuned flags (q8_0 KV cache, 32 GB prompt cache,
                             128K ctx). Invoked by the scheduled task below.
  register-llama-task.ps1    Register a Windows scheduled task that runs the
                             above as SYSTEM at startup, restart-on-failure
models/                      GGUF model weights (gitignored)
```
