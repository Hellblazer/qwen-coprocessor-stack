---
name: Plugin management — exposing the inner Qwen's tool surface to the operator
type: architecture
status: draft
priority: medium
created: 2026-05-04
authors:
  - hal.hildebrand
related:
  - RDR-001 §D6 (in-repo authoring decision — superseded in spirit by this RDR's pass-through framing)
  - RDR-001 §S4 (write-authority gating, applied uniformly across whatever plugin set is loaded)
  - RDR-003 (plugins emit through the same pino logger / OTel context)
  - RDR-004 (qwenctl plugins subcommand surface lives there)
---

# RDR-002 — Plugin management: exposing the inner Qwen's tool surface to the operator

## Status

**Draft** (2026-05-04). Reframed from an earlier draft of this RDR which
was scoped as "catalogue of plugins this repo ships." That framing was
rejected by the project owner: plugins are an operator concern and this
repo does not impose its preferences. The current scope — **management
of whatever plugins the operator chooses** — is what was originally
intended.

This RDR is research-gated. Three spikes (Q1–Q3 below) must land before
the design here moves to Accepted. The provisional design assumes the
SDK supports per-call plugin selection; if it doesn't, the implementation
shifts to a heavier home-directory pre-filtering path with the same
operator-facing surface.

## Context

### Architectural fact (load-bearing)

`@qwen-code/sdk` runs as a Node library inside the supervisor's process
on the operator's workstation. The SDK is given `cwd: process.cwd()`
and an OpenAI-compatible HTTP endpoint (`backend.url`). When `query(...)`
is invoked, the SDK opens an HTTP stream to the backend and exchanges
prompts and completions.

The LLM at the other end of that stream — whether on the local M4 Max
llama-server, a remote Strix Halo Vulkan host, or any other backend
declared in the fleet (RDR-004) — performs inference only. It generates
tokens. When those tokens describe a `tool_use` block, the SDK on the
operator's workstation parses that block and executes the tool against
the supervisor's filesystem, network, and environment.

This means the *plugins* (the things that extend the inner Qwen's tool
surface) run in the **supervisor's** process, on the **operator's** box,
not on the inference backend. The set of plugins available is determined
by the local Qwen Code SDK installation, not by the choice of inference
backend.

This separation is what makes RDR-004 (fleet management) and this RDR
(plugin management) orthogonal: adding a remote llama-server changes
nothing about which plugins the inner Qwen sees; adding a plugin changes
nothing about which backends are reachable.

### What's missing

The supervisor currently inherits whatever the SDK's default plugin
search path picks up — silently. There is no operator-facing surface to:

- See which plugins are installed and which are active.
- Install or upgrade plugins.
- Disable a plugin without uninstalling it.
- Choose a different plugin loadout for one session vs. another.

These omissions matter as soon as more than one task type is in play.
A code-refactoring session benefits from Serena's symbol-navigation
tools; a documentation-lookup session wants Context7's library docs;
running both with the union of all tools loaded inflates the model's
attention surface and degrades tool-selection precision. Per-task
loadouts directly address that.

The supervisor also has a contract with the inner Qwen — write-authority
gating (§S4), `ask_user_question` exclusion (§Q1), the coprocessor
preamble (system prompt). Today this contract is enforced entirely
through `QueryOptions` (`permissionMode`, `excludeTools`, `canUseTool`,
`systemPrompt`) and does **not** require any plugin to be loaded. That
is the desired baseline: the framework imposes zero plugins. Future
supervisor features that *do* require a plugin (e.g. a hypothetical
"report progress" callback the inner Qwen calls into) would be tracked
explicitly in a follow-up RDR — never implicitly bundled into a
"canonical default set."

## Scope (what this RDR is and is not)

**This RDR is:**

- The supervisor's management surface for plugins the operator chooses
  to install.
- The protocol by which the supervisor selects which subset of installed
  plugins is active for a given session.
- A clear declaration that the framework-required plugin set is empty
  today, with a tracked path to add to it only by explicit RDR.

**This RDR is not:**

- A catalogue of plugins to ship with this repo.
- A mandate that any specific plugin be installed.
- A reimplementation of Qwen Code's plugin loader. The supervisor
  passes through to whatever the SDK provides; it does not fork it.
- A specification of any specific plugin's behavior.

## Decision drivers

- **D1. Tools run locally; plugins extend that local surface.** The
  inference backend is irrelevant to the plugin question. The
  management surface lives entirely on the operator's workstation.
- **D2. Per-task plugin loadout.** Different sessions want different
  tool surfaces. The orchestrator (Claude) or the operator should be
  able to ask for a specific loadout at `qwen_spawn` time.
- **D3. No framework mandate beyond the supervisor's runtime
  contract.** The contract is enforced through `QueryOptions`, not
  plugins. Any future need for a forced-on plugin is a visible
  decision recorded in its own RDR, not a hidden default.
- **D4. Consistent with Qwen Code's plugin system.** The supervisor
  exposes what's already there; it does not invent a parallel plugin
  format, install mechanism, or manifest schema.
- **D5. Discoverable.** "What plugins are loaded right now?" must
  have a one-command answer for the operator and a one-tool-call
  answer for Claude.
- **D6. Reversible.** Disabling a plugin is non-destructive; the
  installed bits remain on disk. Operator can re-enable without
  reinstall.

## Research questions (gating)

The concrete shape of the management surface depends on what the SDK
exposes. These spikes must complete before the design below is
finalised:

### Q1 — Plugin discovery: where does Qwen Code look?

What environment variables, search paths, or config files determine
which plugins the SDK loads? Most likely candidates: a directory under
the user's `~/.qwen/` (or similar), an env var, or a `QueryOptions`
field. Exact behaviour TBD.

**Spike:** read the @qwen-code/sdk source for plugin discovery; run a
trivial hello-world plugin and observe which paths are consulted.
~30 minutes.

### Q2 — Per-call plugin selection in `QueryOptions`

Does `QueryOptions` expose a per-call plugin search path or
include/exclude list? If yes, per-session loadout is a one-line
pass-through. If no, we need to either:

- (a) Pre-filter the home directory before SDK init (heavier; the
  supervisor manages a per-session plugins directory), or
- (b) Use a single shared loadout per supervisor process, with no
  per-session override.

**Spike:** TypeScript test against `@qwen-code/sdk@0.1.7` constructing
two simultaneous `query()` sessions with different plugin sets;
observe whether they're isolated. ~30 minutes.

### Q3 — Plugin manifest and identity

What identifies a plugin? Directory name, `plugin.json` field,
`package.json` `name`, or something else? Affects how
`qwenctl plugins list` displays them and how `opts.plugins.only`
references them.

**Spike:** examine an existing public Qwen Code plugin's structure
(if one is published). ~15 minutes.

### Q4 — Distinction between installed and active

Does Qwen Code surface a notion of "installed but disabled," or is
the only state present-vs-absent in the search path? Affects whether
the supervisor needs to maintain its own `enabled`/`disabled` state
file, or can rely on the SDK's mechanism.

**Spike:** check the SDK / Qwen Code docs for an enable/disable
concept; if absent, plan to maintain state in a supervisor-side file
(`plugins.toml` below). ~10 minutes.

## Provisional design

The design below assumes Q1–Q4 will broadly confirm: plugins live
under a known directory; `QueryOptions` accepts some form of
per-call selection (or can be wrapped to provide it); plugins are
identified by directory name; "disabled" is a supervisor concept
even if the SDK lacks one.

If the spikes invalidate any of these, the design adapts. The
operator-facing surface (Layer 1) and the per-spawn shape (Layer 3)
do not change; only the mechanics inside Layer 2 / Layer 3 do.

### Layer 1 — Operator: install / upgrade / remove

Plugins live where Qwen Code expects them (TBD per Q1; assumed to be
`${QWEN_AGENT_SERVER_HOME}/plugins/<name>/` or equivalent). The
supervisor does NOT reimplement install. Operators install plugins
the way they install any Qwen Code plugin — `git clone`, `npm install`,
unzip a release tarball, etc.

`qwenctl plugins` (defined in RDR-004's CLI surface) wraps the
common operations:

| Command                              | Effect |
|--------------------------------------|--------|
| `qwenctl plugins list`               | List installed plugins, indicate enabled/disabled |
| `qwenctl plugins inspect <name>`     | Show the plugin's manifest, declared tools, enabled state |
| `qwenctl plugins install <source>`   | Convenience wrapper: git clone or download to the plugins dir |
| `qwenctl plugins remove <name>`      | Delete the plugin's directory (with confirmation) |

`install` is intentionally thin — a wrapper around git/curl, not a
package manager. Operators with more complex needs use their normal
tools directly; the supervisor doesn't get in the way.

### Layer 2 — Supervisor-wide: enabled set

Some installed plugins default to active; others installed but
inactive. The supervisor reads
`${QWEN_AGENT_SERVER_HOME}/plugins.toml`:

```toml
# plugins.toml — supervisor-wide enabled set

[plugins]
enabled  = ["serena-code-nav", "context7-docs"]
disabled = ["some-experimental-plugin"]   # installed but off by default
```

Plugin identifiers (`serena-code-nav` etc.) are operator-chosen labels
matching whatever Q3 settles on (most likely directory names).

If `plugins.toml` is absent, ALL installed plugins are enabled — the
backwards-compatible default for operators upgrading from no
management at all.

`qwenctl plugins enable <name>` / `disable <name>` mutate this file.
The supervisor watches the file (opt-in `QWEN_PLUGINS_WATCH=1`) and
re-applies on edit; otherwise, the change takes effect on the next
supervisor restart or `qwen_reload_plugins` call (see Layer 4).

### Layer 3 — Per-spawn override

`qwen_spawn` gains `opts.plugins`:

```ts
opts.plugins?: {
  enable?:  string[];   // additive over supervisor defaults
  disable?: string[];   // subtractive
  only?:    string[];   // exact set; ignore supervisor defaults entirely
}
```

Resolution order: if `only` is set, it wins. Otherwise the supervisor
default set is taken, `enable` adds, `disable` removes. The resolved
list is passed to the SDK per Q2's outcome.

This is the surface Claude actually uses: when delegating a task,
Claude can request "for this code-refactoring task, use the
serena-code-nav loadout only." The supervisor honours it for that
session without affecting the supervisor-wide default.

### Layer 4 — Hot-reload (admin-only MCP tool)

A `qwen_reload_plugins` MCP tool, gated on `QWEN_ADMIN_TOOLS=1`,
re-reads `plugins.toml` and applies the diff to future sessions. In-flight
sessions retain the loadout they spawned with — re-reading the
config does not mutate running sessions. This matches RDR-004's
hot-reload semantics for backends.

### Framework-required plugins (today: empty)

The supervisor's contract with the inner Qwen — write-authority
gating, ask_user_question exclusion, system prompt preamble,
multi-turn streamInput input queue — is enforced through
`QueryOptions` and does not require any plugin to be loaded.

The supervisor therefore declares **zero framework-required plugins**.
This is deliberate. Adding even one would change the supervisor's
contract; that change must be explicit, RDR-tracked, and reviewable.
Until such an RDR exists, an operator can disable every plugin and
the supervisor still functions correctly.

If a future feature requires a forced-on plugin, it gets its own RDR
(RDR-002.x or follow-up). The operator-facing surface gains a small
"forced" badge in `qwenctl plugins list` for any such plugin, with a
hint pointing back to the introducing RDR.

### Resolution algorithm (per `qwen_spawn`)

```
1. Read supervisor defaults from plugins.toml (or "all installed" fallback).
2. If opts.plugins.only is set, use that as the base set; else use defaults.
3. Apply opts.plugins.enable additively.
4. Apply opts.plugins.disable subtractively.
5. Union with framework-required plugins (today: none; the union is a no-op).
6. Pass the resolved set to the SDK via the Q2-resolved mechanism.
7. Record the resolved set in the session's first event (plugins_loaded)
   so qwen_poll surfaces it, making "what was the tool surface for this
   session?" a self-answering question.
```

## Consequences

### Positive

- Operator has a clear, minimal management surface: one config file,
  four `qwenctl` subcommands, three spawn options.
- Per-session loadouts let Claude tailor the tool surface to the task,
  improving tool-selection accuracy.
- No mandate beyond the runtime contract — operators bring their own
  plugins; the repo doesn't dictate.
- Pass-through to Qwen Code's plugin system avoids forking it; SDK
  upgrades inherit upstream plugin improvements.
- Framework-required plugins are a tracked, RDR-gated decision —
  no implicit defaults to surprise operators.

### Negative

- Three layers of state (installed / enabled / per-spawn) is more
  surface than zero. Each is small and serves a distinct concern,
  but operators must learn the resolution order.
- Per-spawn override depends on SDK support (Q2). If the SDK doesn't
  support per-call selection, the fallback (home-directory
  pre-filtering) is heavier and less elegant — but the operator
  surface remains identical, which protects the integration layer
  from leaking into the operator's mental model.
- Operators who already manage plugins by hand (editing
  `~/.qwen/plugins/` directly outside the supervisor's view) see two
  paths to the same data. Documented as a corner case; the supervisor's
  Layer 1 commands are best-effort wrappers, not the only valid path.

### Neutral

- `plugins.toml` is a new file. Sized like RDR-004's `fleet.toml` —
  small, hand-editable, TOML to avoid YAML's whitespace gotchas.
- This RDR ships with research questions explicitly listed and gated
  on spike outcomes. That's the cost of designing against an external
  plugin system whose surface we don't yet fully know; the alternative
  (over-commit and hope) is worse.

## Open work

- Q1–Q4 spikes (above). Land before the RDR moves to Accepted.
- `qwenctl plugins` subcommand spec in RDR-004 implementation.
- Decision on `plugins.toml` schema once Q3 (plugin identity) lands —
  if plugin IDs aren't directory names, the schema's keys change.
- Operator UX for the "all installed = enabled" default fallback —
  decide whether to silently default-enable or prompt the operator
  to confirm on first run.

## Related decisions and prior art

- RDR-001 §S4 — write-authority gating. Applied uniformly across
  whatever plugin set is active; plugins do not bypass.
- RDR-001 §Q1 — `ask_user_question` exclusion. Same: applies
  uniformly. A plugin cannot re-add `ask_user_question` to the inner
  Qwen's surface; if a plugin tries, the SDK's `excludeTools` wins.
- RDR-003 — plugin-logger helper for unified pino + OTel emission;
  plugins use that, not their own logger.
- RDR-004 — `qwenctl plugins` subcommand. The Go binary in RDR-004
  is the operator's surface; the supervisor's MCP tools are
  Claude's surface. Same data, two views.
- Qwen Code's plugin documentation (TBD link once stable) — the
  upstream definition this RDR exposes.

## References

- `mcp-bridges/qwen-agent-server/src/session.ts` — `QueryOptions`
  construction; the integration point per Q2.
- `mcp-bridges/qwen-agent-server/src/server.ts` — `qwen_spawn`
  signature, where `opts.plugins` is added.
- `mcp-bridges/qwen-agent-server/src/types.ts` — `SpawnOpts` type;
  needs an optional `plugins` field after the spike outcomes.
