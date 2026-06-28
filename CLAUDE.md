# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

- **MCP supervisor** (Node/TS) — `mcp-bridges/qwen-agent-server/`:
  - `npm run build` (tsc; must be clean) · `npx vitest run` (unit; excludes `tests/integration/**`).
  - Run a single suite: `npx vitest run tests/backends.test.ts`.
- **Coprocessor shakeout** (end-to-end against a live endpoint): `QWEN_URL=http://<host>:<port> python3 scripts/shakeout.py` — tests chat, JSON-schema synthesis, tool-calling, vision/OCR, tokenize, embed, rerank. Vision tests FAIL on text-only models by design.
- **Coding-agent eval** (Python) — `scripts/coding-eval/`:
  - **Setup** (the venv is gitignored — create it once): `cd scripts/coding-eval && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`. The spine is pure stdlib, so the offline floor is just `pytest` (any pytest-equipped interpreter works — `.venv/bin/python` is the convention, not a hard requirement).
  - **Offline suites** (conformance + projection + decoupling — the gate for contract changes): `.venv/bin/python -m pytest tests/test_contract_conformance.py tests/test_run_arm.py tests/test_swebench_decoupling.py -q`.
  - `pytest tests/ -q` is NOT fully offline: `tests/test_subset.py` needs `datasets` (SWE-bench snapshot, network). Live eval needs Docker + a served backend + `swebench`.

## Architecture Overview

Stateful Node **MCP supervisor** (`mcp-bridges/qwen-agent-server/`) with **config-driven multi-backend routing** (`src/backends.ts`). Backends live in `~/.qwen-coprocessor-stack/config.json` (examples in `config/`). Each backend is an OpenAI-compatible endpoint (llama-server on the box, MLX on the Mac, or a remote API). `chooseBackend` filters by **modality** (text/multimodal for chat; embedding/rerank by their tool) → **tier** → **capacity** (prompt-size heuristic) → **health** → **weighted round-robin** (the pooling mechanism). `vision_only: true` excludes a multimodal backend from the text pool (dedicated vision). Vision/OCR routes via `qwen_oneshot_vision`; embed/rerank via their own modality select.

**Remote auth'd backends (RDR-012).** A backend may carry `api_key` / `api_key_env` (bearer; prefer the env form) and `headers` for remote OpenAI-compatible providers (OpenRouter, Together, Fireworks) — see `config/coprocessor-pool-openrouter.example.json`. Credentials reach **both** paths. **Headers asymmetry:** `headers` (e.g. OpenRouter `HTTP-Referer`/`X-Title`) are honored on the **direct-HTTP tools** (`qwen_chat`/`qwen_oneshot_vision`/`qwen_embed`/`qwen_rerank`/`qwen_tokenize`) but **not** on the **agentic path** (`qwen_spawn`/`qwen_oneshot`) — `@qwen-code/sdk` has no request-header channel; the supervisor WARNs once per backend (`agentic_headers_not_forwarded`). OpenRouter works without them (attribution-only). Remote agentic backends bypass the prompt-size capacity heuristic by design — pin via `opts.backend` or route by `role`.

## Operational Runbook & Hard-Won Lessons

**Hardware.** Box = `qwentescence` (Windows, AMD Radeon 8060S iGPU on Ryzen AI Max+ 395; 128 GB unified, BIOS carveout ~96 GB GPU / ~32 GB system; Vulkan sees ~106 GB; ~256 GB/s). Mac = M4 Max, 128 GB unified, ~546 GB/s, serves via **MLX**. Both can host ~30–120B small-active-MoE models; bandwidth (not capacity) is the decode bottleneck.

**llama.cpp on the box.** Use **`D:\llama-b9596\`** (≥ b9596) — required for the `qwen3_next` / Gated Delta Net (linear-attention) arch (Coder-Next). The older `D:\llama\` (b9090) **loads the weights but crashes the Vulkan compute** on that arch (warmup/first-token OOM-style failure). b9090 is kept as a fallback for older archs only. Drop `--kv-unified` (kept off since the b9090 cancel-task stall bug).

**Box GPU memory is load-order-sensitive.** Vulkan has a submit-time allocation quirk: **load coder-box (49 GB) BEFORE vision-box (21 GB)** or the 2nd load OOMs even with nominal free memory. Anything ≥ ~58 GB single-model (e.g. gpt-oss-120B mxfp4) tends to OOM at submit regardless.

**Box servers cannot detach from SSH.** `Start-Process -WindowStyle Hidden` dies when the SSH session ends; a scheduled task hits **session-0/GPU isolation** (`/run` from SSH never enters the GPU-capable interactive desktop session; auto-login is OFF). So a **keepalive holder** is required — see below.

**Keepalive (durable serving).** `scripts/ops/keepalive-coprocessor.sh` run as a **launchd LaunchAgent** (`scripts/ops/com.qwen.coprocessor-keepalive.plist.example` → `~/Library/LaunchAgents/`) holds both box servers via SSH and restarts on crash, independent of any login shell. Encoded invariants (each was a real failure): **`ssh -n`** (a backgrounded ssh reading stdin gets SIGTTIN under launchd and kills the daemon); **guard every `kill`** (`kill 0` signals the whole process group → self-TERM crash loop); **`--log-file`** not nested shell redirect; **order-aware recovery** (if the coder anchor is down, kill all → clean GPU → coder → vision). Does NOT survive a box reboot-while-locked (auto-login off) — that needs auto-login + Startup launcher (deployed to the box Startup folder) or an NSSM service.

**Mac / MLX.** Serve with **`-w1`** for agentic runs — two concurrent long-context (~150-turn) conversations + a 42 GB model OOMs Metal (`kIOGPUCommandBufferCallbackErrorOutOfMemory`) and crashes the server. Set **`HF_HOME` to the external disk** (`/Volumes/Transcend Hell/hf-cache`) so big model downloads don't fill the internal SSD; cost is a one-time ~8-min model load (~94 MB/s external read).

**Eval methodology (also in nexus KB).** (1) **Never compare numbers across harnesses** — the vendor-vs-standardized-scaffold gap is 10–30 pp; always reproduce a known anchor in *your* harness first (we reproduced Claude Sonnet = 65 % in mini-swe-agent). (2) **Gold-validate any subset** before trusting it — gold patches must score ~100 %; broken/flaky instances exist (Lite 36/40, Verified 46/50) and must be excluded from model scores; build images **serially** (parallel cold builds throw false OOM "failures"). (3) **`temperature=0` causes deterministic agentic loops** in Qwen-coder (identical context → identical command → step-limit, empty patch) — use the model's intended sampling (`temp 0.7, top_p 0.8`). (4) A too-low **generation `max_tokens` truncates tool calls mid-write** → unparseable → stalls; set it generously (16384) but bounded. (5) Vendor SWE-bench numbers don't reproduce in minimal harnesses (gpt-oss 62 % → ~1/10); **agentic-trained models are harness-robust** (Coder-Next ~71 % in mini-swe-agent). (6) best-of-k gains don't survive de-enrichment (random sample) — the lift was a flippy-instance selection artifact.

## Conventions & Patterns

- Routing config is data, not code — add backends in `config.json`; the supervisor health-probes and pools automatically. Keep `tier`/`capacity`/`weight` consistent across backends you want pooled together.
- For a new model on the box, verify the llama.cpp build supports its arch (load + a real generation) **before** wiring it into the pool.
- Operational scripts under `scripts/coding-eval/work/` are gitignored experiments; durable findings go to `bd remember` (T2) and the nexus T3 KB.
