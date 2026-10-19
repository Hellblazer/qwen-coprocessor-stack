"""Kill processes a dsh session left running: python3 reap.py WORKTREE SINCE_EPOCH [EXCLUDE_PID...]

dsh-run.sh kills dsh's process group itself; this catches jobs that left the group
(setsid and the like). It kills each process whose working directory is WORKTREE or
below it and that started at or after SINCE_EPOCH, so a shell you opened in the
worktree before the run is left alone. Prints the killed pids as a JSON list.
"""
import json, os, signal, subprocess, sys, time

wt, since = os.path.realpath(sys.argv[1]), float(sys.argv[2])
exclude = {int(p) for p in sys.argv[3:]} | {os.getpid(), os.getppid()}
out = subprocess.run(["lsof", "-nP", "-d", "cwd", "-Fpn"], capture_output=True, text=True).stdout
pids, pid = [], None
for line in out.splitlines():
    if line.startswith("p"):
        pid = int(line[1:])
    elif line.startswith("n") and pid is not None:
        n = line[1:]
        if (n == wt or n.startswith(wt + "/")) and pid not in exclude:
            pids.append(pid)
killed = []
for p in pids:
    r = subprocess.run(["ps", "-o", "lstart=", "-p", str(p)], capture_output=True, text=True)
    try:
        started = time.mktime(time.strptime(r.stdout.strip(), "%a %b %d %H:%M:%S %Y"))
    except ValueError:
        continue
    if started + 1 < since:  # lstart has 1 s resolution
        continue
    try:
        os.kill(p, signal.SIGKILL)
        killed.append(p)
    except OSError:
        pass
print(json.dumps(killed))
