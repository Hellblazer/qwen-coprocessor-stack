---
name: extensions
description: Manage Qwen Code extensions on the supervisor host — list, inspect, install, remove, enable, disable, and update. Local sources are ungated; remote sources (git URL, npm @scope/name, owner/repo, marketplace url:name) are refused unless QWEN_ALLOW_REMOTE_INSTALL=1 is set in the supervisor's environment. Use when the user types `/qwen-stack:extensions` or asks "what qwen extensions are installed", "install/remove/enable/disable/update extension X", or "what does extension X provide".
argument-hint: list | info <name> | install <source> | remove <name> | enable <name> [--scope user|workspace] | disable <name> [--scope user|workspace] | update [<name>...]
allowed-tools: Bash, mcp__plugin_qwen-stack_supervisor__qwen_extensions, mcp__plugin_qwen-stack_supervisor__qwen_extension_install, mcp__plugin_qwen-stack_supervisor__qwen_extension_remove, mcp__plugin_qwen-stack_supervisor__qwen_extension_enable, mcp__plugin_qwen-stack_supervisor__qwen_extension_disable, mcp__plugin_qwen-stack_supervisor__qwen_extension_update
---

# /qwen-stack:extensions

Discovery and lifecycle management for the supervisor's extension surface: `list`, `info`, `install`, `remove`, `enable`, `disable`, `update`. All seven shell out through the supervisor to the bundled `qwen extensions ...` CLI (RDR-002 §Layer 1) — this skill never edits `~/.qwen/extensions/extension-enablement.json` or any extension directory directly.

## Architectural reminder

Extensions live on the **supervisor host** — the Mac running Claude Code, not the inference backend (e.g., `qwentescence`). The `qwen` CLI runs as a subprocess of the supervisor, so its extension state is local to wherever the supervisor lives. Don't reach across SSH for any of this.

## Gate decision — read before `install` or `update`

**Local sources are ungated.** A local filesystem path always installs/updates without restriction.

**Remote sources are refused by default.** A git URL, an npm `@scope/name`, an `owner/repo` shorthand, or a marketplace `url:name` source is rejected with `remote_install_gated` unless the supervisor process has **`QWEN_ALLOW_REMOTE_INSTALL=1`** set in its environment. This is enforced inside the supervisor's exec layer, not just at this tool boundary — there's no flag on the call that bypasses it. If a caller wants remote install/update enabled, they set that variable where the supervisor process runs and restart it; this skill cannot set it for them mid-session.

**`--scope` accepts only `user` or `workspace`.** The upstream `qwen extensions enable/disable --scope` flag also *validates* `system` and `systemdefaults`, but its handlers only branch on `workspace` — passing either of those two silently behaves as `user`. This skill refuses them outright (`invalid_scope`) rather than let that silent downgrade happen.

**`enable`/`disable` default to scope `user` when `--scope` is omitted.** This is the supervisor's own explicit default, not upstream's: upstream's own default is asymmetric (`enable` with no `--scope` applies to *all* scopes; `disable` defaults to `User`). State the effective scope in every confirmation so the operator isn't left guessing which one actually changed.

## Subcommand routing

Parse the first positional arg as the subcommand. If absent or `list`, run **list**. Otherwise dispatch on `info`, `install`, `remove`, `enable`, `disable`, or `update`.

### list (default when no args)

1. Call the MCP tool `qwen_extensions` (no args). Returns an array of `ExtensionInfo` objects: `{name, version, source, path, enabled_user, enabled_workspace, commands, skills, agents, mcp_servers, context_files}`. Fields not present in the upstream output are omitted from the object.
2. Render a compact table: `name`, `version`, `enabled (U/W)`, `source`, `declares` (count summary like `2 cmds, 1 skill`).
3. Use ✓ / ✗ for the enabled-user and enabled-workspace columns, separated by a slash (`✓/✓`, `✓/✗`, etc.). Use `?` if the field is undefined.
4. If the list is empty, say "No extensions installed on the supervisor host." and suggest `install <source>`.
5. Footer line: count + path of the supervisor's extensions dir if known (typically `~/.qwen/extensions/`). The MCP response carries `path` per-extension; show the dirname of any entry as a hint.

### info <name>

(RDR-002 calls this verb `inspect`; this skill has always spelled it `info` — same behavior, different name.)

1. Call `qwen_extensions`. Filter for the given name (case-insensitive). If not found, list available names and stop.
2. Render the full record as a compact key-value block. Show all populated fields in this order: `version`, `source`, `path`, `enabled (User)`, `enabled (Workspace)`, `commands`, `skills`, `agents`, `mcp_servers`, `context_files`.
3. List-typed fields (commands, skills, agents, mcp_servers, context_files) render as inline arrays for ≤4 items, indented multi-line for more.

### install <source>

