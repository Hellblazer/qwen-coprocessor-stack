// SPDX-License-Identifier: MIT
//
// Shared benign-EPIPE guard for the integration tests. Import this module for
// its side effect from any integration test file that spawns the qwen-code SDK.
//
// Why: when llama-server is unreachable (the CI default) the SDK still spawns
// its CLI subprocess during initialize(), and several tests deliberately drive
// a subprocess that exits early (e.g. sdk-behavior Pin 4's exit-42 wrapper, or
// round-trip's qwen_spawn whose backend is offline). The SDK then writes a
// control request to the already-closed subprocess stdin → Node emits
// `write EPIPE` on the socket's async error path as an UNCAUGHT exception (NOT
// the iterator rejection the tests catch). vitest records that as an unhandled
// error and fails the run non-deterministically (the race is timing-dependent:
// fast machines never EPIPE, slower CI runners do).
//
// The handler is installed once per process (idempotent) and left installed for
// the whole integration run — the EPIPE may land a tick after a test body
// resolves, so a per-file install/remove window can miss it. It swallows ONLY
// EPIPE and re-throws everything else, so genuine faults still fail the run.

const GUARD_FLAG = "__qwenEpipeGuardInstalled__";

if (!(globalThis as Record<string, unknown>)[GUARD_FLAG]) {
  process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") return; // benign: SDK wrote to a dead subprocess stdin
    throw err;
  });
  (globalThis as Record<string, unknown>)[GUARD_FLAG] = true;
}

export {};
