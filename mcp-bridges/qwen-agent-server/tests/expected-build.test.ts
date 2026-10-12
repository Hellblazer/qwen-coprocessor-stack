// SPDX-License-Identifier: MIT
//
// Tests for the optional build-identity check on the health probe (bead 55q).
//
// `probeHealth` used to return true on any OK answer from /health or
// /models, so a backend was reported healthy while a DIFFERENT llama-server
// build was answering on its port. With `Backend.expected_build` set, the
// probe additionally GETs `<host>/props` and requires the reported
// `build_info` to CONTAIN the expected string.
//
// These tests use a REAL http.createServer on port 0 (no mocking of fetch or
// http) so the probe exercises the actual transport; the `/props` body is
// configurable per test. Log output is captured via a hoisted mock of
// ../src/log.js (same technique as session.test.ts).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logCapture = vi.hoisted(() => ({ lines: [] as Array<{ level: string; args: unknown[] }> }));
vi.mock("../src/log.js", () => {
  const make = () => {
    const rec = (level: string) => (...args: unknown[]) => {
      logCapture.lines.push({ level, args });
    };
    return {
      info: rec("info"),
      warn: rec("warn"),
      error: rec("error"),
      debug: rec("debug"),
      trace: rec("trace"),
      fatal: rec("fatal"),
      child: () => make(),
    };
  };
  return { createLogger: () => make() };
});

import {
  _resetConfigCache,
  probeHealth,
  resetHealthCache,
} from "../src/backends.js";
import { createToolHandlers } from "../src/server.js";
import type { Backend, BackendInfo } from "../src/types.js";

// ─────────────────────────────────────────────────────────────────
// Real HTTP fixture

interface Route {
  status?: number;
  body?: string;
}

interface FakeServer {
  base: string;
  paths: string[];
  setRoute: (path: string, r: Route) => void;
  close: () => Promise<void>;
}

