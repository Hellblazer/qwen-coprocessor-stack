# qwen-coprocessor-stack

A local Qwen 3.6-27B running as a **coprocessor** for Claude Code. Claude is
the top-level orchestrator (your normal subscription, your normal `/model`
picker, no env-var redirection); Qwen lives behind an MCP server that
exposes a handful of delegation tools so Claude can offload cheap or bulk
work to a supervised, multi-turn Qwen session.

## Architecture

```
Claude Code (TUI, normal subscription auth, default model picker)
    │ MCP stdio
    ▼
qwen-agent-server      (mcp-bridges/qwen-agent-server, Node + TypeScript)
    │   – session pool, LRU eviction, idle reaper
    │   – multi-backend routing, KV-cache affinity per task_id
    │   – multi-turn streamInput input queue
    │ uses @qwen-code/sdk@0.1.7
    ▼
llama-server  (Qwen 3.6 27B Q6_K_XL, Metal-accelerated, port 8080)
```

The MCP supervisor in `mcp-bridges/qwen-agent-server/` is the only
delegation surface — five tools (`qwen_spawn`, `qwen_poll`, `qwen_send`,
`qwen_stop`, `qwen_backends`) running on long-lived supervised sessions.
Design: [docs/rdr/RDR-001](docs/rdr/RDR-001-qwen-coprocessor-mcp-server.md).

## Quick start

```bash
# 1. Build llama.cpp with Metal + download Qwen 3.6 27B (~25 GB)
./scripts/setup-mac-host.sh

# 2. Run llama-server (loads model into Metal, ~5 min cold start off USB-C SSD)
./scripts/start-stack.sh

# 3. Build + register the qwen-agent-server MCP supervisor
./scripts/setup-qwen-agent-server.sh
# (alternatively, register manually with `claude mcp add --scope user`)

# 4. Run Claude Code anywhere — qwen_spawn / qwen_poll / qwen_send /
#    qwen_stop / qwen_backends are now available as tools
claude
```

## Tools Claude sees

When `qwen-agent-server` is registered, Claude gets a long-running
delegation surface:

| Tool             | Use for                                                                                            |
|------------------|----------------------------------------------------------------------------------------------------|
| `qwen_spawn`     | Start a supervised Qwen session for a task; returns `task_id` + `chosen_backend` immediately.      |
| `qwen_poll`      | Pull events and current state for a `task_id`. Cursor-paginated; small payloads.                   |
| `qwen_send`      | Push a follow-up user message into a session — answers a plain-text question or starts a new turn. |
| `qwen_stop`      | Cancel and tear down a session. Idempotent.                                                        |
| `qwen_backends`  | Discovery: list configured backends and cached health.                                             |

## Why this topology?

We originally tried the inverse — Claude Code routed through a LiteLLM
gateway, with Qwen as the workhorse and a `claude-escalation` route paying
for hard problems via subscription auth (subprocess-spawning `claude -p`
with isolated `HOME`). It's an Anthropic ToS violation as of February
2026 — the revised Consumer ToS prohibits using Pro/Max OAuth tokens "in
any other product, tool, or service — including the Agent SDK," and
Anthropic has been actively breaking and banning third-party harnesses
since April 4, 2026.

The coprocessor topology avoids the entire ToS surface:

- Claude Code runs **unmodified** with normal subscription auth.
- Qwen is just **a tool that Claude calls**, identical in posture to Bash
  or Read.
- No OAuth interception, no subprocess-spawning of `claude`, no gateway
  rerouting Anthropic-bound traffic.

It also matches reality better. Claude is materially better than Qwen at
hard reasoning; making Claude the orchestrator and giving it cheap
delegation primitives is a more useful tool than trying to gate Claude
behind heuristics.

The full design and decision log lives in
[docs/rdr/RDR-001](docs/rdr/RDR-001-qwen-coprocessor-mcp-server.md). The
legacy gateway code (LiteLLM, claude-shim, consult-claude,
docker-compose) was removed from disk in commit-ab6.7 once the
coprocessor stabilized; git history preserves it for reference.

## Operational notes

- **Cold start**: Qwen 3.6-27B Q6 GGUF is ~25 GB. On USB-C SSD it loads in
  ~3-5 min; on internal NVMe ~5 s.
- **Throughput**: ~16 tok/s on M4 Max for the 27B Q6.
- **KV-cache locality**: the supervisor pins each `task_id` to one
  backend so llama-server's prefix cache stays warm — turn-2 typically
  sees ~98% cache-read hit rate within a session.
- **Multi-turn ergonomics**: the inner Qwen is told via system prompt to
  ask plain-text questions and stop; the supervisor delivers answers via
  `qwen_send` (NOT through `ask_user_question`, which is excluded from
  Qwen's tool surface — see RDR-001 §Q1 for empirical rationale).
- **Aspirational remote tier**: a second llama-server on a Linux/Vulkan
  Strix Halo box running a heavier Qwen variant slots into the supervisor
  via `QWEN_BACKENDS`. Not yet running in this setup.

## File map

```
.
├── docs/rdr/                                    # decision records
│   └── RDR-001-qwen-coprocessor-mcp-server.md   # primary design doc
├── mcp-bridges/
│   └── qwen-agent-server/                       # MCP supervisor (TypeScript)
│       ├── src/                                 #   5 MCP tools, pool, session
│       ├── tests/                               #   unit + integration pins
│       └── README.md
├── scripts/
│   ├── setup-mac-host.sh                        # llama.cpp Metal + Qwen 3.6 27B
│   ├── setup-strix-halo.sh                      # Vulkan path (aspirational)
│   ├── setup-qwen-agent-server.sh               # build + register the supervisor
│   ├── start-stack.sh                           # bring llama-server up
│   └── stop-stack.sh                            # bring it down
├── plugins/                                     # Qwen Code extension surface
└── models/                                      # GGUF model weights (gitignored)
```
