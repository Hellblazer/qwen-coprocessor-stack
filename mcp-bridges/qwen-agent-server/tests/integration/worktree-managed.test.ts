// SPDX-License-Identifier: MIT
//
// RDR-008 1gl integration test: the executor-managed worktree strategy against
// REAL git (no network — clones --bare from a local source repo). Proves the
// materialize.py port end-to-end: ensure mirror → detached worktree at
// base_commit → a committed agent edit is captured by gitExtractPatch
// (diff-vs-base non-empty, source-only) → cleanup removes the worktree.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitExtractPatch } from "../../src/dispatch-tool.js";
import { executorManagedWorktree } from "../../src/worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

let root: string;
let source: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-managed-it-"));
  // A local source repo with a base commit — the clone source (offline).
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

describe("executorManagedWorktree (real git)", () => {
  it("materializes a detached worktree at base_commit; a committed edit diffs vs base; cleanup removes it", async () => {
    const strategy = executorManagedWorktree({
      repo: "acme/calc",
      repoUrl: source, // offline clone source
      baseCommit: base,
      instanceId: "inst-1",
      cacheRoot: join(root, "cache"),
      workRoot: join(root, "work"),
    });

    const prep = await strategy.prepare();
    expect(existsSync(prep.worktree)).toBe(true);
    // Checked out AT base_commit (detached HEAD == base).
    expect(git(prep.worktree, "rev-parse", "HEAD").trim()).toBe(base);

    // The "agent" fixes the bug AND COMMITS (the silent-zero case): git diff HEAD
    // would be empty; diff-vs-base must still capture it.
    git(prep.worktree, "config", "user.email", "a@a.test");
    git(prep.worktree, "config", "user.name", "a");
    git(prep.worktree, "config", "commit.gpgsign", "false");
    writeFileSync(join(prep.worktree, "calc.py"), "def add(a, b):\n    return a + b\n");
    git(prep.worktree, "add", "-A");
    git(prep.worktree, "commit", "-q", "-m", "agent fix");

    expect(git(prep.worktree, "diff", "HEAD").trim()).toBe(""); // agent committed
    const patch = await gitExtractPatch(prep.worktree, base);
    expect(patch.trim()).not.toBe("");
    expect(patch).toContain("calc.py");
    expect(patch).toContain("return a + b");

    await prep.cleanup();
    expect(existsSync(prep.worktree)).toBe(false);
  });

  it("reuses the mirror on a second instance (no re-clone), each at base", async () => {
    const common = {
      repo: "acme/calc",
      repoUrl: source,
      baseCommit: base,
      cacheRoot: join(root, "cache"),
      workRoot: join(root, "work"),
    };
    const a = await executorManagedWorktree({ ...common, instanceId: "a" }).prepare();
    const b = await executorManagedWorktree({ ...common, instanceId: "b" }).prepare();

    expect(a.worktree).not.toBe(b.worktree);
    expect(git(a.worktree, "rev-parse", "HEAD").trim()).toBe(base);
    expect(git(b.worktree, "rev-parse", "HEAD").trim()).toBe(base);
    // One shared bare mirror.
    expect(existsSync(join(root, "cache", "acme__calc.git"))).toBe(true);

    await a.cleanup();
    await b.cleanup();
    // Mirror is KEPT (reuse); only worktrees are removed.
    expect(existsSync(join(root, "cache", "acme__calc.git"))).toBe(true);
    expect(existsSync(a.worktree)).toBe(false);
    expect(existsSync(b.worktree)).toBe(false);
  });
});
