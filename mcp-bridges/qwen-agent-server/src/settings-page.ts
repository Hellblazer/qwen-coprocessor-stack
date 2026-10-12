// SPDX-License-Identifier: MIT
//
// Human-operated settings page (bead qwen-coprocessor-stack-9sm2).
//
// A small loopback HTTP server, started lazily the first time its URL is asked
// for, through which the person at the keyboard opts THIS session in to
// `qwen_dispatch`, picks its provider(s) and its default extension loadout.
// It exists because the env-var route (QWEN_DISPATCH_ENABLE at launch) is
// awkward, not because the model should be able to flip the switch.
//
// THE FLOOR: only a human may opt in. The one and only write path is the HTTP
// `POST /api/state` below. There is deliberately no MCP tool, tool argument or
// env var that reaches `writer.apply`: the `writer` is held by this module and
// nowhere else, and `qwen_settings` is read-only and takes no input. A model
// with a browser or shell tool could still fetch the URL and POST; that is
// outside what this module can prevent, so it is not pretended otherwise. The
// tool result is the only place the token appears.
//
// Hardening, all of it exercised by tests/settings-page.test.ts:
//   - binds 127.0.0.1 only, port 0;
//   - a random 256-bit token per server start, compared in constant time;
//   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   - state changes: POST only, Origin (if sent) must be our own, JSON only,
//     64 KiB cap, strict body validation;
//   - no-store / nosniff / no-referrer and a CSP with per-response nonces.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { createLogger } from "./log.js";
import {
  effectiveDefaultExtensions,
  effectiveDispatchEnabled,
  effectiveProviders,
  type EnabledSource,
  type ExtensionsSource,
  type ProvidersSource,
  type SessionSettingsPatch,
  type SessionSettingsView,
  type SessionSettingsWriter,
} from "./session-settings.js";
import { DISPATCHER_KINDS } from "./types.js";
import type { AgentProvider, Backend } from "./types.js";

const log = createLogger("qwen-settings-page");

/** Header the page's script sends the token in for `/api/*` calls. */
export const SETTINGS_TOKEN_HEADER = "x-settings-token";

const MAX_BODY_BYTES = 64 * 1024;
/** At most one WARN per rejection reason per window; the rest are counted. */
const REJECT_LOG_WINDOW_MS = 5_000;
const MAX_PROVIDERS = 16;
const MAX_EXTENSIONS = 64;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ── types ────────────────────────────────────────────────────────────────────

/** One pool backend as the page shows it. `suitable` = a text-modality backend,
 *  i.e. one the page offers as a coding provider. */
export interface SettingsBackendRow {
  id: string;
  healthy: boolean | null;
  tier: string;
  capacity: string;
  roles: string[];
  modality: string;
  suitable: boolean;
}

export interface SettingsProviderRow {
  id: string;
  agentKind: string | null;
  backend: string | null;
}

/** The read-only JSON served by `GET /api/state` and returned by `qwen_settings`. */
export interface SettingsState {
  dispatchEnabled: boolean;
  enabledSource: EnabledSource;
  providers: SettingsProviderRow[];
  providersSource: ProvidersSource;
  /** `null` = leave the CLI defaults. */
  defaultExtensions: string[] | null;
  extensionsSource: ExtensionsSource;
  backends: SettingsBackendRow[];
  installedExtensions?: string[];
  /** What the launch environment says, regardless of the page. */
  env: {
    QWEN_DISPATCH_ENABLE: string | null;
    QWEN_AGENT_PROVIDERS: "set" | "unset";
    QWEN_DEFAULT_EXTENSIONS: string | null;
  };
}

export interface SettingsPageDeps {
  view: SessionSettingsView;
  /** Held by this module only. See the file header. */
  writer: SessionSettingsWriter;
  env?: NodeJS.ProcessEnv;
  /** The env/config providers (`loadAgentProviders`), for display and fallback. */
  loadProviders: () => AgentProvider[];
  /** The current pool, with health. Also the set a provider's `backend` must be in. */
  listBackends: () => Promise<SettingsBackendRow[]>;
  /** Installed extension names, when the supervisor can list them cheaply. */
  installedExtensions?: () => string[];
  /** Server factory; defaults to `http.createServer`. A seam for tests (e.g. a
   *  server whose listen fails), not a way to change where the page binds. */
  createServer?: (listener: RequestListener) => Server;
  /** Clock for the rejected-request log rate limit; defaults to `Date.now`. */
  now?: () => number;
}

