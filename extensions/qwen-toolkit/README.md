# qwen-toolkit

First-party Qwen Code extension encoding the supervisor's standing coding
contract for the served box model. Justified by RDR-002's §Scope exception
(amendment 2026-08-22); built by epic qwen-coprocessor-stack-3su (W1).

- **Prompt-and-subagent only.** This extension declares NO `mcpServers`, by
  design: a stdio `mcpServers` entry launches at SDK session init, before any
  permission check (RDR-013), so a first-party extension shipping one would put
  arbitrary process launch on every dispatch that enables it. Adding an MCP
  server here is a tracked decision (RDR amendment), not a quiet manifest edit.
- **Never force-enabled.** `FRAMEWORK_REQUIRED_EXTENSIONS` stays empty;
  sessions opt in per spawn via `opts.extensions.only`.
- **`contextFileName` is set explicitly** to `QWEN.md` in the manifest even
  though 0.15.6 defaults to it — documentation-of-intent, so the contract file
  binding survives an upstream default change.
- **Dev loop**: `qwen extensions link "$(pwd)/extensions/qwen-toolkit"` — the
  loader reads through to this directory, so edits are live. Never `install`
  (it copies and goes stale).

Layout (0.15.6 conventions): `QWEN.md` (context), `agents/*.md` (flat,
task-family subagents — bead 3su.4), no commands/skills/hooks yet.
