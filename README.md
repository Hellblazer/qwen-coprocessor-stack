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

## What is and isn't built

- ✅ M4 Max llama.cpp Metal workhorse path
- ✅ LiteLLM proxy with Anthropic-compatible `/v1/messages`
- ✅ Pre-call hook router with heuristic policy
- ✅ Fallback chain to Claude when the local/remote backends fail
- ✅ IDE configs (Cursor `.cursorrules`, Continue.dev)
- 🚧 Strix Halo remote tier is **stubbed**. `setup-strix-halo.sh` works but
     requires actual hardware. `QWEN_REMOTE_BASE_URL` should resolve to the
     box; LiteLLM falls back gracefully when it doesn't.
- 🚧 Workhorse self-escalation (Qwen emits a tool call that gets re-fired
     against Claude) — not yet implemented. The current router decides
     escalation pre-call, not mid-conversation.
- 🚧 Langfuse observability — defined in `docker-compose.yml` under the
     `observability` profile, off by default.

## File map

```
.
├── .env.example                       # all tunables + secrets
├── docker-compose.yml                 # LiteLLM (+ optional Langfuse profile)
├── config/
│   ├── litellm_config.yaml            # 4 model routes + fallbacks
│   └── router.py                      # pre-call hook with routing heuristic
├── scripts/
│   ├── setup-mac-host.sh              # llama.cpp Metal + Qwen 3.6 27B
│   ├── setup-strix-halo.sh            # Vulkan + Qwen 3.6 35B-A3B (aspirational)
│   ├── start-stack.sh                 # bring everything up
│   └── stop-stack.sh                  # bring it down cleanly
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
