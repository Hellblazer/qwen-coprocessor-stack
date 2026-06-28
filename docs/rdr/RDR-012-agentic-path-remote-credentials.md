---
title: "Agentic-path remote credentials — forward per-backend auth so qwen_spawn/qwen_oneshot can drive authenticated remote OpenAI-compatible providers (OpenRouter, Together, Fireworks)"
id: RDR-012
type: Design
status: accepted
priority: medium
author: hal
reviewed-by: self
created: 2026-06-27
accepted_date: 2026-06-27
related_issues: []
---

# RDR-012: Agentic-path remote credentials

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft (2026-06-27).** Small, focused routing/auth change. No new abstractions; closes a
one-line asymmetry between the direct-HTTP tool path and the agentic SDK path.

## Problem Statement

The supervisor already treats every backend as "an OpenAI-compatible endpoint," and the
`Backend` schema already carries the remote-provider credential fields — `api_key`,
`api_key_env`, and `headers` (`src/types.ts:147-156`, comment literally names *"OpenRouter,
Together, Fireworks"*). The **direct-HTTP tools** (`qwen_chat`, `qwen_oneshot_vision`,
`qwen_embed`, `qwen_rerank`, `qwen_tokenize`) honor those fields today via
`resolveAuthHeaders` in `src/openai-compat.ts:72-90`. So authenticated remote providers
already work for chat/vision/embed/rerank with a config edit and **zero code**.

The **agentic path** (`qwen_spawn` / `qwen_oneshot`, routed through `@qwen-code/sdk`) does
**not**. `src/session.ts:223-227` hardcodes the credential:

```ts
const env: Record<string, string> = {
  OPENAI_BASE_URL: backend.url,                                  // ✅ per-backend
  OPENAI_API_KEY: process.env["OPENAI_API_KEY"] ?? "sk-local",   // ❌ single global key
  QWEN_MODEL: backend.model,
};
```

`OPENAI_BASE_URL` is already per-backend, so an agentic spawn can *point* at a remote
endpoint — but it cannot carry that backend's own credential. Every agentic spawn shares one
process-global `OPENAI_API_KEY` (or the `sk-local` placeholder). Consequences:

1. You cannot pool a credentialed remote agentic backend (OpenRouter) alongside a local
   no-auth llama-server in the same agentic pool — the local placeholder and the remote key
   are mutually exclusive at the process level.
2. Per-backend key rotation (the whole point of `api_key_env` resolving at request time)
   does not reach the agentic path.
3. OpenRouter attribution headers (`HTTP-Referer` / `X-Title`) have no channel on the
   agentic path at all (the SDK takes credentials via env, not an arbitrary headers map).

This blocks using remote frontier models for the hard agentic tail — exactly the SWE-bench
ceiling RDR-006's eval work kept hitting with local models.

## Context

- **RDR-001** (closed): the supervisor's session pool and the credential-boundary invariant
  — the supervisor holds no Anthropic credential. This RDR does **not** weaken that: it
  forwards an *OpenAI-compatible* bearer the operator placed in config/env, never an
  Anthropic credential, and never logs it.
- **`src/openai-compat.ts:72-90` `resolveAuthHeaders`**: the existing, tested resolution
  order — `api_key` literal > `api_key_env` (read from `process.env` at request time) >
  merge `headers`. The direct-HTTP path's source of truth. This RDR reuses its *resolution
  logic*, not its return shape (the agentic path needs an env value, not an `Authorization`
  header string).
- **`src/session.ts:223-227`**: the env block handed to the SDK query. The single change
  site.
- **`@qwen-code/sdk` credential model**: the inner qwen-code CLI authenticates via
  `OPENAI_BASE_URL` / `OPENAI_API_KEY` env (`authType: "openai"`). It has **no documented
  env channel for arbitrary request headers** — confirmed against the SDK surface used in
  `session.ts`. This bounds what item 2 can deliver (see Decision).

## Decision

### In scope

