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
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLogger } from "./log.js";

import { readConfigDefaultExtensions } from "./backends.js";

const log = createLogger("qwen-extensions");

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
  return parseInstalledExtensionsRich(stdout).map((e) => e.name);
}

/**
 * Per-extension structured info parsed from `qwen extensions list`. All
 * fields are best-effort — fields not present in the output are omitted
 * from the object (rather than emitted as empty / null) so JSON
 * downstream stays compact.
 */
export interface ExtensionInfo {
  /** Lowercased `config.name`. */
  name: string;
  version?: string;
  /** True when prefixed with `✓`, false with `✗`, undefined if neither. */
  enabled_workspace?: boolean;
  path?: string;
  source?: string;
  enabled_user?: boolean;
  context_files?: string[];
  commands?: string[];
  skills?: string[];
  agents?: string[];
  mcp_servers?: string[];
}

/**
 * Parse `qwen extensions list` stdout into structured per-extension
 * records. Mirrors `extensionToOutputString` in cli.js:456690 — each
 * block is joined by `\n\n` and starts with `<glyph> <name> (<version>)`.
 *
 * Fail-soft: on empty / sentinel / unparseable input, returns `[]`.
 * Individual fields that don't match expected line patterns are simply
 * omitted from the record; we never throw.
 */
export function parseInstalledExtensionsRich(stdout: string): ExtensionInfo[] {
  if (typeof stdout !== "string") return [];
  const cleaned = stdout.replace(ANSI_RE, "");
  if (cleaned.trim() === "") return [];
  if (/no extensions installed/i.test(cleaned)) return [];

  const blocks = cleaned.split(/\n{2,}/);
  const out: ExtensionInfo[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    if (firstLine === "") continue;

    // Header match: glyph + name + (version)
    const headerMatch = /^\s*([✓✗])\s+(.+?)\s+\(([^()]+)\)\s*$/.exec(firstLine);
    if (!headerMatch) continue;
    const glyph = headerMatch[1];
    const name = headerMatch[2]?.trim();
    const version = headerMatch[3]?.trim();
    if (!name) continue;

    const info: ExtensionInfo = { name: name.toLowerCase() };
    if (version) info.version = version;
    info.enabled_workspace = glyph === "✓";

    // Field lines and list-section accumulation. Format reference:
    //   ` Path: <path>`
    //   ` Source: <source> (Type: <type>)` [optional]
    //   ` Enabled (User): <bool>`
    //   ` Enabled (Workspace): <bool>`
    //   ` Context files:` then `  <file>` lines
    //   ` Commands:` then `  /<cmd>` lines
    //   ` Skills:` then `  <skill>` lines
    //   ` Agents:` then `  <agent>` lines
    //   ` MCP servers:` then `  <name>` lines
    let currentList: string[] | null = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const trimmed = line.trim();
      if (trimmed === "") continue;

      // List-item lines start with two spaces of indent; field lines start with one.
      const isListItem = /^ {2,}\S/.test(line) && !/^\s*\w[\w\s]*?:/.test(trimmed);
      if (isListItem && currentList !== null) {
        // Strip the leading slash for commands ("/foo" → "foo") to match
        // how the supervisor's resolveExtensions expects them.
        const item = trimmed.replace(/^\//, "");
        if (item) currentList.push(item);
        continue;
      }

      currentList = null;

      const fieldMatch = /^\s*([\w\s()]+?):\s*(.*)$/.exec(line);
      if (!fieldMatch) continue;
      const key = (fieldMatch[1] ?? "").trim().toLowerCase();
      const val = (fieldMatch[2] ?? "").trim();

      if (key === "path") {
        if (val) info.path = val;
      } else if (key === "source") {
        // Strip trailing "(Type: ...)" suffix — source is just the identifier.
        if (val) info.source = val.replace(/\s*\(Type:\s*[^)]*\)\s*$/, "");
      } else if (key === "enabled (user)") {
        info.enabled_user = /^true$/i.test(val);
      } else if (key === "enabled (workspace)") {
        info.enabled_workspace = /^true$/i.test(val);
      } else if (key === "context files") {
        info.context_files = [];
        currentList = info.context_files;
      } else if (key === "commands") {
        info.commands = [];
        currentList = info.commands;
      } else if (key === "skills") {
        info.skills = [];
        currentList = info.skills;
      } else if (key === "agents") {
        info.agents = [];
        currentList = info.agents;
      } else if (key === "mcp servers") {
        info.mcp_servers = [];
        currentList = info.mcp_servers;
      }
    }

    // Drop empty list arrays so JSON stays compact.
    for (const k of ["context_files", "commands", "skills", "agents", "mcp_servers"] as const) {
      if (info[k] && info[k]?.length === 0) delete info[k];
    }

    out.push(info);
  }
  return out;
}

