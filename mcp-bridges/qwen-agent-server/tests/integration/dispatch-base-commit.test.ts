// SPDX-License-Identifier: MIT
//
// RDR-008 P2 NON-NEGOTIABLE integration test (bead qwen-coprocessor-stack-exn):
// the agent-commits-its-edits case. The ExtractPatch signature change
// (worktree → worktree+baseCommit) and THIS test land in the same bead so the
// silent-zero path can't ship unguarded.
//
// Asserts, against a REAL git repo, the locked contract:
//   - diff-vs-base_commit is NON-EMPTY  (the agent's committed edit is captured)
//   - diff-vs-HEAD is EMPTY             (the agent committed, so HEAD == worktree)
//   - the patch is SOURCE-ONLY          (test-file edits stripped)
// exercising the full composed path: loadAgentProviders → select →
// createDefaultDispatcherRegistry → registry.resolve → dispatch → REAL
// gitExtractPatch. spawn/poll are faked (no real Qwen); the worktree mutation
// the "agent" would make is performed + committed by the test before dispatch.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadAgentProviders, selectAgentProvider } from "../../src/backends.js";
import { createDefaultDispatcherRegistry } from "../../src/dispatch-registry.js";
import { gitDiffHarvester, gitExtractPatch, runQwenDispatch } from "../../src/dispatch-tool.js";
import type { QwenSpawnEffects } from "../../src/dispatch.js";
import { patchArtifact } from "../../src/types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let repo: string;
let base: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "qwen-dispatch-it-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.test");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  // Source file + a test file at the base commit.
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_calc.py"), "def test_add():\n    assert add(1, 2) == 3\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  base = git(repo, "rev-parse", "HEAD").trim();

  // The "agent" fixes the bug AND COMMITS — plus edits a test file (to verify
  // source-only stripping). git diff HEAD would be empty after this.
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
  writeFileSync(join(repo, "tests", "test_calc.py"), "def test_add():\n    assert add(1, 2) == 3  # edited\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "agent fix");

  // Declare the agent-cli provider for loadAgentProviders.
  process.env["QWEN_AGENT_PROVIDERS"] = JSON.stringify([
    { id: "qwen-coder-mac", agentKind: "qwen-local" },
  ]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  delete process.env["QWEN_AGENT_PROVIDERS"];
});

/** Fake spawn/poll: the agent is "done" immediately (its edit was committed
 *  above). harvest is the REAL git-diff harvester over gitExtractPatch — that is
 *  what's under test. */
function fakeEffects(): QwenSpawnEffects {
  return {
    spawn: async () => "task-1",
    poll: async () => ({ state: "complete", turnsUsed: 1, cost: 0 }),
    harvest: gitDiffHarvester(gitExtractPatch),
    sleep: async () => {},
    now: () => 0,
  };
}

describe("qwen_dispatch base_commit contract (agent commits its edits)", () => {
  it("diff-vs-base is NON-EMPTY while diff-vs-HEAD is EMPTY; patch is source-only", async () => {
    // Sanity: the agent committed, so a bare HEAD diff is empty (the silent-zero trap).
    expect(git(repo, "diff", "HEAD").trim()).toBe("");

    const providers = loadAgentProviders();
    const provider = selectAgentProvider(providers, { agentKind: "qwen-local" });
    expect(provider).toBeDefined();

    const result = await runQwenDispatch(
      { prompt: "fix add", worktree: repo, base_commit: base },
      {
        loadProviders: () => providers,
        resolveDispatch: (p, baseCommit) =>
          createDefaultDispatcherRegistry({ qwenSpawn: fakeEffects(), baseCommit }).resolve(p),
      },
    );

    expect(result.outcome).toBe("completed");
    // Captured the committed source change (vs base, NOT HEAD) as a patch artifact.
    const patch = patchArtifact(result);
    expect(patch).toBeDefined();
    expect(patch!.base).toBe(base);
    expect(patch!.diff.trim()).not.toBe("");
    expect(patch!.diff).toContain("calc.py");
    expect(patch!.diff).toContain("return a + b");
    // Source-only: the test-file edit is stripped.
    expect(patch!.diff).not.toContain("test_calc.py");
  });

  it("gitExtractPatch diffs vs base, not HEAD (direct effect check)", async () => {
    const vsBase = await gitExtractPatch(repo, base);
    const vsHead = await gitExtractPatch(repo, "HEAD");
    expect(vsBase.trim()).not.toBe("");
    expect(vsHead.trim()).toBe(""); // HEAD == worktree (agent committed)
  });
});
