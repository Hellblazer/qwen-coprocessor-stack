// SPDX-License-Identifier: MIT
//
// Per-spawn extension loadout helpers — RDR-002.
//
// This module exposes the supervisor-side bridge between Claude's
// orchestrator and the Qwen Code CLI's extensions surface:
//
//   resolveQwenRealBin(env, whichFn?)  — resolve the real qwen binary
//     path the wrapper script will exec. Called once at supervisor
//     startup; result is cached on the handlers/pool context and
//     forwarded to every session via QueryOptions.env.QWEN_REAL_BIN.
//
//   resolveWrapperPath()  — absolute path to the bash wrapper shipped
//     in this package at scripts/qwen-extensions-wrapper.sh. The
//     wrapper is a fixed file; per-session variation is via env vars
//     (QWEN_REAL_BIN, QWEN_AGENT_EXTENSIONS).
//
//   parseInstalledExtensions(stdout)  — pure parser for `qwen
//     extensions list` output. Returns the list of installed names
//     (lowercased) or [] on empty / unparseable input. Never throws.
//
//   createInstalledExtensionsCache(qwenRealBin, execFn?)  — async
//     factory returning a cache object with get/reload/size methods.
//     Initial population shells out to `<qwenRealBin> extensions list`;
//     execFn is injected for testability.
//
// Subsequent phases will add the resolveExtensions(opts, sessionDefault,
// installedCache) algorithm and the qwen_spawn handler integration.

import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";

const log = pino({ name: "qwen-extensions" });

/**
 * Default `which` implementation used when a caller doesn't inject one.
 * Returns the resolved absolute path or null if the command is not on
 * PATH. Never throws.
 */
