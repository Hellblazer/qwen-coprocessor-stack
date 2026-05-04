// SPDX-License-Identifier: MIT
//
// makeCanUseTool — factory for the CanUseTool callback injected into the
// @qwen-code/sdk QueryOptions.
//
// Scope (post-2026-05-04 spike): canUseTool is responsible ONLY for
// write-tool permission gating. The original RDR §Q1 design also had
// canUseTool intercept ask_user_question to deliver answers via the
// deny-message field; that mechanism was empirically confirmed to fail
// (probe-tool-result.mjs, 2026-05-04 — the model treats the deny as
// "user cancelled with reason X", not "user answered X"). The
// supervisor now excludes ask_user_question from the inner Qwen's
// tool surface entirely (see session.ts DEFAULT_EXCLUDED_TOOLS); the
// model is told to ask in plain text and the user replies via
// streamInput-driven multi-turn input.
//
// Critical pins (RDR-001):
//   §S4  Write tools when write_authority=false: emit a synthetic
//        permission_denied event AND return deny. The event is
//        important — without it, denials are silently swallowed by
//        the SDK and the supervisor has no visibility into what the
//        inner Qwen tried to do.
//   §S4  Write tools when write_authority=true: this callback isn't
//        invoked — permissionMode='yolo' bypasses canUseTool entirely.

import type { CanUseTool, PermissionResult, ToolInput } from "@qwen-code/sdk";
import type { QwenSession } from "./session.js";

// ─────────────────────────────────────────────────────────────────
// Write-tool set
//
// These tool names require write_authority===true to execute. Must be
// revisited if Qwen adds new write tools (names sourced from Qwen Code
// core tool registry as of SDK 0.1.7).

export const WRITE_TOOLS = new Set<string>([
  "write_file",
  "edit",
  "run_shell_command",
  "replace",
  "multi_edit",
]);

// ─────────────────────────────────────────────────────────────────
// Factory

/**
 * Returns a CanUseTool callback for use with permissionMode='default'.
 *
 * Routing:
 *  - write tool  → emit permission_denied event + return deny
 *  - everything else → return allow (read tools, search, web_fetch, etc.)
 *
 * `ask_user_question` should never reach this callback because it's in
 * the inner Qwen's excludeTools list. If it somehow does, the
 * everything-else branch returns allow — but the SDK can't actually
 * execute ask_user_question in headless mode, so the inner Qwen would
 * likely hang. Defense-in-depth: we treat it as a write-equivalent
 * deny if encountered, since the supervisor's design assumes it never
 * fires.
 */
export function makeCanUseTool(session: QwenSession): CanUseTool {
  return async (
    toolName: string,
    input: ToolInput,
    _opts: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    // Defense-in-depth: ask_user_question shouldn't reach us (excluded
    // at the SDK level); if it does, deny with a clear hint.
    if (toolName === "ask_user_question") {
      session.pushEvent(
        "permission_denied",
        `ask_user_question reached canUseTool — should be excluded`,
        { tool_name: toolName, input },
      );
      return {
        behavior: "deny",
        message:
          "ask_user_question is not available; ask in plain text in your response and the user will reply.",
      };
    }

    if (WRITE_TOOLS.has(toolName)) {
      session.pushEvent(
        "permission_denied",
        `write_authority not granted for ${toolName}`,
        { tool_name: toolName, input },
      );
      return { behavior: "deny", message: "write_authority not granted" };
    }

    // Read tools / search tools / web_fetch / etc. — auto-allow.
    return { behavior: "allow", updatedInput: input };
  };
}
