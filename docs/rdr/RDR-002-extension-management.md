---
name: Extension management — exposing the inner Qwen's tool surface to the operator
type: architecture
status: draft
priority: medium
created: 2026-05-04
authors:
  - hal.hildebrand
related:
  - RDR-001 §D6 (in-repo authoring decision — superseded by this RDR's pass-through framing)
  - RDR-001 §S4 (write-authority gating, applied uniformly across whatever extension set is loaded)
  - RDR-003 (extensions emit through the same pino logger / OTel context)
  - RDR-004 (qwenctl extensions subcommand surface lives there)
---

# RDR-002 — Extension management: exposing the inner Qwen's tool surface to the operator

## Status

**Draft** (2026-05-04). Reframed earlier the same day from a rejected
"canonical plugin catalogue" framing — operator preference, not repo
mandate. The four research questions (Q1–Q4) that gated the original
design are **resolved** via a spike against `@qwen-code/sdk@0.1.7`
(report at `/tmp/rdr-002-spikes.md`); findings are inline in the
"Research findings" section below and have firmed the design from
provisional to specified. A follow-up spike on the bundled Qwen CLI's
extensions subcommand surface (report at `/tmp/rdr-002-cli-spike.md`,
T2 record `002-research-005`) further simplified Layer 1 to a thin
shell-out wrapper — see "Decision" → "Layer 1."

A third spike (`/tmp/qwen-bridge-spike/spike.mjs`, T2 record
`002-research-006`) verified the Layer 2 wrapper bridge end-to-end
against the live SDK: `pathToQwenExecutable` accepts a script path,
`QueryOptions.env` reaches the wrapper subprocess, and the SDK's
constructed argv is structured such that prepending `--extensions
<list>` is safe. The behavior is now pinned as Pin 4 of
`tests/integration/sdk-behavior.test.ts` — any future SDK change
that breaks one of these assumptions is caught in CI.

**Terminology revision:** Qwen Code (the upstream tool the SDK
embeds) calls these things **extensions**, not "plugins." The
manifest file is `qwen-extension.json`; the on-disk directory is
`~/.qwen/extensions/`; the CLI flag is `--extensions`. This RDR
adopts that vocabulary throughout. Filename moved
`RDR-002-plugin-management.md` → `RDR-002-extension-management.md`
to match.

## Context

### Architectural fact (load-bearing)

`@qwen-code/sdk` runs as a Node library inside the supervisor's
process on the operator's workstation. The SDK is given
`cwd: process.cwd()` and an OpenAI-compatible HTTP endpoint
(`backend.url`). When `query(...)` is invoked, the SDK spawns the
bundled Qwen CLI as a subprocess (via `ProcessTransport`) and
exchanges JSON over stdio.

The LLM at the other end of the HTTP stream — whether on the local
M4 Max llama-server, a remote Strix Halo Vulkan host, or any other
backend declared in the fleet (RDR-004) — performs inference only.
It generates tokens. When those tokens describe a `tool_use` block,
the **CLI subprocess on the operator's workstation** parses that
block and executes the tool against the supervisor's filesystem,
network, and environment.

This means **extensions** (the things that extend the inner Qwen's
tool surface) run in the **supervisor's** subprocess, on the
**operator's** box, not on the inference backend. The set of
extensions available is determined by the local Qwen Code
installation, not by the choice of inference backend.

This separation makes RDR-004 (fleet management) and this RDR
(extension management) orthogonal: adding a remote llama-server
changes nothing about which extensions the inner Qwen sees; adding
an extension changes nothing about which backends are reachable.

### What's missing

The supervisor currently inherits whatever Qwen Code's default
extension search path picks up — silently. There is no
operator-facing surface to:

- See which extensions are installed and which are active.
- Install or upgrade extensions.
- Disable an extension without uninstalling it.
- Choose a different extension loadout for one session vs. another.

These omissions matter as soon as more than one task type is in
play. A code-refactoring session benefits from Serena's
symbol-navigation tools; a documentation-lookup session wants
Context7's library docs; running both with the union of all tools
loaded inflates the model's attention surface and degrades
tool-selection precision. Per-task loadouts directly address that.

The supervisor also has a contract with the inner Qwen —
write-authority gating (§S4), `ask_user_question` exclusion (§Q1),
the coprocessor preamble (system prompt). Today this contract is
enforced entirely through `QueryOptions` (`permissionMode`,
`excludeTools`, `canUseTool`, `systemPrompt`) and does **not**
require any extension to be loaded. That is the desired baseline:
the framework imposes zero extensions. Future supervisor features
that *do* require an extension (e.g. a hypothetical "report
progress" callback the inner Qwen calls into) would be tracked
explicitly in a follow-up RDR — never implicitly bundled into a
"canonical default set."

## Scope (what this RDR is and is not)

**This RDR is:**

- The supervisor's management surface for extensions the operator
  chooses to install.
- The protocol by which the supervisor selects which subset of
  installed extensions is active for a given session.
- A clear declaration that the framework-required extension set is
  empty today, with a tracked path to add to it only by explicit RDR.

**This RDR is not:**

- A catalogue of extensions to ship with this repo.
- A mandate that any specific extension be installed.
- A reimplementation of Qwen Code's extension loader. The
  supervisor passes through to whatever upstream provides.
- A specification of any specific extension's behavior.

## Decision drivers

- **D1. Tools run locally; extensions extend that local surface.**
  The inference backend is irrelevant to the extension question.
  The management surface lives entirely on the operator's
  workstation.
- **D2. Per-task extension loadout.** Different sessions want
  different tool surfaces. The orchestrator (Claude) or the
  operator should be able to ask for a specific loadout at
  `qwen_spawn` time.
- **D3. No framework mandate beyond the supervisor's runtime
  contract.** The contract is enforced through `QueryOptions`, not
  extensions. Any future need for a forced-on extension is a
  visible decision recorded in its own RDR, not a hidden default.
- **D4. Defer to Qwen Code's extension system where it already
  works.** The supervisor exposes what's already there; it does
  not invent a parallel manifest format, install mechanism, or
  enable/disable state file when one already exists upstream.
- **D5. Discoverable.** "What extensions are loaded right now?"
  must have a one-command answer for the operator and a
  one-tool-call answer for Claude.
- **D6. Reversible.** Disabling an extension is non-destructive;
  the installed bits remain on disk. Operator can re-enable
  without reinstall.

## Research findings (resolved 2026-05-04)

A spike against `@qwen-code/sdk@0.1.7` (sources cited; full report
at `/tmp/rdr-002-spikes.md`) resolved the four questions that
gated the design.

### Q1 — Extension discovery

**Resolved.** Qwen Code reads extensions from two paths:

- **User-level** (always searched): `~/.qwen/extensions/<dir>/` —
  via `ExtensionStorage.getUserExtensionsDir()` →
  `path.join(os.homedir(), ".qwen", "extensions")` (`cli.js:19490–19593`).
- **Project-level**: `<cwd>/.qwen/extensions/<dir>/` — via the
  session's `cwd`, when set (`cli.js:19588–19591`).

There is **no env var** to redirect the user extensions directory.
`QWEN_RUNTIME_DIR` redirects only runtime temp dirs, not the
extensions search path. The user-level directory is always
`os.homedir() + "/.qwen/extensions"`.

If the CLI is invoked with `--extensions <names>`, only the named
extensions load from the user-level directory; otherwise all
subdirectories are scanned (`cli.js:270699`).

### Q2 — Per-call selection in `QueryOptions`

**Resolved (the critical finding).** `QueryOptions` does **not**
expose an `extensions` field. The full set of fields is `cwd`,
`model`, `pathToQwenExecutable`, `env`, `systemPrompt`,
`permissionMode`, `canUseTool`, `mcpServers`, `abortController`,
`debug`, `stderr`, `logLevel`, `maxSessionTurns`, `coreTools`,
`excludeTools`, `allowedTools`, `authType`, `agents`,
`includePartialMessages`, `resume`, `sessionId`, `timeout`
(`index.d.ts:512–790`). No `extensions`, `plugins`,
`enableExtensions`, or `includeExtensions` field exists.

The CLI itself accepts `--extensions <names>`
(`cli.js:469728–469738`), which feeds
`enabledExtensionNamesOverride` and works exactly as needed. The
SDK's `ProcessTransport.buildArgs()` translates many `QueryOptions`
fields to CLI args but **omits** `--extensions`.

There is no env var hook either: `grep QWEN_EXTENSIONS` in the
bundled CLI returns zero results.

**The bridge:** set `QueryOptions.pathToQwenExecutable` (a real
field) to a thin wrapper script that prepends
`--extensions <comma-list>` to the CLI's argv before delegating to
the real binary. The list comes from a known env var that the
supervisor controls per-session. This avoids any filesystem
manipulation (no per-session temp extension dirs, no symlinks).

### Q3 — Extension manifest and identity

**Resolved.** The canonical identity of an extension is the
`"name"` field in `qwen-extension.json` — **not** the directory
name. The two can differ.

- Manifest filename constant: `EXTENSIONS_CONFIG_FILENAME = "qwen-extension.json"`
  (`cli.js:254173`).
- Required field: `"name"`. Loading fails with `'missing "name"'`
  if absent (`cli.js:270860–270861`).
- Name is validated via `validateName()` (`cli.js:270863`).
- Matching: `config.name.toLowerCase() === requestedName.toLowerCase()`
  (`cli.js:270731`).

The manifest can also declare `mcpServers`, `channels`, `hooks`,
and lists context files. Extension subdirs may contain `commands/`,
`skills/`, `agents/` per Qwen Code's standard extension layout.

### Q4 — Installed vs active distinction

**Resolved — and the supervisor doesn't need to reimplement it.**
Qwen Code maintains its own enable/disable state in
`~/.qwen/extensions/extension-enablement.json` with two scopes:
`SettingScope.User` and `SettingScope.Workspace` (`cli.js:270551,
270612–270645`). Default for any extension with no entry is
`enabled` (`cli.js:270589–270607`).

`isActive` is computed per session, taking the override from
`--extensions` first, then falling back to the enablement file
(`cli.js:270781`). Special value `--extensions none` disables all.

This means the supervisor's earlier "Layer 2 — supervisor-wide
`plugins.toml` enabled set" is **not needed**. Operators manage
the global enabled set through Qwen Code's existing mechanism;
the supervisor only needs to handle per-spawn overrides.

## Decision

The simplified design has two operator-facing layers, plus a small
wrapper-script bridge.

### Layer 1 — Install / upgrade / lifecycle (thin shell-out)

A follow-up spike (2026-05-04, full report at
`/tmp/rdr-002-cli-spike.md`) confirmed Qwen Code already exposes a
complete non-interactive `qwen extensions` subcommand surface:
`list`, `enable`, `disable`, `install`, `uninstall`, `update`,
`link`, `new`, `settings`. All of them go through the same
`ExtensionManager` code path that mutates
`extension-enablement.json` and the on-disk extension dirs. There is
no need (or benefit) to manipulate `extension-enablement.json`
directly.

`qwenctl extensions` is therefore a thin wrapper. It validates
arguments, fixes one name translation (`remove` → `uninstall`),
and shells out to the bundled Qwen CLI:

| `qwenctl …`                                | Shells out to                              | Notes |
|--------------------------------------------|--------------------------------------------|-------|
| `qwenctl extensions list`                  | `qwen extensions list`                     | Pass-through; optional client-side reformat to a tighter table. Native output already includes `Enabled (User)`, `Enabled (Workspace)`, `Path`, `Source`, declared `Commands`/`Skills`/`Agents`/`MCP servers`. |
| `qwenctl extensions inspect <name>`        | `qwen extensions list` filtered by `<name>` | The native `list` block per extension is exactly the "inspect" payload. No separate Qwen subcommand needed. |
| `qwenctl extensions install <source>`      | `qwen extensions install <source>`         | Source types upstream supports: git URL, local path, npm `@scope/name`, marketplace `url:name`. `qwenctl` initially restricts to git URL + local path; pass-through additional flags (`--ref`, `--auto-update`, `--pre-release`, `--registry`, `--consent`). |
| `qwenctl extensions remove <name>`         | `qwen extensions uninstall <name>`         | Name translation only. `qwenctl` accepts both `remove` and `uninstall` as an alias for muscle-memory consistency. |
| `qwenctl extensions enable <name> [--scope user\|workspace]`  | `qwen extensions enable <name> --scope <s>`  | `--scope` defaults: upstream defaults to all scopes; `qwenctl` passes through verbatim. |
| `qwenctl extensions disable <name> [--scope user\|workspace]` | `qwen extensions disable <name> --scope <s>` | Upstream default scope is `User`; `qwenctl` passes through. |
| `qwenctl extensions update [<name>] [--all]` | `qwen extensions update …`               | Bonus surface from upstream; useful and free. |
| `qwenctl extensions link <path>`           | `qwen extensions link <path>`              | Live-symlink an extension from a local source path; useful for extension-development workflows. |
| `qwenctl extensions settings list <name>`  | `qwen extensions settings list <name>`     | Per-extension settings table (sensitive values masked). |
| `qwenctl extensions settings set <name> <setting> [--scope user\|workspace]` | `qwen extensions settings set …` | Per-extension setting mutation. |

The interactive-REPL `/extensions` slash commands inside Qwen Code
(`cli.js:477680`, tagged `supportedModes: ["interactive"]`) are a
separate code path and are not consumed by `qwenctl` — those run
only inside the Qwen REPL session.

Global enable/disable state lives in
`~/.qwen/extensions/extension-enablement.json`, written exclusively
by Qwen Code (via the CLI we just shell out to). The supervisor
does **not** maintain a parallel state file; nothing in this RDR
edits that JSON directly.

### Layer 2 — Per-spawn override (the novel piece)

`qwen_spawn` gains `opts.extensions`:

```ts
opts.extensions?: {
  enable?:  string[];   // additive over the supervisor's session default
  disable?: string[];   // subtractive
  only?:    string[];   // exact set; ignore session defaults entirely
}
```

Extension names match `config.name` from `qwen-extension.json`
(per Q3), case-insensitive (matching the SDK's matching rule).

Resolution: if `only` is set, that's the active set. Otherwise
start from the supervisor's session-default set (which the
operator can pin via `QWEN_DEFAULT_EXTENSIONS` env var; defaults
to "all enabled per `extension-enablement.json`"), apply `enable`
additively, apply `disable` subtractively. Empty set is allowed
and resolves to `--extensions none`.

This is the surface Claude actually uses: when delegating a task,
Claude can request "for this code-refactoring task, use only the
serena extension." The supervisor honours it for that session
without affecting any other session.

### The wrapper-script bridge (verified)

A small shell wrapper, shipped with the supervisor at
`mcp-bridges/qwen-agent-server/scripts/qwen-extensions-wrapper.sh`,
is set as `QueryOptions.pathToQwenExecutable` per session. The
wrapper:

```bash
#!/usr/bin/env bash
# Read the resolved extension list from env, prepend as a CLI flag,
# delegate to the real qwen binary.
exec "$QWEN_REAL_BIN" \
  ${QWEN_AGENT_EXTENSIONS:+--extensions "$QWEN_AGENT_EXTENSIONS"} \
  "$@"
```

Per-session, the supervisor sets:

- `QWEN_REAL_BIN` — path to the real Qwen Code binary (resolved
  once at supervisor startup; default: `which qwen`).
- `QWEN_AGENT_EXTENSIONS` — comma-separated list of extension
  names (per `config.name`). Empty/unset → no `--extensions` flag
  → CLI defaults apply. `none` → disable all.

The wrapper is a fixed file; per-session variation is via the env
vars. No per-session temp file, no symlinks, no filesystem state
for the bridge.

**Verified end-to-end against `@qwen-code/sdk@0.1.7`** (spike
`/tmp/qwen-bridge-spike/spike.mjs`, T2 record `002-research-006`,
2026-05-04). The SDK:

- Exec's a script path set as `pathToQwenExecutable` without
  validating that it's a real binary.
- Passes `QueryOptions.env` into the subprocess's environment
  intact (alongside `OPENAI_BASE_URL`, `OPENAI_API_KEY`, etc.).
- Constructs argv as a series of `--flag value` pairs (`--input-format
  stream-json --output-format stream-json --channel=SDK --model
  <m> --approval-mode <p> --exclude-tools <list> --auth-type <a>
  --session-id <id>`). Yargs accepts `--extensions <list>`
  prepended at any position.

These behaviors are pinned by **Pin 4** of
`tests/integration/sdk-behavior.test.ts`. Any future SDK change
that strips `env`, validates `pathToQwenExecutable` as a binary,
or constructs argv with positional arguments fails the pin and
blocks the SDK upgrade.

### Framework-required extensions (today: empty)

The supervisor's contract with the inner Qwen — write-authority
gating, `ask_user_question` exclusion, system prompt preamble,
multi-turn streamInput input queue — is enforced through
`QueryOptions` and does not require any extension to be loaded.

The supervisor therefore declares **zero framework-required
extensions** today. This is deliberate. Adding even one would
change the supervisor's contract; that change must be explicit,
RDR-tracked, and reviewable. Until such an RDR exists, an operator
can `--extensions none` every session and the supervisor still
functions correctly.

If a future feature requires a forced-on extension, it gets its
own RDR (RDR-002.x or follow-up). The operator-facing surface
gains a small "forced" badge in `qwenctl extensions list` for
any such extension, with a hint pointing back to the introducing
RDR.

### Resolution algorithm (per `qwen_spawn`)

```
1. Determine the session-default set:
   a. If QWEN_DEFAULT_EXTENSIONS is set, use that.
   b. Else, leave the set unspecified (CLI defaults apply — i.e. all
      enabled per extension-enablement.json).
2. If opts.extensions.only is set, use that as the base set.
3. Else apply opts.extensions.enable additively to the session default.
4. Else apply opts.extensions.disable subtractively from the session default.
5. Union with the framework-required set (today: empty; the union is a no-op).
6. If the resolved set is non-empty: render comma-list and set
   QWEN_AGENT_EXTENSIONS in the SDK env. If exactly empty by an explicit
   only=[]: set QWEN_AGENT_EXTENSIONS=none.
7. If the resolved set is "leave defaults": don't set the env var; the
   wrapper drops the --extensions flag entirely.
8. Set QueryOptions.pathToQwenExecutable to the wrapper.
9. Record the resolved set in the session's first event (extensions_loaded)
   so qwen_poll surfaces it, making "what was the tool surface for this
   session?" a self-answering question.
```

## Consequences

### Positive

- Two-layer management surface instead of three or four. Operator
  has a clear, minimal interface: install via Qwen Code's normal
  paths, override per-session via `opts.extensions`.
- Per-session loadouts let Claude tailor the tool surface to the
  task, improving tool-selection accuracy.
- Defers to Qwen Code's native `extension-enablement.json` for
  global state — no parallel file fighting it.
- The wrapper-script bridge is one fixed file; per-session
  variation is env-driven. No filesystem state per session.
- Pass-through to Qwen Code's extension system; SDK upgrades
  inherit upstream improvements automatically.
- Framework-required extension set is RDR-gated — no implicit
  defaults to surprise operators.

### Negative

- The wrapper-script `pathToQwenExecutable` indirection adds one
  hop on every CLI exec. Negligible overhead (process exec is
  already milliseconds), but worth noting for anyone debugging
  exec paths.
- The wrapper is bash. Operators on Windows would need a `.cmd`
  variant; deferred until a Windows operator exists. (The
  supervisor itself runs on macOS/Linux today.)
- Extension identity is `config.name`, which can differ from the
  directory name. `qwenctl extensions list` displays both to keep
  the gap visible.
- Operators who manage `extension-enablement.json` by hand and
  also use `qwenctl extensions enable/disable` see two paths.
  Documented; both paths converge on the same file.

### Neutral

- Switched terminology from "plugin" to "extension" mid-RDR.
  Matches upstream; the on-disk dir `~/.qwen/extensions/` and the
  manifest `qwen-extension.json` are now consistently named
  throughout this repo.

## Open work

- ~~**Decide `qwenctl extensions enable/disable` mechanism**~~ —
  **resolved 2026-05-04** by spike. Shell out to `qwen extensions
  enable/disable` (record `002-research-005`); same upstream call
  path that any hand-rolled JSON editor would invoke.
- ~~**Windows wrapper variant**~~ — **closed 2026-05-04, no longer
  needed.** The Strix Halo box (the only non-macOS host on the
  near-term roadmap) is now planned as native Linux — see RDR-004
  Status note and `/tmp/strix-halo-linux-production.md`. Both the
  operator workstation (macOS) and the remote inference host
  (Linux) run bash; one wrapper variant covers the fleet. If a
  Windows host ever joins the fleet, this item reopens with full
  context preserved in the git history.
- **`qwenctl extensions install <source>` initial scope**: spike
  confirmed upstream handles git URL, local path, npm `@scope/name`,
  and marketplace `url:name`. Initial `qwenctl` release restricts
  to git URL + local path only; lifts restrictions in a later
  release once the operator UX for npm/marketplace sources is
  designed.

## Related decisions and prior art

- RDR-001 §S4 — write-authority gating. Applied uniformly across
  whatever extension set is active; extensions do not bypass.
- RDR-001 §Q1 — `ask_user_question` exclusion. Applies uniformly.
  An extension cannot re-add `ask_user_question` to the inner
  Qwen's surface; the SDK's `excludeTools` wins.
- RDR-003 — pino logger surface; extensions emit through the
  unified context.
- RDR-004 — `qwenctl extensions` subcommand. The TypeScript CLI
  in RDR-004 is the operator's surface; the supervisor's MCP
  tools are Claude's surface. Same data, two views.
- Qwen Code's extension loader: `cli.js` paths cited in the
  Research findings section.

## References

- Spike report: `/tmp/rdr-002-spikes.md` (full citations and
  `cli.js:N` line refs).
- `mcp-bridges/qwen-agent-server/node_modules/@qwen-code/sdk/dist/index.d.ts`
  — `QueryOptions` definition (lines 512–790).
- `mcp-bridges/qwen-agent-server/src/session.ts` — `QueryOptions`
  construction; `pathToQwenExecutable` is set here per session.
- `mcp-bridges/qwen-agent-server/src/server.ts` — `qwen_spawn`
  signature, where `opts.extensions` is added.
- `mcp-bridges/qwen-agent-server/src/types.ts` — `SpawnOpts` type
  gains an optional `extensions` field.
