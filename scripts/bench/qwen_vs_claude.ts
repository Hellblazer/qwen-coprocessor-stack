// SPDX-License-Identifier: MIT
//
// qwen_vs_claude.ts — A/B benchmark comparing Qwen via qwen_oneshot
// against Claude via `claude -p --output-format json --json-schema`.
//
// Designed to seed measurement for the v0.7 report's headline question:
// is Qwen3.6-35B-A3B good enough at JSON-conforming synthesis to
// replace `claude_dispatch` for the bundleable nx_answer operators?
//
// Usage (from mcp-bridges/qwen-agent-server/):
//   npm run build                    # compile supervisor
//   npm run bench                    # run with default cases
//   npm run bench -- --cases <path>  # override case file
//   npm run bench -- --out <path>    # override output JSONL
//   npm run bench -- --only qwen     # skip claude leg (saves $$)
//   npm run bench -- --only claude   # skip qwen leg (sanity)
//
// Output: JSONL with one row per (case, engine) pair. Columns:
//   case, engine, elapsed_ms, ok, json_valid, output_len, output (truncated),
//   error (when failed)
//
// The bench creates a fresh pool inline via `createToolHandlers` so the
// operator's running supervisor process is not perturbed.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createInstalledExtensionsCache,
  resolveQwenRealBin,
  resolveWrapperPath,
  type InstalledExtensionsCache,
} from "../../mcp-bridges/qwen-agent-server/dist/extensions.js";
import { createPool } from "../../mcp-bridges/qwen-agent-server/dist/pool.js";
import { createToolHandlers, type ToolHandlers } from "../../mcp-bridges/qwen-agent-server/dist/server.js";

// ─────────────────────────────────────────────────────────────────
// Types

interface Oracle {
  match: "set" | "exact";
  expected: Record<string, unknown>;
}

interface Case {
  name: string;
  operator: string;
  prompt: string;
  schema: Record<string, unknown>;
  oracle?: Oracle;
}

