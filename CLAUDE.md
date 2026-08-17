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

**Per-spawn MCP tools + subagents (RDR-013).** `qwen_spawn` / `qwen_oneshot` accept `opts.mcpServers` (a record of stdio `{command,args,env,cwd}` / SSE `{url}` / HTTP `{httpUrl,headers}` server configs) and `opts.agents` (qwen-code subagent definitions). They're forwarded into the inner qwen-code agent via the `@qwen-code/sdk` control-protocol `initialize` (the supervisor sets `queryOptions.mcpServers`/`agents`; the RDR-002 wrapper bridge is not involved). This is how you give a coprocessor the exact tools a task needs without a host-installed extension. Example:
```jsonc
qwen_spawn({ task: "...", opts: {
  backend: "glm-openrouter",
  mcpServers: { "lsp": { "command": "agent-lsp", "args": ["--stdio"] } },
  agents: [{ name: "reviewer", description: "...", systemPrompt: "..." }],
  allow_subagents: true
}})
```
Two invariants: (1) `agents[]` is only reachable when `allow_subagents: true` — otherwise the `agent` tool is excluded and the agents are dead config (the supervisor WARNs `agents_without_allow_subagents`). (2) **`mcpServers` is trusted input, not permission-gated:** a stdio server's `command` is spawned at SDK session init, *before* any tool call, so it is NOT governed by `permissionMode`/`canUseTool` — `write_authority: false` does **not** make a session with stdio `mcpServers` read-only. The in-process `type:"sdk"` config form is rejected at the tool boundary (it can't cross MCP); use stdio/SSE/HTTP.

**codeIntel opt-in (RDR-014).** `qwen_spawn` / `qwen_oneshot` accept `opts.codeIntel?: boolean`. `true` makes the supervisor synthesize — server-side at the opts boundary (`applyCodeIntel` in `src/server.ts`, at both wire sites), before the session is built — three RDR-013-shaped inputs: an **agent-lsp** stdio `mcpServers` entry under the reserved key `agent-lsp` scoped via `includeTools` to 10 high-signal read-only nav tools, a **symbol-graph guidance** block folded into the system prompt, and a **`max_tool_calls` default of 12** (only when the caller left it `undefined`; `0` = unbounded is preserved). It is an agent-lsp-specific boolean (no preset registry, by YAGNI). `includeTools` is **enforced** at MCP discovery on the bare tool name (RF-4), so the surface is a hard scope, not advisory. Caller-wins: a caller-supplied `agent-lsp` key is kept untouched (WARN `codeintel_lsp_key_present`) and the guidance is suppressed too. Inherits the RDR-013 trust model — `uvx agent-lsp` launches at SDK init regardless of `write_authority`. Prereq `uvx`+`agent-lsp` on the coprocessor host (not installed by the supervisor); a missing binary degrades only that spawn (the agent-lsp tools are absent), it does not fail the spawn. Example: `config/coprocessor-pool-codeintel.example.json`; usage recipe in `docs/USER_GUIDE.md`.

## Operational Runbook & Hard-Won Lessons

**Hardware.** Box = `qwentescence` (Windows, AMD Radeon 8060S iGPU on Ryzen AI Max+ 395; 128 GB unified, BIOS carveout ~96 GB GPU / ~32 GB system; Vulkan sees ~106 GB; ~256 GB/s). Mac = M4 Max, 128 GB unified, ~546 GB/s, serves via **MLX**. Both can host ~30–120B small-active-MoE models; bandwidth (not capacity) is the decode bottleneck.