1. Call `qwen_extension_install` with `{ source }` verbatim as the user gave it — do not pre-classify or reshape it; the supervisor's exec layer does the local-vs-git-vs-npm-vs-marketplace classification and, for a relative local path, resolves it against the supervisor's own `cwd` (not this skill's).
2. On success, render a one-line confirmation: `Installed <name-or-source> — argv: qwen <argv...>`. The cache reloads automatically (see "Reload relationship" below) — do not call `qwen_reload_extensions` after this.
3. On `{ error }`, map the code:
   - `invalid_source` — the source doesn't exist on disk (if local-shaped) or matches no recognized source shape. Show the message verbatim; it already names the resolved path or the literal source string.
   - `remote_install_gated` — the source is remote and the gate is closed. Say so plainly: "Remote install refused — set `QWEN_ALLOW_REMOTE_INSTALL=1` in the supervisor's environment and restart it to allow this." Do not suggest any other workaround; there isn't one.
   - `exec_failed` — the underlying `qwen extensions install` failed. Show the message.

### remove <name>

1. Call `qwen_extension_remove` with `{ name }`. This is the operator-facing verb; the supervisor performs the `remove` → `uninstall` translation to the upstream subcommand internally — don't mention "uninstall" to the user unless echoing a raw error message that already uses it.
2. On success: `Removed <name>.` Cache reloads automatically.
3. On `{ error }`: `invalid_name` (empty/whitespace name — ask for a real one) or `exec_failed` (show the message; a not-installed name will surface here from the upstream CLI, not as a distinct code).

### enable <name> [--scope user|workspace]

1. Call `qwen_extension_enable` with `{ name }` plus `{ scope }` only if the user gave one explicitly.
2. On success, state the **effective scope from the response** (`result.scope`), not just echo back what was asked: `Enabled <name> (scope: user).` This is the one place a caller could otherwise be surprised — the supervisor's default differs from upstream's.
3. On `{ error }`: `invalid_scope` (the user asked for `system`/`systemdefaults`/anything else — explain upstream's silent-downgrade hazard, same reasoning as the Gate decision section above, and suggest `user` or `workspace`), `invalid_name`, or `exec_failed`.

### disable <name> [--scope user|workspace]

Same shape as `enable`, calling `qwen_extension_disable`. State the effective scope in the confirmation.

### update [<name>...]

1. If the user named specific extensions, call `qwen_extension_update` with `{ names: [...] }`. If they said "update everything" / gave no names, call it with `{}` (omit `names` entirely — do not synthesize a `--all` string anywhere in this skill; the supervisor enumerates and updates each extension individually).
2. The response is always `{ items: [{ name, status, reason?, argv?, stdout? }] }` — never a top-level error for a per-extension refusal. Render one line per item:
   - `status: "updated"` → `✓ <name> updated`
   - `status: "refused"` → `✗ <name> refused — <reason>`. A refusal here is fail-closed classification, not a crash: missing/unrecognized `.qwen-extension-install.json` metadata, or (same gate as `install`) a remote-sourced extension refused because `QWEN_ALLOW_REMOTE_INSTALL` isn't set. If any refusal reason mentions the gate variable, repeat the same one-line remedy as in `install`'s `remote_install_gated` handling.
   - `status: "failed"` → `✗ <name> failed — <reason>` (the exec itself ran and errored).
3. If `qwen_extension_update` itself returns a top-level `{ error }` (rare — only when the initial `qwen extensions list` enumeration fails), report that as a single failure, not a per-item table.
4. Cache reloads automatically whenever at least one item updated. No manual `qwen_reload_extensions` step.

## Reload relationship

`qwen_extension_install` / `remove` / `enable` / `disable` / `update` each reload the supervisor's installed-extensions cache themselves on success — that's how a just-installed extension becomes usable in `opts.extensions.only`/`enable` on the very next `qwen_spawn` without an extra step. **Never tell the user to run a manual reload after using one of these tools; there is nothing left for it to do.** The standalone `qwen_reload_extensions` MCP tool (not routed by this skill) still exists for the one case these five don't cover: the operator hand-edited `~/.qwen/extensions/extension-enablement.json` outside any tool here.

## Error handling

- `qwen_extensions` returns `[]` if the supervisor's `pool.qwenRealBin` is unset (rare — happens only in test-shaped pools without infra wiring) or if the shell-out to `qwen extensions list` fails. Don't treat empty as an error — say "no extensions reported (or qwen binary unreachable)".
- On `info <name>` miss, do not retry with substring matching. Be strict; the operator can reread the list to find the exact name.
- Every mutation tool (`install`/`remove`/`enable`/`disable`) returns either the success shape or `{ error: { code, message } }` — never both, never a silent no-op. `update` is the one exception: it always returns `{ items }` and folds per-target refusals/failures in there instead of a top-level error (except the rare enumeration-failure case above).

## Output style

- Tables for `list`; key-value block for `info`; one-line confirmations for `install`/`remove`/`enable`/`disable`; one line per item for `update`.
- No emojis outside the enabled-state and update-status glyphs (✓/✗).
- Suppress fields that are undefined or empty arrays.
- When an extension has zero declared `commands` AND zero `skills` AND zero `agents` AND zero `mcp_servers`, render "(declares nothing exposable)" rather than four empty zeros — unusual case but worth noting clearly.
- Never invent a workaround for `remote_install_gated` beyond naming the env var and noting the supervisor needs a restart to pick it up.
