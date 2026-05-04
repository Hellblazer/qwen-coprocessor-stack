# qwen-coprocessor-stack

A four-tier LLM stack for **unmodified Claude Code**, with **Qwen as the
top-level workhorse** and Claude reserved as a heavy-thinker escalation.

## Architecture

```
┌─────────────────────┐
│  Claude Code (CLI)  │  ANTHROPIC_BASE_URL=http://localhost:4000
└──────────┬──────────┘
           │ Anthropic /v1/messages
           ▼
┌─────────────────────────────────────────┐
│  LiteLLM proxy  (:4000)                 │
│   pre-call hook in config/router.py     │
│   classifies each request and picks:    │
└────┬─────────────┬─────────────┬────────┘
     ▼             ▼             ▼
 Qwen 3.6 27B    Qwen 3.6      Claude Sonnet 4.6
 (M4 Max,        35B-A3B       (Anthropic API,
  llama.cpp      (Strix Halo,   escalation only)
  Metal,         Vulkan,
  default)       aspirational)
```

The router is heuristic and **does not run a third LLM as a triage step**:

| Trigger                                                | Route             |
|--------------------------------------------------------|-------------------|
| Prompt contains a `ROUTER_HARD_KEYWORDS` term          | `claude-escalation` |
| Approx tokens ≥ `ROUTER_LARGE_PROMPT_TOKENS` (8 k)     | `claude-escalation` |
| Approx tokens ≥ `ROUTER_REMOTE_THRESHOLD_TOKENS` (2 k) | `claude-qwen-remote` |
| Otherwise                                              | `claude-qwen-coding` |

If `ANTHROPIC_API_KEY` is unset, escalations collapse to the local Qwen.
If the remote box is unreachable, LiteLLM's fallback chain catches it.

## Quick start

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env                       # set LITELLM_MASTER_KEY, optionally ANTHROPIC_API_KEY

# 2. Build llama.cpp + download Qwen 3.6 27B (~22 GB)
./scripts/setup-mac-host.sh

# 3. Start workhorse + proxy
./scripts/start-stack.sh

# 4. Run Claude Code, routed
source ./claude-code/env.sh
claude
```

`source claude-code/env.sh` exports `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
and `ANTHROPIC_MODEL=claude-router-auto`. Claude Code is otherwise unmodified.

## Dry run (before downloading 22 GB)

```bash
cp .env.example .env && $EDITOR .env
./scripts/dry-run.sh
```

Pulls the LiteLLM image (~1 GB once), starts the proxy without a workhorse,
verifies `/v1/models` returns all four routes, runs the router heuristic
self-tests inside the container, snapshots backend reachability, then tears
down. Does not build llama.cpp and does not download any model weights.

## Routes

| Route                  | Backend                                              |
|------------------------|------------------------------------------------------|
| `claude-router-auto`   | heuristic — picks one of the others below           |
| `claude-qwen-coding`   | Qwen 3.6 27B on M4 Max, **thinking off** (default)   |
| `claude-qwen-thinking` | Qwen 3.6 27B on M4 Max, **thinking on** (opt-in)     |
| `claude-qwen-remote`   | Qwen 3.6 35B-A3B on Strix Halo (aspirational)        |
| `claude-escalation`    | Anthropic Claude Sonnet 4.6                          |

All five show up in Claude Code's `/model` picker via the `/v1/models` discovery
endpoint that LiteLLM exposes. Pick one explicitly to bypass the router.

### Why two local routes?

Qwen 3.6-27B is a **hybrid-thinking** model — it emits a `<think>...</think>`
trace before its visible answer. With thinking enabled, the model spends most
of its output budget on reasoning even for trivial prompts (we measured
2 048 thinking tokens for "write a Fibonacci one-liner"). At ~16 tok/s on a
27B Q6 quant, that's minutes of latency per Claude Code interaction.

So `claude-qwen-coding` disables thinking via `chat_template_kwargs.enable_thinking: false`
for the fast default path, and `claude-qwen-thinking` keeps it on for the rare
case where you want deeper reasoning. The router currently picks `coding` for
default; pin `thinking` from the `/model` picker when needed.

## One-time shim auth setup

The shim runs `claude -p` subprocesses against an **isolated `HOME`** so they
can't read or write your real `~/.claude.json` or `~/.claude/`. That isolated
home needs its own OAuth login — it's the same Anthropic account, same
subscription, same billing, just a separate persisted auth state for the
shim.

```bash
./scripts/setup-shim-auth.sh
```

This launches Claude Code interactively against `/tmp/claude-shim-home`
(override via `CLAUDE_SHIM_HOME`). Inside the TUI: `/login`, complete the
OAuth flow in the browser, `/quit`. From then on the shim has its own auth
state and won't perturb your main config.

Re-run if your subscription auth changes (re-login, account swap, etc.).

## Subscription-billed escalation

The `claude-escalation` route does **not** call the Anthropic API directly.
Instead it routes through `claude-shim`, a small host-side OpenAI/Anthropic-
compatible HTTP server that spawns a fresh `claude -p` subprocess with all
gateway env vars stripped. The inner `claude` authenticates via your normal
Pro/Max OAuth login, so escalation traffic bills against the subscription
rather than against a Console API key.

```
LiteLLM (Docker)                 claude-shim (host)
    │  POST /v1/responses             │  subprocess.run(["claude","-p"])
    ▼  via host.docker.internal:9000  ▼  with ANTHROPIC_BASE_URL etc. stripped
   ──────────────────────────────►  ─────────────────────────────────►
                                                                    api.anthropic.com
                                                                    (subscription quota)
```

