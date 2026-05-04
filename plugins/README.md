# plugins/

This directory is **not** a canonical store of plugins this repo
ships. Plugin management is an operator concern; see
[RDR-002](../docs/rdr/RDR-002-plugin-management.md) for the design.

If a future supervisor feature ever requires a forced-on plugin (none
do today), it will land here and be force-enabled by the supervisor
with a tracked RDR justifying it. Until then, this directory is empty
on purpose.

Operator-installed plugins live in the supervisor's Qwen home directory
(`${QWEN_AGENT_SERVER_HOME}/plugins/`), not here. Manage them with
`qwenctl plugins ...` (see
[RDR-004](../docs/rdr/RDR-004-multi-qwen-fleet-management.md)) or
directly in that directory using whatever Qwen Code's plugin install
mechanism prescribes.
