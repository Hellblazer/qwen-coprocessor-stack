// SPDX-License-Identifier: MIT
//
// Shared pino logger factory.
//
// All loggers in this package MUST write to stderr (fd 2), never stdout.
// This package runs as an MCP stdio server: stdout is reserved exclusively
// for JSON-RPC protocol frames. Any non-JSONRPC bytes on stdout corrupt the
// channel for strict MCP clients (e.g. the official Python SDK, which
// pydantic-validates every received line as a JSONRPCMessage).
//
// Discovered via nexus spike_d bench, 2026-05-15 — Claude Code's MCP plugin
// happened to be lenient with non-JSONRPC stdout, masking the bug until a
// strict client connected.

import pino, { type Logger } from "pino";

// Single shared destination — pino docs recommend reusing one destination
// stream across loggers rather than constructing one per logger.
const STDERR = pino.destination(2);

export function createLogger(name: string): Logger {
  return pino({ name }, STDERR);
}
