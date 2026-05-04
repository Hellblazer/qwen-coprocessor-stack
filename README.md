# qwen-coprocessor-stack

A locally-hosted Qwen 3.6-27B model wired into Claude Code as an MCP
coprocessor. Claude Code runs unmodified with normal subscription auth;
Qwen is exposed as a small set of MCP tools that Claude can call to
delegate cheap or bulk work to long-lived, supervised inference sessions.

The supervisor is a TypeScript MCP server
([`mcp-bridges/qwen-agent-server`](mcp-bridges/qwen-agent-server)) that
manages session lifecycle, backend routing, KV-cache affinity, and
permission gating on top of [`@qwen-code/sdk`](https://www.npmjs.com/package/@qwen-code/sdk).
Inference runs in a local `llama.cpp` build (Metal-accelerated on
Apple Silicon) serving Qwen 3.6 27B Q6_K_XL.

Full design rationale: [`docs/rdr/RDR-001`](docs/rdr/RDR-001-qwen-coprocessor-mcp-server.md).

## Requirements

- macOS on Apple Silicon (M1 or later) — the included setup scripts
  build `llama.cpp` with Metal. The supervisor itself is portable; only
  the bundled inference backend assumes macOS.
- ~25 GB free disk for the GGUF model.
- Node.js 24+, `npm`.
- [Claude Code](https://docs.anthropic.com/claude/docs/claude-code)
  installed and signed in.

## Quick start

```bash
# 1. Build llama.cpp with Metal support and download Qwen 3.6 27B (~25 GB).
./scripts/setup-mac-host.sh

# 2. Start llama-server (cold start: ~5 min off external SSD, ~5 s off NVMe).
./scripts/start-stack.sh

# 3. Build the supervisor and register it with Claude Code (idempotent).
./scripts/setup-qwen-agent-server.sh

# 4. Run Claude Code anywhere — the qwen_* tools are now available.
claude
```

To shut down: `./scripts/stop-stack.sh`.

## MCP tools

| Tool             | Purpose |
|------------------|---------|
| `qwen_spawn`     | Start a supervised Qwen session for a task. Returns `task_id` and the chosen backend immediately; inference runs asynchronously. |
| `qwen_poll`      | Read the current state and recent events for a session. Cursor-paginated. |
| `qwen_send`      | Push the next user message into a session — answers a clarifying question or starts a follow-up turn. |
| `qwen_stop`      | Cancel and remove a session. Idempotent. |
| `qwen_backends`  | List configured backends and their cached health. |

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
llama-server  (Qwen 3.6 27B Q6_K_XL, Metal, port 8080)
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

All supervisor configuration is via environment variables. Defaults work
for the standard local setup; see
[`mcp-bridges/qwen-agent-server/README.md`](mcp-bridges/qwen-agent-server/README.md#configuration)
for the full reference, including `QWEN_BACKENDS` syntax for adding
remote backends.

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
mcp-bridges/
  qwen-agent-server/         MCP supervisor (TypeScript)
plugins/                     Qwen Code extension surface
scripts/
  setup-mac-host.sh          Build llama.cpp + download Qwen 3.6 27B
  setup-strix-halo.sh        Vulkan path for a remote tier (aspirational)
  setup-qwen-agent-server.sh Build + register the supervisor
  start-stack.sh             Start llama-server
  stop-stack.sh              Stop llama-server
models/                      GGUF model weights (gitignored)
```
