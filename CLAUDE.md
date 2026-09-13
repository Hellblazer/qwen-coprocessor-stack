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

**Hardware.** Box = `qwentescence` (Windows, AMD Radeon 8060S iGPU on Ryzen AI Max+ 395; 128 GB unified; ~256 GB/s). **BIOS carve is 64 GB GPU / 63.6 GB Windows, pagefile fixed at 128 GB — this is the measured optimum, do not raise the carve** (set 2026-09-12; board max is 96G). Mac = M4 Max, 128 GB unified, ~546 GB/s, serves via **MLX**. Both can host ~30–120B small-active-MoE models; bandwidth (not capacity) is the decode bottleneck, and **density, not size, is what costs on the box**: gpt-oss-120B (5.1B active, 63 GB) measured 47 tok/s in-carve against the dense Qwen3.8-27B's ~13.

**llama.cpp on the box.** Pinned build: **`D:\llama-b10867-patched\`** since 2026-09-13 (manifest `llama.cpp@b10867-patched`, an RDR-016 overlay entry: official zip plus our `ggml-vulkan.dll`, minted in online mode against the workflow run's own artifact; the keepalive gates the overlaid DLL too). b10867 also carries the Gated-DeltaNet normalization fix (#28068) that Coder-Next needs and b9596 lacks. `D:\llama-b9596\` stays as the Qwen3.8 revert. The carve regression is **root-caused**: upstream PR #22930 ("prefer host-visible memory buffers on UMA devices", commit `32120c10e3`, first in **b9668**) makes the `device->uma` branch of `ggml_vk_create_buffer_device()` request host-visible memory first, so the model lands in pageable shared memory while tps stays normal. Proven by single-commit A/B, same model and flags: b9596 and b9667 hold 28.17 GB dedicated; b9668 falls to 0.07 GB (T2 `pr-22930-confirmed-carve-regression-single-commit-ab-2026-09-12`). It is still on master and b10078 *carries* it, so there is no build to upgrade to. The same change made `GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM` dead code on every iGPU (the uma branch is tested first). Fix: `scripts/ops/patches/vulkan-uma-honor-disable-host-visible-vidmem.patch`, which makes that env var work on UMA without changing defaults; `.github/workflows/llama-vulkan-patched.yml` (workflow_dispatch only) builds a patched `ggml-vulkan.dll` to drop into the official zip of the same tag. A patched **b10867** is staged at `D:\llama-b10867-patched\` but not yet A/B'd — test with the var both unset (should reproduce the collapse) and set (should hold ~28 GB). b10867 is below b10875, where `--no-mmap` left the arg parser. **Never validate a build on tps alone; check GPU dedicated usage + Available MBytes.** Drop `--kv-unified` (b9090 cancel-task stall bug); `--cache-reuse` stays dropped (bead 081 agentic stall).

**Box served model (promoted 2026-09-13).** :1235 serves **Qwen3-Coder-Next UD-Q4_K_XL** (text-only; vision is vision-mac only) on **`D:\llama-b10867-patched\`** with `GGML_VK_DISABLE_HOST_VISIBLE_VIDMEM=1`, `--ctx-size 262144 --ubatch-size 1024 --batch-size 4096 --flash-attn 1 --jinja`, default load mode. Measured: 53 GB dedicated, 52.7 GB Available, 42-45 tok/s decode (30 at 65K depth), prefill ~640 tok/s at 8K. Agentic battery 9/9 at median 0.90 min against Qwen3.8's 9/9 at 2.15. **Do not pass `-lm mmap`**: it gives identical GPU placement but leaves Windows 6.7 GB instead of 53.9 GB. `-ub 1024` beats 512/2048/4096 at every prompt length on this iGPU. Only 12 of 48 layers carry KV, so full 262K context costs 4.7 GB over 64K. Q6_K does not fit (weights reach 61.85 GB dedicated, then `ErrorOutOfDeviceMemory` at context creation, no GTT spill), so ~62 GB is the practical dedicated ceiling for one model. No speculative decoding (no MTP head; recurrent-state rollback for qwen3next unmerged). Qwen3.8-27B stays on disk as the revert; recipe in the keepalive header. Record: T2 `coder-next-box-sweep-2026-09-13`.

**Box GPU memory.** Never co-load two large models (beads-081 crash class) — one llama-server, one large model, always. The ceiling is a **Windows/WDDM rule, not the carve**: `usable dedicated VRAM = min(carve, Windows-visible RAM)`, overflow spills to GTT sized at ~half of Windows RAM, so `capacity = min(carve, RAM) + RAM/2`, which peaks at carve 64 and drops to ~48 GB at carve 96. That ~96 GB figure is an upper bound that has **not** held for a single model: on 2026-09-13 Coder-Next Q6_K (61.1 GiB weights) filled 61.85 GB dedicated and then failed context creation with `ErrorOutOfDeviceMemory` while shared stayed at 0.4 GB, and DeepSeek-V4-Flash (91 GB) failed the same way at 0.8 GB dedicated. Plan on **~62 GB dedicated for weights + KV + compute** as the working ceiling; the largest spill ever proven is 14.6 GB. WDDM requires video allocations be evictable, so it caps VRAM against **physical** RAM — a larger pagefile does not help. Llama.cpp's probe still advertises `Vulkan0 ... 108782 MiB free` when this cap refuses a load; the failure is `vk::Queue::submit: ErrorOutOfDeviceMemory`. GTT spill is the same LPDDR5X at the same bandwidth, so it is not slow; spill to the pagefile is. The old "≥58 GB OOMs / gone on b10078" note was wrong on both counts — b10078's apparent headroom was the model serving from the pagefile. Record: T2 `box-vram-ceiling-rule-wddm-min-carve-ram-2026-09-12`.

**Box coordination protocol.** A Claude instance (Claude Desktop, user Sam) manages the box locally. Coordinate server lifecycle via the append-only channel `D:\claude-coordination\QWEN_SERVER_NEGOTIATION.md` (announce service windows there) and the launch-metadata file `D:\claude-coordination\qwen-server-state.json` (written by the keepalive's `write_state()` on every respawn). Servers are Mac-keepalive-owned; the box side announces before ever spawning one. Box curl quirk: full unranged HTTPS GETs to HF/GitHub CDNs stall at 0 bytes — download on the Mac (`hf download`) and scp over the LAN instead.

**Model & runtime provenance (RDR-016) — non-negotiable.** Nothing is served that is not in `models/MANIFEST.json` with a sha256 verified against its upstream on the Mac AND the box. Acquire ONLY via `python3 scripts/ops/provenance/provenance.py fetch|add-runtime|register|adopt` (skill `/qwen-stack:provenance`; runbook `docs/MODEL_PROVENANCE.md`): allowlisted origin (tier `origin` = model authors; `packager` = unsloth/ggml-org/bartowski/mlx-community with `--allow-packager` + `--derived-from`), pinned 40-hex commit sha, `.safetensors`/`.gguf` only — pickle formats and archives refused, `.py`/`trust_remote_code` refused without `--allow-remote-code`. Prefer self-quantizing from origin safetensors. Ship with `PROVENANCE_TRANSFER=1 scp`, then verify on the box (`D:\claude-coordination\Get-ProvenanceListing.ps1` → `provenance.py verify --listing --host box`). The PreToolUse hook denies `hf download`/`curl huggingface.co`/`ollama pull`/unmarked `scp *.gguf`/pickle loads; the keepalive refuses unmanifested model paths (`QWEN_PROVENANCE_ENFORCE=0` is a logged escape hatch, not a convenience). **Never bulk-hash `D:\models` against a live mmap-served model** — the box D: NVMe surprise-removes under sustained read (2026-08-01/07/15) and kills llama-server; announce a service window first. Defender history: the only two detections ever were a `!ml` heuristic on an upstream-identical llama.cpp DLL and our own PowerShell diagnostic (T2 `box-defender-detections-audit-2026-08-15`).

**Box servers cannot detach from SSH.** `Start-Process -WindowStyle Hidden` dies when the SSH session ends; a scheduled task hits **session-0/GPU isolation** (`/run` from SSH never enters the GPU-capable interactive desktop session). So a **keepalive holder** is required — see below. Auto-login is **ON** (Sysinternals Autologon, credential stored as an LSA secret, no cleartext `DefaultPassword`).

**Keepalive (durable serving).** `scripts/ops/keepalive-coprocessor.sh` run as a **launchd LaunchAgent** (`scripts/ops/com.qwen.coprocessor-keepalive.plist.example` → `~/Library/LaunchAgents/`) holds the box server via SSH and restarts on crash, independent of any login shell. It **executes out of the git worktree**, so switching branches changes what production runs. Encoded invariants (each was a real failure): **`ssh -n`** (a backgrounded ssh reading stdin gets SIGTTIN under launchd and kills the daemon); **guard every `kill`** (`kill 0` signals the whole process group → self-TERM crash loop); **`--log-file`** not nested shell redirect; **order-aware recovery**. **Survives unattended reboot** (validated 2026-09-12, 111 s reboot→serving, no human input): it blocks on an interactive-session guard before starting — without it the keepalive starts before auto-login finishes, launches into session 0, fails, and gives up silently. A **preflight** refuses to launch, by name, unless carve is 64 GB, the pagefile is fixed at 128 GB, exactly one launcher exists (no Startup-folder entry, scheduled task or service — stale ones from bead 36p were removed), and post-load GPU dedicated lands in the expected band; it also adopts an already-running server rather than restarting it. `QWEN_PREFLIGHT_ENFORCE=0` is a logged escape hatch. **Never run `keepalive-mac.sh` directly** — it reaps existing MLX servers on startup as singleton enforcement.

**Mac / MLX.** Serve with **`-w1`** for agentic runs — two concurrent long-context (~150-turn) conversations + a 42 GB model OOMs Metal (`kIOGPUCommandBufferCallbackErrorOutOfMemory`) and crashes the server. Model and repo storage is the **WD_BLACK NVMe at `/Volumes/SanHell`** (`HF_HOME=/Volumes/SanHell/hf-cache`, repo at `/Volumes/SanHell/git/qwen-coprocessor-stack`, Docker `DataFolder` there too). Do **not** use the SD card at `/Volumes/Transcend Hell`: it silently corrupted two separate 50 GB downloads with different wrong hashes and no I/O error (its stored data verified clean — the fault is sustained writes under load). **TCC:** launchd cannot read an external volume without Full Disk Access (granted to `/bin/bash`; symptom `Operation not permitted`, rc 126), and FDA on bash is not enough — launchd opens `StandardOutPath`/`StandardErrorPath` itself before exec, so **agent log paths must stay on internal storage** or the job fails with `EX_CONFIG` 78 and never runs. Homebrew's framework Python also needs its own grant: `bin/python3.14` re-execs into `Versions/3.14/Resources/Python.app`, TCC treats that bundle as a separate client, and without FDA on `Python.app` the keepalive's manifest read blocks forever in `open()` (no error, no log line, serving stays down; 2026-09-13). Keep the mlx-venv on internal. Time Machine excludes SanHell, the card and `~/llm-staging`. The `mlx-lm` server strips MTP weights at load, so speculative decoding needs `mlx_vlm.server`.

**Eval methodology (also in nexus KB).** (1) **Never compare numbers across harnesses** — the vendor-vs-standardized-scaffold gap is 10–30 pp; always reproduce a known anchor in *your* harness first (we reproduced Claude Sonnet = 65 % in mini-swe-agent). (2) **Gold-validate any subset** before trusting it — gold patches must score ~100 %; broken/flaky instances exist (Lite 36/40, Verified 46/50) and must be excluded from model scores; build images **serially** (parallel cold builds throw false OOM "failures"). (3) **`temperature=0` causes deterministic agentic loops** in Qwen-coder (identical context → identical command → step-limit, empty patch) — use the model's intended sampling (`temp 0.7, top_p 0.8`). (4) A too-low **generation `max_tokens` truncates tool calls mid-write** → unparseable → stalls; set it generously (16384) but bounded. (5) Vendor SWE-bench numbers don't reproduce in minimal harnesses (gpt-oss 62 % → ~1/10); **agentic-trained models are harness-robust** (Coder-Next ~71 % in mini-swe-agent). (6) best-of-k gains don't survive de-enrichment (random sample) — the lift was a flippy-instance selection artifact.

## Conventions & Patterns

- Routing config is data, not code — add backends in `config.json`; the supervisor health-probes and pools automatically. Keep `tier`/`capacity`/`weight` consistent across backends you want pooled together.
- For a new model on the box, verify the llama.cpp build supports its arch (load + a real generation) **before** wiring it into the pool.
- Operational scripts under `scripts/coding-eval/work/` are gitignored experiments; durable findings go to `bd remember` (T2) and the nexus T3 KB.
