// SPDX-License-Identifier: MIT
//
// Per-session settings set from the human-operated settings page
// (src/settings-page.ts, bead qwen-coprocessor-stack-9sm2).
//
// Each Claude Code session spawns its own supervisor process, so this state is
// per session by construction. It lives in memory only: never written to disk,
// never written to the shared `~/.qwen-coprocessor-stack/config.json` (every
// session's supervisor reads that file, so a value there would reach sessions
// that did not ask). It is lost when the supervisor restarts.
//
// The WRITE side is split from the READ side on purpose. `createSessionSettings`
// returns a `view` (read-only) and a `writer`. Everything the model can reach
// (tool handlers, the dispatch gate) receives only the view; the writer is
// handed to the settings page and nothing else. That makes "only the page can
// change settings" a property of who holds which object, not of a convention.

import { getSessionDefaultExtensions } from "./extensions.js";
import { isDispatchEnabled } from "./dispatch-tool.js";
import type { AgentProvider } from "./types.js";

/** What the page has set. `undefined` = not set from the page (env/config rule). */
export interface SessionSettingsSnapshot {
  readonly dispatchEnabled: boolean | undefined;
  /** Non-empty when set. */
  readonly providers: readonly AgentProvider[] | undefined;
  /** Non-empty when set; names are lowercased and unique. */
  readonly defaultExtensions: readonly string[] | undefined;
}

/** Read access. This is the only form of the settings the rest of the
 *  supervisor ever sees. */
export interface SessionSettingsView {
  get(): SessionSettingsSnapshot;
}

/** `null` clears a field back to "not set from the page". An empty array also
 *  clears (providers and extensions have no meaningful "set to empty"). */
export interface SessionSettingsPatch {
  dispatchEnabled?: boolean | null;
  providers?: AgentProvider[] | null;
  defaultExtensions?: string[] | null;
}

/** Write access. Handed to the settings page only; never to a tool handler. */
export interface SessionSettingsWriter {
  apply(patch: SessionSettingsPatch): SessionSettingsSnapshot;
}

export interface SessionSettings {
  view: SessionSettingsView;
  writer: SessionSettingsWriter;
}

/**
 * Deep copy of a provider, array fields included (`modalities`, `excludes`,
 * `strengths`). With `freeze`, the copy and its arrays are frozen.
 */
export function cloneProvider(p: AgentProvider, freeze = false): AgentProvider {
  const copy: AgentProvider = {
    ...p,
    modalities: [...p.modalities] as AgentProvider["modalities"],
    excludes: [...p.excludes],
    ...(p.strengths !== undefined ? { strengths: [...p.strengths] } : {}),
  };
  if (freeze) {
    Object.freeze(copy.modalities);
    Object.freeze(copy.excludes);
    if (copy.strengths !== undefined) Object.freeze(copy.strengths);
    Object.freeze(copy);
  }
  return copy;
}

/** Factory, not a module singleton: every supervisor (and every test) gets its
 *  own state. Everything handed out is frozen: the settings object, the view,
 *  the writer and every snapshot, so nothing that holds a reference can alter
 *  the state or swap a method out. */