export interface SettingsPage {
  /** Start the server on first call; the URL carries the token. Rejects once closed. */
  url(): Promise<string>;
  state(): Promise<SettingsState>;
  /** The listening address, or undefined when not started / closed. */
  address(): AddressInfo | undefined;
  close(): Promise<void>;
}

// ── request validation ──────────────────────────────────────────────────────

const providerSchema = z.strictObject({
  id: z.string().regex(ID_PATTERN),
  agentKind: z.enum(DISPATCHER_KINDS),
  backend: z.string().min(1).max(128),
});

const patchSchema = z.strictObject({
  dispatchEnabled: z.boolean().nullable().optional(),
  providers: z.array(providerSchema).max(MAX_PROVIDERS).nullable().optional(),
  defaultExtensions: z.array(z.string().regex(EXTENSION_PATTERN)).max(MAX_EXTENSIONS).nullable().optional(),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string = reason,
  ) {
    super(message);
  }
}

// ── the server ──────────────────────────────────────────────────────────────

export function createSettingsPage(deps: SettingsPageDeps): SettingsPage {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const makeServer = deps.createServer ?? ((listener: RequestListener) => createServer(listener));
  let server: Server | undefined;
  let starting: Promise<string> | undefined;
  let closed = false;
  // reason -> last time it was logged, and how many were dropped since.
  const rejectLog = new Map<string, { last: number; suppressed: number }>();
  let token = "";
  let tokenDigest: Buffer = Buffer.alloc(0);
  let port = 0;

  const tokenOk = (presented: string | undefined): boolean => {
    if (presented === undefined || presented === "") return false;
    // Hash both sides so the comparison is over equal-length buffers.
    const a = createHash("sha256").update(presented).digest();
    return timingSafeEqual(a, tokenDigest);
  };

  async function buildState(): Promise<SettingsState> {
    const en = effectiveDispatchEnabled(deps.view, env);
    const pr = effectiveProviders(deps.view, deps.loadProviders, env);
    const ex = effectiveDefaultExtensions(deps.view, env);
    const state: SettingsState = {
      dispatchEnabled: en.enabled,
      enabledSource: en.source,
      providers: pr.providers.map((p) => ({
        id: p.id,
        agentKind: p.agentKind ?? null,
        backend: p.backend ?? null,
      })),
      providersSource: pr.source,
      defaultExtensions: ex.value === "leave-defaults" ? null : ex.value,
      extensionsSource: ex.source,
      backends: await deps.listBackends(),
      env: {
        QWEN_DISPATCH_ENABLE: env["QWEN_DISPATCH_ENABLE"] ?? null,
        QWEN_AGENT_PROVIDERS:
          env["QWEN_AGENT_PROVIDERS"] !== undefined && env["QWEN_AGENT_PROVIDERS"].trim() !== "" ? "set" : "unset",
        QWEN_DEFAULT_EXTENSIONS: env["QWEN_DEFAULT_EXTENSIONS"] ?? null,
      },
    };
    if (deps.installedExtensions !== undefined) state.installedExtensions = deps.installedExtensions();
    return state;
  }

  /** Validate a POST body against the pool and the installed extensions, and
   *  turn it into a settings patch. Throws HttpError(400). */
  async function toPatch(body: unknown): Promise<SessionSettingsPatch> {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(400, "invalid_body", `invalid body: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
    }
    const p = parsed.data;
    const patch: SessionSettingsPatch = {};
    if (p.dispatchEnabled !== undefined) patch.dispatchEnabled = p.dispatchEnabled;

    if (p.providers !== undefined) {
      if (p.providers === null) {
        patch.providers = null;
      } else {
        const rows = await deps.listBackends();
        const pool = new Set(rows.map((b) => b.id));
        const suitable = new Set(rows.filter((b) => b.suitable).map((b) => b.id));
        const seen = new Set<string>();
        const out: AgentProvider[] = [];
        for (const prov of p.providers) {
          if (seen.has(prov.id)) {
            throw new HttpError(400, "duplicate_provider_id", `duplicate provider id "${prov.id}"`);
          }
          seen.add(prov.id);
          if (!pool.has(prov.backend)) {
            throw new HttpError(
              400,
              "unknown_backend",
              `provider "${prov.id}" names backend "${prov.backend}", which is not in the pool [${[...pool].join(", ")}]`,
            );
          }
          // The page only offers suitable backends; enforce it here too, so a
          // hand-built POST cannot pin dispatch to an embedding/rerank/vision-only one.
          if (!suitable.has(prov.backend)) {
            throw new HttpError(
              400,
              "unsuitable_backend",
              `provider "${prov.id}" names backend "${prov.backend}", which is not a text coding backend (embedding, rerank, multimodal and vision_only backends are refused)`,
            );
          }
          out.push({
            id: prov.id,
            kind: "agent-cli",
            agentKind: prov.agentKind,
            modalities: ["text"],
            excludes: [],
            backend: prov.backend,
          });
        }
        patch.providers = out;
      }
    }

    if (p.defaultExtensions !== undefined) {
      if (p.defaultExtensions === null) {
        patch.defaultExtensions = null;
      } else {
        const names = [...new Set(p.defaultExtensions.map((n) => n.toLowerCase()))];
        if (deps.installedExtensions !== undefined) {
          const installed = new Set(deps.installedExtensions().map((n) => n.toLowerCase()));
          const unknown = names.filter((n) => !installed.has(n));
          if (unknown.length > 0) {
            throw new HttpError(400, "unknown_extension", `extension(s) not installed: ${unknown.join(", ")}`);
          }
        }
        patch.defaultExtensions = names;
      }
    }
    return patch;
  }

  async function applyPatch(patch: SessionSettingsPatch): Promise<void> {
    // THE ONLY CALL SITE of writer.apply in the supervisor. Reached only from
    // the authenticated, origin-checked POST route. Do not add another one, and
    // do not route a tool or env var here (see the file header).
    const before = deps.view.get();
    const after = deps.writer.apply(patch);
    const changes: Record<string, unknown> = {};
    if (before.dispatchEnabled !== after.dispatchEnabled) {
      changes["dispatchEnabled"] = { from: before.dispatchEnabled ?? null, to: after.dispatchEnabled ?? null };
    }
    const ids = (ps: readonly AgentProvider[] | undefined) => (ps ?? []).map((x) => `${x.id}->${x.backend ?? ""}`);
    if (JSON.stringify(ids(before.providers)) !== JSON.stringify(ids(after.providers))) {
      changes["providers"] = { from: ids(before.providers), to: ids(after.providers) };
    }
    if (JSON.stringify(before.defaultExtensions ?? null) !== JSON.stringify(after.defaultExtensions ?? null)) {
      changes["defaultExtensions"] = { from: before.defaultExtensions ?? null, to: after.defaultExtensions ?? null };
    }
    log.info({ event_type: "settings_changed", changes }, "session settings changed from the settings page");
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────────

  const securityHeaders = (nonce?: string): Record<string, string> => ({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      nonce === undefined
        ? "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });

  function send(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    nonce?: string,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
      ...securityHeaders(nonce),
      ...extra,
    });
    res.end(body);
  }

  const sendJson = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value), undefined, extra);

  function reject(res: ServerResponse, req: IncomingMessage, status: number, reason: string, message?: string): void {
    // Path only: the query string of `GET /` carries the token.
    let path = "?";
    try {
      path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      /* keep "?" */
    }
    // Rate-limited per reason so a local process hammering the port cannot
    // grow the log without bound. The next line after a window carries the
    // count that was dropped.
    const t = now();
    const entry = rejectLog.get(reason);
    if (entry === undefined || t - entry.last >= REJECT_LOG_WINDOW_MS) {
      log.warn(
        {
          event_type: "settings_request_rejected",
          reason,
          status,
          method: req.method,
          path,
          ...(entry !== undefined && entry.suppressed > 0 ? { suppressed: entry.suppressed } : {}),
        },
        "settings page request rejected",
      );
      rejectLog.set(reason, { last: t, suppressed: 0 });
    } else {
      entry.suppressed++;
    }
    // Auth failures disclose nothing: a fixed body, whatever the cause.
    const text = status === 403 ? "forbidden" : (message ?? reason);
    send(res, status, "application/json; charset=utf-8", JSON.stringify({ error: text }));
  }

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject_) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        reject_(new HttpError(413, "body_too_large"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          chunks.length = 0;
          // Stop reading: pause, do not drain. The client's upload backs up
          // in the kernel buffers instead of being consumed.
          req.removeAllListeners("data");
          req.pause();
          reject_(new HttpError(413, "body_too_large"));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", (e) => reject_(e));
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reject(res, req, 403, "bad_host");
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${host}`);
    } catch {
      return reject(res, req, 403, "bad_url");
    }
    const isPage = url.pathname === "/";
    const presented = isPage
      ? (url.searchParams.get("t") ?? undefined)
      : (req.headers[SETTINGS_TOKEN_HEADER] as string | undefined);
    if (!tokenOk(presented)) return reject(res, req, 403, "bad_token");

    const method = req.method ?? "GET";
    if (isPage) {
      if (method !== "GET") return reject(res, req, 405, "method_not_allowed");
      const nonce = randomBytes(16).toString("base64url");
      return send(res, 200, "text/html; charset=utf-8", renderPage(nonce), nonce);
    }
    if (url.pathname !== "/api/state") return reject(res, req, 404, "not_found");

    if (method === "GET") return sendJson(res, 200, await buildState());
    if (method !== "POST") return reject(res, req, 405, "method_not_allowed");

    // State-changing request.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) return reject(res, req, 403, "bad_origin");
    const ct = req.headers["content-type"];
    if (ct === undefined || !/^application\/json\s*(;|$)/i.test(ct)) {
      return reject(res, req, 415, "unsupported_media_type");
    }
    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBody(req);
    } catch (err) {
      if (err instanceof HttpError) {
        reject(res, req, err.status, err.reason);
        // Do not keep reading an oversized upload: drop the connection once the
        // 413 is out.
        res.once("finish", () => req.destroy());
        return;
      }
      throw err;
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyBuf.toString("utf8"));
    } catch {
      return reject(res, req, 400, "invalid_json", "body is not valid JSON");
    }
    try {
      await applyPatch(await toPatch(body));
    } catch (err) {
      if (err instanceof HttpError) return reject(res, req, err.status, err.reason, err.message);
      throw err;
    }
    return sendJson(res, 200, await buildState());
  }

  function start(): Promise<string> {
    if (closed) return Promise.reject(new Error("settings page is closed"));
    if (starting !== undefined) return starting;
    const attempt = new Promise<string>((resolve, reject_) => {
      token = randomBytes(32).toString("base64url");
      tokenDigest = createHash("sha256").update(token).digest();
      const srv = makeServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
          log.error(
            { event_type: "settings_request_error", error: err instanceof Error ? err.message : String(err) },
            "settings page request failed",
          );
          if (!res.headersSent) send(res, 500, "application/json; charset=utf-8", JSON.stringify({ error: "internal" }));
          else res.end();
        });
      });
      const onStartError = (err: Error): void => {
        srv.close();
        reject_(err);
      };
      srv.once("error", onStartError);
      // 127.0.0.1 only; never 0.0.0.0. Port 0 = OS-assigned.
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", onStartError);
        // Once listening, a server-level error is logged, never thrown: an
        // unhandled 'error' event would take the whole supervisor down.
        srv.on("error", (err: Error) => {
          log.error({ event_type: "settings_server_error", error: err.message }, "settings page server error");
        });
        if (closed) {
          // close() ran between listen() and this callback.
          srv.close();
          reject_(new Error("settings page is closed"));
          return;
        }
        server = srv;
        port = (srv.address() as AddressInfo).port;
        log.info({ event_type: "settings_page_started", port, host: "127.0.0.1" }, "settings page listening");
        resolve(`http://127.0.0.1:${port}/?t=${token}`);
      });
    });
    starting = attempt;
    // A failed start must not stay cached: the next call tries again.
    attempt.catch(() => {
      if (starting === attempt) starting = undefined;
    });
    return attempt;
  }

  return {
    url: start,
    state: buildState,
    address(): AddressInfo | undefined {
      const addr = server?.address();
      return addr !== null && typeof addr === "object" ? addr : undefined;
    },
    async close(): Promise<void> {
      closed = true;
      // A start still waiting for listen(): its callback sees `closed`, closes
      // the server and rejects. Wait for that so no listener outlives close().
      if (server === undefined && starting !== undefined) await starting.catch(() => undefined);
      const srv = server;
      server = undefined;
      starting = undefined;
      if (srv === undefined) return;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
      log.info({ event_type: "settings_page_closed" }, "settings page closed");
    },
  };
}

