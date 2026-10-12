// SPDX-License-Identifier: MIT
//
// Tests for src/settings-page.ts — the human-operated, loopback-only settings
// server and the read-only `qwen_settings` MCP tool (bead
// qwen-coprocessor-stack-9sm2). Real HTTP against the real server on port 0;
// no mocks of `http`. Requests go through node:http so the Host and Origin
// headers can be set (fetch forbids both).

import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionSettings, type SessionSettings } from "../src/session-settings.js";
import {
  createSettingsPage,
  registerSettingsTool,
  SETTINGS_TOKEN_HEADER,
  toSettingsBackendRows,
  type SettingsBackendRow,
  type SettingsPage,
} from "../src/settings-page.js";
import type { AgentProvider, Backend } from "../src/types.js";

// Capture every structured log line so tests can assert on events and prove the
// token is never logged.
const logCapture = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock("../src/log.js", () => {
  const make = () => {
    const rec = (...args: unknown[]) => {
      logCapture.lines.push(args);
    };
    return { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec, child: () => make() };
  };
  return { createLogger: () => make() };
});

const BACKENDS: SettingsBackendRow[] = [
  { id: "coder-box", healthy: true, tier: "remote", capacity: "heavy", roles: ["code"], modality: "text", suitable: true },
  { id: "coder-mac", healthy: false, tier: "local", capacity: "heavy", roles: ["code"], modality: "text", suitable: true },
  { id: "vision-mac", healthy: true, tier: "local", capacity: "heavy", roles: [], modality: "multimodal", suitable: false },
];
const INSTALLED = ["qwen-toolkit", "other-ext"];

interface Harness {
  settings: SessionSettings;
  page: SettingsPage;
  url: URL;
  port: number;
  token: string;
}

const open: SettingsPage[] = [];

