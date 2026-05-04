// SPDX-License-Identifier: MIT
//
// qwen-agent-server entrypoint.
//
// Phase 1 placeholder: the MCP server, tool wiring, session manager,
// and lifecycle live in subsequent phase beads. This file exists so
// `tsc` has a deterministic entry point (referenced by package.json
// "main") and `npm run build` produces dist/server.js.
//
// Real wiring lands in qwen-coprocessor-stack-ab6.4.

import pino from "pino";

const log = pino({ name: "qwen-agent-server" });

// Banner only — no MCP transport bound, no sessions. Calling this as a
// child of Claude Code at this point would just log the banner and exit.
log.info("qwen-agent-server scaffold loaded; phases 2-4 not yet wired");
