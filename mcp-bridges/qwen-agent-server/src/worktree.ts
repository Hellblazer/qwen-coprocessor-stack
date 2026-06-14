// SPDX-License-Identifier: MIT
//
// Pluggable worktree strategy (RDR-008 §Decision item 4 / RF-5 fast-follow,
// bead qwen-coprocessor-stack-1gl). Worktree ownership is a HOST-EFFECT
// strategy: the executor runs + extracts; HOW the worktree comes to exist is
// pluggable. Two members:
//
//   - callerSuppliedWorktree  — DEFAULT (shipped in P2): the caller passes a
//     ready worktree + base_commit; lifecycle (create/cleanup) is the caller's.
//   - executorManagedWorktree — a TS port of scripts/coding-eval/materialize.py:
//     a per-repo bare MIRROR shared across instances + a per-instance throwaway
//     DETACHED worktree at base_commit, cleaned up after the run.
//
// base_commit stays CALLER-SUPPLIED in both (RF-5 non-negotiable — the executor
// never infers it). The git mechanics go through an injectable `GitRunner` so
// the network clone is isolated in tests; the worktree mechanics are exercised
// against a local bare repo with no network.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createLogger } from "./log.js";

const execFileP = promisify(execFile);
const log = createLogger("qwen-worktree");

/** Runs a full argv (e.g. `["git", "-C", mirror, "fetch", ...]`), rejecting on
 *  non-zero exit. `args[0]` is the program. Injectable so tests can run offline /
 *  against a local bare repo. */
export type GitRunner = (args: string[]) => Promise<void>;

const defaultRunner: GitRunner = async (args) => {
  const [bin, ...rest] = args;
  await execFileP(bin!, rest);
};

/** One prepared worktree plus the lifecycle hook to tear it down. `cleanup` is a
 *  no-op for the caller-supplied strategy (the caller owns lifecycle). */
export interface WorktreePreparation {
  worktree: string;
  cleanup: () => Promise<void>;
}

/** A worktree-provisioning strategy. `prepare()` yields a ready worktree the
 *  agent edits and `extractPatch` diffs. */
export interface WorktreeStrategy {
  prepare: () => Promise<WorktreePreparation>;
}

/** The caller-supplied strategy (P2 default): use the given path as-is; cleanup
 *  is the caller's responsibility (no-op here). */
export function callerSuppliedWorktree(worktree: string): WorktreeStrategy {
  return { prepare: async () => ({ worktree, cleanup: async () => {} }) };
}