export function createSessionSettings(): SessionSettings {
  let state: SessionSettingsSnapshot = Object.freeze({
    dispatchEnabled: undefined,
    providers: undefined,
    defaultExtensions: undefined,
  });
  const freezeSnapshot = (v: {
    dispatchEnabled: boolean | undefined;
    providers: readonly AgentProvider[] | undefined;
    defaultExtensions: readonly string[] | undefined;
  }): SessionSettingsSnapshot =>
    Object.freeze({
      dispatchEnabled: v.dispatchEnabled,
      providers:
        v.providers === undefined ? undefined : Object.freeze(v.providers.map((p) => cloneProvider(p, true))),
      defaultExtensions: v.defaultExtensions === undefined ? undefined : Object.freeze([...v.defaultExtensions]),
    });
  // Each read builds a fresh deep copy, so no two callers share a snapshot.
  const snapshot = (): SessionSettingsSnapshot => freezeSnapshot(state);
  const view: SessionSettingsView = Object.freeze({ get: snapshot });
  const writer: SessionSettingsWriter = Object.freeze({
    apply(patch: SessionSettingsPatch): SessionSettingsSnapshot {
      const next = { ...state };
      if (patch.dispatchEnabled !== undefined) {
        next.dispatchEnabled = patch.dispatchEnabled === null ? undefined : patch.dispatchEnabled;
      }
      if (patch.providers !== undefined) {
        next.providers =
          patch.providers === null || patch.providers.length === 0 ? undefined : patch.providers;
      }
      if (patch.defaultExtensions !== undefined) {
        next.defaultExtensions =
          patch.defaultExtensions === null || patch.defaultExtensions.length === 0
            ? undefined
            : patch.defaultExtensions;
      }
      // freezeSnapshot copies the patch's arrays, so later mutation of the
      // caller's objects cannot reach the stored state.
      state = freezeSnapshot(next);
      return snapshot();
    },
  });
  return Object.freeze({ view, writer });
}

// ── effective resolution ────────────────────────────────────────────────────
//
// Page value if set, else the pre-existing rule. With nothing set from the page
// each function returns exactly what the old direct call returned.

export type EnabledSource = "page" | "env" | "off";
export type ProvidersSource = "page" | "env" | "config" | "none";
export type ExtensionsSource = "page" | "env" | "config" | "none";

export function effectiveDispatchEnabled(
  view: SessionSettingsView | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: EnabledSource } {
  const page = view?.get().dispatchEnabled;
  if (page !== undefined) return { enabled: page, source: "page" };
  const enabled = isDispatchEnabled(env);
  return { enabled, source: enabled ? "env" : "off" };
}

export function effectiveProviders(
  view: SessionSettingsView | undefined,
  loadProviders: () => AgentProvider[],
  env: NodeJS.ProcessEnv = process.env,
): { providers: AgentProvider[]; source: ProvidersSource } {
  const page = view?.get().providers;
  if (page !== undefined && page.length > 0) {
    return { providers: page.map((p) => cloneProvider(p)), source: "page" };
  }
  const providers = loadProviders();
  if (providers.length === 0) return { providers, source: "none" };
  return { providers, source: envProvidersArePresent(env) ? "env" : "config" };
}

/** True when `QWEN_AGENT_PROVIDERS` holds a JSON array, i.e. when
 *  `loadAgentProviders` would have used it rather than the config file. */
function envProvidersArePresent(env: NodeJS.ProcessEnv): boolean {
  const raw = env["QWEN_AGENT_PROVIDERS"];
  if (raw === undefined || raw.trim() === "") return false;
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
}

/** The session-default extension set: the page's value if set, else
 *  `getSessionDefaultExtensions` (env, then config file, then leave-defaults). */
export function effectiveDefaultExtensions(
  view: SessionSettingsView | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { value: string[] | "leave-defaults"; source: ExtensionsSource } {
  const page = view?.get().defaultExtensions;
  if (page !== undefined && page.length > 0) return { value: [...page], source: "page" };
  const value = getSessionDefaultExtensions(env);
  if (value === "leave-defaults") return { value, source: "none" };
  const envRaw = env["QWEN_DEFAULT_EXTENSIONS"];
  return { value, source: envRaw !== undefined && envRaw !== "" ? "env" : "config" };
}

/** The two seams `runQwenDispatch` reads, bound to a settings view. */
export function settingsDispatchGates(
  view: SessionSettingsView | undefined,
  loadProviders: () => AgentProvider[],
  env: NodeJS.ProcessEnv = process.env,
): { enabled: () => boolean; loadProviders: () => AgentProvider[] } {
  return {
    enabled: () => effectiveDispatchEnabled(view, env).enabled,
    loadProviders: () => effectiveProviders(view, loadProviders, env).providers,
  };
}
