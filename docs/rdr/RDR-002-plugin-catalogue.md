---
name: Per-plugin catalogue — in-repo Qwen Code extensions, install order, and scope
type: architecture
status: draft
priority: medium
created: 2026-05-04
authors:
  - hal.hildebrand
related:
  - RDR-001 §D6 (in-repo plugin authoring as a primary decision driver)
  - RDR-003 (observability — pino logger surface used by plugin code)
  - RDR-004 (fleet management — orthogonal; plugins target the inner Qwen, not the supervisor's host)
---

# RDR-002 — Per-plugin catalogue: in-repo Qwen Code extensions, install order, and scope

## Status

**Draft** (2026-05-04). Scope was reserved during RDR-001 §D6; this RDR
fills it. The `plugins/` directory exists in the repo as a placeholder
(empty except for `README.md` and `.keep`); this RDR catalogues what
goes there, the install/upgrade contract, and the scope of each
shipped plugin.

## Context

RDR-001 settled that Qwen Code customizations belong in-repo — versioned
alongside the supervisor so a `git checkout` of any commit captures the
matching tool surface. The mechanism (Qwen Code's plugin format) and
the storage location (`plugins/`) were decided. What was *not* decided:

- The list of plugins to author.
- The install/upgrade contract — copy vs. symlink, scope, conflict
  policy with personal global plugins.
- The dependency relationships between plugins (does plugin B need
  plugin A's artifacts present?).
- The integration test plan — how do we verify a plugin still works
  against the current `@qwen-code/sdk` pin?

Without this RDR, every new plugin invents its own install path and
test story, and the `plugins/` directory drifts toward the same
unstructured grab-bag that motivated putting it in-repo to begin with.

## Decision drivers

- **D1. Single source of truth.** The `plugins/` tree is canonical.
  Anything installed under the inner Qwen's home directory must be
  derivable from `plugins/` — no hidden state.
- **D2. Reproducible installs.** A `git pull` followed by one command
  yields the same Qwen Code environment on any machine where the
  supervisor runs.
- **D3. No conflict with personal plugins.** A user with their own
  `~/.qwen/plugins/` for unrelated work should not have those plugins
  silently overwritten or merged.
- **D4. Composability with the supervisor's tool surface.** Plugins
  that wrap supervisor MCP tools (e.g. an "ask Claude" plugin that
  surfaces `qwen_send` for the inner Qwen) must work without the user
  manually wiring registration.
- **D5. SDK-pin compatibility.** Plugin code calling `@qwen-code/sdk`
  internals (rare but possible for advanced plugins) must respect the
  exact-pin policy in RDR-001 §C1.

## Options considered

### Option A — Documentation only

A `plugins/README.md` describing recommended Qwen Code config; users
configure their own `~/.qwen/` to match.

- ✅ Zero install machinery
- ❌ Not reproducible (D2 fails)
- ❌ No version tracking — plugin authors edit doc and ship without
  any artifact in the repo

Reject.

### Option B — Symlink-only install

A script symlinks `plugins/<name>/` into `~/.qwen/plugins/<name>/`.
The user's running plugin set is the linked source.

- ✅ Edits to `plugins/` are live immediately; great for plugin
  development
- ⚠️ Some Qwen Code internals follow symlinks unevenly (verified in
  spike B during RDR-001, before plugin work)
- ❌ Breaks D3 if a personal plugin already exists at the target name
- ❌ Operator surprise on a `git checkout`: their live plugin set
  changes silently

### Option C — Project-scoped plugin loader

Use a `.qwenrc` or equivalent in the repo root that the inner Qwen
loads with a project-scoped plugin search path. No install step.

- ✅ Cleanest: `git pull` is install
- ❌ Requires `@qwen-code/sdk@0.1.7` to support project-scoped plugin
  search. As of the time of this RDR this is unverified — needs a
  spike. If supported, prefer this immediately; if not, defer to D.

### Option D — Hybrid: copy install with editable mode

`scripts/install-plugins.sh` copies `plugins/<name>/` to
`~/.qwen/plugins/<name>/` by default; `--symlink` flag does B; install
fails (with a hint) if the target already exists and isn't a managed
copy.

- ✅ Reproducible (D2)
- ✅ Conflict-safe (D3)
- ✅ Editable mode available for plugin authors who opt in
- ⚠️ Two extra commands (install / uninstall) in the operator
  workflow

**Decision: Option D, with a verification spike for Option C as
follow-up.** D ships now; if C is empirically supported it replaces
D's runtime path while keeping D's `plugins/` layout unchanged.

## Decision

`plugins/` is the canonical source. `scripts/install-plugins.sh`
provides the install/upgrade/uninstall contract. The scope below
catalogues the initial set.

### Plugin layout

Each plugin is its own directory under `plugins/`:

```
plugins/
  <name>/
    plugin.json          manifest: name, version, deps, scope, install_kind
    agents/              optional — agent definitions
    skills/              optional — skill definitions
    commands/            optional — slash command definitions
    hooks/               optional — pre/post-tool hooks
    README.md            user-facing description
    tests/               optional — plugin self-tests (run by supervisor CI)
```

### `plugin.json` shape

```json
{
  "name": "nx-search-bridge",
  "version": "0.1.0",
  "scope": "user",
  "install_kind": "copy",
  "depends_on": [],
  "qwen_sdk_compat": ">=0.1.7 <0.2",
  "description": "Bridge nx_search/nx_query MCP results into the inner Qwen's context."
}
```

- `scope`: `user` (default) or `project`. `project` plugins live only
  for sessions spawned from this repo's working directory; `user`
  plugins are available to any inner Qwen the supervisor manages.
  Initial release: `user` only. `project` deferred until Qwen Code
  exposes a project scope reliably.
- `install_kind`: `copy` (default) or `symlink`. The install script
  honors this unless overridden by `--symlink` / `--copy` flags.
- `qwen_sdk_compat`: semver range. The install script refuses if the
  installed SDK version is outside the range — guards against the
  exact-pin policy drift between supervisor and plugin.

### Install / upgrade / uninstall contract

```bash
scripts/install-plugins.sh                   # install all (idempotent upgrade)
scripts/install-plugins.sh nx-search-bridge  # install one
scripts/install-plugins.sh --symlink         # editable mode
scripts/install-plugins.sh --dry-run         # show planned changes
scripts/uninstall-plugins.sh [name]          # remove one or all
```

The script:

1. Reads `plugins/<name>/plugin.json` for each candidate.
2. Resolves install target: `${QWEN_AGENT_SERVER_HOME:-$HOME/.qwen-agent-server-home}/plugins/<name>/`.
3. Refuses if target exists and is *not* a previously-managed install
   (manifest hash mismatch). Hint: `--force` to override.
4. Validates `qwen_sdk_compat` against the supervisor's pinned SDK
   version (read from `mcp-bridges/qwen-agent-server/package.json`).
5. Resolves `depends_on` topologically; aborts on cycles or missing
   deps.
6. For `copy`: removes target, copies fresh.
   For `symlink`: removes target, symlinks plugin source.
7. Writes a per-target `.installed-from` file recording the source
   commit SHA and manifest hash for later upgrade detection.

### Initial plugin scope

| Plugin                | Purpose                                                                              | Status        |
|-----------------------|--------------------------------------------------------------------------------------|---------------|
| `nx-search-bridge`    | Surface `nx_search` / `nx_query` results to the inner Qwen as a callable tool.       | Author next   |
| `serena-code-nav`     | Bridge Serena's symbol-navigation MCP tools into Qwen's tool surface for code tasks. | Author next   |
| `context7-docs`       | Library/framework doc lookups via Context7 — read-only, no auth.                     | Author next   |
| `qwen-task-status`    | Adds a `report_status(summary)` tool the inner Qwen calls to write `model_message_summary` events visible in `qwen_poll`. | Optional, low priority |

Each gets its own RDR (RDR-002.1, RDR-002.2, …) only if the design is
non-trivial. Trivial plugins are added with a PR linking back to this
RDR.

### Integration test plan

Each plugin includes `tests/` with at minimum:

- A unit test of any plugin-internal logic (where applicable).
- A `tests/integration/install.test.sh` that runs
  `scripts/install-plugins.sh <name> --dry-run` and asserts the planned
  filesystem changes match an expected manifest.

The supervisor's CI runs install dry-runs on every PR that touches
`plugins/`. SDK-pin bumps in the supervisor's `package.json` trigger a
re-validation of every plugin's `qwen_sdk_compat`.

## Consequences

### Positive

- Reproducible Qwen Code environment — `git pull && install-plugins.sh`
  yields the same tool surface anywhere.
- Versioned alongside the supervisor; no documentation-as-config drift.
- Editable mode for plugin authors via `--symlink`.
- Conflict-safe by default — won't clobber a user's personal plugins.

### Negative

- Two extra commands in the Quick Start (install + uninstall scripts).
  Mitigated by `setup-qwen-agent-server.sh` calling install-plugins.sh
  by default.
- Plugin authors learn a small manifest schema. Mitigated by a
  single-page reference in `plugins/README.md`.
- The exact-pin compatibility check tightens the upgrade path —
  bumping the SDK now requires every plugin to declare compat. This is
  desired (catch incompat early) but adds friction.

### Neutral

- The `install_kind: copy` default means plugin edits require a
  re-install to take effect. Authors will use `--symlink` during
  development; the default keeps end-user installs reproducible.

## Research findings (open questions)

### Q1 — Project-scoped plugin loader (Option C)

**Status:** Open. Deferred to a small spike before authoring the first
plugin.

Hypothesis: `@qwen-code/sdk@0.1.7` supports a project-scoped plugin
search path via `QueryOptions` or env var. If yes, the install script
becomes a (much shorter) generator for that config and the copy step
goes away.

Spike: write a minimal hello-world plugin, load it via SDK options
without copying to the user home, observe whether the inner Qwen sees
it. ~30 minutes.

### Q2 — Plugin-to-supervisor MCP loop

**Status:** Deferred until a real plugin needs it.

A plugin running inside the inner Qwen could in principle call back
into the supervisor's MCP tools (creating a recursive `qwen_spawn`
loop). RDR-001 §S4 already excludes the `agent` tool by default to
prevent recursive sub-agent spawning; that exclusion suffices for now.
If a plugin ever needs intentional recursion, RDR-002.x captures the
specific decision.

### Q3 — Plugin telemetry

**Status:** Deferred to RDR-003.

Plugins should emit pino logs through the supervisor's log surface, not
their own. The mechanism (env var injection, helper module published
from the supervisor) is RDR-003 territory.

## Related decisions and prior art

- RDR-001 §D6 — established `plugins/` as the canonical location.
- RDR-001 §C1 — exact SDK pin policy, which `qwen_sdk_compat` enforces
  per plugin.
- Claude Code's `.claude/` conventions (skills, agents, hooks) — same
  shape, different runtime; `plugins/` mirrors the layout where it
  doesn't conflict with Qwen Code's expectations.
- Qwen Code plugin format: TBD link once a public reference page
  stabilizes.

## References

- `plugins/README.md` — user-facing summary; this RDR is the design
  authority.
- `mcp-bridges/qwen-agent-server/src/session.ts` `excludeTools` — the
  recursion-prevention mechanism plugins must respect.
- `scripts/setup-qwen-agent-server.sh` — calls `install-plugins.sh` to
  enrich the home directory it just created.
