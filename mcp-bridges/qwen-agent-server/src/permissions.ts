// SPDX-License-Identifier: MIT
//
// makeCanUseTool — factory for the CanUseTool callback injected into the
// @qwen-code/sdk QueryOptions.
//
// Critical pins (RDR-001):
//   §Q1  ask_user_question: transition to awaiting_input, hold the Promise.
//        The answer is delivered by resolving the Promise as
//        { behavior: 'deny', message: <answer> }.
//        Empirically verified in /tmp/qwen-sdk-probe/probe.mjs Spike B
//        (2026-05-04): the SDK ferries the answer back to the model via
//        the deny-message field of PermissionResult, NOT via a separate
//        streamInput call. See RDR §Q1 for full justification and the
//        fallback path (re-inject via streamInput with parent_tool_use_id)
//        if this stops working in a future SDK version.
//   §S4  Write tools: emit a synthetic permission_denied event, return deny.
//        This ensures denials are visible in the poll stream rather than
//        silently swallowed by the SDK.

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
 * Routing logic:
 *  1. ask_user_question  → setAwaitingInput on session; hold Promise;
 *                          resolve with deny-message when qwen_send arrives
 *                          (see §Q1 spike-B note above).
 *  2. write tools        → emit permission_denied event; return deny.
 *  3. everything else    → return allow (read tools, search tools, etc.).
 */
export function makeCanUseTool(session: QwenSession): CanUseTool {
  return async (
    toolName: string,
    input: ToolInput,
    _opts: { signal: AbortSignal },
  ): Promise<PermissionResult> => {
    // ── Branch 1: ask_user_question ───────────────────────────
    if (toolName === "ask_user_question") {
      const tool_use_id = (input["tool_use_id"] as string | undefined) ?? "";
      const questions = input["questions"] as
        | Array<{ question: string; header?: string; options?: Array<{ label: string; description?: string }> }>
        | undefined;

      return new Promise<PermissionResult>((resolve) => {
        session.setAwaitingInput({
          tool_use_id,
          tool_name: toolName,
          ...(questions !== undefined ? { questions } : {}),
          // When qwen_send calls pending.resolve(answer), we return
          // { behavior: 'deny', message: answer } — this is the proven
          // mechanism by which the SDK ferries the answer back to the model
          // (Spike B, 2026-05-04; see §Q1 for fallback path).
          resolve: (answer: string) => {
            resolve({ behavior: "deny", message: answer });
          },
        });
      });
    }

    // ── Branch 2: write tools (gated by write_authority) ──────
    if (WRITE_TOOLS.has(toolName)) {
      session.pushEvent(
        "permission_denied",
        `write_authority not granted for ${toolName}`,
        { tool_name: toolName, input },
      );
      return { behavior: "deny", message: "write_authority not granted" };
    }

    // ── Branch 3: read / other tools (auto-allow) ─────────────
    return { behavior: "allow", updatedInput: input };
  };
}