/**
 * Async stdout-producing function for `qwen extensions list`. Injected
 * into `createInstalledExtensionsCache` for testability; the production
 * default shells out to `<qwenRealBin> extensions list`.
 */
export type ExecExtensionsListFn = (qwenRealBin: string) => Promise<string>;

export const defaultExecExtensionsList: ExecExtensionsListFn = (qwenRealBin) =>
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
 * Shell out to `<qwenRealBin> extensions list`, parse the rich form, and
 * return the structured per-extension records. Throws on exec failure
 * (qwen binary missing, etc.). Returns `[]` if output is empty or
 * unparseable — same fail-soft contract as the bare-name parser.
 *
 * Used by the `qwen_extensions` MCP tool to give callers the full
 * installed-extensions inventory (versions, paths, source, declared
 * commands/skills/agents/MCP servers) without going through the
 * cache (which only retains names).
 */
export async function listInstalledExtensions(
  qwenRealBin: string,
  execFn: ExecExtensionsListFn = defaultExecExtensionsList,
): Promise<ExtensionInfo[]> {
  const stdout = await execFn(qwenRealBin);
  return parseInstalledExtensionsRich(stdout);
}

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
 * Read the supervisor's session-default extension set.
 *
 * Resolution priority (highest first):
 *   1. `QWEN_DEFAULT_EXTENSIONS` env var (back-compat / one-shot override)
 *   2. `default_extensions` field in `~/.qwen-coprocessor-stack/config.json`
 *   3. "leave-defaults" sentinel — wrapper drops --extensions; CLI defaults
 *      (all enabled per extension-enablement.json) apply
 *
 * The config-file source is mtime-cached at the `readConfig()` layer in
 * backends.ts, so re-invocation on every spawn is cheap.
 */