async function startServer(routes: Record<string, Route>): Promise<FakeServer> {
  const table = new Map(Object.entries(routes));
  const paths: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    paths.push(url);
    const route = table.get(url);
    if (!route) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    res.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    paths,
    setRoute: (path, r) => table.set(path, r),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function makeBackend(url: string, expected?: string): Backend {
  return {
    id: "coder-box",
    url,
    model: "qwen",
    tier: "remote",
    capacity: "heavy",
    ...(expected !== undefined ? { expected_build: expected } : {}),
  };
}

function mismatchWarnings(): unknown[][] {
  return logCapture.lines
    .filter((l) => l.level === "warn")
    .map((l) => l.args)
    .filter((a) => (a[0] as { event_type?: string } | undefined)?.event_type === "backend_build_mismatch");
}

beforeEach(() => {
  resetHealthCache();
  logCapture.lines.length = 0;
});

afterEach(() => {
  resetHealthCache();
});

// ─────────────────────────────────────────────────────────────────
// probeHealth — build identity

describe("probeHealth — expected_build", () => {
  it("makes no /props request at all when expected_build is unset (byte-for-byte today's behavior)", async () => {
    const srv = await startServer({ "/health": { body: "ok" } });
    try {
      const healthy = await probeHealth(makeBackend(`${srv.base}/v1`));
      expect(healthy).toBe(true);
      expect(srv.paths).toContain("/health");
      expect(srv.paths).not.toContain("/props");
    } finally {
      await srv.close();
    }
  });

  it("is healthy when the reported build_info CONTAINS expected_build", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b11541-f2918cabb" }) },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(true);
      expect(srv.paths).toContain("/props");
    } finally {
      await srv.close();
    }
  });

  it("is unhealthy when the reported build does not match", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b99999-deadbeef" }) },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("is unhealthy when /props is unreachable (404)", async () => {
    const srv = await startServer({ "/health": { body: "ok" } }); // no /props route -> 404
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
      expect(srv.paths).toContain("/props");
    } finally {
      await srv.close();
    }
  });

  it("is unhealthy when the /props body is not JSON", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: "not json at all" },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("is unhealthy when build_info is missing", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ version: "1.2.3" }) },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("is unhealthy when build_info is present but not a string", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: 11541 }) },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("still runs the build check when /health fails but /models answers", async () => {
    const srv = await startServer({
      "/health": { status: 500, body: "nope" },
      "/v1/models": { body: "{}" },
      "/props": { body: JSON.stringify({ build_info: "b99999-deadbeef" }) },
    });
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
      expect(srv.paths).toContain("/v1/models");
      expect(srv.paths).toContain("/props");

      // ...and a matching build on the same fallback path is healthy.
      srv.setRoute("/props", { body: JSON.stringify({ build_info: "b11541-f2918cabb" }) });
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("a non-string expected_build is ignored (treated as absent: no /props)", async () => {
    const srv = await startServer({ "/health": { body: "ok" } });
    try {
      const backend = { ...makeBackend(`${srv.base}/v1`), expected_build: 12345 } as unknown as Backend;
      expect(await probeHealth(backend)).toBe(true);
      expect(srv.paths).not.toContain("/props");
    } finally {
      await srv.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// mismatch warning — logged once, re-armed after a healthy probe

describe("probeHealth — backend_build_mismatch warning", () => {
  it("logs one structured warning on mismatch and does not repeat on an identical second probe", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b99999-deadbeef" }) },
    });
    try {
      const backend = makeBackend(`${srv.base}/v1`, "b11541");
      expect(await probeHealth(backend)).toBe(false);
      expect(await probeHealth(backend)).toBe(false);

      const warns = mismatchWarnings();
      expect(warns).toHaveLength(1);
      const fields = warns[0]![0] as Record<string, unknown>;
      expect(fields["event_type"]).toBe("backend_build_mismatch");
      expect(fields["backend_id"]).toBe("coder-box");
      expect(fields["expected_build"]).toBe("b11541");
      expect(fields["reported_build"]).toBe("b99999-deadbeef");
    } finally {
      await srv.close();
    }
  });

  it("reports reported_build as null when /props is unreadable", async () => {
    const srv = await startServer({ "/health": { body: "ok" } }); // /props 404
    try {
      expect(await probeHealth(makeBackend(`${srv.base}/v1`, "b11541"))).toBe(false);
      const fields = mismatchWarnings()[0]![0] as Record<string, unknown>;
      expect(fields["reported_build"]).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("re-logs only after the backend has been healthy in between", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b99999-deadbeef" }) },
    });
    try {
      const backend = makeBackend(`${srv.base}/v1`, "b11541");
      expect(await probeHealth(backend)).toBe(false);
      expect(mismatchWarnings()).toHaveLength(1);

      // A healthy probe in between re-arms the warning.
      srv.setRoute("/props", { body: JSON.stringify({ build_info: "b11541-f2918cabb" }) });
      expect(await probeHealth(backend)).toBe(true);
      expect(mismatchWarnings()).toHaveLength(1);

      srv.setRoute("/props", { body: JSON.stringify({ build_info: "b99999-deadbeef" }) });
      expect(await probeHealth(backend)).toBe(false);
      expect(mismatchWarnings()).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it("resetHealthCache() clears the mismatch state so tests stay isolated", async () => {
    const srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b99999-deadbeef" }) },
    });
    try {
      const backend = makeBackend(`${srv.base}/v1`, "b11541");
      expect(await probeHealth(backend)).toBe(false);
      expect(mismatchWarnings()).toHaveLength(1);
      resetHealthCache();
      expect(await probeHealth(backend)).toBe(false);
      expect(mismatchWarnings()).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// qwen_backends surfaces the configured value

describe("qwen_backends — expected_build surfacing", () => {
  let dir: string;
  let srv: FakeServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "qwen-expected-build-"));
    process.env["QWEN_CONFIG_DIR"] = dir;
    delete process.env["QWEN_BACKENDS"];
    _resetConfigCache();
    resetHealthCache();
    srv = await startServer({
      "/health": { body: "ok" },
      "/props": { body: JSON.stringify({ build_info: "b11541-f2918cabb" }) },
    });
  });

  afterEach(async () => {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env["QWEN_CONFIG_DIR"];
    delete process.env["QWEN_BACKENDS"];
    _resetConfigCache();
    resetHealthCache();
  });

  it("carries expected_build when set, and omits it otherwise", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        backends: [
          {
            id: "box",
            url: `${srv.base}/v1`,
            model: "qwen",
            tier: "remote",
            capacity: "heavy",
            expected_build: "b11541",
          },
          { id: "mac", url: `${srv.base}/v1`, model: "qwen", tier: "remote", capacity: "heavy" },
        ],
      }),
      "utf8",
    );
    _resetConfigCache();

    const handlers = createToolHandlers();
    const result = (await handlers.qwen_backends({})) as BackendInfo[];
    expect(result.find((r) => r.id === "box")!.expected_build).toBe("b11541");
    expect(result.find((r) => r.id === "mac")).not.toHaveProperty("expected_build");
  });
});