/**
 * Project the pool into the rows the page shows. `suitable` marks the backends
 * offered as coding providers: text modality (unset counts as text) and not
 * `vision_only`.
 */
export async function toSettingsBackendRows(
  backends: readonly Backend[],
  health: (b: Backend) => Promise<boolean | null>,
): Promise<SettingsBackendRow[]> {
  return Promise.all(
    backends.map(async (b) => ({
      id: b.id,
      healthy: await health(b),
      tier: b.tier,
      capacity: b.capacity,
      roles: b.roles ?? [],
      modality: b.modality ?? "text",
      suitable: (b.modality === undefined || b.modality === "text") && b.vision_only !== true,
    })),
  );
}

// ── MCP tool ────────────────────────────────────────────────────────────────

/**
 * Register `qwen_settings`: returns `{url, state}` and nothing else. Takes no
 * input and has no access to the settings writer, so it cannot enable dispatch
 * or change any setting whatever it is called with. The URL (with its token) is
 * for the assistant to open in the HUMAN's browser.
 */
export function registerSettingsTool(mcpServer: Pick<McpServer, "tool">, page: SettingsPage): void {
  mcpServer.tool(
    "qwen_settings",
    "Read-only. Returns {url, state}: the URL of this session's human-operated settings page (it carries a one-time access token) and the current effective settings. Open the URL in the user's browser (`open <url>`) so THEY can opt this session in to qwen_dispatch, pick providers and a default extension loadout. This tool cannot change any setting; do not fetch or POST to the URL yourself.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      const url = await page.url();
      const state = await page.state();
      return { content: [{ type: "text" as const, text: JSON.stringify({ url, state }) }] };
    },
  );
}

