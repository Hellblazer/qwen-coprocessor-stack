# extensions/

First-party Qwen Code extensions shipped by this repo. Design of record:
[RDR-002](../docs/rdr/RDR-002-extension-management.md) (revived and amended
2026-08-22 — see its §Scope exception and the 2026-08-22 amendment entry).

This directory holds exactly **one** extension:

- `qwen-toolkit/` — encodes the supervisor's standing coding contract for the
  served box model (QWEN.md context + task-family subagents). It is **not**
  force-enabled: `FRAMEWORK_REQUIRED_EXTENSIONS` stays empty, and sessions opt
  in per spawn via `opts.extensions.only`. Built by epic
  `qwen-coprocessor-stack-3su` (W1).

Anything else landing here needs its own RDR-tracked justification — the
RDR-002 exception is scoped to `qwen-toolkit` and does not generalize.

Operator-installed extensions still live where Qwen Code expects them —
`~/.qwen/extensions/<dir>/` (user-level) and optionally
`<cwd>/.qwen/extensions/<dir>/` (workspace-level), not here. Manage them via
the supervisor's extension tools / the `/qwen-stack:extensions` skill
(RDR-002 Layer 1; implementation epic `3su` W2). For development of
`qwen-toolkit` itself, install with `qwen extensions link <abs-path>` so the
loader reads through to this directory and edits are live.