1. **Resolve the agentic `OPENAI_API_KEY` from the chosen backend, not the process global.**
   Add a small helper (e.g. `resolveBackendApiKey(backend, env): string | undefined`)
   mirroring `resolveAuthHeaders`'s precedence: `backend.api_key` literal >
   `process.env[backend.api_key_env]` > **fall back to the existing
   `process.env["OPENAI_API_KEY"] ?? "sk-local"`** so current local-only behavior is
   byte-for-byte unchanged when a backend declares no credential. Factor the precedence so
   `resolveAuthHeaders` and the new helper share one source of truth (no second copy of the
   literal-vs-env order to drift).

   **The `api_key_env`-unset trap is closed explicitly (gate finding S1).** The
   `?? "sk-local"` placeholder fallback applies ONLY when the backend declares **neither**
   `api_key` nor `api_key_env` (the local-llama case). When a backend *does* declare
   `api_key_env` but the named variable is unset/empty at request time, the resolver must
   **not** silently fall through to `"sk-local"` — that would ship a bogus bearer to a remote
   provider and surface as an ambiguous 401. Instead: emit a WARN naming `backend.id` and the
   missing variable name (never the value) and resolve to an **explicit empty string** so the
   provider rejects on a clean, distinguishable "no credential" path. (Empty string, not
   `undefined`/omitted: omitting the env key would let the SDK child inherit any process-global
   `OPENAI_API_KEY` and leak it to the remote provider; an explicit `""` overrides it.) This is
   a deliberate divergence from the
   direct-HTTP path only in *logging* — `resolveAuthHeaders` already resolves the same unset
   case to "no Authorization header" (openai-compat.ts:78-80), which is the correct quiet
   behavior there; the agentic path adds the WARN because its placeholder fallback would
   otherwise mask the misconfig.

2. **Attribution headers on the agentic path: documented limitation, not silent drop.**
   The SDK has no header channel, so `backend.headers` cannot reach the inner qwen-code on
   the agentic path. This RDR does **not** invent one (no wrapper-injected proxy, no forked
   SDK — that would be a galactic hammer for optional dashboard labeling). Instead: when an
   agentic spawn routes to a backend that declares `headers`, **log once at WARN** that
   custom headers are not forwarded on the agentic path (they *are* on the direct-HTTP
   tools). **WARN-once scope is specified (gate finding S2): once per distinct `backend.id`,
   per process lifetime, tracked in a `Set` at the pool level** — not per-spawn (would storm
   long-running pools) and not a single global flag (would miss a headers-bearing backend
   added via config hot-reload). OpenRouter functions correctly without
   `HTTP-Referer`/`X-Title`; only its dashboard attribution is affected. The limitation is
   recorded here and surfaced in the config example.

3. **Secret hygiene parity.** The resolved key is never logged. Existing failure-message
   excerpting (≤300 chars of provider error text) is unchanged; it already never includes
   the request `Authorization`/env. Add a test asserting the key never appears in any log
   line emitted on the spawn path.

### Out of scope

- **Forwarding arbitrary headers to the inner qwen-code CLI.** Deferred until a concrete
  caller needs provider-specific routing tags on the *agentic* path (the direct-HTTP path
  already covers headers). If ever needed, the wrapper-bridge env (`session.ts:228-230`) is
  the natural seam — note it, don't build it.
- **A managed/self-hosted gateway layer (LiteLLM / Portkey).** Researched and rejected:
  the supervisor already implements modality → tier → capacity → health → weighted-RR
  routing with local fallback (`backends.ts`). Wrapping our working router in another
  router is net-negative. OpenRouter is adopted *as one more `tier:"remote"` backend* (a
  meta-provider), not as a replacement router. (The stray empty `config/litellm_config.yaml`
  and `config/router.py` directories predate this and are unrelated; leave or remove
  separately.)
- **Capacity-heuristic retuning for remote economics.** `classifyCapacity` is a
  prompt-size proxy tuned for local VRAM/bandwidth; remote frontier models invert the cost
  model (latency/$ not VRAM). Routing remote agentic backends is expected via explicit
  `opts.backend` pin or `role`, not the size heuristic. Documented as guidance; no code.

### Bright line

No change to the credential-boundary invariant (no Anthropic credential in the supervisor),
no new abstraction beyond the single shared resolver, no SDK fork, no proxy.

### Approach

Implementation phases, each closed by a bead (`ItemN=<closing-bead>`; beads filed at planning).

