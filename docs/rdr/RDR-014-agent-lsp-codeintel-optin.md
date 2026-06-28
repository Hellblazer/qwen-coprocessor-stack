---
title: "agent-lsp opt-in code-intelligence provider — one-flag opts.codeIntel that injects agent-lsp, its symbol-graph guidance, and a default tool budget into a spawn"
id: RDR-014
type: Design
status: accepted
priority: medium
author: hal
reviewed-by: self
created: 2026-06-28
accepted_date: 2026-06-28
related_issues: []
---

# RDR-014: agent-lsp opt-in code-intelligence provider (`opts.codeIntel`)

> Revise during planning; lock at implementation.
> If wrong, abandon code and iterate the RDR.

## Status

**Draft (2026-06-28).** Phase 2 of the harness adopt-vs-rewrite decision
(T2 `qwen-coprocessor-stack/decision-harness-adopt-vs-rewrite-2026-06-27`):
**extend in place**. RDR-013 (closed) shipped per-spawn `mcpServers`/`agents`
forwarding and explicitly deferred "agent-lsp bundling / a default MCP set" to
"Phase 2 ... built ON this forwarding" (RDR-013 §Out of scope). This RDR is that
Phase 2 — but **opt-in, not a default** (the agent-lsp spike forced that
narrowing, see below). Approved design: T2
`qwen-coprocessor-stack/design-agent-lsp-codeintel-optin.md`.

## Problem Statement

RDR-013 made it *possible* to provision a coprocessor with agent-lsp by passing
a full `opts.mcpServers` block per call. But the agent-lsp spike
(T2 `qwen-coprocessor-stack/agent-lsp-spike-findings-2026-06-28`) showed two
things: (1) the plumbing works end-to-end through the live supervisor; (2) the
real friction is **output format** — agent-lsp returns a scored *symbol-graph*
(`@NNN … name SCORE lsp_resolved`), not plain `file:line`, and a driving model
(GLM 5.2) looped trying to convert graph nodes to locations until its
`max_tool_calls` budget cut it off. The raw `mcpServers` block carries no
guidance, so every caller would re-hit that friction and would have to remember
to (a) paste the agent-lsp config, (b) paste a recommended `max_tool_calls`, and
(c) hand-write the symbol-graph guidance into the task.

We want a single opt-in flag that bundles all three so the friction can't recur,
**without** making agent-lsp a default (the spike's explicit recommendation:
"do NOT wire agent-lsp as an unconditional default yet").

## Context

- **Delivery rides RDR-013's forwarding (VERIFIED, shipped).** `qwen_spawn` /
  `qwen_oneshot` already forward `opts.mcpServers` into
  `queryOptions.mcpServers` over the SDK control-protocol `initialize`. agent-lsp
  is a stdio server (`uvx agent-lsp`), one of the three JSON-serializable shapes
  RDR-013 accepts. So `codeIntel` is a **server-side convenience that synthesizes
  an `opts.mcpServers` entry + a guidance preamble + a budget default** — it adds
  no new transport.
- **agent-lsp install surface (VERIFIED this session).** `uvx agent-lsp`
  (v0.15.0) launches; `agent-lsp doctor` auto-detects typescript-language-server,
  clangd, gopls, jdtls on this host. The supervisor's own package is TypeScript,
  so the live ts-language-server detection is what coprocessor coding tasks need.
- **RDR-013 trust invariant carries over (do not relax).** A stdio `mcpServers`
  `command` spawns at SDK session *init*, before any tool call, so it is NOT
  gated by `permissionMode`/`canUseTool`. `codeIntel:true` therefore launches
  `uvx agent-lsp` regardless of `write_authority`. This is unchanged from
  RDR-013; `codeIntel` must document it, not silently widen it.
- **Serena is unaffected.** Serena (JetBrains backend) stays the human-driver
  code-nav seat; agent-lsp is for the *headless coprocessors* only. Different
  seats, no overlap.

## Decision

> **RF-1/RF-2/RF-3/RF-4 all VERIFIED (2026-06-28).** RF-4 (Item0, bead
> qwen-coprocessor-stack-60v) confirmed the inner CLI **enforces** per-server
> `includeTools` as a hard scope at MCP discovery (bare-name match) — the
> unenforced fallback did not trigger. The guidance + `max_tool_calls` cap remain
> additional anti-wander legs. See Research Findings.

### In scope

