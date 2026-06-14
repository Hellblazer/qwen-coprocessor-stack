// SPDX-License-Identifier: MIT
//
// Dispatcher registry (RDR-008 P1, bead qwen-coprocessor-stack-q8k) — the
// plugin SEAM. A small `DispatcherKind -> Dispatch` map built on RDR-007's
// `Dispatch` type and its injected-effect dispatchers (`makeQwenSpawnDispatch`
// etc.). Resolving + invoking a dispatcher is uniform; adding a new kind is a
// REGISTRATION, not a rewrite. This module IS the framework.
//
// DISCIPLINE (RDR-008): registry + RDR-007 effect interfaces ONLY — no plugin
// discovery, no dynamic loading, no plugin lifecycle. The dispatcher axis is
// single-member by design (`DispatcherKind = "qwen-local"`) until a real second
// dispatcher appears. This file runs NO side effects: it holds a map and a
// lookup; the dispatchers it stores own their (injected) effects.

import { assertAgentCli, type Dispatch } from "./dispatch.js";
import type { AgentProvider, DispatcherKind } from "./types.js";

/**
 * The dispatcher registry. `register(kind, dispatch)` wires a `DispatcherKind`
 * to its `Dispatch`; `resolve(provider)` returns the `Dispatch` for an
 * `kind:"agent-cli"` provider by its declared `agentKind`.
 */
export interface DispatcherRegistry {
  /** Register (or replace — last-write-wins) the dispatcher for a kind. */
  register(kind: DispatcherKind, dispatch: Dispatch): void;
  /** True when a dispatcher is registered for `kind`. */
  has(kind: DispatcherKind): boolean;
  /** The registered kinds, in insertion order. */
  kinds(): DispatcherKind[];
  /**
   * Resolve the `Dispatch` for an agent-cli provider. Throws when:
   *  - the provider is `kind:"model-endpoint"` (no agentic loop — invoked via
   *    its tool path, `assertAgentCli`);
   *  - the provider declares no `agentKind`;
   *  - no dispatcher is registered for the declared `agentKind`.
   */
  resolve(provider: AgentProvider): Dispatch;
}

/** Build an empty dispatcher registry. */
export function createDispatcherRegistry(): DispatcherRegistry {
  const map = new Map<DispatcherKind, Dispatch>();
  return {
    register(kind, dispatch) {
      map.set(kind, dispatch);
    },
    has(kind) {
      return map.has(kind);
    },
    kinds() {
      return [...map.keys()];
    },
    resolve(provider) {
      assertAgentCli(provider);
      const kind = provider.agentKind;
      if (kind === undefined) {
        throw new Error(
          `dispatch registry cannot resolve provider "${provider.id}": ` +
            `kind:"agent-cli" provider declares no agentKind.`,
        );
      }
      const dispatch = map.get(kind);
      if (dispatch === undefined) {
        throw new Error(
          `dispatch registry has no dispatcher registered for agentKind "${kind}" ` +
            `(provider "${provider.id}"). Registered: [${[...map.keys()].join(", ")}].`,
        );
      }
      return dispatch;
    },
  };
}
