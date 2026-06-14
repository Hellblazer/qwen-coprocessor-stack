// SPDX-License-Identifier: MIT
//
// RDR-008 dps integration test: qwen_dispatch REPO-MODE end-to-end through
// runQwenDispatch with the REAL executor-managed worktree (the server-shaped
// resolveWorktree wiring). Proves: repo input → materialized detached worktree
// at base_commit → the dispatch runs ON that worktree → cleanup removes it.
// The dispatcher is faked (no real Qwen) but uses the REAL gitExtractPatch.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Dispatch } from "../../src/dispatch.js";
import { gitExtractPatch, runQwenDispatch, type QwenDispatchInput } from "../../src/dispatch-tool.js";
import type { AgentProvider } from "../../src/types.js";
import { executorManagedWorktree } from "../../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

const provider: AgentProvider = {
  id: "qwen-coder-mac",
  kind: "agent-cli",
  agentKind: "qwen-local",
  modalities: ["text"],
  excludes: [],
  costClass: "free-local",
};

let root: string;
let source: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-repo-it-"));
  source = join(root, "source");
  execFileSync("git", ["init", "-q", source]);
  git(source, "config", "user.email", "t@t.test");
  git(source, "config", "user.name", "t");
  git(source, "config", "commit.gpgsign", "false");
  writeFileSync(join(source, "calc.py"), "def add(a, b):\n    return a - b\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  base = git(source, "rev-parse", "HEAD").trim();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("qwen_dispatch repo-mode (real managed worktree)", () => {
  it("materializes at base, dispatches on the managed worktree, returns the patch, cleans up", async () => {
    const workRoot = join(root, "work");
    // Mirror the server.ts resolveWorktree wiring (RDR-008 dps).
    const resolveWorktree = (input: QwenDispatchInput) =>
      executorManagedWorktree({
        repo: input.repo!,
        baseCommit: input.base_commit,
        instanceId: "inst-it",
        cacheRoot: join(root, "cache"),
        workRoot,
        ...(input.repo_url !== undefined ? { repoUrl: input.repo_url } : {}),
      });

    // Fake dispatcher: the "agent" edits + COMMITS in the managed worktree, then
    // the result patch is the REAL gitExtractPatch (diff vs base).
    let ranIn: string | undefined;
    const fakeDispatch: Dispatch = async (task) => {
      ranIn = task.worktree;
      git(task.worktree, "config", "user.email", "a@a.test");
      git(task.worktree, "config", "user.name", "a");
      git(task.worktree, "config", "commit.gpgsign", "false");
      writeFileSync(join(task.worktree, "calc.py"), "def add(a, b):\n    return a + b\n");
      git(task.worktree, "add", "-A");
      git(task.worktree, "commit", "-q", "-m", "fix");
      const patch = await gitExtractPatch(task.worktree, base);
      return { patch, turns: 2, outcome: "completed", cost: 0 };
    };

    const result = await runQwenDispatch(
      { prompt: "fix add", base_commit: base, repo: "acme/calc", repo_url: source },
      {
        loadProviders: () => [provider],
        resolveDispatch: () => fakeDispatch,
        resolveWorktree,
      },
    );

    // Ran on the executor-managed worktree (under workRoot), checked out at base.
    expect(ranIn).toBe(join(workRoot, "inst-it"));
    expect(result.outcome).toBe("completed");
    expect(result.turns).toBe(2);
    expect(result.patch).toContain("return a + b");
    expect(result.patch).not.toContain("test_"); // source-only

    // Cleanup ran: the worktree is gone, the mirror is kept.
    expect(existsSync(join(workRoot, "inst-it"))).toBe(false);
    expect(existsSync(join(root, "cache", "acme__calc.git"))).toBe(true);
  });

  it("rejects repo-mode when no host worktree resolver is wired (invalid_worktree_spec)", async () => {
    // Without resolveWorktree, repo-mode is not serviceable — a host misconfig.
    await expect(
      runQwenDispatch(
        { prompt: "x", base_commit: base, repo: "acme/calc" },
        { loadProviders: () => [provider], resolveDispatch: () => (async () => ({ patch: "", turns: 0, outcome: "completed", cost: 0 })) as Dispatch },
      ),
    ).rejects.toMatchObject({ code: "invalid_worktree_spec" });
    // No stray worktrees were left behind.
    expect(existsSync(join(root, "work"))).toBe(false);
  });
});
