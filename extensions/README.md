# extensions/

This directory is **not** a canonical store of Qwen Code extensions
this repo ships. Extension management is an operator concern; see
[RDR-002](../docs/rdr/RDR-002-extension-management.md) for the design.

If a future supervisor feature ever requires a forced-on extension
(none do today), it will land here and be force-enabled by the
supervisor with a tracked RDR justifying it. Until then, this
directory is empty on purpose.

Operator-installed extensions live where Qwen Code expects them —
`~/.qwen/extensions/<dir>/` (user-level) and optionally
`<cwd>/.qwen/extensions/<dir>/` (project-level), not here. Manage
them with `qwenctl extensions ...` (see
[RDR-004](../docs/rdr/RDR-004-multi-qwen-fleet-management.md)) or
directly in those directories using whatever Qwen Code's extension
install mechanism prescribes.