interface RunRow {
  case: string;
  engine: "qwen" | "claude";
  repeat: number;
  elapsed_ms: number;
  ok: boolean;
  json_valid: boolean;
  oracle_match?: boolean;
  output_len: number;
  output_truncated?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────
// CLI

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Args {
  casesPath: string;
  outPath: string;
  only?: "qwen" | "claude";
  perCaseTimeoutMs: number;
  repeat: number;
  operatorFilter?: string;
  caseFilter?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    casesPath: join(__dirname, "cases.json"),
    outPath: join(__dirname, "out", `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`),
    perCaseTimeoutMs: 120_000,
    repeat: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cases") out.casesPath = argv[++i]!;
    else if (a === "--out") out.outPath = argv[++i]!;
    else if (a === "--only") {
      const v = argv[++i];
      if (v !== "qwen" && v !== "claude") throw new Error(`--only must be qwen|claude, got ${v}`);
      out.only = v;
    } else if (a === "--timeout-ms") out.perCaseTimeoutMs = parseInt(argv[++i]!, 10);
    else if (a === "--repeat") out.repeat = parseInt(argv[++i]!, 10);
    else if (a === "--operator") out.operatorFilter = argv[++i]!;
    else if (a === "--case") out.caseFilter = argv[++i]!;
  }
  if (!Number.isFinite(out.repeat) || out.repeat < 1) throw new Error(`--repeat must be ≥1`);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Oracle grading

function gradeOracle(parsed: unknown, oracle: Oracle | undefined): boolean | undefined {
  if (!oracle || parsed === null || typeof parsed !== "object") return undefined;
  const got = parsed as Record<string, unknown>;
  for (const [key, exp] of Object.entries(oracle.expected)) {
    const actual = got[key];
    if (oracle.match === "set" && Array.isArray(exp) && Array.isArray(actual)) {
      const a = new Set(exp.map(String));
      const b = new Set(actual.map(String));
      if (a.size !== b.size) return false;
      for (const v of a) if (!b.has(v)) return false;
    } else if (JSON.stringify(actual) !== JSON.stringify(exp)) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Engines

async function runQwen(
  handlers: ToolHandlers,
  c: Case,
  timeoutMs: number,
  repeat: number,
): Promise<RunRow> {
  const t0 = Date.now();
  try {
    const result = await handlers.qwen_oneshot({
      task: c.prompt,
      opts: {
        json_schema: c.schema,
        timeout_ms: timeoutMs,
        max_attempts: 1,
      },
    });
    const elapsed = Date.now() - t0;
    if (!result.ok) {
      return {
        case: c.name,
        engine: "qwen",
        repeat,
        elapsed_ms: elapsed,
        ok: false,
        json_valid: false,
        output_len: result.result?.length ?? 0,
        ...(result.result !== undefined ? { output_truncated: truncate(result.result) } : {}),
        error: result.error?.message ?? "unknown",
      };
    }
    const oracleMatch = gradeOracle(result.parsed, c.oracle);
    return {
      case: c.name,
      engine: "qwen",
      repeat,
      elapsed_ms: elapsed,
      ok: true,
      json_valid: result.parsed !== undefined,
      ...(oracleMatch !== undefined ? { oracle_match: oracleMatch } : {}),
      output_len: result.result?.length ?? 0,
      ...(result.result !== undefined ? { output_truncated: truncate(result.result) } : {}),
    };
  } catch (err) {
    return {
      case: c.name,
      engine: "qwen",
      repeat,
      elapsed_ms: Date.now() - t0,
      ok: false,
      json_valid: false,
      output_len: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pull the schema-conforming bit out of `claude -p --output-format json
 * --json-schema X`'s stdout. The OUTER envelope is always JSON (Claude
 * Code metadata); the schema-constrained answer is at the top-level
 * `structured_output` key when --json-schema is in play. Empirically
 * verified against `claude` v6.x: `result` is empty, `iterations[]`
 * contains only token-usage metadata, and `structured_output` is the
 * one with the actual schema-shaped object.
 *
 * Fallback chain in case the structure shifts in a future Claude
 * release: structured_output → result (when populated) → undefined.
 *
 * v0.8.0 of this bench checked only the outer envelope's parseability,
 * which is meaningless (the envelope is always JSON). v0.8.1 walked
 * `iterations[].message.content[]` (also wrong). v0.8.1 final just
 * pulls `.structured_output`.
 */
function extractClaudeAnswer(stdout: string): { text: string; parsed: unknown | undefined } {
  let envelope: { result?: unknown; structured_output?: unknown } | undefined;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { text: stdout, parsed: undefined };
  }
  // Canonical: --json-schema places the conforming answer here.
  if (envelope?.structured_output !== undefined) {
    return {
      text: JSON.stringify(envelope.structured_output),
      parsed: envelope.structured_output,
    };
  }
  // Fallback: some Claude paths put a JSON-string in `.result`.
  if (typeof envelope?.result === "string" && envelope.result.trim().length > 0) {
    try {
      return { text: envelope.result, parsed: JSON.parse(envelope.result) };
    } catch {
      // .result is a textual summary, not JSON.
      return { text: envelope.result, parsed: undefined };
    }
  }
  return { text: stdout, parsed: undefined };
}

async function runClaude(c: Case, timeoutMs: number, repeat: number): Promise<RunRow> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(c.schema),
        "--no-session-persistence",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        case: c.name,
        engine: "claude",
        repeat,
        elapsed_ms: Date.now() - t0,
        ok: false,
        json_valid: false,
        output_len: stdout.length,
        ...(stdout ? { output_truncated: truncate(stdout) } : {}),
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      const ok = code === 0;
      const { text, parsed } = extractClaudeAnswer(stdout);
      const jsonValid = parsed !== undefined;
      const oracleMatch = gradeOracle(parsed, c.oracle);
      resolve({
        case: c.name,
        engine: "claude",
        repeat,
        elapsed_ms: elapsed,
        ok,
        json_valid: jsonValid,
        ...(oracleMatch !== undefined ? { oracle_match: oracleMatch } : {}),
        output_len: text.length,
        ...(text ? { output_truncated: truncate(text) } : {}),
        ...(ok ? {} : { error: stderr.slice(0, 500) || `exit ${code}` }),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        case: c.name,
        engine: "claude",
        repeat,
        elapsed_ms: Date.now() - t0,
        ok: false,
        json_valid: false,
        output_len: 0,
        error: err.message,
      });
    });

    proc.stdin.write(c.prompt);
    proc.stdin.end();
  });
}