export function getSessionDefaultExtensions(
  env: NodeJS.ProcessEnv,
): string[] | "leave-defaults" {
  // 1. env override
  const raw = env["QWEN_DEFAULT_EXTENSIONS"];
  if (raw !== undefined && raw !== "") {
    return dedupeLower(
      raw.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    );
  }

  // 2. config file
  const fromFile = readConfigDefaultExtensions();
  if (fromFile && fromFile.length > 0) {
    return dedupeLower(fromFile);
  }

  // 3. unset → CLI defaults apply
  return "leave-defaults";
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

// ─────────────────────────────────────────────────────────────────
// W2 — extension lifecycle exec layer (bead qwen-coprocessor-stack-3su.13)
//
// RDR-002 §Layer 1, Phase 0 amendment (2026-08-22, gate-approved):
// install/upgrade/lifecycle mutation, thin shell-out to `qwen extensions
// <subcommand>`. Everything below is pure argv-construction + validation
// plus an injectable execFn for the actual exec — no MCP tool wiring
// here (that's bead 3su.14).
//
// Gate decision (hard acceptance criterion): LOCAL sources are ungated;
// REMOTE sources (git URL, npm @scope/name, owner/repo shorthand,
// marketplace url:name) are refused unless QWEN_ALLOW_REMOTE_INSTALL=1
// is set in the supervisor's environment. The enforcement point is HERE,
// inside the library functions below — not deferred to the MCP boundary
// — so an in-process caller (bench harness, driver script) cannot bypass
// it by skipping the MCP tool.

/** Env var that must be "1" to permit installing/updating a remote source. */
export const QWEN_ALLOW_REMOTE_INSTALL_ENV = "QWEN_ALLOW_REMOTE_INSTALL";

export const EXTENSION_LIFECYCLE_ERROR_CODES = [
  /** Source classification failed, or a caller-claimed local path doesn't exist. */
  "invalid_source",
  /** A required name argument (extension name) was empty/whitespace. */
  "invalid_name",
  /** --scope was anything other than "user" | "workspace". */
  "invalid_scope",
  /** Remote source refused because QWEN_ALLOW_REMOTE_INSTALL!=1. */
  "remote_install_gated",
  /** The underlying `qwen extensions <subcommand>` exec failed (nonzero exit / spawn error). */
  "exec_failed",
] as const;
export type ExtensionLifecycleErrorCode = (typeof EXTENSION_LIFECYCLE_ERROR_CODES)[number];

/**
 * Structured error surfaced by every mutation function in this section.
 * Mirrors the `QwenDispatchError` pattern in dispatch-tool.ts: a fixed
 * `code` union plus a human-readable message. `stderr` is populated when
 * the failure came from an actual subprocess exit (exec_failed); it is
 * intentionally omitted (not set to `undefined`) on every other code so
 * JSON serialization stays compact and `exactOptionalPropertyTypes`
 * holds.
 */
export class ExtensionLifecycleError extends Error {
  readonly code: ExtensionLifecycleErrorCode;
  readonly stderr?: string;
  constructor(code: ExtensionLifecycleErrorCode, message: string, stderr?: string) {
    super(message);
    this.name = "ExtensionLifecycleError";
    this.code = code;
    if (stderr !== undefined) this.stderr = stderr;
  }
}

function requireNonEmptyName(name: string, context: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new ExtensionLifecycleError(
      "invalid_name",
      `extension name must not be empty (${context})`,
    );
  }
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────
// Source classification — RDR-002 Phase 0 amendment: `qwen extensions
// install <source>` takes ONE positional and auto-detects. There is no
// --source and no --path flag; do not invent one.
//
// Auto-detect order, verbatim from the live-install verification
// (qwen-code 0.15.6): stat() succeeds -> local path; git URL -> git;
// @scope/name -> npm; owner/repo -> git; otherwise "Install source not
// found". stat() is checked FIRST for every input shape (not only
// path-marker-prefixed ones) so a literal on-disk match always wins over
// a superficial remote-shape match. Marketplace `url:name` sources are
// documented in the original Layer-1 table and are classified last,
// before the final rejection — the amendment's "otherwise" wording
// describes the terminal case, not marketplace's absence.
export type ExtensionSourceType = "local" | "git" | "npm" | "marketplace";

export interface ClassifiedSource {
  type: ExtensionSourceType;
  /** Absolute path for "local"; the source string verbatim otherwise —
   *  this is exactly the positional argument `qwen extensions install`
   *  receives. */
  value: string;
}

const GIT_URL_RE = /^(git@|git:\/\/|https?:\/\/|ssh:\/\/)/i;
const NPM_SCOPE_RE = /^@[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/;
const OWNER_REPO_RE = /^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/;
const MARKETPLACE_RE = /^[^\s:]+:[^\s:/]+$/;

function looksLikeExplicitLocalPath(s: string): boolean {
  return (
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s.startsWith("~/") ||
    s === "." ||
    s === ".." ||
    s === "~"
  );
}

/**
 * Classify a caller-supplied extension source string, resolving a
 * relative local path to absolute. Throws `ExtensionLifecycleError`
 * (code `invalid_source`) pre-exec when the source is empty, when it
 * unambiguously looks like a local path but doesn't exist on disk, or
 * when it matches none of the recognized shapes.
 *
 * `cwd` defaults to `process.cwd()`; tests inject a temp dir so path
 * resolution/existence checks don't depend on the process's real cwd.
 */
export function classifySource(source: string, cwd: string = process.cwd()): ClassifiedSource {
  const trimmed = source.trim();
  if (trimmed === "") {
    throw new ExtensionLifecycleError("invalid_source", "extension source must not be empty");
  }

  const resolvedAbs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);

  // stat() succeeds -> local path. Checked first for every shape.
  if (existsSync(resolvedAbs)) {
    return { type: "local", value: resolvedAbs };
  }

  // An explicit local-path marker with no match on disk is a path error,
  // not a "try the next source type" fallthrough. Rejecting here also
  // prevents a nonexistent './foo/bar' from being misread as an
  // owner/repo git shorthand purely because it contains one slash.
  if (looksLikeExplicitLocalPath(trimmed)) {
    throw new ExtensionLifecycleError(
      "invalid_source",
      `local extension path does not exist: ${resolvedAbs}`,
    );
  }

  if (GIT_URL_RE.test(trimmed)) {
    return { type: "git", value: trimmed };
  }
  if (NPM_SCOPE_RE.test(trimmed)) {
    return { type: "npm", value: trimmed };
  }
  if (OWNER_REPO_RE.test(trimmed)) {
    return { type: "git", value: trimmed };
  }
  if (MARKETPLACE_RE.test(trimmed)) {
    return { type: "marketplace", value: trimmed };
  }

  throw new ExtensionLifecycleError(
    "invalid_source",
    `Install source not found: ${trimmed}`,
  );
}

/** Anything other than "local" requires QWEN_ALLOW_REMOTE_INSTALL=1. */
export function isRemoteSourceType(type: ExtensionSourceType): boolean {
  return type !== "local";
}

/**
 * Gate decision enforcement point (RDR-002 Phase 0 amendment, hard
 * acceptance criterion). Throws `ExtensionLifecycleError` (code
 * `remote_install_gated`) naming the env var when `type` is remote and
 * the var isn't set to exactly "1". A no-op for local sources.
 */
export function assertRemoteAllowed(type: ExtensionSourceType, env: NodeJS.ProcessEnv): void {
  if (!isRemoteSourceType(type)) return;
  if (env[QWEN_ALLOW_REMOTE_INSTALL_ENV] === "1") return;
  throw new ExtensionLifecycleError(
    "remote_install_gated",
    `remote extension source (type=${type}) refused: set ${QWEN_ALLOW_REMOTE_INSTALL_ENV}=1 ` +
      "in the supervisor environment to allow remote install/update",
  );
}

// ─────────────────────────────────────────────────────────────────
// --scope validation — RDR-002 Phase 0 amendment: upstream VALIDATES
// user|workspace|system|systemdefaults but the handlers only branch on
// "workspace" — system/systemdefaults silently behave as "user". This
// wrapper accepts ONLY user|workspace and rejects the rest before exec.

export type ExtensionScope = "user" | "workspace";

const SILENTLY_DOWNGRADED_SCOPES = new Set(["system", "systemdefaults"]);

/**
 * Validate a caller-supplied `--scope` value. Returns `undefined` when
 * `scope` is `undefined` so the caller can apply its own explicit
 * default (see `DEFAULT_ENABLE_SCOPE` / `DEFAULT_DISABLE_SCOPE`) rather
 * than silently inheriting upstream's asymmetric defaults. Throws
 * `ExtensionLifecycleError` (code `invalid_scope`) for anything other
 * than "user" | "workspace", including the two values upstream accepts
 * but silently downgrades.
 */
export function validateScope(scope: string | undefined): ExtensionScope | undefined {
  if (scope === undefined) return undefined;
  const lower = scope.toLowerCase();
  if (lower === "user" || lower === "workspace") return lower;
  if (SILENTLY_DOWNGRADED_SCOPES.has(lower)) {
    throw new ExtensionLifecycleError(
      "invalid_scope",
      `scope '${scope}' is rejected: upstream 'qwen extensions' validates it but silently ` +
        "treats it as 'user' (RDR-002 Phase 0 amendment) — pass 'user' explicitly instead",
    );
  }
  throw new ExtensionLifecycleError(
    "invalid_scope",
    `invalid scope '${scope}': only 'user' or 'workspace' are accepted`,
  );
}

/**
 * Explicit wrapper defaults applied when the caller omits --scope.
 * Upstream's own defaults are asymmetric (enable -> all scopes; disable
 * -> User) and must not be silently inherited (RDR-002 Phase 0
 * amendment). This wrapper instead picks one visible, symmetric default
 * for both verbs: "user" — the narrower, least-surprising scope. An
 * operator who wants the wider behavior passes `--scope workspace`
 * explicitly.
 */
export const DEFAULT_ENABLE_SCOPE: ExtensionScope = "user";
export const DEFAULT_DISABLE_SCOPE: ExtensionScope = "user";

// ─────────────────────────────────────────────────────────────────
// Mutation exec — execFile only, never exec (shell-injection pin below
// in tests). Mutation failures THROW a typed error carrying stderr; this
// is deliberately NOT fail-soft, unlike the LIST path above (a silent
// no-op mutation is the worst outcome for install/uninstall/enable/
// disable/update).

/**
 * Injectable mutation exec function, mirroring `ExecExtensionsListFn`'s
 * shape (`(qwenRealBin) => Promise<string>`) but taking the full argv
 * tail. Resolves with stdout on success; rejects (any Error, optionally
 * carrying a `.stderr` string property) on failure. `runMutation` below
 * normalizes any rejection into an `ExtensionLifecycleError`.
 */
export type ExecExtensionsMutateFn = (qwenRealBin: string, args: string[]) => Promise<string>;

export const defaultExecExtensionsMutate: ExecExtensionsMutateFn = (qwenRealBin, args) =>
  new Promise((res, rej) => {
    execFile(qwenRealBin, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        rej(
          new ExtensionLifecycleError(
            "exec_failed",
            `qwen ${args.join(" ")} failed: ${err.message}`,
            stderr,
          ),
        );
        return;
      }
      res(stdout);
    });
  });