function defaultWhich(cmd: string): string | null {
  try {
    const out = execFileSync("/usr/bin/env", ["which", cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/**
 * Resolve the real qwen binary path the wrapper script will `exec`.
 *
 * Policy (RDR-002 §The wrapper-script bridge → QWEN_REAL_BIN bullet):
 *
 *   1. If `env.QWEN_REAL_BIN` is set and non-empty, honour it verbatim.
 *      Verify the path exists and has any executable bit set; throw
 *      with a descriptive message on miss. The supervisor exits
 *      non-zero at startup rather than failing at first spawn.
 *   2. Else, run `which qwen`. If empty/null, throw — the supervisor
 *      cannot start without a resolvable qwen binary.
 *
 * The `whichFn` parameter is injected for testability; production code
 * leaves it undefined and `defaultWhich` is used.
 */
export function resolveQwenRealBin(
  env: NodeJS.ProcessEnv,
  whichFn?: (cmd: string) => string | null,
): string {
  const override = env["QWEN_REAL_BIN"];
  if (override !== undefined && override !== "") {
    let mode: number;
    try {
      const stat = statSync(override);
      if (!stat.isFile()) {
        throw new Error(
          `QWEN_REAL_BIN=${override} is not a regular file`,
        );
      }
      mode = stat.mode;
    } catch (err) {
      // Re-throw our own descriptive errors; wrap fs errors with the path.
      if (err instanceof Error && err.message.startsWith("QWEN_REAL_BIN=")) {
        throw err;
      }
      throw new Error(
        `QWEN_REAL_BIN=${override} does not exist or is not accessible`,
      );
    }
    if ((mode & 0o111) === 0) {
      throw new Error(
        `QWEN_REAL_BIN=${override} exists but is not executable (mode bits 0o111 unset)`,
      );
    }
    return override;
  }

  const which = whichFn ?? defaultWhich;
  const found = which("qwen");
  if (found === null || found === "") {
    throw new Error(
      "QWEN_REAL_BIN unset and 'qwen' not on PATH — install Qwen Code or set QWEN_REAL_BIN",
    );
  }
  return found;
}

/**
 * Absolute path to the wrapper script shipped at
 * `mcp-bridges/qwen-agent-server/scripts/qwen-extensions-wrapper.sh`.
 *
 * Resolution is anchored on `import.meta.url` so the same code works
 * whether the module loads from `src/` (during tests) or from `dist/`
 * (after `tsc` build) — both sit one level below the package root.
 */
export function resolveWrapperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "scripts", "qwen-extensions-wrapper.sh");
}

// ─────────────────────────────────────────────────────────────────
// Installed-extensions cache

/**
 * Strip ANSI SGR escape sequences (chalk emits these around status
 * glyphs) so the parser can match plain-text content.
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * First-line header of an extension block emitted by
 * `extensionToOutputString` (cli.js:456690):
 *
 *     <glyph> <name> (<version>)
 *
 * where `<glyph>` is `✓` (U+2713) or `✗` (U+2717) and `<name>` is the
 * `config.name` field of the extension manifest. The glyph is REQUIRED:
 * `extensionToOutputString` only emits a leading-space-only line in
 * `inline2 = true` mode, which `handleList` (cli.js:456770) does not
 * pass. Requiring the glyph narrows the regex so unrelated lines that
 * happen to end with `(something)` cannot accidentally register as
 * extension names if a future block-separator change causes the
 * `\n{2,}` split to miss boundaries.
 *
 * The version sub-pattern `[^()]+` deliberately rejects nested parens,
 * which keeps the second-line ` Source: ... (Type: ...)` from
 * accidentally matching when block boundaries don't separate cleanly.
 */
const HEADER_RE = /^\s*[✓✗]\s+(.+?)\s+\([^()]+\)\s*$/;

/**
 * Parse `qwen extensions list` stdout and return the lowercased
 * `config.name` of each installed extension.
 *
 * Fail-soft per RDR-002 audit-note #4: empty input, the
 * "No extensions installed." sentinel, and unrecognized output all
 * yield `[]` rather than throwing — an upstream output-format change
 * degrades gracefully (cache populates empty; future spawns reject
 * unknown names) instead of bricking the supervisor.
 */
export function parseInstalledExtensions(stdout: string): string[] {
  if (typeof stdout !== "string") return [];
  const cleaned = stdout.replace(ANSI_RE, "");
  if (cleaned.trim() === "") return [];
  if (/no extensions installed/i.test(cleaned)) return [];

  // Blocks are joined by `\n\n` (handleList in cli.js:456770). Take
  // the first line of each block as the candidate header so the
  // ` Path: ... (Type: ...)` second line never gets matched.
  const blocks = cleaned.split(/\n{2,}/);
  const names: string[] = [];
  for (const block of blocks) {
    const firstLine = block.split("\n")[0]?.trim() ?? "";
    if (firstLine === "") continue;
    const match = HEADER_RE.exec(firstLine);
    if (match && match[1]) {
      const name = match[1].trim();
      if (name !== "") names.push(name.toLowerCase());
    }
  }
  return names;
}

/**
 * Async stdout-producing function for `qwen extensions list`. Injected
 * into `createInstalledExtensionsCache` for testability; the production
 * default shells out to `<qwenRealBin> extensions list`.
 */
export type ExecExtensionsListFn = (qwenRealBin: string) => Promise<string>;

const defaultExecExtensionsList: ExecExtensionsListFn = (qwenRealBin) =>
  new Promise((res, rej) => {
    execFile(
      qwenRealBin,
      ["extensions", "list"],
      { encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          rej(err);
          return;
        }
        res(stdout);
      },
    );
  });

/**
 * Process-lifetime cache of currently-installed extension names. Used
 * by `qwen_spawn` (Phase 4) to validate caller-supplied extension
 * names and by the admin tool `qwen_reload_extensions` (Phase 3) to
 * pick up newly-installed extensions without restarting.
 *
 * In-flight sessions are unaffected by reload — their wrapper script
 * already received `QWEN_AGENT_EXTENSIONS` at exec time and the SDK
 * subprocess is bound to that resolved set for its lifetime
 * (RDR-002 §The wrapper-script bridge — drain semantics).
 */
export interface InstalledExtensionsCache {
  /** Snapshot of currently-installed extension names (lowercased). */
  get(): Set<string>;
  /** Re-shell `qwen extensions list`, parse, replace internal state. */
  reload(): Promise<Set<string>>;
  /** Convenience for response payloads / observability. */
  size(): number;
}

/**
 * Construct an `InstalledExtensionsCache` and prime it once.
 *
 * - Exec errors propagate (fail-fast at startup) — the supervisor
 *   should not start if the qwen binary cannot be invoked.
 * - Output that is non-empty but unparseable is treated as an empty
 *   set; a structured-log warning records the first 200 chars of the
 *   output so an operator can diagnose without a crash.
 */
export async function createInstalledExtensionsCache(
  qwenRealBin: string,
  execFn?: ExecExtensionsListFn,
): Promise<InstalledExtensionsCache> {
  const exec = execFn ?? defaultExecExtensionsList;
  let names = new Set<string>();

  async function loadOnce(): Promise<Set<string>> {
    const stdout = await exec(qwenRealBin);
    const parsed = parseInstalledExtensions(stdout);
    if (
      parsed.length === 0 &&
      stdout.trim() !== "" &&
      !/no extensions installed/i.test(stdout)
    ) {
      log.warn(
        { stdout_preview: stdout.slice(0, 200) },
        "qwen extensions list output did not match expected format; cache populated empty",
      );
    }
    return new Set(parsed);
  }

  names = await loadOnce();

  return {
    get: () => names,
    reload: async () => {
      names = await loadOnce();
      return names;
    },
    size: () => names.size,
  };
}

// ─────────────────────────────────────────────────────────────────
// Resolution algorithm — RDR-002 §Resolution-algorithm steps 1–9

/**
 * Per-spawn opts.extensions shape, matching the SpawnOpts.extensions
 * field declared in src/types.ts.
 */
interface ExtensionOpts {
  enable?: string[];
  disable?: string[];
  only?: string[];
}

/**
 * Resolution result consumed by the QwenSession constructor.
 *
 *   - envValue: comma-list / "none" / null. Non-null values are set
 *     verbatim into QueryOptions.env.QWEN_AGENT_EXTENSIONS; null tells
 *     the wrapper to drop the --extensions flag entirely (CLI defaults
 *     apply).
 *   - resolved: the same shape rendered for observability — a string[]
 *     of names, the literal "none" sentinel, or "leave-defaults". Goes
 *     into the extensions_loaded event's payload so qwen_poll surfaces
 *     "what was the tool surface for this session?" without inference.
 */
export interface ResolveExtensionsResult {
  envValue: string | null;
  resolved: string[] | "leave-defaults" | "none";
}

/**
 * Thrown by `resolveExtensions` when the resolved set contains a name
 * the supervisor's installed-extensions cache does not know, or when
 * the caller asked for enable/disable without a session-default base
 * to mutate. Caught by the qwen_spawn handler and translated into a
 * `{ error: { code: 'spawn_error', message } }` envelope.
 */
export class ExtensionResolutionError extends Error {
  readonly unknown: string[];
  constructor(message: string, unknown: string[] = []) {
    super(message);
    this.name = "ExtensionResolutionError";
    this.unknown = unknown;
  }
}

/**
 * Read the supervisor's session-default extension set from the
 * environment. Empty / unset returns the "leave-defaults" sentinel,
 * meaning the wrapper drops the --extensions flag and the CLI defaults
 * (all enabled per extension-enablement.json) apply.
 */
export function getSessionDefaultExtensions(
  env: NodeJS.ProcessEnv,
): string[] | "leave-defaults" {
  const raw = env["QWEN_DEFAULT_EXTENSIONS"];
  if (raw === undefined || raw === "") return "leave-defaults";
  return dedupeLower(
    raw.split(",").map((s) => s.trim()).filter((s) => s !== ""),
  );
}

function dedupeLower(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of input) {
    const lower = name.toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * Framework-required extension set — RDR-002 §Framework-required
 * extensions. Empty today: the supervisor's contract with the inner
 * Qwen (write-authority gating, ask_user_question exclusion,
 * system-prompt preamble, multi-turn streamInput) is enforced via
 * QueryOptions and does not require any extension to be loaded. Adding
 * even one would change the supervisor's contract and must be
 * RDR-tracked.
 *
 * If this set ever becomes non-empty: names here are supervisor-
 * controlled and must be validated against the installed-extensions
 * cache once at supervisor startup; the per-spawn `resolveExtensions`
 * step-7 union does NOT re-validate framework-required names (step 7
 * runs after step 6 in the RDR algorithm).
 */
const FRAMEWORK_REQUIRED_EXTENSIONS: readonly string[] = [];

/**
 * Step 7 — union with framework-required. Adds any framework-required
 * names not already in the resolved set, lowercased and dedup-safe.
 * Idempotent / no-op today because the framework-required set is empty.
 *
 * Exported for direct testability of the non-empty path: an inline
 * call with a non-empty `frameworkRequired` argument exercises the
 * union logic that would otherwise be unreachable from
 * `resolveExtensions` while `FRAMEWORK_REQUIRED_EXTENSIONS` is empty.
 */
export function unionFrameworkRequired(
  base: string[],
  frameworkRequired: readonly string[] = FRAMEWORK_REQUIRED_EXTENSIONS,
): string[] {
  if (frameworkRequired.length === 0) return base;
  const seen = new Set(base);
  const out = [...base];
  for (const name of frameworkRequired) {
    const lower = name.toLowerCase();
    if (!seen.has(lower)) {
      out.push(lower);
      seen.add(lower);
    }
  }
  return out;
}

/**
 * Resolve the active extension set for a single qwen_spawn call,
 * implementing steps 1–9 of RDR-002 §Resolution-algorithm.
 *
 * Steps (verbatim from the RDR):
 *   1. Determine session-default — caller passes it in.
 *   2. Compute base — `only` wins exact-set semantics; otherwise
 *      session-default is the base.
 *   3. Apply `enable` additively.
 *   4. Apply `disable` subtractively (disable wins on overlap).
 *   5. enable / disable independent.
 *   6. Validate against installedCache; throw ExtensionResolutionError
 *      with the unknown names if any.
 *   7. Union with framework-required (today: empty).
 *   8. Render — non-empty → comma-list; explicit empty → "none".
 *   9. "leave-defaults" → null envValue.
 */
export function resolveExtensions(
  opts: ExtensionOpts | undefined,
  sessionDefault: string[] | "leave-defaults",
  installedCache: Set<string>,
): ResolveExtensionsResult {
  const onlyProvided = opts?.only !== undefined;
  const enableProvided = opts?.enable !== undefined && opts.enable.length > 0;
  const disableProvided = opts?.disable !== undefined && opts.disable.length > 0;

  // Step 2: compute base.
  // 2a: only wins (enable/disable IGNORED).
  // 2b: else base is session-default with enable/disable applied.
  let base: string[];

  if (onlyProvided) {
    base = dedupeLower(opts!.only!);
  } else if (sessionDefault === "leave-defaults") {
    if (enableProvided || disableProvided) {
      // Cannot compute a deterministic resolved set without enumerating
      // the implicit CLI-defaults set; reject so the caller gets a
      // visible error rather than silent surprise.
      throw new ExtensionResolutionError(
        "cannot apply opts.extensions.enable/disable when QWEN_DEFAULT_EXTENSIONS is unset; " +
          "set a session default or use opts.extensions.only to specify the exact set",
      );
    }
    // Step 9: no mutations and no base — leave-defaults short-circuits
    // before validation/union (no resolved set to validate or union into).
    return { envValue: null, resolved: "leave-defaults" };
  } else {
    // Session-default is a concrete list. Apply enable additively, then
    // disable subtractively (steps 3–5).
    base = dedupeLower(sessionDefault);
    if (enableProvided) {
      const additions = dedupeLower(opts!.enable!);
      const seen = new Set(base);
      for (const name of additions) {
        if (!seen.has(name)) {
          base.push(name);
          seen.add(name);
        }
      }
    }
    if (disableProvided) {
      const removals = new Set(dedupeLower(opts!.disable!));
      base = base.filter((name) => !removals.has(name));
    }
  }

  // Step 6: validate caller-supplied names against the installed cache.
  validateInstalled(base, installedCache);

  // Step 7: union with framework-required. Names here are supervisor-
  // controlled and pre-validated at startup; not re-validated per spawn.
  base = unionFrameworkRequired(base);

  // Step 8: render. An empty base reached by subtraction or an explicit
  // only=[] renders as "none". The only path that produces leave-defaults
  // is the no-op branch above.
  if (base.length === 0) {
    return { envValue: "none", resolved: "none" };
  }
  return { envValue: base.join(","), resolved: base };
}

function validateInstalled(names: string[], installed: Set<string>): void {
  const unknown: string[] = [];
  for (const name of names) {
    if (!installed.has(name)) unknown.push(name);
  }
  if (unknown.length > 0) {
    throw new ExtensionResolutionError(
      `unknown extension(s): ${unknown.join(", ")}`,
      unknown,
    );
  }
}