**llama.cpp on the box.** Pinned build: **`D:\llama-b9596\`** (re-pinned 2026-07-26, bead iuq). b10078's ggml-vulkan carve fix did NOT reproduce on this box after the C: repair / D: cable change — with or without `--no-mmap`/`GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM=1`, GPU dedicated fell to ~0.7 GB and the model served from the pagefile while tps stayed 47-50, so **never validate a build on tps alone; check GPU dedicated usage + Available MBytes** (full record in the keepalive script comments). b9596 fills the carve. Do not re-pin b10078 until the regression is understood. Older: b9090 (crashes Vulkan compute on qwen3_next; oldest-arch fallback only). Drop `--kv-unified` (b9090 cancel-task stall bug); `--cache-reuse` stays dropped (bead 081 agentic stall).

**Box served model (promoted 2026-08-16, PR #86).** :1235 serves **Qwen3.8-27B-Q6_K + mmproj** (multimodal), flags `--reasoning off` (REQUIRED — the model ignores `/no_think`, bead yjr; without it agentic sessions overflow ctx in 3-5 tool calls) + `--spec-type draft-mtp` (~14 tps prose / ~17 tps code) + 64K ctx; 28.1 GB GPU dedicated, in-carve. Coder-Next (UD-Q4_K_XL, ~45 tps text-only) stays on disk, manifested; revert recipe in the keepalive script header. Known edge: OCR can misread dense glyph runs (deterministic at temp 0). Record: `bd memory qwen3.8-27b-box-optimized-config-2026-08-16`.

**Box GPU memory.** Never co-load two large models (beads-081 crash class) — one llama-server, one large model, always. Current footprint: Qwen3.8-Q6_K serving at 28.1 GB in-carve (Coder-Next was 48.4 GB; gpt-oss-120B is 61.4 GB — any pairing of large models risks the carve). On b10078 the old "≥ ~58 GB single-model OOMs at submit" limit was GONE (gpt-oss-120B mxfp4, 63 GB, loaded clean at 51.6 tps) — but b10078 is un-pinned pending the carve regression (bead iuq), so treat that headroom as unavailable on b9596 until re-measured. Historical (pre-b10078) load-order quirk: coder before vision, ≥58 GB OOMs.

**Box coordination protocol.** A Claude instance (Claude Desktop, user Sam) manages the box locally. Coordinate server lifecycle via the append-only channel `D:\claude-coordination\QWEN_SERVER_NEGOTIATION.md` (announce service windows there) and the launch-metadata file `D:\claude-coordination\qwen-server-state.json` (written by the keepalive's `write_state()` on every respawn). Servers are Mac-keepalive-owned; the box side announces before ever spawning one. Box curl quirk: full unranged HTTPS GETs to HF/GitHub CDNs stall at 0 bytes — download on the Mac (`hf download`) and scp over the LAN instead.

**Model & runtime provenance (RDR-016) — non-negotiable.** Nothing is served that is not in `models/MANIFEST.json` with a sha256 verified against its upstream on the Mac AND the box. Acquire ONLY via `python3 scripts/ops/provenance/provenance.py fetch|add-runtime|register|adopt` (skill `/qwen-stack:provenance`; runbook `docs/MODEL_PROVENANCE.md`): allowlisted origin (tier `origin` = model authors; `packager` = unsloth/ggml-org/bartowski/mlx-community with `--allow-packager` + `--derived-from`), pinned 40-hex commit sha, `.safetensors`/`.gguf` only — pickle formats and archives refused, `.py`/`trust_remote_code` refused without `--allow-remote-code`. Prefer self-quantizing from origin safetensors. Ship with `PROVENANCE_TRANSFER=1 scp`, then verify on the box (`D:\claude-coordination\Get-ProvenanceListing.ps1` → `provenance.py verify --listing --host box`). The PreToolUse hook denies `hf download`/`curl huggingface.co`/`ollama pull`/unmarked `scp *.gguf`/pickle loads; the keepalive refuses unmanifested model paths (`QWEN_PROVENANCE_ENFORCE=0` is a logged escape hatch, not a convenience). **Never bulk-hash `D:\models` against a live mmap-served model** — the box D: NVMe surprise-removes under sustained read (2026-08-01/07/15) and kills llama-server; announce a service window first. Defender history: the only two detections ever were a `!ml` heuristic on an upstream-identical llama.cpp DLL and our own PowerShell diagnostic (T2 `box-defender-detections-audit-2026-08-15`).

**Box servers cannot detach from SSH.** `Start-Process -WindowStyle Hidden` dies when the SSH session ends; a scheduled task hits **session-0/GPU isolation** (`/run` from SSH never enters the GPU-capable interactive desktop session; auto-login is OFF). So a **keepalive holder** is required — see below.

**Keepalive (durable serving).** `scripts/ops/keepalive-coprocessor.sh` run as a **launchd LaunchAgent** (`scripts/ops/com.qwen.coprocessor-keepalive.plist.example` → `~/Library/LaunchAgents/`) holds both box servers via SSH and restarts on crash, independent of any login shell. Encoded invariants (each was a real failure): **`ssh -n`** (a backgrounded ssh reading stdin gets SIGTTIN under launchd and kills the daemon); **guard every `kill`** (`kill 0` signals the whole process group → self-TERM crash loop); **`--log-file`** not nested shell redirect; **order-aware recovery** (if the coder anchor is down, kill all → clean GPU → coder → vision). Does NOT survive a box reboot-while-locked (auto-login off) — that needs auto-login + Startup launcher (deployed to the box Startup folder) or an NSSM service.

**Mac / MLX.** Serve with **`-w1`** for agentic runs — two concurrent long-context (~150-turn) conversations + a 42 GB model OOMs Metal (`kIOGPUCommandBufferCallbackErrorOutOfMemory`) and crashes the server. Set **`HF_HOME` to the external disk** (`/Volumes/Transcend Hell/hf-cache`) so big model downloads don't fill the internal SSD; cost is a one-time ~8-min model load (~94 MB/s external read).

**Eval methodology (also in nexus KB).** (1) **Never compare numbers across harnesses** — the vendor-vs-standardized-scaffold gap is 10–30 pp; always reproduce a known anchor in *your* harness first (we reproduced Claude Sonnet = 65 % in mini-swe-agent). (2) **Gold-validate any subset** before trusting it — gold patches must score ~100 %; broken/flaky instances exist (Lite 36/40, Verified 46/50) and must be excluded from model scores; build images **serially** (parallel cold builds throw false OOM "failures"). (3) **`temperature=0` causes deterministic agentic loops** in Qwen-coder (identical context → identical command → step-limit, empty patch) — use the model's intended sampling (`temp 0.7, top_p 0.8`). (4) A too-low **generation `max_tokens` truncates tool calls mid-write** → unparseable → stalls; set it generously (16384) but bounded. (5) Vendor SWE-bench numbers don't reproduce in minimal harnesses (gpt-oss 62 % → ~1/10); **agentic-trained models are harness-robust** (Coder-Next ~71 % in mini-swe-agent). (6) best-of-k gains don't survive de-enrichment (random sample) — the lift was a flippy-instance selection artifact.

## Conventions & Patterns

- Routing config is data, not code — add backends in `config.json`; the supervisor health-probes and pools automatically. Keep `tier`/`capacity`/`weight` consistent across backends you want pooled together.
- For a new model on the box, verify the llama.cpp build supports its arch (load + a real generation) **before** wiring it into the pool.
- Operational scripts under `scripts/coding-eval/work/` are gitignored experiments; durable findings go to `bd remember` (T2) and the nexus T3 KB.