function truncate(s: string, max = 800): string {
  return s.length > max ? s.slice(0, max) + `... (${s.length - max} more chars)` : s;
}

// ─────────────────────────────────────────────────────────────────
// Main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let cases: Case[] = JSON.parse(readFileSync(args.casesPath, "utf-8"));
  if (args.operatorFilter) cases = cases.filter((c) => c.operator === args.operatorFilter);
  if (args.caseFilter) cases = cases.filter((c) => c.name === args.caseFilter);

  console.log(`bench: ${cases.length} cases × ${args.repeat} repeats, only=${args.only ?? "both"}`);
  console.log(`bench: writing to ${args.outPath}`);

  // Spawn a fresh supervisor pool. Mirrors production main() in
  // server.ts but doesn't bind to stdio — we call handlers directly.
  let installedExtensions: InstalledExtensionsCache | undefined;
  let handlers: ToolHandlers | undefined;
  if (args.only !== "claude") {
    const qwenRealBin = resolveQwenRealBin(process.env);
    const wrapperPath = resolveWrapperPath();
    installedExtensions = await createInstalledExtensionsCache(qwenRealBin);
    const pool = createPool({ qwenRealBin, wrapperPath });
    handlers = createToolHandlers(pool, installedExtensions);
    console.log(`bench: pool ready (qwenRealBin=${qwenRealBin})`);
  }

  mkdirSync(dirname(args.outPath), { recursive: true });
  const rows: RunRow[] = [];

  for (const c of cases) {
    for (let rep = 1; rep <= args.repeat; rep++) {
      const tag = args.repeat > 1 ? `${c.name} [${rep}/${args.repeat}]` : c.name;
      console.log(`bench: ${tag}`);
      if (args.only !== "qwen" /* run claude */) {
        const row = await runClaude(c, args.perCaseTimeoutMs, rep);
        rows.push(row);
        const oracle = row.oracle_match === undefined ? "" : ` oracle=${row.oracle_match}`;
        console.log(
          `  claude: ${row.ok ? "ok" : "FAIL"} ${row.elapsed_ms}ms json_valid=${row.json_valid}${oracle} len=${row.output_len}`,
        );
      }
      if (args.only !== "claude" /* run qwen */) {
        const row = await runQwen(handlers!, c, args.perCaseTimeoutMs, rep);
        rows.push(row);
        const oracle = row.oracle_match === undefined ? "" : ` oracle=${row.oracle_match}`;
        console.log(
          `  qwen:   ${row.ok ? "ok" : "FAIL"} ${row.elapsed_ms}ms json_valid=${row.json_valid}${oracle} len=${row.output_len}`,
        );
      }
    }
  }

  writeFileSync(args.outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nbench: wrote ${rows.length} rows to ${args.outPath}`);

  // Summary table.
  console.log("\nSummary:");
  const byEngine: Record<string, { n: number; ok: number; valid: number; oracleN: number; oracleOk: number; ms: number[] }> = {};
  for (const r of rows) {
    byEngine[r.engine] ??= { n: 0, ok: 0, valid: 0, oracleN: 0, oracleOk: 0, ms: [] };
    const s = byEngine[r.engine]!;
    s.n++;
    if (r.ok) s.ok++;
    if (r.json_valid) s.valid++;
    if (r.oracle_match !== undefined) {
      s.oracleN++;
      if (r.oracle_match) s.oracleOk++;
    }
    s.ms.push(r.elapsed_ms);
  }
  for (const [engine, s] of Object.entries(byEngine)) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const total = sorted.reduce((a, b) => a + b, 0);
    const oracle = s.oracleN > 0 ? `  oracle=${s.oracleOk}/${s.oracleN}` : "";
    console.log(
      `  ${engine.padEnd(8)} ok=${s.ok}/${s.n}  json_valid=${s.valid}/${s.n}${oracle}  median=${median}ms  total=${total}ms`,
    );
  }

  // Force exit — the supervisor pool's reaper interval is unref'd but
  // pino's worker can keep the loop alive briefly.
  process.exit(0);
}

main().catch((err) => {
  console.error("bench failed:", err);
  process.exit(1);
});