Concretely, when Claude Code (or any client) hits the gateway with model
`claude-escalation`, LiteLLM's openai/responses adapter forwards to the
shim, which returns the inner Claude's text. There's no API key involved
unless you manually re-point the route at `anthropic/claude-sonnet-4-6`.

### Two complementary subscription paths

The stack ships *both* of the following — they serve different escalation
patterns and don't conflict:

1. **Pre-call route**: Qwen-routed traffic flagged by the router heuristic
   (large prompt or `ROUTER_HARD_KEYWORDS` match) goes to `claude-escalation`
   automatically. No tool call required; works for any client of the gateway.
2. **Mid-flight tool**: `consult_claude` MCP server lets the active model
   (Qwen) decide *during* a turn that it needs to ask a Claude oracle a
   single question. Both paths terminate at a `claude -p` subprocess and
   bill the subscription identically.

Disable pre-call escalation by setting `ROUTER_ESCALATION=0` in `.env`
(useful when you want only Qwen-self-judged escalation via the MCP tool).

### Wire up the MCP path (one-time)

```bash
claude mcp add --scope user consult-claude \
  "$(pwd)/mcp-bridges/consult-claude/server.py"
claude mcp list | grep consult-claude
# expected: consult-claude: ... - ✓ Connected
```

`uv` must be on PATH (both shim and MCP server are `uv run --script`
shebangs).

### Tuning escalation triggers

- `ROUTER_HARD_KEYWORDS`: comma-separated phrases that auto-escalate.
- `ROUTER_LARGE_PROMPT_TOKENS`: approx-token threshold for size-triggered escalation.
- `ROUTER_ESCALATION=0` to disable the pre-call path entirely.
- The MCP tool's docstring in `mcp-bridges/consult-claude/server.py` is the
  guardrail Qwen reads before invoking it; tighten or relax there.

### Security note

Both bridges spawn `claude -p` inheriting the host environment minus the
gateway keys. Other secrets in your shell are inherited as-is. Run the
gateway in a sanitised shell if that matters.

## What is and isn't built

- ✅ M4 Max llama.cpp Metal workhorse path
- ✅ LiteLLM proxy with Anthropic-compatible `/v1/messages`
- ✅ Pre-call hook router with heuristic policy
- ✅ Fallback chain to Claude when the local/remote backends fail
- ✅ IDE configs (Cursor `.cursorrules`, Continue.dev)
- 🚧 Strix Halo remote tier is **stubbed**. `setup-strix-halo.sh` works but
     requires actual hardware. `QWEN_REMOTE_BASE_URL` should resolve to the
     box; LiteLLM falls back gracefully when it doesn't.
- ✅ Subscription-billed pre-call escalation: `claude-escalation` route
     goes through `claude-shim` (host-side OpenAI-compat HTTP server) which
     spawns `claude -p` with subscription auth. No API key required.
- ✅ Subscription-billed mid-flight escalation: `consult_claude` MCP server
     lets the active model self-judge and ask a Claude oracle a single
     question (single-turn Q&A, same `claude -p` mechanism).
- 🚧 Full task delegation (Qwen hands off the conversation + tool authority
     to Claude mid-flight, not just a question) — not yet implemented.
- 🚧 Langfuse observability — defined in `docker-compose.yml` under the
     `observability` profile, off by default.

## File map

```
.
├── .env.example                       # all tunables + secrets
├── docker-compose.yml                 # LiteLLM (+ optional Langfuse profile)
├── config/
│   ├── litellm_config.yaml            # 5 model routes + fallbacks
│   └── router.py                      # pre-call hook with routing heuristic
├── mcp-bridges/
│   ├── claude-shim/server.py          # OpenAI/Anthropic-compat HTTP shim
│   │                                  # → spawns subscription `claude -p`
│   └── consult-claude/server.py       # MCP tool for self-judged escalation
├── scripts/
│   ├── setup-mac-host.sh              # llama.cpp Metal + Qwen 3.6 27B
│   ├── setup-strix-halo.sh            # Vulkan + Qwen 3.6 35B-A3B (aspirational)
│   ├── start-stack.sh                 # bring everything up (incl. claude-shim)
│   └── stop-stack.sh                  # bring it down cleanly
│   └── dry-run.sh                     # validate wiring without llama.cpp
├── claude-code/
│   └── env.sh                         # source before `claude`
├── ide/
│   ├── cursor/.cursorrules
│   └── vscode/continue-config.json
└── README.md
```

## Operational notes

- **KV cache memory**: 27B at 64 K context is roomy on a 128 GB M4 Max;
  `start-stack.sh` uses `--cache-type-k q8_0 --cache-type-v q8_0` to halve
  it. Bump `-c` to 131072 or 262144 only if you need it — the KV cache is
  what'll OOM you, not the weights.
- **`host.docker.internal`**: the LiteLLM container reaches the host
  llama-server via this name (configured in `docker-compose.yml`'s
  `extra_hosts`). On Linux Docker without Docker Desktop, you may need
  `--network host` or a different mapping.
- **Security**: LiteLLM PyPI 1.82.7/1.82.8 were compromised in late 2025.
  This stack uses the official `ghcr.io/berriai/litellm:main-stable` image,
  not pip. If you switch to pip, pin to a known-good version.
- **`ANTHROPIC_API_KEY` is gateway-only**. Claude Code itself sees only
  `ANTHROPIC_AUTH_TOKEN` (= `LITELLM_MASTER_KEY`). The real key lives in
  `.env` and is consumed by LiteLLM when routing escalates.
```
