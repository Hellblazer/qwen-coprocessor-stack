// SPDX-License-Identifier: MIT
//
// Regression test: pino loggers MUST write to stderr, never stdout.
//
// This package runs as an MCP stdio server — stdout is reserved for
// JSON-RPC protocol frames. Pino log lines on stdout corrupt the channel
// for strict MCP clients (e.g. the official Python SDK, which pydantic-
// validates each received line as a JSONRPCMessage).
//
// Bug discovered via nexus spike_d bench, 2026-05-15. Claude Code's MCP
// plugin happens to tolerate non-JSONRPC stdout content, which is why the
// bug went undetected until a strict client connected.
//
// Strategy: spawn a tiny node subprocess that imports createLogger and
// emits a known marker. Capture stdout and stderr independently. Assert
// the marker appears on stderr and never on stdout. This catches the
// real fd-level destination (pino.destination(fd) uses sonic-boom +
// fs.writeSync at the native layer, which is not interceptable from the
// vitest process via JS-level monkey-patching).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const distLog = resolve(__dirname, "../dist/log.js");

describe("logger destination (subprocess fd-level)", () => {
  it("writes log lines to stderr and nothing to stdout", () => {
    const script = `
      import { createLogger } from ${JSON.stringify(distLog)};
      const log = createLogger("regression-test");
      log.info({ marker: "stderr-only-marker" }, "hello");
      // Give sonic-boom a tick to flush before exit.
      setImmediate(() => process.exit(0));
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    // Marker must be on stderr only.
    expect(result.stderr).toContain("stderr-only-marker");
    expect(result.stderr).toContain("regression-test");
    expect(result.stdout).not.toContain("stderr-only-marker");
    expect(result.stdout).not.toContain("regression-test");

    // stdout must be empty (or whitespace) — no log JSON whatsoever.
    expect(result.stdout.trim()).toBe("");

    // And the stderr line must be a parseable pino JSON record.
    const line = result.stderr
      .split("\n")
      .find((l) => l.includes("stderr-only-marker"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.name).toBe("regression-test");
    expect(parsed.marker).toBe("stderr-only-marker");
    expect(parsed.msg).toBe("hello");
  });

  it("does not leak any pino JSON to stdout when production modules are imported", () => {
    // Import all modules that construct module-scope loggers. None of
    // them should emit anything to stdout on load. This guards against a
    // future module accidentally going back to `pino({ name: ... })`
    // (which defaults to stdout) instead of `createLogger(...)`.
    const distRoot = resolve(__dirname, "../dist");
    const script = `
      await import(${JSON.stringify(resolve(distRoot, "backends.js"))});
      await import(${JSON.stringify(resolve(distRoot, "pool.js"))});
      await import(${JSON.stringify(resolve(distRoot, "extensions.js"))});
      await import(${JSON.stringify(resolve(distRoot, "shutdown.js"))});
      await import(${JSON.stringify(resolve(distRoot, "session.js"))});
      // server.js has top-level main()-on-import side effects guarded by
      // import.meta — we intentionally skip it here to avoid spawning a
      // real StdioServerTransport during the test.
      setImmediate(() => process.exit(0));
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/"name":"qwen-/);
    expect(result.stdout).not.toMatch(/"level":\d+/);
  });
});