1. **Shared credential resolver + agentic-path wiring + tests.** Extract the
   literal-vs-env precedence into one helper used by both `resolveAuthHeaders` (refactor to
   call it) and `session.ts`. Wire `session.ts:223-227` to resolve `OPENAI_API_KEY` from the
   backend, preserving the `?? "sk-local"` fallback. Unit tests: (a) backend with
   `api_key` literal → that key in the SDK env; (b) backend with `api_key_env` → resolved
   from `process.env` at call time; (c) backend with neither → unchanged
   `OPENAI_API_KEY ?? "sk-local"` fallback; (d) key never appears in emitted logs;
   (e) `api_key_env` set but the named var **unset** → resolves to `undefined` (NOT
   `"sk-local"`) and WARNs with `backend.id` + var name (gate S1); (f) **refactor regression**
   — `resolveAuthHeaders` for a no-auth local backend still returns an empty object through the
   shared helper path (gate obs 4). Item1=qwen-coprocessor-stack-5de.
2. **Headers-limitation WARN + docs.** One-time WARN when an agentic spawn routes to a
   backend declaring `headers`; document the direct-HTTP-vs-agentic header asymmetry in the
   config example and `CLAUDE.md` routing notes. Item2=qwen-coprocessor-stack-i8q.

## Research Findings

- **RF-1 — Direct-HTTP path already complete. VERIFIED (2026-06-27).** `resolveAuthHeaders`
  (`openai-compat.ts:72-90`) builds `Authorization: Bearer <key>` and merges `headers`;
  all five direct-HTTP tools dispatch through it. OpenRouter/Together/Fireworks work for
  chat/vision/embed/rerank today via config alone.
- **RF-2 — Agentic path is the sole gap. VERIFIED.** `session.ts:223-227` hardcodes a
  process-global key; `OPENAI_BASE_URL` and `QWEN_MODEL` are already per-backend.
- **RF-3 — SDK has no header channel. VERIFIED against the SDK surface in `session.ts`.**
  `@qwen-code/sdk` authenticates via env (`authType:"openai"`); no env carries arbitrary
  request headers. Bounds item 2 to a documented limitation rather than a feature.
- **RF-4 — Gateway landscape. RESEARCHED, rejected as a layer.** OpenRouter (managed,
  +5% markup, ~100-150ms overhead, auto provider-failover + opt-in model fallbacks) vs
  LiteLLM (self-hosted, ~8ms P95, 6 routing modes) vs Portkey (Apache-2.0, <1ms,
  guardrails). Our router already covers health/failover/RR; adopt OpenRouter as a backend,
  not a router. Sources: openrouter.ai/docs, helicone.ai/blog/top-llm-gateways-comparison-2025,
  openrouter.ai/blog/insights/openrouter-vs-litellm.

## Consequences

### Positive
- Unblocks authenticated remote agentic backends (frontier models for the hard SWE-bench
  tail) with a single, low-risk change site.
- One shared credential resolver — direct-HTTP and agentic paths stop being able to drift.
- Per-backend key rotation (`api_key_env` at request time) now reaches the agentic path.
- Behavior-neutral for existing local-only deployments (the `sk-local` fallback is preserved).

### Negative
- OpenRouter attribution headers remain unavailable on the agentic path (SDK limitation);
  affects dashboard labeling only, surfaced as a WARN + doc note rather than fixed.
- Remote agentic backends bypass the capacity heuristic by design — operators must pin or
  role-route them, an extra config discipline. If left unpinned, the prompt-size heuristic
  can route arbitrarily large prompts to a remote backend at unexpected cost/latency; this is
  the operator's responsibility (gate observation 3).
- **Known-unknown: remote-provider agentic tool-call/JSON-schema compatibility is unvalidated
  (gate observation 2).** The inner qwen-code CLI emits tool-use and `response_format` in the
  shape `@qwen-code/sdk` produces; a remote provider must accept that shape for the chosen
  frontier model. Providers differ in tool-call tolerance, JSON-schema keyword support, and
  streaming. Since the SDK has no format-override channel and forking it is out of scope, a
  provider/model that rejects qwen-code's shape has no in-stack recourse beyond switching
  model/provider. `scripts/shakeout-openrouter.py` validates chat/json-schema/tool-calling
  against the *provider's* direct endpoint, but the *agentic* tool-loop shape is only
  confirmable by a live `qwen_spawn` against the target — flagged as a first-use check, not a
  pre-validated guarantee.

### Neutral
- No gateway dependency adopted; OpenRouter is just another `tier:"remote"` backend.