// ── the page ────────────────────────────────────────────────────────────────

function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qwen-stack session settings</title>
<style nonce="${nonce}">
  body { font: 15px/1.45 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1b1b1b; background: #fafafa; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.6rem; border-bottom: 1px solid #ccc; padding-bottom: .2rem; }
  .note { background: #fff6dc; border: 1px solid #e2cf8f; padding: .6rem .8rem; border-radius: 4px; }
  .muted { color: #666; } .ok { color: #0a6b2d; } .bad { color: #a31515; } .unk { color: #8a6d00; }
  label { display: block; margin: .25rem 0; } table { border-collapse: collapse; } td, th { padding: .15rem .8rem .15rem 0; text-align: left; }
  button { font: inherit; padding: .35rem .9rem; margin-top: 1rem; } #status { margin-left: .8rem; }
  code { background: #eee; padding: 0 .25rem; border-radius: 3px; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #181818; } .note { background: #3a3220; border-color: #6b5a2a; } code { background: #2a2a2a; } .muted { color: #999; } }
</style>
</head>
<body>
<h1>qwen-stack session settings</h1>
<p class="note">These settings apply to <strong>this session only</strong>. They are held in memory by this session's supervisor process and are lost when it restarts. Nothing is written to <code>config.json</code> or any other file. The access token has been removed from the address bar; to reload this page, ask for the link again.</p>

<h2>Dispatch</h2>
<label for="enabled">qwen_dispatch in this session:
  <select id="enabled">
    <option value="env">use the launch environment</option>
    <option value="on">on</option>
    <option value="off">off</option>
  </select>
</label>
<p class="muted" id="enabledNote"></p>

<h2>Providers</h2>
<p class="muted">A provider runs a dispatched task on one pinned backend. Tick the backends this session may dispatch to. None ticked uses the providers from the environment or config file.</p>
<div id="providers"></div>
<p class="muted" id="providersNote"></p>

<h2>Default extensions</h2>
<label><input type="checkbox" id="leaveDefaults"> Leave defaults (the environment, config file, or the CLI's own set)</label>
<div id="extensions"></div>
<p class="muted" id="extensionsNote"></p>

<button id="save" type="button">Save</button><span id="status" role="status"></span>

<h2>Backends (live)</h2>
<table id="health"><tbody></tbody></table>

<h2>Launch environment</h2>
<table id="env"><tbody></tbody></table>

<script nonce="${nonce}">
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  history.replaceState(null, "", "/");
  var TOKEN_HEADER = ${JSON.stringify(SETTINGS_TOKEN_HEADER)};
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function api(method, body) {
    var headers = {};
    headers[TOKEN_HEADER] = token;
    var init = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    return fetch("/api/state", init).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
        if (!r.ok) throw new Error((j && j.error) ? j.error : ("HTTP " + r.status));
        return j;
      });
    });
  }

  function healthCell(h) {
    if (h === true) return el("span", "healthy", "ok");
    if (h === false) return el("span", "unhealthy", "bad");
    return el("span", "not probed yet", "unk");
  }

  function renderHealth(s) {
    var body = $("health").tBodies[0];
    clear(body);
    var head = el("tr");
    ["backend", "health", "tier", "capacity", "modality", "roles"].forEach(function (h) { head.appendChild(el("th", h)); });
    body.appendChild(head);
    s.backends.forEach(function (b) {
      var tr = el("tr");
      tr.appendChild(el("td", b.id));
      var td = el("td"); td.appendChild(healthCell(b.healthy)); tr.appendChild(td);
      tr.appendChild(el("td", b.tier));
      tr.appendChild(el("td", b.capacity));
      tr.appendChild(el("td", b.modality));
      tr.appendChild(el("td", (b.roles || []).join(", ") || "-"));
      body.appendChild(tr);
    });
  }

  function renderEnv(s) {
    var body = $("env").tBodies[0];
    clear(body);
    [["QWEN_DISPATCH_ENABLE", s.env.QWEN_DISPATCH_ENABLE === null ? "(unset)" : s.env.QWEN_DISPATCH_ENABLE],
     ["QWEN_AGENT_PROVIDERS", s.env.QWEN_AGENT_PROVIDERS === "set" ? "(set)" : "(unset)"],
     ["QWEN_DEFAULT_EXTENSIONS", s.env.QWEN_DEFAULT_EXTENSIONS === null ? "(unset)" : s.env.QWEN_DEFAULT_EXTENSIONS]
    ].forEach(function (row) {
      var tr = el("tr"); tr.appendChild(el("td", row[0])); tr.appendChild(el("td", row[1])); body.appendChild(tr);
    });
  }

  // Form state is rendered once per load/save, not on the health poll, so an
  // edit in progress is never overwritten.
  function renderForm(s) {
    $("enabled").value = s.enabledSource === "page" ? (s.dispatchEnabled ? "on" : "off") : "env";
    $("enabledNote").textContent = "Currently " + (s.dispatchEnabled ? "on" : "off") + " (source: " + s.enabledSource + ").";

    var pageProviders = s.providersSource === "page" ? s.providers : [];
    var chosen = {};
    pageProviders.forEach(function (p) { if (p.backend) chosen[p.backend] = true; });
    var box = $("providers"); clear(box);
    var offered = s.backends.filter(function (b) { return b.suitable; });
    if (offered.length === 0) box.appendChild(el("p", "No text backend in the pool.", "muted"));
    offered.forEach(function (b) {
      var label = el("label");
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.value = b.id; cb.checked = !!chosen[b.id]; cb.className = "provider";
      label.appendChild(cb);
      label.appendChild(document.createTextNode(" " + b.id + " "));
      label.appendChild(el("span", "(" + b.tier + ", " + b.capacity + ")", "muted"));
      box.appendChild(label);
    });
    var names = s.providers.map(function (p) { return p.id + (p.backend ? " -> " + p.backend : " (unpinned)"); });
    $("providersNote").textContent = "Currently: " + (names.length ? names.join(", ") : "none") + " (source: " + s.providersSource + ").";

    var installed = s.installedExtensions;
    var pageExt = s.extensionsSource === "page" ? (s.defaultExtensions || []) : [];
    $("leaveDefaults").checked = pageExt.length === 0;
    var ebox = $("extensions"); clear(ebox);
    if (installed) {
      installed.forEach(function (name) {
        var label = el("label");
        var cb = document.createElement("input");
        cb.type = "checkbox"; cb.value = name; cb.className = "extension";
        cb.checked = pageExt.indexOf(name.toLowerCase()) !== -1;
        // Ticking an extension means "not the defaults"; collect() ignores the ticks otherwise.
        cb.addEventListener("change", function () { if (cb.checked) $("leaveDefaults").checked = false; });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + name));
        ebox.appendChild(label);
      });
    } else {
      var input = document.createElement("input");
      input.type = "text"; input.id = "extText"; input.value = pageExt.join(","); input.size = 40;
      input.addEventListener("input", function () { if (input.value.trim()) $("leaveDefaults").checked = false; });
      ebox.appendChild(el("p", "Comma-separated extension names:", "muted"));
      ebox.appendChild(input);
    }
    $("extensionsNote").textContent = "Currently: " + (s.defaultExtensions ? s.defaultExtensions.join(", ") : "CLI defaults") + " (source: " + s.extensionsSource + ").";
  }

  // And the other way round: choosing the defaults clears whatever was ticked.
  $("leaveDefaults").addEventListener("change", function () {
    if (!$("leaveDefaults").checked) return;
    Array.prototype.forEach.call(document.querySelectorAll("input.extension"), function (cb) { cb.checked = false; });
    var t = $("extText"); if (t) t.value = "";
  });

  function render(s) { renderForm(s); renderHealth(s); renderEnv(s); }

  function collect() {
    var mode = $("enabled").value;
    var providers = [];
    Array.prototype.forEach.call(document.querySelectorAll("input.provider"), function (cb) {
      if (cb.checked) providers.push({ id: cb.value, agentKind: "qwen-local", backend: cb.value });
    });
    var exts = [];
    if (!$("leaveDefaults").checked) {
      Array.prototype.forEach.call(document.querySelectorAll("input.extension"), function (cb) { if (cb.checked) exts.push(cb.value); });
      var t = $("extText");
      if (t) t.value.split(",").forEach(function (n) { n = n.trim(); if (n) exts.push(n); });
    }
    return {
      dispatchEnabled: mode === "env" ? null : mode === "on",
      providers: providers.length ? providers : null,
      defaultExtensions: exts.length ? exts : null
    };
  }

  function setStatus(msg, cls) { var s = $("status"); s.textContent = msg; s.className = cls || ""; }

  $("save").addEventListener("click", function () {
    setStatus("saving...", "muted");
    api("POST", collect()).then(function (s) { render(s); setStatus("saved", "ok"); })
      .catch(function (e) { setStatus("not saved: " + e.message, "bad"); });
  });

  api("GET").then(render).catch(function (e) { setStatus("could not load: " + e.message, "bad"); });
  setInterval(function () {
    api("GET").then(function (s) { renderHealth(s); }).catch(function () { /* next tick */ });
  }, 10000);
})();
</script>
</body>
</html>
`;
}
