# qwen-coprocessor-stack

A local Qwen 3.6-27B running as a **coprocessor** for Claude Code. Claude is
the top-level orchestrator (your normal subscription, your normal `/model`
picker, no env-var redirection); Qwen lives behind an MCP server that exposes
a handful of delegation tools so Claude can offload cheap/bulk work.

## Architecture

```
Claude Code (TUI, normal subscription auth, default model picker)
    │ MCP stdio
    ▼
qwen-coprocessor MCP server  (mcp-bridges/qwen-coprocessor/server.py)
    │ HTTP /v1/chat/completions
    ▼
llama-server  (Qwen 3.6 27B Q6_K_XL, Metal-accelerated, port 8080)
```

The MCP server registers user-scope (one-time `claude mcp add`), so any
Claude Code session in any directory has Qwen-as-coprocessor available
alongside Bash, Read, Edit, etc.

## Tools Claude sees

| Tool                | Use for                                                         |
|---------------------|-----------------------------------------------------------------|
| `qwen()`            | General escape hatch. Cheap text work, speculative tries.       |
| `qwen_classify()`   | Triage: pick one of N labels.                                   |
| `qwen_summarize()`  | Compress text to save Claude's context budget.                  |
| `qwen_extract()`    | Pull structured JSON out of prose.                              |

Each tool's docstring teaches Claude *when* to delegate. Set `deep=True` on
`qwen()` to enable Qwen 3.6's hybrid thinking mode for harder questions.

## Quick start

```bash
# 1. Build llama.cpp with Metal + download Qwen 3.6 27B (~25 GB)
./scripts/setup-mac-host.sh

# 2. Run llama-server (loads model into Metal, ~5 min cold start off USB-C SSD)
./scripts/start-stack.sh

# 3. Register the coprocessor MCP user-scope (once)
claude mcp add --scope user qwen-coprocessor \
  "$(pwd)/mcp-bridges/qwen-coprocessor/server.py"

# 4. Run Claude Code anywhere — Qwen tools are now available
claude
```

`uv` must be on PATH (the MCP server is a `uv run --script` shebang).

## Why this topology?

We originally tried the inverse — Claude Code routed through a LiteLLM
gateway, with Qwen as the workhorse and a `claude-escalation` route paying
for hard problems via subscription auth (subprocess-spawning `claude -p`
with isolated `HOME`). It worked technically and the implementation lives
in this repo's history. **It's also an Anthropic ToS violation as of
February 2026** — the revised Consumer ToS prohibits using Pro/Max OAuth
tokens "in any other product, tool, or service — including the Agent SDK,"
and Anthropic has been actively breaking and banning third-party harnesses
since April 4, 2026 (OpenClaw and many similar projects).

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

## Operational notes

- **Cold start**: Qwen 3.6-27B Q6 GGUF is ~25 GB. On USB-C SSD it loads in
  ~3-5 min; on internal NVMe ~5 s.
- **Throughput**: ~16 tok/s on M4 Max for the 27B Q6.
- **Thinking mode**: Off by default in the MCP tools. `qwen(prompt, deep=True)`
  toggles it on. With thinking, Qwen burns several thousand tokens of
  internal reasoning before the answer — useful for hard problems, painful
  for simple ones.
- **MCP server lifecycle**: Stateless HTTP calls to llama-server. No
  persistent process per session. Each tool call is a fresh request.
- **Aspirational remote tier**: A second llama-server on a Linux/Vulkan
  box (Strix Halo) running the larger Qwen 3.6-35B-A3B MoE could be added
  via a second MCP tool variant, e.g. `qwen_remote(prompt)`. Not built.

## File map

```
.
├── mcp-bridges/
│   └── qwen-coprocessor/server.py    # ← THE PRIMARY ARTIFACT
├── scripts/
│   ├── setup-mac-host.sh             # llama.cpp Metal + Qwen 3.6 27B
│   ├── setup-strix-halo.sh           # Vulkan path (aspirational)
│   ├── start-stack.sh                # bring llama-server up
│   ├── stop-stack.sh                 # bring it down
│   └── dry-run.sh                    # validate gateway pieces (legacy)
├── config/                           # legacy LiteLLM gateway config
├── mcp-bridges/claude-shim/          # legacy subprocess-OAuth bridge (ToS issue)
├── mcp-bridges/consult-claude/       # legacy Qwen→Claude consult (ToS issue)
├── docker-compose.yml                # legacy LiteLLM container
├── claude-code/env.sh                # legacy gateway env exporter
└── ide/                              # IDE configs (Cursor, Continue.dev)
```

The `legacy` annotations refer to the original gateway architecture, kept
in git history and on disk for reference. They're not used in the
coprocessor topology and should not be wired in for any real use, given
the ToS posture.

## Cleanup recommendation

The legacy gateway machinery (`docker-compose.yml`, `config/`,
`mcp-bridges/claude-shim/`, `mcp-bridges/consult-claude/`,
`claude-code/env.sh`) can be deleted entirely if you don't want to keep
the reference code around. The git history preserves it. See
`scripts/cleanup-legacy.sh` if/when added.
