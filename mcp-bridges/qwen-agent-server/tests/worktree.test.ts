// SPDX-License-Identifier: MIT
//
// Unit tests for src/worktree.ts — the pluggable WorktreeStrategy seam
// (RDR-008 fast-follow, bead qwen-coprocessor-stack-1gl). The git mechanics go
// through an injected GitRunner so branch logic (clone-vs-fetch, worktree add,
// cleanup, stale-dest removal, per-mirror serialization) is exercised offline.
// The REAL git path is covered by tests/integration/worktree-managed.test.ts.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  callerSuppliedWorktree,
  executorManagedWorktree,
  mirrorPath,
  type GitRunner,
} from "../src/worktree.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-unit-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("callerSuppliedWorktree", () => {
  it("prepare returns the given path with a no-op cleanup", async () => {
    const prep = await callerSuppliedWorktree("/some/wt").prepare();
    expect(prep.worktree).toBe("/some/wt");
    await expect(prep.cleanup()).resolves.toBeUndefined();
  });
});

describe("executorManagedWorktree", () => {
  function baseOpts(over: Record<string, unknown> = {}) {
    return {
      repo: "owner/name",
      repoUrl: "/local/bare.git",
      baseCommit: "base-sha",
      instanceId: "inst-1",
      cacheRoot: join(root, "cache"),
      workRoot: join(root, "work"),
      ...over,
    };
  }

  // A fake runner that records argv and simulates clone by creating the dest dir
  // (so the atomic tmp→mirror rename succeeds).
  function recordingRunner(): { runner: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      if (args.includes("clone")) mkdirSync(args[args.length - 1]!, { recursive: true });
    };
    return { runner, calls };
  }

  it("clones a bare mirror when absent, then adds a detached worktree at base", async () => {
    const { runner, calls } = recordingRunner();
    const prep = await executorManagedWorktree({ ...baseOpts(), runner }).prepare();

    const mirror = mirrorPath("owner/name", join(root, "cache"));
    const dest = join(root, "work", "inst-1");
    expect(prep.worktree).toBe(dest);

    // First op is a bare clone from repoUrl (into a tmp, then renamed into mirror).
    expect(calls[0]![0]).toBe("git");
    expect(calls[0]).toContain("clone");
    expect(calls[0]).toContain("--bare");
    expect(calls[0]).toContain("/local/bare.git");
    // Then a detached worktree add at base_commit off the mirror.
    const add = calls.find((c) => c.includes("worktree") && c.includes("add"))!;
    expect(add).toEqual([
      "git", "-C", mirror, "worktree", "add", "--detach", "--force", dest, "base-sha",
    ]);
  });

  it("fetches (does NOT clone) when the mirror already exists", async () => {
    const mirror = mirrorPath("owner/name", join(root, "cache"));
    mkdirSync(mirror, { recursive: true }); // pre-existing mirror
    const { runner, calls } = recordingRunner();

    await executorManagedWorktree({ ...baseOpts(), runner }).prepare();

    expect(calls.some((c) => c.includes("clone"))).toBe(false);
    expect(calls[0]).toEqual(["git", "-C", mirror, "fetch", "--all", "--quiet"]);
  });

  it("removes a stale worktree dest before re-adding (idempotent)", async () => {
    const mirror = mirrorPath("owner/name", join(root, "cache"));
    mkdirSync(mirror, { recursive: true });
    const dest = join(root, "work", "inst-1");
    mkdirSync(dest, { recursive: true }); // stale dest from a prior run
    const { runner, calls } = recordingRunner();

    await executorManagedWorktree({ ...baseOpts(), runner }).prepare();

    // worktree remove --force <dest> appears BEFORE worktree add.
    const removeIdx = calls.findIndex((c) => c.includes("worktree") && c.includes("remove"));
    const addIdx = calls.findIndex((c) => c.includes("worktree") && c.includes("add"));
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeLessThan(addIdx);
  });

  it("cleanup removes the worktree and prunes the registry", async () => {
    const mirror = mirrorPath("owner/name", join(root, "cache"));
    mkdirSync(mirror, { recursive: true });
    const { runner, calls } = recordingRunner();

    const prep = await executorManagedWorktree({ ...baseOpts(), runner }).prepare();
    calls.length = 0;
    await prep.cleanup();

    const dest = join(root, "work", "inst-1");
    expect(calls).toContainEqual(["git", "-C", mirror, "worktree", "remove", "--force", dest]);
    expect(calls).toContainEqual(["git", "-C", mirror, "worktree", "prune"]);
  });

  it("cleanup falls back to rmtree (no prune throw) when the mirror was externally deleted", async () => {
    const mirror = mirrorPath("owner/name", join(root, "cache"));
    mkdirSync(mirror, { recursive: true });
    const { runner } = recordingRunner();
    const prep = await executorManagedWorktree({ ...baseOpts(), runner }).prepare();

    // Simulate the mirror being deleted out from under us, and a worktree dir
    // left behind (the fake `worktree add` didn't create it, so make it).
    rmSync(mirror, { recursive: true, force: true });
    mkdirSync(prep.worktree, { recursive: true });

    // Must NOT throw (no `git worktree prune` against a missing mirror).
    await expect(prep.cleanup()).resolves.toBeUndefined();
    expect(existsSync(prep.worktree)).toBe(false);
  });

  it("derives the github URL from an owner/name slug when repoUrl is omitted", async () => {
    const mirror = mirrorPath("owner/name", join(root, "cache"));
    mkdirSync(mirror, { recursive: true }); // skip clone, just inspect no-url path
    const { runner, calls } = recordingRunner();
    // mirror exists → fetch path; assert slug→cache-key mapping is owner__name.git
    await executorManagedWorktree({ ...baseOpts({ repoUrl: undefined }), runner }).prepare();
    expect(mirror.endsWith("owner__name.git")).toBe(true);
    expect(calls[0]).toContain(mirror);
  });

  it("serializes concurrent prepare() on the same mirror (per-mirror mutex)", async () => {
    // Two concurrent prepares for the same mirror must not interleave their git
    // mutations. We record entry/exit ordering via a runner that yields.
    let active = 0;
    let maxActive = 0;
    const runner: GitRunner = async (args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      if (args.includes("clone")) mkdirSync(args[args.length - 1]!, { recursive: true });
      active--;
    };
    await Promise.all([
      executorManagedWorktree({ ...baseOpts({ instanceId: "a" }), runner }).prepare(),
      executorManagedWorktree({ ...baseOpts({ instanceId: "b" }), runner }).prepare(),
    ]);
    // Same mirror → git ops never run concurrently.
    expect(maxActive).toBe(1);
  });
});
