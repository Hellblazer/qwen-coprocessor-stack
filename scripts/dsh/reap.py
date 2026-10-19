"""Kill processes a dsh session left running: python3 reap.py SINCE_EPOCH ANCESTOR_PID ROOT...

dsh-run.sh kills dsh's process group itself; this catches jobs that left the group
(dsh's shell tool starts its shell detached, in a new session) and outlived dsh. A process
is killed only if all hold: its parent is pid 1 (orphaned, as a left-behind job is once
dsh is gone), its working directory is under one of the ROOTs, it started at or after SINCE_EPOCH (to the second),
and it is not ANCESTOR_PID or one of its ancestors. A shell or editor you open in the
worktree has a live parent, so it is never a candidate. Repeats a few times, since
killing an orphan can orphan its children. Prints {"reaped": [...]} or {"error": ...}
and exits 1 on error.
"""
import json, os, signal, subprocess, sys, time

C = dict(os.environ, LC_ALL="C")  # ps prints lstart in the locale's language otherwise


def ancestors(pid):
    chain = set()
    while pid > 1 and pid not in chain:
        chain.add(pid)
        r = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True, env=C)
        try:
            pid = int(r.stdout.strip())
        except ValueError:
            break
    return chain


def candidates(roots, since, keep):
    r = subprocess.run(["lsof", "-nP", "-d", "cwd", "-Fpn"], capture_output=True, text=True, env=C)
    if r.returncode not in (0, 1) or (r.returncode == 1 and r.stderr.strip()):
        raise RuntimeError(f"lsof failed: {r.stderr.strip()[:200]}")
    pids, pid = [], None
    for line in r.stdout.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid is not None and pid not in keep:
            n = line[1:]
            if any(n == w or n.startswith(w + "/") for w in roots):
                pids.append(pid)
    out = []
    for p in pids:
        r = subprocess.run(["ps", "-o", "ppid=,lstart=", "-p", str(p)], capture_output=True, text=True, env=C)
        fields = r.stdout.split(None, 1)
        if len(fields) != 2:
            continue  # exited meanwhile
        started = time.mktime(time.strptime(fields[1].strip(), "%a %b %d %H:%M:%S %Y"))
        if int(fields[0]) == 1 and started >= int(since):
            out.append(p)
    return out


def main():
    since, anc = float(sys.argv[1]), int(sys.argv[2])
    roots = [os.path.realpath(r) for r in sys.argv[3:]]
    keep = ancestors(anc) | {os.getpid()}
    killed = []
    for _ in range(5):
        found = [p for p in candidates(roots, since, keep) if p not in killed]
        if not found:
            break
        for p in found:
            try:
                os.kill(p, signal.SIGKILL)
                killed.append(p)
            except OSError:
                pass
        time.sleep(0.2)
    print(json.dumps({"reaped": killed}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
