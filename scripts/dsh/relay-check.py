"""Mechanical checks for dsh-relay: build the patch and check its scope, then optionally run a test.

Usage: python3 relay-check.py WORKTREE BASE RUNDIR SCOPE [TEST]
  SCOPE  comma-separated paths; a path ending in "/" is a directory prefix, any other is an
         exact file
  TEST   a shell command, run in WORKTREE under test-sandbox.sb (writes only to the worktree,
         temp and tool caches) with OPENROUTER_API_KEY removed from its environment

Writes RUNDIR/patch.diff (tracked changes and new files against BASE) and prints one JSON
object: files [{path, status}], non_empty, scope_ok, outside_scope, symlinks, test
{exit, tail} or null. Only read-only git commands are used.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))


def git(wt, *args):
    return subprocess.run(["git", "-C", wt, *args], capture_output=True, check=True).stdout


def main():
    wt, base, rundir, scope = sys.argv[1:5]
    test = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
    prefixes = [s.strip() for s in scope.split(",") if s.strip()]
    files = []
    out = git(wt, "diff", "--name-status", "-z", "--no-renames", base).split(b"\0")
    for st, path in zip(out[0::2], out[1::2]):
        if path:
            files.append({"path": path.decode(), "status": st.decode()})
    for path in git(wt, "ls-files", "-o", "--exclude-standard", "-z").split(b"\0"):
        if path:
            files.append({"path": path.decode(), "status": "new"})

    def inside(p):
        return any(p.startswith(s) if s.endswith("/") else p == s for s in prefixes)

    symlinks = [f["path"] for f in files if os.path.islink(os.path.join(wt, f["path"]))]
    os.makedirs(rundir, exist_ok=True)
    with open(os.path.join(rundir, "patch.diff"), "wb") as fh:
        fh.write(git(wt, "diff", "--no-renames", base))
        for f in files:
            if f["status"] == "new":
                r = subprocess.run(["git", "-C", wt, "diff", "--no-index", "--", "/dev/null", f["path"]],
                                   capture_output=True)
                fh.write(r.stdout)
    res = {"files": files, "non_empty": bool(files),
           "outside_scope": [f["path"] for f in files if not inside(f["path"])], "symlinks": symlinks}
    res["scope_ok"] = not res["outside_scope"] and not symlinks
    res["test"] = None
    if test:
        env = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
        r = subprocess.run(["sandbox-exec", "-D", f"WT={os.path.realpath(wt)}", "-D", f"HOME={os.path.expanduser('~')}",
                            "-f", os.path.join(HERE, "test-sandbox.sb"), "bash", "-c", test],
                           cwd=wt, env=env, capture_output=True, text=True, errors="replace", timeout=1200)
        tail = (r.stdout + r.stderr).splitlines()[-30:]
        res["test"] = {"exit": r.returncode, "tail": "\n".join(tail)}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