async function harness(
  opts: { env?: NodeJS.ProcessEnv; envProviders?: AgentProvider[]; now?: () => number } = {},
): Promise<Harness> {
  const settings = createSessionSettings();
  const page = createSettingsPage({
    view: settings.view,
    writer: settings.writer,
    env: opts.env ?? {},
    loadProviders: () => opts.envProviders ?? [],
    listBackends: async () => BACKENDS,
    installedExtensions: () => INSTALLED,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  open.push(page);
  const url = new URL(await page.url());
  return { settings, page, url, port: Number(url.port), token: url.searchParams.get("t") ?? "" };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
  logCapture.lines.length = 0;
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      // agent:false = a fresh connection per request (no keep-alive reuse), so
      // a closed server shows up as ECONNREFUSED rather than a reset socket.
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const api = (h: Harness, headers: Record<string, string> = {}) => ({
  [SETTINGS_TOKEN_HEADER]: h.token,
  ...headers,
});

const postJson = (h: Harness, body: unknown, headers: Record<string, string> = {}) =>
  raw(h.port, {
    method: "POST",
    path: "/api/state",
    headers: { ...api(h), "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const untouched = (h: Harness) =>
  expect(h.settings.view.get()).toEqual({
    dispatchEnabled: undefined,
    providers: undefined,
    defaultExtensions: undefined,
  });

describe("toSettingsBackendRows", () => {
  const b = (o: Partial<Backend> & { id: string }): Backend => ({
    url: "http://x/v1",
    model: "m",
    tier: "local",
    capacity: "heavy",
    ...o,
  });

  it("offers text (or unset) backends and withholds multimodal-vision-only, embedding and rerank", async () => {
    const rows = await toSettingsBackendRows(
      [
        b({ id: "t-unset" }),
        b({ id: "t-text", modality: "text", roles: ["code"] }),
        b({ id: "mm", modality: "multimodal" }),
        b({ id: "mm-vision", modality: "multimodal", vision_only: true }),
        b({ id: "emb", modality: "embedding" }),
        b({ id: "rr", modality: "rerank" }),
      ],
      async (x) => (x.id === "t-text" ? true : null),
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.suitable]))).toEqual({
      "t-unset": true,
      "t-text": true,
      mm: false,
      "mm-vision": false,
      emb: false,
      rr: false,
    });
    const t = rows.find((r) => r.id === "t-text")!;
    expect(t).toMatchObject({ healthy: true, tier: "local", capacity: "heavy", roles: ["code"], modality: "text" });
    expect(rows.find((r) => r.id === "t-unset")).toMatchObject({ healthy: null, roles: [], modality: "text" });
  });
});

describe("listen lifecycle", () => {
  const baseDeps = () => {
    const settings = createSessionSettings();
    return {
      view: settings.view,
      writer: settings.writer,
      env: {} as NodeJS.ProcessEnv,
      loadProviders: () => [] as AgentProvider[],
      listBackends: async () => BACKENDS,
    };
  };

  it("a failed first start does not poison later calls: the second url() succeeds", async () => {
    const servers: Server[] = [];
    const page = createSettingsPage({
      ...baseDeps(),
      createServer: (listener) => {
        const s = createServer(listener);
        servers.push(s);
        if (servers.length === 1) {
          // A real server whose listen() fails, the way EADDRINUSE would.
          s.listen = (() => {
            queueMicrotask(() => s.emit("error", new Error("listen EADDRINUSE (injected)")));
            return s;
          }) as typeof s.listen;
        }
        return s;
      },
    });
    open.push(page);
    await expect(page.url()).rejects.toThrow(/EADDRINUSE/);
    expect(servers[0]!.listening).toBe(false);
    const url = new URL(await page.url());
    expect(servers).toHaveLength(2);
    const res = await raw(Number(url.port), { path: `/?t=${url.searchParams.get("t")}` });
    expect(res.status).toBe(200);
  });

  it("close() between listen() and its callback leaves no listener and rejects url()", async () => {
    const servers: Server[] = [];
    const page = createSettingsPage({
      ...baseDeps(),
      createServer: (listener) => {
        const s = createServer(listener);
        servers.push(s);
        return s;
      },
    });
    const started = page.url();
    const settled = expect(started).rejects.toThrow(/closed/);
    await page.close();
    await settled;
    expect(servers).toHaveLength(1);
    expect(servers[0]!.listening).toBe(false);
    expect(page.address()).toBeUndefined();
    await expect(page.url()).rejects.toThrow(/closed/);
  });

  it("two concurrent first url() calls return the same URL and start one server", async () => {
    let created = 0;
    const page = createSettingsPage({
      ...baseDeps(),
      createServer: (listener) => {
        created++;
        return createServer(listener);
      },
    });
    open.push(page);
    const [a, b] = await Promise.all([page.url(), page.url()]);
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  it("a server-level error after start is logged, not thrown", async () => {
    const servers: Server[] = [];
    const page = createSettingsPage({
      ...baseDeps(),
      createServer: (listener) => {
        const s = createServer(listener);
        servers.push(s);
        return s;
      },
    });
    open.push(page);
    await page.url();
    expect(() => servers[0]!.emit("error", new Error("late server error"))).not.toThrow();
    expect(JSON.stringify(logCapture.lines)).toContain("settings_server_error");
    expect(JSON.stringify(logCapture.lines)).toContain("late server error");
  });
});

describe("rejected-request log rate limit", () => {
  const rejectedLines = () =>
    logCapture.lines.filter((l) => JSON.stringify(l).includes("settings_request_rejected"));

  it("logs at most one WARN per reason per window, then reports the suppressed count", async () => {
    let t = 1_000_000;
    const h = await harness({ now: () => t });
    for (let i = 0; i < 50; i++) await raw(h.port, { path: "/?t=nope" });
    expect(rejectedLines()).toHaveLength(1);

    // A different reason has its own budget.
    await raw(h.port, { path: `/?t=${h.token}`, headers: { Host: "evil.example" } });
    expect(rejectedLines()).toHaveLength(2);

    t += 10_000;
    await raw(h.port, { path: "/?t=nope" });
    const lines = rejectedLines();
    expect(lines).toHaveLength(3);
    const last = JSON.stringify(lines[2]);
    expect(last).toContain("bad_token");
    expect(last).toContain('"suppressed":49');
  });
});

describe("body cap on a declared length", () => {
  it("an oversized Content-Length is refused with 413 before any of the body arrives", async () => {
    const h = await harness();
    // Declares 10 MiB, sends 10 bytes and stops. Only the header check can
    // answer; the streaming counter never sees enough bytes to trip.
    const status = await new Promise<number | undefined>((resolve) => {
      let got: number | undefined;
      const req = request({
        host: "127.0.0.1",
        port: h.port,
        method: "POST",
        path: "/api/state",
        agent: false,
        headers: {
          [SETTINGS_TOKEN_HEADER]: h.token,
          "Content-Type": "application/json",
          "Content-Length": String(10 * 1024 * 1024),
        },
      });
      const timer = setTimeout(() => {
        req.destroy();
        resolve(got);
      }, 3000);
      req.on("response", (res) => {
        got = res.statusCode;
        res.resume();
        clearTimeout(timer);
        req.destroy();
        resolve(got);
      });
      req.on("error", () => {});
      req.write("0123456789");
    });
    expect(status).toBe(413);
    untouched(h);
  });
});

describe("body cap while streaming", () => {
  it("a chunked upload with no Content-Length over the cap gets 413 and the connection is dropped without the upload finishing", async () => {
    const h = await harness();
    // Exactly one byte over the cap, in a single write, and then NO more
    // bytes and no end of body. With no Content-Length the declared-length
    // check cannot fire; only the streaming counter can answer. (If the
    // counter were absent the server would sit waiting for the rest of the
    // body and the timeout below would win.)
    const out = await new Promise<{ status: number | undefined; closed: boolean }>((resolve) => {
      let status: number | undefined;
      const req = request({
        host: "127.0.0.1",
        port: h.port,
        method: "POST",
        path: "/api/state",
        agent: false,
        headers: { [SETTINGS_TOKEN_HEADER]: h.token, "Content-Type": "application/json" },
      });
      const timer = setTimeout(() => {
        req.destroy();
        resolve({ status, closed: false });
      }, 3000);
      req.on("response", (res) => {
        status = res.statusCode;
        res.resume();
      });
      req.on("error", () => {
        /* the server cutting the connection is expected */
      });
      // The server hung up on its own while the upload was still open.
      req.on("close", () => {
        clearTimeout(timer);
        resolve({ status, closed: true });
      });
      req.write(Buffer.alloc(64 * 1024 + 1, 0x61));
    });
    expect(out.status).toBe(413);
    expect(out.closed).toBe(true);
    untouched(h);
  });
});

describe("backend suitability is enforced on POST", () => {
  const mk = (o: Partial<Backend> & { id: string }): Backend => ({
    url: "http://x/v1",
    model: "m",
    tier: "local",
    capacity: "heavy",
    ...o,
  });
  const POOL: Backend[] = [
    mk({ id: "text-ok", modality: "text" }),
    mk({ id: "embed", modality: "embedding" }),
    mk({ id: "rerank", modality: "rerank" }),
    mk({ id: "vision-only", modality: "multimodal", vision_only: true }),
  ];

  it("accepts a text backend and rejects embedding, rerank and vision_only backends with 400", async () => {
    const settings = createSessionSettings();
    const page = createSettingsPage({
      view: settings.view,
      writer: settings.writer,
      env: {},
      loadProviders: () => [],
      listBackends: () => toSettingsBackendRows(POOL, async () => true),
    });
    open.push(page);
    const url = new URL(await page.url());
    const post = (backend: string) =>
      raw(Number(url.port), {
        method: "POST",
        path: "/api/state",
        headers: { [SETTINGS_TOKEN_HEADER]: url.searchParams.get("t")!, "Content-Type": "application/json" },
        body: JSON.stringify({ providers: [{ id: "p", agentKind: "qwen-local", backend }] }),
      });
    for (const bad of ["embed", "rerank", "vision-only"]) {
      const res = await post(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body).toContain(bad);
    }
    expect(settings.view.get().providers).toBeUndefined();
    expect((await post("text-ok")).status).toBe(200);
    expect(settings.view.get().providers![0]!.backend).toBe("text-ok");
  });
});

describe("server start and binding", () => {
  it("does not listen until the URL is first asked for", async () => {
    const settings = createSessionSettings();
    const page = createSettingsPage({
      view: settings.view,
      writer: settings.writer,
      env: {},
      loadProviders: () => [],
      listBackends: async () => BACKENDS,
    });
    open.push(page);
    expect(page.address()).toBeUndefined();
    await page.url();
    expect(page.address()).toBeDefined();
  });

  it("binds 127.0.0.1 only, on an OS-assigned port", async () => {
    const h = await harness();
    const addr = h.page.address()!;
    expect(addr.address).toBe("127.0.0.1");
    expect(addr.family).toBe("IPv4");
    expect(addr.port).toBeGreaterThan(0);
    expect(h.url.hostname).toBe("127.0.0.1");
  });

  it("asking twice returns the same server and token", async () => {
    const h = await harness();
    expect(await h.page.url()).toBe(h.url.toString());
  });

  it("mints a >=128-bit token, different for every server", async () => {
    const a = await harness();
    const b = await harness();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(a.token).not.toBe(b.token);
  });

  it("logs the start with the port and never logs the token", async () => {
    const h = await harness();
    await raw(h.port, { path: "/?t=wrong-token-value" });
    await postJson(h, { dispatchEnabled: true });
    const all = JSON.stringify(logCapture.lines);
    expect(all).toContain("settings_page_started");
    expect(all).toContain(String(h.port));
    expect(all).not.toContain(h.token);
    expect(all).not.toContain("wrong-token-value");
  });
});

describe("token", () => {
  it("GET / without a token is 403 and discloses nothing", async () => {
    const h = await harness();
    const res = await raw(h.port, { path: "/" });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("coder-box");
    expect(res.body).not.toContain("<html");
  });

  it("GET / with a wrong token is 403", async () => {
    const h = await harness();
    expect((await raw(h.port, { path: "/?t=nope" })).status).toBe(403);
    expect((await raw(h.port, { path: `/?t=${h.token}x` })).status).toBe(403);
    expect((await raw(h.port, { path: `/?t=${h.token.slice(0, -1)}` })).status).toBe(403);
  });

  it("GET / with the right token is 200 HTML", async () => {
    const h = await harness();
    const res = await raw(h.port, { path: `/?t=${h.token}` });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/^text\/html/);
  });

  it("API routes need the token in the header: missing, wrong, and query-param all 403", async () => {
    const h = await harness();
    expect((await raw(h.port, { path: "/api/state" })).status).toBe(403);
    expect((await raw(h.port, { path: "/api/state", headers: { [SETTINGS_TOKEN_HEADER]: "bad" } })).status).toBe(403);
    expect((await raw(h.port, { path: `/api/state?t=${h.token}` })).status).toBe(403);
    const ok = await raw(h.port, { path: "/api/state", headers: api(h) });
    expect(ok.status).toBe(200);
  });

  it("an unknown path without a token is 403, not 404 (no route disclosure)", async () => {
    const h = await harness();
    expect((await raw(h.port, { path: "/etc/passwd" })).status).toBe(403);
  });

  it("POST with a wrong or missing token is 403 and changes nothing", async () => {
    const h = await harness();
    const body = JSON.stringify({ dispatchEnabled: true });
    const wrong = await raw(h.port, {
      method: "POST",
      path: "/api/state",
      headers: { [SETTINGS_TOKEN_HEADER]: "bad", "Content-Type": "application/json" },
      body,
    });
    const missing = await raw(h.port, {
      method: "POST",
      path: "/api/state",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(wrong.status).toBe(403);
    expect(missing.status).toBe(403);
    untouched(h);
  });

  it("rejected requests are logged with a reason", async () => {
    const h = await harness();
    await raw(h.port, { path: "/?t=nope" });
    const rejected = logCapture.lines.filter((l) => JSON.stringify(l).includes("settings_request_rejected"));
    expect(rejected.length).toBeGreaterThan(0);
    expect(JSON.stringify(rejected[0])).toContain("bad_token");
  });
});

describe("Host and Origin", () => {
  it("rejects a Host that is not 127.0.0.1:<port> or localhost:<port>", async () => {
    const h = await harness();
    for (const host of ["evil.example", `evil.example:${h.port}`, "127.0.0.1:1", `127.0.0.1.evil.example:${h.port}`, `[::1]:${h.port}`]) {
      const res = await raw(h.port, { path: `/?t=${h.token}`, headers: { Host: host } });
      expect(res.status, `Host ${host}`).toBe(403);
    }
    const viaApi = await raw(h.port, { path: "/api/state", headers: api(h, { Host: "evil.example" }) });
    expect(viaApi.status).toBe(403);
  });

  it("accepts localhost:<port> and 127.0.0.1:<port>", async () => {
    const h = await harness();
    for (const host of [`localhost:${h.port}`, `127.0.0.1:${h.port}`]) {
      const res = await raw(h.port, { path: `/?t=${h.token}`, headers: { Host: host } });
      expect(res.status, `Host ${host}`).toBe(200);
    }
  });

  it("a state change from a foreign Origin is 403 and changes nothing", async () => {
    const h = await harness();
    for (const origin of ["http://evil.example", "null", `http://127.0.0.1.evil.example:${h.port}`, `https://127.0.0.1:${h.port}`]) {
      const res = await postJson(h, { dispatchEnabled: true }, { Origin: origin });
      expect(res.status, `Origin ${origin}`).toBe(403);
    }
    untouched(h);
  });

  it("a state change from the server's own origin is accepted", async () => {
    const h = await harness();
    const res = await postJson(h, { dispatchEnabled: true }, { Origin: `http://127.0.0.1:${h.port}` });
    expect(res.status).toBe(200);
    expect(h.settings.view.get().dispatchEnabled).toBe(true);
  });
});

describe("POST /api/state validation", () => {
  it("accepts only POST with Content-Type application/json", async () => {
    const h = await harness();
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await postJson(h, { dispatchEnabled: true }, { "Content-Type": ct });
      expect(res.status, ct).toBe(415);
    }
    const noCt = await raw(h.port, {
      method: "POST",
      path: "/api/state",
      headers: api(h),
      body: JSON.stringify({ dispatchEnabled: true }),
    });
    expect(noCt.status).toBe(415);
    untouched(h);
  });

  it("accepts a charset parameter on application/json", async () => {
    const h = await harness();
    const res = await postJson(h, { dispatchEnabled: true }, { "Content-Type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });

  it("other methods on /api/state are 405", async () => {
    const h = await harness();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await raw(h.port, { method, path: "/api/state", headers: api(h) });
      expect(res.status, method).toBe(405);
    }
    untouched(h);
  });

  it("rejects an oversized body with 413 and changes nothing", async () => {
    const h = await harness();
    const big = JSON.stringify({ defaultExtensions: ["a"], pad: "x".repeat(70 * 1024) });
    const res = await postJson(h, big);
    expect(res.status).toBe(413);
    untouched(h);
  });

  it("rejects invalid JSON, non-object bodies, unknown keys and wrong types with 400", async () => {
    const h = await harness();
    const bad: unknown[] = [
      "{not json",
      "[]",
      "null",
      { unknownKey: 1 },
      { dispatchEnabled: true, extra: "x" },
      { dispatchEnabled: "yes" },
      { providers: "box" },
      { providers: [{ id: "a", agentKind: "qwen-local", backend: "coder-box", extra: 1 }] },
      { providers: [{ id: "a", agentKind: "claude-local", backend: "coder-box" }] },
      { providers: [{ id: "a", backend: "coder-box" }] },
      { providers: [{ id: "has space", agentKind: "qwen-local", backend: "coder-box" }] },
      { defaultExtensions: "qwen-toolkit" },
      { defaultExtensions: [1] },
    ];
    for (const b of bad) {
      const res = await postJson(h, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    untouched(h);
  });

  it("rejects a provider whose backend is not in the pool", async () => {
    const h = await harness();
    const res = await postJson(h, { providers: [{ id: "a", agentKind: "qwen-local", backend: "no-such-backend" }] });
    expect(res.status).toBe(400);
    expect(res.body).toContain("no-such-backend");
    untouched(h);
  });

  it("rejects duplicate provider ids", async () => {
    const h = await harness();
    const res = await postJson(h, {
      providers: [
        { id: "a", agentKind: "qwen-local", backend: "coder-box" },
        { id: "a", agentKind: "qwen-local", backend: "coder-mac" },
      ],
    });
    expect(res.status).toBe(400);
    untouched(h);
  });

  it("rejects extension names that do not match the conservative pattern or are not installed", async () => {
    const h = await harness();
    for (const bad of ["../etc", "a b", "a,b", "", "-lead", "x".repeat(65), "not-installed"]) {
      const res = await postJson(h, { defaultExtensions: [bad] });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    untouched(h);
  });

  it("GET requests never change state", async () => {
    const h = await harness();
    await raw(h.port, { path: `/?t=${h.token}` });
    await raw(h.port, { path: "/api/state", headers: api(h) });
    await raw(h.port, { path: `/?t=${h.token}&dispatchEnabled=true` });
    await raw(h.port, { path: "/api/state?dispatchEnabled=true", headers: api(h) });
    untouched(h);
  });

  it("an applied change updates the view, returns the new state, and is logged", async () => {
    const h = await harness();
    const res = await postJson(h, {
      dispatchEnabled: true,
      providers: [{ id: "box", agentKind: "qwen-local", backend: "coder-box" }],
      defaultExtensions: ["Qwen-Toolkit"],
    });
    expect(res.status).toBe(200);
    const state = JSON.parse(res.body);
    expect(state.dispatchEnabled).toBe(true);
    expect(state.enabledSource).toBe("page");
    expect(state.providersSource).toBe("page");
    expect(state.providers.map((p: { id: string }) => p.id)).toEqual(["box"]);
    expect(state.defaultExtensions).toEqual(["qwen-toolkit"]);
    expect(state.extensionsSource).toBe("page");

    const snap = h.settings.view.get();
    expect(snap.dispatchEnabled).toBe(true);
    expect(snap.providers![0]).toMatchObject({ id: "box", agentKind: "qwen-local", backend: "coder-box", kind: "agent-cli" });
    expect(snap.defaultExtensions).toEqual(["qwen-toolkit"]);

    const changed = logCapture.lines.filter((l) => JSON.stringify(l).includes("settings_changed"));
    expect(changed).toHaveLength(1);
  });

  it("null clears a field back to the env rule", async () => {
    const h = await harness({ env: { QWEN_DISPATCH_ENABLE: "1" } });
    await postJson(h, { dispatchEnabled: false });
    expect(JSON.parse((await raw(h.port, { path: "/api/state", headers: api(h) })).body).enabledSource).toBe("page");
    const res = await postJson(h, { dispatchEnabled: null });
    const state = JSON.parse(res.body);
    expect(state.dispatchEnabled).toBe(true);
    expect(state.enabledSource).toBe("env");
  });
});

describe("GET /api/state", () => {
  it("reports sources, backends, installed extensions and the env", async () => {
    const h = await harness({
      env: { QWEN_DISPATCH_ENABLE: "1", QWEN_DEFAULT_EXTENSIONS: "qwen-toolkit" },
      envProviders: [
        { id: "envp", kind: "agent-cli", agentKind: "qwen-local", modalities: ["text"], excludes: [], backend: "coder-box" },
      ],
    });
    const res = await raw(h.port, { path: "/api/state", headers: api(h) });
    expect(res.status).toBe(200);
    const s = JSON.parse(res.body);
    expect(s.dispatchEnabled).toBe(true);
    expect(s.enabledSource).toBe("env");
    expect(s.providers.map((p: { id: string }) => p.id)).toEqual(["envp"]);
    expect(s.defaultExtensions).toEqual(["qwen-toolkit"]);
    expect(s.extensionsSource).toBe("env");
    expect(s.backends.map((b: { id: string }) => b.id)).toEqual(["coder-box", "coder-mac", "vision-mac"]);
    expect(s.backends[0]).toMatchObject({ id: "coder-box", healthy: true, tier: "remote", capacity: "heavy", roles: ["code"] });
    expect(s.installedExtensions).toEqual(INSTALLED);
    expect(s.env.QWEN_DISPATCH_ENABLE).toBe("1");
  });

  it("with nothing set anywhere, dispatch is off", async () => {
    const h = await harness();
    const s = JSON.parse((await raw(h.port, { path: "/api/state", headers: api(h) })).body);
    expect(s.dispatchEnabled).toBe(false);
    expect(s.enabledSource).toBe("off");
    expect(s.providers).toEqual([]);
    expect(s.providersSource).toBe("none");
    expect(s.defaultExtensions).toBeNull();
  });
});

describe("response headers and page content", () => {
  const expectHardened = (res: Res) => {
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(res.headers["content-security-policy"])).toContain("default-src 'none'");
  };

  it("carries CSP, no-store, nosniff and no-referrer on the page, the API and the 403s", async () => {
    const h = await harness();
    expectHardened(await raw(h.port, { path: `/?t=${h.token}` }));
    expectHardened(await raw(h.port, { path: "/api/state", headers: api(h) }));
    expectHardened(await postJson(h, { dispatchEnabled: true }));
    expectHardened(await raw(h.port, { path: "/" }));
    expectHardened(await postJson(h, "{bad"));
  });

  it("the CSP allows script and style only through the per-response nonce", async () => {
    const h = await harness();
    const a = await raw(h.port, { path: `/?t=${h.token}` });
    const b = await raw(h.port, { path: `/?t=${h.token}` });
    const csp = String(a.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("connect-src 'self'");
    expect(a.body).toContain(`<script nonce="${nonce}">`);
    expect(a.body).toContain(`<style nonce="${nonce}">`);
    const nonceB = /script-src 'nonce-([^']+)'/.exec(String(b.headers["content-security-policy"]))?.[1];
    expect(nonceB).not.toBe(nonce);
  });

  it("the HTML is self-contained: no external URL, no src/href, no token", async () => {
    const h = await harness();
    const res = await raw(h.port, { path: `/?t=${h.token}` });
    expect(res.body).not.toMatch(/https?:\/\//i);
    expect(res.body).not.toMatch(/\bsrc\s*=/i);
    expect(res.body).not.toMatch(/\bhref\s*=/i);
    expect(res.body).not.toMatch(/<link\b/i);
    expect(res.body).not.toContain(h.token);
    // States the scope of the setting.
    expect(res.body).toMatch(/this session only/i);
    expect(res.body).toMatch(/restarts/i);
  });

  it("the script removes the token from the address bar right after reading it", async () => {
    const h = await harness();
    const res = await raw(h.port, { path: `/?t=${h.token}` });
    const read = res.body.indexOf('.get("t")');
    const scrub = res.body.indexOf('history.replaceState(null, "", "/")');
    expect(read).toBeGreaterThan(-1);
    expect(scrub).toBeGreaterThan(read);
    // Nothing between the read and the scrub (one statement apart).
    expect(res.body.slice(read, scrub)).not.toMatch(/fetch\(|function/);
  });

  it("the client script does not use innerHTML or document.write", async () => {
    const h = await harness();
    const res = await raw(h.port, { path: `/?t=${h.token}` });
    expect(res.body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });
});

describe("qwen_settings MCP tool", () => {
  async function connect(h: Harness) {
    const mcp = new McpServer({ name: "t", version: "0" });
    registerSettingsTool(mcp, h.page);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    return { mcp, client };
  }
  const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text;

  it("returns {url, state}; the URL's token works and the state equals GET /api/state", async () => {
    const h = await harness();
    const { client } = await connect(h);
    const out = JSON.parse(textOf(await client.callTool({ name: "qwen_settings", arguments: {} })));
    const url = new URL(out.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBe(h.port);
    expect((await raw(h.port, { path: `${url.pathname}${url.search}` })).status).toBe(200);
    const viaHttp = JSON.parse(
      (await raw(h.port, { path: "/api/state", headers: { [SETTINGS_TOKEN_HEADER]: url.searchParams.get("t")! } })).body,
    );
    expect(out.state).toEqual(viaHttp);
  });

  it("cannot change any setting whatever arguments it is given", async () => {
    const h = await harness();
    const { client } = await connect(h);
    const attempts: Array<Record<string, unknown>> = [
      { dispatchEnabled: true },
      { dispatch_enabled: true, enabled: true },
      { providers: [{ id: "x", agentKind: "qwen-local", backend: "coder-box" }] },
      { defaultExtensions: ["qwen-toolkit"] },
      { state: { dispatchEnabled: true }, patch: { dispatchEnabled: true }, apply: true },
    ];
    for (const args of attempts) {
      // The SDK may reject unknown arguments or strip them; either way the
      // settings must not move.
      await client.callTool({ name: "qwen_settings", arguments: args }).catch(() => undefined);
    }
    untouched(h);
  });

  it("is the only tool this module registers, and it declares itself read-only", async () => {
    const h = await harness();
    const { client } = await connect(h);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["qwen_settings"]);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tools[0]!.inputSchema.properties ?? {})).toBe("{}");
  });
});

describe("the write path is the HTTP POST and nothing else", () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const read = (f: string) => readFileSync(join(srcDir, f), "utf8");

  it("only settings-page.ts calls writer.apply; server.ts hands the writer to nothing but the page", () => {
    for (const f of ["server.ts", "dispatch-tool.ts", "extensions.ts", "backends.ts", "pool.ts", "session.ts"]) {
      expect(read(f), f).not.toMatch(/writer\.apply|\.apply\(\{\s*dispatchEnabled/);
    }
    const server = read("server.ts");
    const writerLines = server
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && /\bwriter\b/.test(l));
    // Exactly one reference: the writer is passed to the settings page.
    expect(writerLines.map((l) => l.trim())).toEqual(["writer: sessionSettings.writer,"]);
    // The tool handlers receive the read-only view only.
    expect(server).not.toMatch(/createToolHandlers\([^)]*writer/s);
  });

  it("the settings tool does not read or write settings at all", () => {
    const page = read("settings-page.ts");
    const toolBody = page.slice(page.indexOf("export function registerSettingsTool"));
    expect(toolBody).not.toMatch(/writer|\.apply\(/);
  });
});

describe("shutdown", () => {
  it("close() stops listening: new connections are refused", async () => {
    const h = await harness();
    expect((await raw(h.port, { path: `/?t=${h.token}` })).status).toBe(200);
    await h.page.close();
    await expect(raw(h.port, { path: `/?t=${h.token}` })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(h.page.address()).toBeUndefined();
  });

  it("close() drops an open keep-alive connection instead of hanging", async () => {
    const h = await harness();
    const { Agent } = await import("node:http");
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: h.port, path: `/?t=${h.token}`, agent },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
    await h.page.close();
    agent.destroy();
  });

  it("close() before the first URL is a no-op, and a closed page does not restart", async () => {
    const settings = createSessionSettings();
    const page = createSettingsPage({
      view: settings.view,
      writer: settings.writer,
      env: {},
      loadProviders: () => [],
      listBackends: async () => BACKENDS,
    });
    await page.close();
    await expect(page.url()).rejects.toThrow(/closed/);
  });
});
