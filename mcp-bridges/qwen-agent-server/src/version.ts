// SPDX-License-Identifier: MIT
//
// Single source of truth for the supervisor binary's externally-visible
// version string. Reported via MCP ServerInfo.version on the wire and
// asserted in tests against the plugin and marketplace manifests so a
// release bump that misses any one surface fails CI rather than ships
// silently stale (see bead qwen-coprocessor-stack-djv).
//
// Bump this in lockstep with .claude-plugin/plugin.json and
// .claude-plugin/marketplace.json (metadata.version and plugins[0].version).
// The version_consistency test enforces equality across all four sites.

export const SUPERVISOR_VERSION = "0.11.12";