1. **`opts.codeIntel?: boolean` on `SpawnOpts`** (`src/types.ts`), reachable from
   both `qwen_spawn` and `qwen_oneshot`, zod-validated in `src/server.ts`
   (`buildSpawnOptsFromRaw`). Default/unset → byte-for-byte unchanged behavior.
2. **When `codeIntel === true`, synthesize an agent-lsp stdio `mcpServers`
   entry** under reserved key **`agent-lsp`** (namespaced, NOT the generic `lsp`
   a caller would plausibly use for their own language-server integration):
   `{ command: "uvx", args: ["agent-lsp"], cwd: <session cwd>,
   includeTools: [<high-signal set>] }`. The `includeTools` allow-list
   (field VERIFIED on `CLIMcpServerConfig`, RF-1) scopes the forwarded server to
   the high-signal tools. **Enforcement (RF-4, VERIFIED ENFORCED):** the inner
   qwen-code CLI hides non-listed tools at MCP discovery (bare-name match), so
   `includeTools` is a hard scope, not best-effort; the symbol-graph guidance
   (item 3) and `max_tool_calls` cap are additional anti-wander legs. The pinned
   10-tool allow-list (from agent-lsp v0.15.0's 65 advertised tools): `start_lsp,
   list_symbols, find_symbol, find_references, find_callers, inspect_symbol,
   explore_symbol, go_to_definition, get_symbol_source, get_diagnostics`
   (T2 `rf4-includetools-enforcement-result`). **Caller-wins merge:** if the caller already supplied an `agent-lsp`
   server in `opts.mcpServers`, respect theirs, do NOT clobber, emit a structured
   WARN (`event_type: "codeintel_lsp_key_present"`, `backend_id`), and **suppress
   the guidance injection (item 3) too** — see item 3. (Precedent: RDR-013 never
   silently overrides caller config.)
3. **Inject symbol-graph guidance into the spawn's system prompt — but ONLY when
   item 2 actually injected the agent-lsp server.** A fixed block telling the
   agent: agent-lsp returns a scored symbol-*graph* (`@NNN … lsp_resolved`), NOT
   raw `file:line`; resolved paths live on the graph nodes; use
   `find_symbol` / `find_references` / `inspect_symbol` to obtain locations.
   **Coupling (fixes the collision case):** the guidance describes agent-lsp's
   tool surface specifically, so it MUST be gated on the same condition as the
   server injection. When a caller-supplied `agent-lsp` key suppresses the server
   injection, the guidance is suppressed too — otherwise the model would be told
   to call tools that may not exist on the caller's server, re-creating the
   search-loop failure. (The operator WARN is log-only; the inner model never
   sees it.) Delivery (RF-2 VERIFIED): the guidance is folded into `opts.system`
   **before** `buildSystemPrompt(...)` consumes it (see §Approach synthesis
   location), so it composes with `opts.system`/`prior_context`/`json_schema` and
   leaves the caller's `task` text untouched.
4. **Default `max_tool_calls` to 12** *only when the caller did not set one*
   (caller value always wins). 12 is the spike's working cap (clean
   `context_exceeded` abort observed at 13/12 with room to do real work).
   **The "did not set one" test MUST be `opts.max_tool_calls === undefined`,
   NOT a falsy/`??` coalesce.** `session.ts:180` uses `opts.max_tool_calls ?? 0`
   where **`0` is the "unbounded" sentinel** — a caller passing `0` is explicitly
   asking for no cap and MUST keep `0`. A `!opts.max_tool_calls` /
   `opts.max_tool_calls ?? 12` idiom would silently re-cap an explicitly-unbounded
   session to 12, re-creating the very loop-then-abort failure this RDR prevents.
5. **Tests** (extend `tests/session.test.ts` `capturedOptions` mock + the
   server-schema tests):
   (a) `codeIntel:true`, no caller `agent-lsp` → captured
   `queryOptions.mcpServers["agent-lsp"]` is the `uvx agent-lsp` entry **with the
   pinned `includeTools` allow-list**;
   (b) `codeIntel` unset → `mcpServers` unchanged/undefined AND `systemPrompt`
   carries no guidance block;
   (c) `codeIntel:true` + caller-supplied `agent-lsp` → caller entry preserved,
   `codeintel_lsp_key_present` WARN emitted (log spy), **AND the guidance block is
   NOT present in `systemPrompt`** (coupling assertion);
   (d) `codeIntel:true`, caller did not set `max_tool_calls` (undefined) →
   resolved budget is 12;
   (e) caller set `max_tool_calls:5` → stays 5;
   (f) `codeIntel:true`, caller set `max_tool_calls:0` (explicit unbounded) →
   stays 0 (NOT re-capped to 12) — guards C1;
   (g) `codeIntel:true`, no collision → guidance block present in captured
   `queryOptions.systemPrompt` and caller `task` unchanged;
   (h) zod: `codeIntel` accepts boolean (incl. explicit `false` → byte-for-byte
   unset behavior), rejects non-boolean.

### Out of scope

- **agent-lsp as a default / config-level default-on** — spike-locked NO. Opt-in
  only this RDR.
- **A named-preset registry / second code-intel provider** — YAGNI; `codeIntel`
  is an agent-lsp-specific boolean. A second provider later is a cheap registry
  refactor, paid only if it happens.
- **Bundling a language-server set / host provisioning of `uvx`** — we assume
  `uvx` + agent-lsp present on the coprocessor host (documented prereq), not
  installed by the supervisor.
- **Sandboxing the agent-lsp `command`** — inherits the RDR-013 trust model;
  hardening is a separate decision.

### Bright line

`codeIntel` only *synthesizes* RDR-013-shaped inputs (an `mcpServers` entry, a
guidance string, a budget default) — no new transport, no wrapper change, no SDK
fork, no supervisor-managed MCP lifecycle. When `codeIntel` is unset the path is
byte-for-byte the existing one.

### Approach

Implementation phases, each closed by a bead (`ItemN=<closing-bead>`).
Epic: `qwen-coprocessor-stack-63n`. **Item0=qwen-coprocessor-stack-60v**,
**Item1=qwen-coprocessor-stack-3k7** (blocked by Item0),
**Item2=qwen-coprocessor-stack-2qi** (blocked by Item1). NOTE: the server-side
expansion lands at BOTH `buildSpawnOptsFromRaw` sites in `server.ts` — `qwen_spawn`
(~:1277) and `qwen_oneshot` (~:1386).

**Synthesis location (committed): all `codeIntel` expansion happens server-side
in `src/server.ts`, in/just-after `buildSpawnOptsFromRaw(args.opts)`
(`server.ts:~1277`), mutating the resolved `SpawnOpts` BEFORE `QwenSession` is
constructed.** This keeps `session.ts` unchanged except for consuming the already-
resolved fields: the synthesized `agent-lsp` entry rides the existing
`opts.mcpServers` passthrough; the guidance is folded into `opts.system` so the
existing `buildSystemPrompt(opts.system, …)` at `session.ts:225` picks it up with
no signature change; the `max_tool_calls` default is set on `opts.max_tool_calls`
so the existing `?? 0` at `session.ts:180` sees the resolved value. Rationale: the
`=== undefined` budget check (C1) and the collision-coupling (C2) are single-site
and testable at the opts-resolution boundary, not threaded through the
constructor. `includeTools` already passes the `qwen_spawn` zod schema
(`server.ts:190`), and server-side synthesis bypasses the boundary anyway.

0. **(RF-4 verification, gates the includeTools claim) — confirm CLI enforcement.**
   A short live spawn through the supervisor: a forwarded MCP server exposing two
   tools with `includeTools:["A"]`; assert the inner model cannot invoke tool B.
   If enforced → keep `includeTools` as a hard scope. If NOT enforced → keep the
   field (harmless) but the RDR's anti-wander guarantee rests on the guidance +
   `max_tool_calls` cap only; update docs accordingly. Item0=<bead>.
1. **`codeIntel` opt + server-side expansion + guidance + budget default + WARN +
   tests.** Add `SpawnOpts.codeIntel` (with the write_authority + caller-wins +
   `max_tool_calls===undefined` docstrings); implement the expansion in
   `server.ts` per the committed location (synthesize `agent-lsp` entry with
   `includeTools`, caller-wins merge + `codeintel_lsp_key_present` WARN +
   **coupled** guidance suppression on collision, guidance folded into
   `opts.system`, `max_tool_calls` default only when `=== undefined`); add
   `codeIntel` to the `qwen_spawn`/`qwen_oneshot` zod schemas; tests (a)–(h).
   `npm run build` clean, `npm run typecheck:tests` clean, `npm test` green.
   Item1=<bead>.
2. **Docs.** USER_GUIDE.md (the opt-in `codeIntel` flag, the `uvx`/agent-lsp
   prereq, the symbol-graph behavior + recommended usage, the RF-4 enforcement
   outcome, and what a missing-`uvx` "degraded" spawn looks like), a config/usage
   example, and the CLAUDE.md architecture note (coprocessor tool surface).
   Item2=<bead>.

## Research Findings

- **RF-1 — Hard vs soft tool-scoping. VERIFIED (2026-06-28).** `CLIMcpServerConfig`
  (the stdio/SSE/HTTP shape in `node_modules/@qwen-code/sdk/dist/index.d.ts:448`)
  carries **`includeTools?: string[]`** and **`excludeTools?: string[]`** per
  server. So the supervisor CAN hard-scope the forwarded agent-lsp server to the
  high-signal tools via `includeTools` — scoping is enforcement, not just guidance.
  Moved hard-scoping INTO scope (§In-scope item 2); dropped the soft-only
  out-of-scope caveat. (Also available but unused here: `trust?`, `timeout?`.)
- **RF-2 — Guidance delivery channel. VERIFIED (2026-06-28).** `QueryOptions`
  exposes `systemPrompt?: string | { type:"preset", preset:"qwen_code",
  append?: string }` (`index.d.ts:560,399`). The supervisor already composes a
  **string** `systemPrompt` in `session.ts:225` (`buildSystemPrompt(opts.system,
  opts.prior_context, opts.json_schema)`) and passes it at `:298`. So guidance
  injects cleanly by **appending the block to that composed string** when
  `codeIntel === true` — no need for the preset form, and the caller's `task`
  text is never touched. Resolves §In-scope item 3's mechanism.
- **RF-3 — agent-lsp install/launch. VERIFIED (2026-06-28).** `uvx agent-lsp`
  v0.15.0 launches; `agent-lsp doctor` auto-detects typescript-language-server
  (+ clangd/gopls/jdtls) on the host. The symbol-graph output format and the
  `max_tool_calls=12` working cap are from the live spike (T2 spike findings).
- **RF-4 — `includeTools` CLI enforcement. VERIFIED — ENFORCED (2026-06-28,
  Item0 / bead qwen-coprocessor-stack-60v).** The inner qwen-code CLI enforces
  per-server `includeTools` as a **hard scope at MCP discovery**, matched on the
  **bare** tool name: a tool absent from the list is never registered and the
  model never sees it. Triangulated three ways: (1) SDK source —
  `cli.js` `isEnabled(funcDecl, …)` returns
  `!includeTools || includeTools.some(t => t === funcDecl.name || …)` and is
  called at discovery as `if (!isEnabled(...)) continue;` BEFORE
  `discoveredTools.push(new DiscoveredMCPTool(...))`; (2) a live spawn through the
  supervisor with a 2-tool test MCP server and `includeTools:["allowed_tool"]` —
  the blocked tool received zero `tools/call`; (3) the driving model's own report
  ("blocked_tool was not exposed … could not be called"). The §In-scope
  "hard-scope" language stands; the guidance + budget cap remain additional
  anti-wander legs. agent-lsp v0.15.0 advertises 65 tools; the pinned 10-tool
  allow-list is in T2 `rf4-includetools-enforcement-result` and the code. The
  RF-4 "unenforced" fallback in §Decision item 2 does NOT apply.

## Consequences

### Positive
- One flag gives a coprocessor real code intelligence with the friction
  pre-solved (guidance + budget travel with the provider) — the spike's three
  remediations bundled, no per-call boilerplate.
- Tiny, additive diff over shipped RDR-013 forwarding; unset path unchanged.
- Keeps agent-lsp opt-in, honoring the spike's "not a default yet" finding while
  still making it ergonomic enough to actually get used.

### Negative
- **Security surface:** `codeIntel:true` launches `uvx agent-lsp` at SDK init
  regardless of `write_authority` (inherited RDR-013 trust model). Documented, not
  sandboxed here.
- **Host prereq:** `uvx` + agent-lsp must be present on the coprocessor host; a
  missing binary degrades that spawn (SDK surfaces the failure, supervisor does
  not health-probe MCP servers — RDR-013 stance). The exact observable failure
  (event_type / error shape the caller sees) is characterized in the Item2 docs
  so a missing-`uvx` degrade is distinguishable from other spawn failures.
- **`includeTools` may be unenforced (pending RF-4):** if the inner CLI ignores
  the per-server allow-list, an agent could still reach low-signal agent-lsp tools
  (`blast_radius`/`explore`); the guidance discourages but cannot then prevent it.
  Resolved/documented by Item0 + Item2.

### Neutral
- `codeIntel` is agent-lsp-specific by deliberate YAGNI choice; generalizing to a
  preset registry is a later, additive refactor if a second provider appears.
