---
name: defaults
description: Manage the qwen-stack supervisor's session-default extension list — show current value with source priority, set a new comma-separated list, set explicit-empty (suppresses CLI defaults), or clear (CLI defaults apply). Operates on the `default_extensions` field in `~/.qwen-coprocessor-stack/config.json` and hot-reloads in the running supervisor without restart. Use when the user types `/qwen-stack:defaults ...`.
argument-hint: list | set <a,b,c> | set --none | clear
allowed-tools: Bash, Read, Write, mcp__plugin_qwen-stack_supervisor__qwen_extensions, mcp__plugin_qwen-stack_supervisor__qwen_reload_extensions
---

# /qwen-stack:defaults

Lifecycle for the supervisor's **session-default extension list** — the base set every spawn starts with when the orchestrator doesn't specify `opts.extensions.only`.

## Resolution priority (read by the supervisor)

1. `QWEN_DEFAULT_EXTENSIONS` env var — comma list. **Overrides** the file. Tell the user to edit shell rc instead of the file if this is set.
2. `~/.qwen-coprocessor-stack/config.json` `default_extensions: ["a", "b"]` — the file you read/write here.
3. Unset → `"leave-defaults"` sentinel. The wrapper drops `--extensions`; CLI defaults from `extension-enablement.json` apply.

## Subcommand routing

Parse the first positional arg as the subcommand. If absent or `list`, run **list**. Otherwise dispatch on `set` or `clear`.

### list (default when no args)

1. Probe `$QWEN_DEFAULT_EXTENSIONS` env (`echo "${QWEN_DEFAULT_EXTENSIONS:-}"`). If non-empty, the env wins.
2. Read `~/.qwen-coprocessor-stack/config.json` if present and look for `default_extensions`.
3. Show:
   - Active value (the resolved list, or "leave-defaults" if neither source has a value).
   - Source label: `(QWEN_DEFAULT_EXTENSIONS env)`, `(config.json)`, or `(unset → CLI defaults apply)`.
   - If both sources are populated, also note "config.json has [...]; env overrides".

### set <comma-list>

Args:
- `<comma-list>` — comma-separated extension names, kebab-case, no spaces required (whitespace is trimmed). Example: `serena,context7,web-fetch`.
- `--none` flag in lieu of a list — explicitly empty set (renders as `--extensions none` at spawn time, suppresses all CLI defaults). Reserve no-args as an error.

Steps:
1. **Refuse if `QWEN_DEFAULT_EXTENSIONS` env is set.** It would silently override the file edit. Tell the user to either `unset QWEN_DEFAULT_EXTENSIONS` in their shell or edit it there directly.
2. Parse the list. Lowercase + dedupe. Reject if any name contains characters outside `[a-z0-9_-]`.
3. **Validate against installed extensions.** Call `qwen_extensions` MCP tool, build a Set of installed names. For each name in the requested list, check membership. If any are unknown, abort with the same error shape as `ExtensionResolutionError`: `unknown extension(s): X, Y`. List the installed names so the user can correct.
4. Read `~/.qwen-coprocessor-stack/config.json` (treat as `{}` if missing). Validate JSON shape.
5. Set `default_extensions` to the validated list (or `[]` for `--none`). Preserve other fields (e.g., `backends`).
6. `mkdir -p ~/.qwen-coprocessor-stack`, write back with 2-space indent.
7. Call `qwen_reload_extensions` MCP tool to refresh the supervisor's installed-extensions cache (defensive — operator may have edited extensions on disk recently).
8. Confirm: print the new resolved value as `list` would, plus a one-liner about drain semantics: "applies to new spawns; running sessions keep their current loadout (RDR-001 §Q3)".

### clear

1. **Refuse if `QWEN_DEFAULT_EXTENSIONS` env is set** (same reasoning).
2. Read config.json. If `default_extensions` is absent, say "already unset" and stop.
3. Remove the key (don't write `null` or `[]` — actually `delete`). Preserve other fields. Write back.
4. Confirm: "default_extensions cleared; CLI defaults apply (RDR-002 §Resolution-algorithm step 1b)".

## Error handling

- File-write failure: show the error, do not partially update.
- Invalid JSON in existing config.json: do not overwrite. Show the parse error and the offending content (first 200 chars). Suggest the user inspect manually.
- `qwen_extensions` returns `[]` (no installed extensions): allow `set --none` and `clear`. Reject `set <list>` with "no extensions installed on the supervisor host; run `qwen extensions install <source>` first."

## Output style

- One-line confirmations for `set` and `clear`.
- For `list`: 2-3 lines max — active value, source, optional override-note.
- No emojis.
- Surface the file path on every write so the operator knows where state lives.
- Don't dump shell command output verbatim; synthesize.
