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

import {
  assertAgentCli,
  makeQwenSpawnDispatch,
  type Dispatch,
  type QwenSpawnEffects,
} from "./dispatch.js";
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

/**
 * Host effects for the default dispatcher loadout. Only `qwen-local` is
 * registered — the single member of the `DispatcherKind` axis. The caller owns
 * the (injected) `QwenSpawnEffects` (supervisor spawn/poll client, git-diff,
 * clock, sleep): P2's server wiring supplies the real effects; tests supply
 * fakes. This module never imports child_process / git / the SDK.
 *
 * `baseCommit` (RDR-008 P2) is the caller-supplied base for THIS run's worktree
 * — the `qwen_dispatch` tool-input value. It is REQUIRED and threaded into the
 * dispatcher so the git-diff harvester always diffs against the base, never `HEAD`.
 * Because the base is per-run, the registry is constructed per dispatch call
 * (the registry still owns kind→dispatcher resolution; only the bound base
 * differs per call).
 */
export interface DefaultDispatcherEffects {
  qwenSpawn: QwenSpawnEffects;
  baseCommit: string;
  /** Forwarded to `makeQwenSpawnDispatch` (e.g. `pollIntervalMs`). */
  qwenSpawnOpts?: { pollIntervalMs?: number };
}

/**
 * Build a registry pre-loaded with the dispatcher set — the REGISTRATION
 * CEREMONY (RDR-008 Approach item 1, part 2). Registers `qwen-local` →
 * `makeQwenSpawnDispatch(effects.qwenSpawn, { baseCommit })` (local Qwen,
 * one-shot poll-to-completion; idle is terminal). This is the production
 * producer for the seam: `resolve()` of a `kind:"agent-cli"` provider declaring
 * `agentKind:"qwen-local"` returns the real RDR-007 dispatcher bound to this
 * run's `baseCommit`.
 *
 * Adding a second dispatcher is a one-line `register()` here plus a new
 * `DispatcherKind` member — no rewrite. Single-member by design until that
 * second dispatcher is real.
 */
export function createDefaultDispatcherRegistry(
  effects: DefaultDispatcherEffects,
): DispatcherRegistry {
  const registry = createDispatcherRegistry();
  registry.register(
    "qwen-local",
    makeQwenSpawnDispatch(effects.qwenSpawn, {
      baseCommit: effects.baseCommit,
      ...(effects.qwenSpawnOpts?.pollIntervalMs !== undefined
        ? { pollIntervalMs: effects.qwenSpawnOpts.pollIntervalMs }
        : {}),
    }),
  );
  return registry;
}