/** Cache-key path of the bare mirror for `repo` (an `owner/name` slug). */
export function mirrorPath(repo: string, cacheRoot: string): string {
  return join(cacheRoot, repo.replace(/\//g, "__") + ".git");
}

/** Path of the throwaway worktree for `instanceId`. */
export function worktreePath(instanceId: string, workRoot: string): string {
  return join(workRoot, instanceId);
}

export interface ExecutorManagedOpts {
  /** `owner/name` slug — the mirror cache key (and default github source). */
  repo: string;
  /** Override clone source (a local bare-repo path / non-github URL). Defaults
   *  to `https://github.com/<repo>.git`. */
  repoUrl?: string;
  /** Caller-supplied base the worktree is checked out at (never inferred). */
  baseCommit: string;
  /** Unique id for this run's throwaway worktree. */
  instanceId: string;
  /** Shared bare-mirror cache root. */
  cacheRoot: string;
  /** Per-instance worktree root. */
  workRoot: string;
  runner?: GitRunner;
}

// Per-mirror async mutex (process-wide, mirroring materialize.py's _MIRROR_LOCKS
// dict). Serializes the git operations that mutate ONE mirror's shared worktree
// registry / refs (fetch, worktree add/remove/prune) — concurrent `git worktree
// add` on the same mirror otherwise races on git's internal locks. Held only
// around git subprocesses, NEVER during the agent run. Distinct mirrors run in
// parallel (distinct keys). Internal helpers run UNLOCKED (the caller holds the
// lock) so there is no re-entrancy / deadlock.
const _mirrorLocks = new Map<string, Promise<void>>();
let _tmpCounter = 0;

async function withMirrorLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _mirrorLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  _mirrorLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Remove a worktree via git (falling back to rmtree if the dir exists without
 *  being registered), then prune. UNLOCKED — caller holds the mirror lock. */
async function removeWorktreeUnlocked(mirror: string, dest: string, runner: GitRunner): Promise<void> {
  try {
    await runner(["git", "-C", mirror, "worktree", "remove", "--force", dest]);
  } catch {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  }
  await runner(["git", "-C", mirror, "worktree", "prune"]);
}

/** Ensure a bare mirror of `repo` exists and is current: clone `--bare` on first
 *  use (into a tmp dir, then atomically rename — cross-process race safety),
 *  else fetch. Returns the mirror path. */
async function ensureMirror(
  repo: string,
  repoUrl: string | undefined,
  cacheRoot: string,
  runner: GitRunner,
): Promise<string> {
  const mirror = mirrorPath(repo, cacheRoot);
  await withMirrorLock(mirror, async () => {
    if (existsSync(mirror)) {
      await runner(["git", "-C", mirror, "fetch", "--all", "--quiet"]);
      return;
    }
    mkdirSync(cacheRoot, { recursive: true });
    const tmp = `${mirror}.tmp.${process.pid}.${_tmpCounter++}`;
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    const url = repoUrl ?? `https://github.com/${repo}.git`;
    await runner(["git", "clone", "--bare", "--quiet", url, tmp]);
    try {
      renameSync(tmp, mirror);
    } catch {
      // Lost the race — another worker materialized the mirror first.
      rmSync(tmp, { recursive: true, force: true });
      await runner(["git", "-C", mirror, "fetch", "--all", "--quiet"]);
    }
  });
  return mirror;
}

/** Add a detached worktree at `baseCommit` off an existing mirror. Idempotent —
 *  a stale dest is removed first. */
async function materializeFromMirror(
  mirror: string,
  instanceId: string,
  baseCommit: string,
  workRoot: string,
  runner: GitRunner,
): Promise<string> {
  const dest = worktreePath(instanceId, workRoot);
  await withMirrorLock(mirror, async () => {
    if (existsSync(dest)) await removeWorktreeUnlocked(mirror, dest, runner);
    mkdirSync(workRoot, { recursive: true });
    await runner(["git", "-C", mirror, "worktree", "add", "--detach", "--force", dest, baseCommit]);
  });
  return dest;
}

/**
 * The executor-managed strategy: ensure the mirror (may clone), add a throwaway
 * detached worktree at `base_commit`, and return a `cleanup` that removes the
 * worktree + prunes the mirror registry (the mirror is kept for reuse). For
 * callers that want isolation handled rather than supplying a worktree.
 */
export function executorManagedWorktree(opts: ExecutorManagedOpts): WorktreeStrategy {
  const runner = opts.runner ?? defaultRunner;
  return {
    prepare: async () => {
      const mirror = await ensureMirror(opts.repo, opts.repoUrl, opts.cacheRoot, runner);
      const worktree = await materializeFromMirror(
        mirror,
        opts.instanceId,
        opts.baseCommit,
        opts.workRoot,
        runner,
      );
      log.info(
        { event_type: "worktree_prepared", repo: opts.repo, instance: opts.instanceId, worktree },
        "executor-managed worktree ready",
      );
      return {
        worktree,
        cleanup: async () => {
          await withMirrorLock(mirror, () => removeWorktreeUnlocked(mirror, worktree, runner));
          log.info(
            { event_type: "worktree_cleaned", repo: opts.repo, instance: opts.instanceId },
            "executor-managed worktree removed",
          );
        },
      };
    },
  };
}