function extractStderr(err: unknown): string | undefined {
  if (err && typeof err === "object" && "stderr" in err) {
    const s = (err as { stderr?: unknown }).stderr;
    if (typeof s === "string") return s;
  }
  return undefined;
}

/** Run one mutation exec, normalizing any rejection into `ExtensionLifecycleError`. */
async function runMutation(
  qwenRealBin: string,
  argv: string[],
  execFn: ExecExtensionsMutateFn = defaultExecExtensionsMutate,
): Promise<string> {
  try {
    return await execFn(qwenRealBin, argv);
  } catch (err) {
    if (err instanceof ExtensionLifecycleError) throw err;
    throw new ExtensionLifecycleError(
      "exec_failed",
      `qwen ${argv.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`,
      extractStderr(err),
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// argv builders — asserted exactly by tests. Pure functions; the unit
// under test is argv construction itself.

/**
 * `--consent` is REQUIRED, not optional. Verified live against the real
 * qwen 0.15.6 CLI (bead 3su.15's mandated end-to-end exercise): without
 * it, `qwen extensions install <source>` prints an interactive
 * "Do you want to continue? [Y/n]:" prompt and reads from stdin. The
 * supervisor's exec layer (`defaultExecExtensionsMutate`) never writes
 * to or closes the child's stdin, so a real invocation hangs the exec
 * call — and the awaiting MCP tool call — forever. `--consent`
 * ("Acknowledge the security risks of installing an extension and skip
 * the confirmation prompt") makes install run non-interactively, same
 * as every other subcommand this module shells out to. This is safe to
 * always pass: the confirmation prompt exists for a human at an
 * interactive terminal, which the supervisor never is; the Phase 0
 * remote-install gate (`assertRemoteAllowed`, called before this
 * function) is this wrapper's own consent gate for remote sources, and
 * a local source needs no extra confirmation at all.
 */
export function buildInstallArgv(classified: ClassifiedSource): string[] {
  return ["extensions", "install", classified.value, "--consent"];
}

/** The `remove` -> `uninstall` name translation lives entirely here: the
 *  argv always says "uninstall" regardless of which caller-facing verb
 *  ("remove" or "uninstall") the MCP tool layer (3su.14) exposes. */
export function buildUninstallArgv(name: string): string[] {
  return ["extensions", "uninstall", name];
}

export function buildEnableArgv(name: string, scope: ExtensionScope): string[] {
  return ["extensions", "enable", name, "--scope", scope];
}

export function buildDisableArgv(name: string, scope: ExtensionScope): string[] {
  return ["extensions", "disable", name, "--scope", scope];
}

/** Always a single-name update — see `updateExtensions` for why --all is
 *  never passed through raw. */
export function buildUpdateArgv(name: string): string[] {
  return ["extensions", "update", name];
}

/**
 * KNOWN LIMITATION (found alongside the install --consent fix above,
 * bead 3su.15's live exercise): `qwen extensions link <path>` shows the
 * SAME interactive confirmation prompt as `install`, but — unlike
 * install — its subcommand does not accept `--consent` at all
 * (`Unknown argument: consent`, verified against qwen 0.15.6). There is
 * currently no upstream flag to run `link` non-interactively. `link` is
 * not wired to any MCP tool today (3su.14 scoped install/remove/enable/
 * disable/update only), so this is dormant, not exploitable — but a
 * future caller of `linkExtension` against a real qwen binary WILL
 * hang. Do not expose it via an MCP tool without first confirming a
 * non-interactive path exists upstream (or piping a "y" into stdin,
 * which this module's exec layer does not currently support).
 */
export function buildLinkArgv(absPath: string): string[] {
  return ["extensions", "link", absPath];
}

// ─────────────────────────────────────────────────────────────────
// Top-level lifecycle operations — classify/validate, gate, build argv,
// exec. Every mutation is enforced HERE, before exec, so no caller
// (MCP tool or in-process driver) can bypass the gate/scope checks by
// calling exec directly.

export interface InstallExtensionOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecExtensionsMutateFn;
}

export interface InstallExtensionResult {
  argv: string[];
  stdout: string;
  source: ClassifiedSource;
}

export async function installExtension(
  qwenRealBin: string,
  source: string,
  opts: InstallExtensionOpts = {},
): Promise<InstallExtensionResult> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const classified = classifySource(source, cwd);
  assertRemoteAllowed(classified.type, env);
  const argv = buildInstallArgv(classified);
  const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
  return { argv, stdout, source: classified };
}

export interface UninstallExtensionResult {
  argv: string[];
  stdout: string;
}

export async function uninstallExtension(
  qwenRealBin: string,
  name: string,
  opts: { execFn?: ExecExtensionsMutateFn } = {},
): Promise<UninstallExtensionResult> {
  const trimmedName = requireNonEmptyName(name, "uninstall");
  const argv = buildUninstallArgv(trimmedName);
  const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
  return { argv, stdout };
}

export interface EnableDisableOpts {
  scope?: string;
  execFn?: ExecExtensionsMutateFn;
}

export interface EnableDisableResult {
  argv: string[];
  stdout: string;
  scope: ExtensionScope;
}

export async function enableExtension(
  qwenRealBin: string,
  name: string,
  opts: EnableDisableOpts = {},
): Promise<EnableDisableResult> {
  const trimmedName = requireNonEmptyName(name, "enable");
  const scope = validateScope(opts.scope) ?? DEFAULT_ENABLE_SCOPE;
  const argv = buildEnableArgv(trimmedName, scope);
  const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
  return { argv, stdout, scope };
}

export async function disableExtension(
  qwenRealBin: string,
  name: string,
  opts: EnableDisableOpts = {},
): Promise<EnableDisableResult> {
  const trimmedName = requireNonEmptyName(name, "disable");
  const scope = validateScope(opts.scope) ?? DEFAULT_DISABLE_SCOPE;
  const argv = buildDisableArgv(trimmedName, scope);
  const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
  return { argv, stdout, scope };
}

export interface LinkExtensionResult {
  argv: string[];
  stdout: string;
}

/** `link <path>` only ever accepts a local path (RDR-002 dev-loop note)
 *  and is always ungated, same as install-from-local-path. A remote-
 *  shaped source is rejected as `invalid_source`, never silently routed
 *  through the remote gate. */
export async function linkExtension(
  qwenRealBin: string,
  path: string,
  opts: { cwd?: string; execFn?: ExecExtensionsMutateFn } = {},
): Promise<LinkExtensionResult> {
  const cwd = opts.cwd ?? process.cwd();
  const classified = classifySource(path, cwd);
  if (classified.type !== "local") {
    throw new ExtensionLifecycleError(
      "invalid_source",
      `link requires a local path; '${path}' classified as ${classified.type}`,
    );
  }
  const argv = buildLinkArgv(classified.value);
  const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
  return { argv, stdout };
}

// ─────────────────────────────────────────────────────────────────
// update — RDR-002 Layer-1 table + 2026-08-22 pickup addendum: `update`
// carries no source argument. `--all` is NEVER passed through raw:
// permitting it would let a single remote-sourced extension silently
// ride along with every local one under one opaque exec call, with no
// per-extension gate check and no way to report a per-extension
// refusal. Instead: enumerate the installed set (or the caller's
// explicit name list), classify EACH one by reading its
// `.qwen-extension-install.json` (installMetadata.type/source) BEFORE
// exec, apply the same remote gate per extension, and shell out to
// `qwen extensions update <name>` individually for every permitted one.

/** File Qwen Code writes into each extension's install directory,
 *  carrying its `installMetadata` (RDR-002 pickup addendum, 2026-08-22). */
export const EXTENSION_INSTALL_METADATA_FILENAME = ".qwen-extension-install.json";

export interface InstallMetadata {
  type?: string;
  source?: string;
}

/** Injected for testability; production default reads
 *  `<extensionPath>/.qwen-extension-install.json`. Returns `null` on
 *  any failure (missing file, unreadable, unparseable, not a JSON
 *  object) — the caller treats `null` as "fail closed", not "assume
 *  local". */
export type ReadInstallMetadataFn = (extensionPath: string) => Promise<InstallMetadata | null>;

export const defaultReadInstallMetadata: ReadInstallMetadataFn = async (extensionPath) => {
  try {
    const raw = await readFile(join(extensionPath, EXTENSION_INSTALL_METADATA_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as InstallMetadata;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * installMetadata.type values this wrapper recognizes as local (ungated)
 * vs. remote (gated via QWEN_ALLOW_REMOTE_INSTALL). This is an allowlist
 * by design (RDR-002 pickup addendum: "fail closed on missing/unknown
 * metadata") — an unrecognized type is refused, never assumed either
 * way. The exact upstream vocabulary was not independently re-spiked for
 * this bead (ground truth: RDR-002 §Layer 1 table names the file and
 * fields, not the full value set); adjust these sets if a live
 * `.qwen-extension-install.json` sample shows a value not covered here.
 */
const LOCAL_INSTALL_METADATA_TYPES = new Set(["local", "link"]);
const REMOTE_INSTALL_METADATA_TYPES = new Set(["git", "npm", "marketplace", "github-release"]);

interface MetadataClassification {
  ok: boolean;
  remote: boolean;
  reason?: string;
}

function classifyInstallMetadataType(meta: InstallMetadata | null): MetadataClassification {
  if (!meta || typeof meta.type !== "string" || meta.type.trim() === "") {
    return {
      ok: false,
      remote: false,
      reason:
        `missing or unreadable ${EXTENSION_INSTALL_METADATA_FILENAME} (installMetadata.type) — ` +
        "update refused fail-closed",
    };
  }
  const type = meta.type.trim().toLowerCase();
  if (LOCAL_INSTALL_METADATA_TYPES.has(type)) return { ok: true, remote: false };
  if (REMOTE_INSTALL_METADATA_TYPES.has(type)) return { ok: true, remote: true };
  return {
    ok: false,
    remote: false,
    reason: `unknown installMetadata.type '${meta.type}' — update refused fail-closed`,
  };
}

export type UpdateItemStatus = "updated" | "refused" | "failed";

export interface UpdateItemResult {
  name: string;
  status: UpdateItemStatus;
  /** Present for "refused" (why it was refused) and "failed" (the exec error message). */
  reason?: string;
  /** Present once an exec was actually attempted ("updated" or "failed"). */
  argv?: string[];
  /** Present only for "updated". */
  stdout?: string;
}

export interface UpdateExtensionsResult {
  items: UpdateItemResult[];
}

export interface UpdateExtensionsOpts {
  env?: NodeJS.ProcessEnv;
  execFn?: ExecExtensionsMutateFn;
  readMetadataFn?: ReadInstallMetadataFn;
}

/**
 * Update one or more installed extensions. `names` is either an explicit
 * list (each looked up in `installed`) or the literal `"all"`, which
 * enumerates every entry in `installed` — never a raw `--all` argv.
 *
 * Every target is classified individually via its
 * `.qwen-extension-install.json` before any exec is attempted; a name
 * not present in `installed`, a target with no known `path`, missing/
 * unreadable metadata, or an unrecognized `installMetadata.type` is
 * reported as `"refused"` and never reaches exec. A recognized-remote
 * target is refused the same way when `QWEN_ALLOW_REMOTE_INSTALL!=1`.
 *
 * One item's exec failure does not abort the batch: it's captured as
 * `"failed"` (with the stderr-derived message in `reason`) so every
 * other item still gets a result. This mirrors the acceptance
 * requirement to "report per-item results including refusals" — the
 * single-target functions above (`installExtension` etc.) still THROW
 * on exec failure, per "mutation failures are NOT fail-soft"; this
 * batch operation is the one explicitly specified to produce a
 * structured per-item report instead.
 */
export async function updateExtensions(
  qwenRealBin: string,
  installed: readonly Pick<ExtensionInfo, "name" | "path">[],
  names: string[] | "all",
  opts: UpdateExtensionsOpts = {},
): Promise<UpdateExtensionsResult> {
  const env = opts.env ?? process.env;
  const readMetadata = opts.readMetadataFn ?? defaultReadInstallMetadata;

  const wanted: string[] = names === "all" ? installed.map((i) => i.name) : dedupeLower(names);
  const byName = new Map(installed.map((i) => [i.name, i]));

  const items: UpdateItemResult[] = [];
  for (const name of wanted) {
    const info = byName.get(name);
    if (!info) {
      items.push({ name, status: "refused", reason: `extension '${name}' is not installed` });
      continue;
    }
    if (!info.path) {
      items.push({
        name,
        status: "refused",
        reason:
          `installed-extensions listing has no path for '${name}'; cannot locate ` +
          EXTENSION_INSTALL_METADATA_FILENAME,
      });
      continue;
    }

    const meta = await readMetadata(info.path);
    const classification = classifyInstallMetadataType(meta);
    if (!classification.ok) {
      items.push({ name, status: "refused", reason: classification.reason ?? "refused" });
      continue;
    }
    if (classification.remote && env[QWEN_ALLOW_REMOTE_INSTALL_ENV] !== "1") {
      items.push({
        name,
        status: "refused",
        reason:
          `remote extension update refused: set ${QWEN_ALLOW_REMOTE_INSTALL_ENV}=1 to allow`,
      });
      continue;
    }

    const argv = buildUpdateArgv(info.name);
    try {
      const stdout = await runMutation(qwenRealBin, argv, opts.execFn);
      items.push({ name, status: "updated", argv, stdout });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      items.push({ name, status: "failed", reason, argv });
    }
  }

  return { items };
}
