// SPDX-License-Identifier: MIT
//
// Regression guard for the npx/bin entrypoint (the v0.11.3 fix).
//
// The supervisor is launched in production via a bin symlink — `npx -y
// qwen-agent-server`, `npm i -g`, or node_modules/.bin/qwen-agent-server.
// In all of those, process.argv[1] is the *symlink* path
// (".../qwen-agent-server"), NOT ".../server.js". The original main-module
// guard did `process.argv[1].endsWith("server.js")`, which is false for
// every symlinked launch -> main() never ran -> the process exited 0 with
// no output and the MCP client reported "Failed to connect". Every
// in-process unit test passed throughout, because they import the module
// (main() is correctly skipped) — so nothing caught it. This test spawns
// the BUILT server through a symlink and asserts it actually speaks MCP.
//
// Skips (does not fail) when dist/server.js is absent, so a src-only
// checkout still runs the rest of the suite; CI builds before testing.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(here, "..", "dist", "server.js");

describe("entrypoint (npx/bin launch)", () => {
  it.skipIf(!existsSync(serverJs))(
    "responds to initialize when launched via a bin symlink (not server.js)",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "qas-entry-"));
      const link = path.join(dir, "qwen-agent-server"); // name != server.js
      symlinkSync(serverJs, link);
      // Deterministic startup regardless of the host: give the server a
      // trivial `qwen` stub on PATH so extension-bridge resolution is fast
      // and never blocks on whatever qwen (if any) the CI runner has.
      const qwenStub = path.join(dir, "qwen");
      writeFileSync(qwenStub, "#!/bin/sh\nexit 0\n");
      chmodSync(qwenStub, 0o755);
      try {
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [link], {
            stdio: ["pipe", "pipe", "ignore"],
            env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
          });
          let buf = "";
          // Generous: a cold CI runner imports the ~56 MB @qwen-code/sdk
          // and runs extension-bridge resolution during startup. We only
          // need proof main() ran via the symlink, not fast startup.
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("no MCP response within 50s — entrypoint guard regression"));
          }, 50_000);
          child.stdout.on("data", (d) => {
            buf += String(d);
            if (buf.includes('"result"')) {
              clearTimeout(timer);
              child.kill();
              resolve(buf);
            }
          });
          child.on("error", reject);
          child.stdin.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
            }) + "\n",
          );
        });
        expect(out).toContain("qwen-agent-server"); // serverInfo.name in the initialize result
        expect(out).toContain('"result"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
