# SPDX-License-Identifier: MIT
"""Arm A driver — Qwen via the MCP supervisor (RDR-006 40v.6).

This is the *headline* arm: the real hand-off path the whole eval exists to
validate. The eval runner (this Python module) drives a SPAWNED qwen-agent-server
supervisor over MCP and asks it to run the inner Qwen Code agent against a
per-instance throwaway worktree, with full write authority and ALL Qwen Code
extensions disabled (tool-surface parity with Arm B, which disables the nx
extension via a CLI config fixture; Arm A disables via the supervisor's OWN
``extensions: {only: []}`` opt — see the resolution note below).

Production path (the headline number)
-------------------------------------
``SpawnedSupervisor`` launches ``node mcp-bridges/qwen-agent-server/dist/server.js``
as an MCP stdio subprocess and speaks the MCP JSON-RPC wire protocol directly
(``initialize`` handshake → ``tools/call`` for qwen_spawn / qwen_poll /
qwen_send / qwen_stop). It is implemented with the Python standard library only
(no ``mcp`` package dependency, which is absent from the eval venv) — a small,
auditable, newline-delimited JSON-RPC client. The HEADLINE Arm-A number MUST
come from this spawned-supervisor path; that is what the integration test
exercises.

There is intentionally NO in-process ``createToolHandlers`` shim in this module:
that shim lives in TypeScript and cannot be imported from Python. The Phase-1
bootstrap, were one ever needed, would be the in-process TS handler factory in
``server.ts`` — but the Python driver goes straight to the spawned-supervisor
production path, so no shim-vs-spawned split exists here. The only seam is the
injectable ``Supervisor`` protocol, used by the offline unit tests to run
without a live supervisor or qwentescence.

Shared spine (verbatim, via run_arm — DO NOT re-implement per arm)
-----------------------------------------------------------------
build_prompt, MIN_COMPLETION_TOKENS (>=16K/turn floor), MAX_TURNS,
WALL_CLOCK_SECONDS, classify_outcome, gold_test_globs, extract_source_patch
(the model_patch is THIS git extraction off the worktree — NEVER a
supervisor-returned patch), write_prediction. Worktrees via materialize.
"""

from __future__ import annotations

import json
import select
import subprocess
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import materialize  # noqa: E402
import run_arm  # noqa: E402
import subset  # noqa: E402

ARM = "A"
DEFAULT_MODEL_NAME = "qwen3.6-35b-a3b.arm-a"
DEFAULT_PREDICTIONS_PATH = HERE / "predictions.A.jsonl"

# Path to the built supervisor entrypoint, relative to repo root.
REPO_ROOT = HERE.parent.parent
SUPERVISOR_DIST = (
    REPO_ROOT / "mcp-bridges" / "qwen-agent-server" / "dist" / "server.js"
)

# Terminal supervisor session states the poll loop stops on.
TERMINAL_STATES = frozenset({"complete", "error"})

# Poll cadence (seconds) for the spawned-supervisor path. The wall-clock guard
# is enforced by the driver against run_arm.WALL_CLOCK_SECONDS, independent of
# this cadence.
POLL_INTERVAL_SECONDS = 2.0


# ── qwen_spawn opts (the load-bearing dict) ─────────────────────────────────


def build_spawn_opts(worktree: Path) -> dict[str, Any]:
    """The exact opts dict sent to qwen_spawn for an Arm-A instance.

    * ``write_authority: true``  → supervisor sets permissionMode='yolo'
      (file-edit + shell), so the inner Qwen can actually edit source.
    * ``cwd: <worktree>``        → the per-instance throwaway worktree, as an
      ABSOLUTE path (the supervisor's schema rejects relative paths). The inner
      Qwen Code process runs with this as its working directory.
    * ``extensions: {only: []}`` → resolves to envValue "none" in the
      supervisor (extensions.resolveExtensions step 8: an explicit only=[]
      renders as "none"), disabling ALL Qwen Code extensions INCLUDING the
      ~/.qwen nx extension. This is the tool-surface-parity mechanism with
      Arm B (which disables nx via a CLI config fixture).
    Token-budget note (per stacked review): the supervisor's
    ``max_context_tokens`` is the ACCUMULATED-context abort ceiling (default
    ~111000 = 0.85*ctx_size), NOT a per-turn output cap. It is a DIFFERENT axis
    from Arm B's ``QWEN_CODE_MAX_OUTPUT_TOKENS`` (an explicit per-turn output
    floor). We therefore leave ``max_context_tokens`` at the supervisor default
    (pinning it to 16K would prematurely abort multi-turn sessions). The
    per-turn output floor for the inner qwen under the supervisor is the
    qwen-code default — achieving exact per-turn parity with Arm B's 16K floor
    requires the supervisor to forward QWEN_CODE_MAX_OUTPUT_TOKENS to the inner
    process, tracked as a follow-up. The report MUST state this asymmetry
    rather than claim an identical floor.
    """
    return {
        "write_authority": True,
        "cwd": str(worktree),
        "extensions": {"only": []},
        "max_tool_calls": 0,  # unlimited; turn budget is governed by MAX_TURNS
    }


# ── Injectable supervisor seam ──────────────────────────────────────────────


class Supervisor(Protocol):
    """The supervisor surface the driver depends on. The production
    implementation is ``SpawnedSupervisor`` (a real MCP stdio client); unit
    tests inject a fake so they run offline."""

    def spawn(self, task: str, opts: Mapping[str, Any]) -> dict[str, Any]: ...

    def poll(
        self, task_id: str, since: str | None = None
    ) -> dict[str, Any]: ...

    def send(self, task_id: str, message: str) -> dict[str, Any]: ...

    def stop(self, task_id: str) -> dict[str, Any]: ...

    def close(self) -> None: ...


class SupervisorError(RuntimeError):
    """Raised when the supervisor returns an error envelope or the transport
    fails."""


# ── Production MCP stdio client (the headline path) ─────────────────────────


class SpawnedSupervisor:
    """Spawn ``node dist/server.js`` and speak MCP JSON-RPC over its stdio.

    Standard-library only: the MCP stdio transport is newline-delimited
    JSON-RPC 2.0. We perform the ``initialize`` handshake, send the
    ``notifications/initialized`` notice, then issue ``tools/call`` requests for
    the four qwen_* tools. Each tool's result is a single text content block
    whose ``text`` is the JSON-serialized tool return (see server.ts tool
    registrations), which we parse back into a dict.
    """

    PROTOCOL_VERSION = "2024-11-05"

    def __init__(
        self,
        dist_path: Path = SUPERVISOR_DIST,
        *,
        node_bin: str = "node",
        env: Mapping[str, str] | None = None,
        startup_timeout: float = 30.0,
    ) -> None:
        if not dist_path.exists():
            raise SupervisorError(
                f"supervisor dist not built: {dist_path} "
                "(run `npm run build` in mcp-bridges/qwen-agent-server)"
            )
        import os

        full_env = {**os.environ, **(env or {})}
        self._proc = subprocess.Popen(
            [node_bin, str(dist_path)],
            cwd=str(dist_path.parent.parent),
            env=full_env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._initialize(startup_timeout)

    # -- wire helpers --

    def _write(self, msg: dict[str, Any]) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

    def _read_message(self, timeout: float) -> dict[str, Any]:
        """Read one JSON-RPC message line from the supervisor's stdout.

        The MCP server may interleave nothing on stdout besides protocol
        messages (logs go to stderr via pino), so each non-empty line is a
        JSON-RPC frame.
        """
        assert self._proc.stdout is not None
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SupervisorError("timed out reading supervisor response")
            # readline() is a blocking syscall — guard it with select so the
            # deadline can actually fire if the supervisor stops responding
            # (otherwise Arm A could hang forever, defeating the wall-clock
            # guarantee).
            rlist, _, _ = select.select([self._proc.stdout], [], [], remaining)
            if not rlist:
                raise SupervisorError("timed out reading supervisor response")
            line = self._proc.stdout.readline()
            if line == "":
                rc = self._proc.poll()
                err = ""
                if self._proc.stderr is not None:
                    err = self._proc.stderr.read() or ""
                raise SupervisorError(
                    f"supervisor process closed stdout (rc={rc}): {err[:500]}"
                )
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                # Non-JSON line on stdout (shouldn't happen); skip it.
                continue

    def _request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        self._next_id += 1
        req_id = self._next_id
        self._write({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        # Read until the matching id arrives (skip notifications / other ids).
        while True:
            msg = self._read_message(timeout)
            if msg.get("id") != req_id:
                continue
            if "error" in msg:
                raise SupervisorError(f"{method} failed: {msg['error']}")
            return msg.get("result", {})

    def _initialize(self, timeout: float) -> None:
        self._request(
            "initialize",
            {
                "protocolVersion": self.PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "rdr-006-arm-a", "version": "1.0.0"},
            },
            timeout,
        )
        self._write({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def _call_tool(self, name: str, arguments: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
        result = self._request(
            "tools/call", {"name": name, "arguments": arguments}, timeout
        )
        content = result.get("content") or []
        for block in content:
            if block.get("type") == "text":
                return json.loads(block["text"])
        raise SupervisorError(f"{name}: no text content in tool result: {result}")

    # -- Supervisor protocol --

    def spawn(self, task: str, opts: Mapping[str, Any]) -> dict[str, Any]:
        return self._call_tool("qwen_spawn", {"task": task, "opts": dict(opts)})

    def poll(self, task_id: str, since: str | None = None) -> dict[str, Any]:
        args: dict[str, Any] = {"task_id": task_id}
        if since is not None:
            args["opts"] = {"since": since}
        return self._call_tool("qwen_poll", args)

    def send(self, task_id: str, message: str) -> dict[str, Any]:
        return self._call_tool("qwen_send", {"task_id": task_id, "message": message})

    def stop(self, task_id: str) -> dict[str, Any]:
        return self._call_tool("qwen_stop", {"task_id": task_id})

    def close(self) -> None:
        try:
            if self._proc.stdin is not None:
                self._proc.stdin.close()
        except OSError:
            pass
        try:
            self._proc.terminate()
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            try:
                self._proc.wait(timeout=5)  # reap; avoid a zombie per instance
            except subprocess.TimeoutExpired:
                pass
        except ProcessLookupError:
            pass


# ── Poll-to-terminal loop ───────────────────────────────────────────────────


def _drive_to_terminal(
    supervisor: Supervisor,
    task_id: str,
    *,
    wall_clock_seconds: float = run_arm.WALL_CLOCK_SECONDS,
    poll_interval: float = POLL_INTERVAL_SECONDS,
) -> tuple[dict[str, Any], bool]:
    """Poll until the session reaches a terminal state OR the wall-clock cutoff
    fires. Returns ``(last_poll_result, timed_out)``.

    A session that goes ``idle`` (one turn done, waiting for the next user
    message) is treated as the agent having finished its work — the prompt is a
    single self-contained task, so we stop on idle rather than feeding empty
    turns. ``complete``/``error`` are hard terminals.
    """
    deadline = time.monotonic() + wall_clock_seconds
    since: str | None = None
    last: dict[str, Any] = {}
    while True:
        last = supervisor.poll(task_id, since=since)
        latest = last.get("latest_event_id")
        if latest:
            since = latest
        state = last.get("state")
        if state in TERMINAL_STATES or state == "idle":
            return last, False
        if time.monotonic() >= deadline:
            return last, True
        time.sleep(poll_interval)


def _turns_and_tool_calls(poll_result: Mapping[str, Any]) -> tuple[int | None, int | None]:
    """Pull turn + tool_call counters from the supervisor's poll budget."""
    budget = poll_result.get("budget") or {}
    tool_calls = budget.get("tool_calls")
    # The supervisor surfaces tool_calls on every poll; turns are reported via
    # last_known on error, else inferred from turn_complete events. We expose
    # tool_calls directly and leave turns to the spine's classify rule using
    # the count derived below.
    last_known = poll_result.get("last_known") or {}
    turns = last_known.get("turns_completed")
    return turns, tool_calls


# ── Per-instance run ────────────────────────────────────────────────────────


def run_instance(
    instance_id: str,
    *,
    rows: Mapping[str, Mapping[str, Any]] | None = None,
    supervisor: Supervisor | None = None,
    predictions_path: Path = DEFAULT_PREDICTIONS_PATH,
    model_name: str = DEFAULT_MODEL_NAME,
    wall_clock_seconds: float = run_arm.WALL_CLOCK_SECONDS,
    poll_interval: float = POLL_INTERVAL_SECONDS,
) -> run_arm.RunResult:
    """Run Arm A for one instance through the (injectable) supervisor seam.

    Materializes the worktree, spawns a supervisor session pointed at it with
    write_authority + extensions-disabled, polls to terminal, extracts the
    arm-uniform source patch via git, writes the prediction, and cleans up.

    ``supervisor`` defaults to a freshly spawned production ``SpawnedSupervisor``
    (the headline path); tests inject a fake to run offline.
    """
    if rows is None:
        rows = subset.load_full_rows()
    row = rows[instance_id]
    repo = row["repo"]
    base_commit = row["base_commit"]
    prompt = run_arm.build_prompt(row["problem_statement"], repo)
    extra_test_paths = run_arm.gold_test_globs(row["test_patch"])

    owns_supervisor = supervisor is None
    worktree: Path | None = None
    start = time.monotonic()
    try:
        worktree = materialize.materialize(instance_id, repo, base_commit)
        if supervisor is None:
            supervisor = SpawnedSupervisor()

        opts = build_spawn_opts(worktree)
        spawn_result = supervisor.spawn(prompt, opts)
        if "error" in spawn_result:
            raise SupervisorError(f"qwen_spawn error: {spawn_result['error']}")
        task_id = spawn_result["task_id"]

        poll_result, timed_out = _drive_to_terminal(
            supervisor,
            task_id,
            wall_clock_seconds=wall_clock_seconds,
            poll_interval=poll_interval,
        )

        # Best-effort stop so the supervisor reaps the session.
        try:
            supervisor.stop(task_id)
        except SupervisorError:
            pass

        duration = time.monotonic() - start
        turns, tool_calls = _turns_and_tool_calls(poll_result)

        # Outcome: timeout dominates; otherwise an error-state poll is ERROR,
        # else funnel through the shared classify rule with the arm-specific
        # turn count.
        if timed_out:
            outcome = run_arm.Outcome.TIMEOUT
            returncode: int | None = None
        elif poll_result.get("state") == "error":
            outcome = run_arm.Outcome.ERROR
            returncode = 1
        else:
            returncode = 0
            outcome = run_arm.classify_outcome(0, turns_used=turns)

        # model_patch ALWAYS from git extraction off the worktree — NEVER any
        # supervisor-returned patch (arm-uniform patch semantics).
        model_patch, contaminated = run_arm.extract_source_patch(
            worktree, extra_test_paths=extra_test_paths, base=base_commit
        )

        run_arm.write_prediction(predictions_path, instance_id, model_name, model_patch)

        return run_arm.RunResult(
            instance_id=instance_id,
            arm=ARM,
            outcome=outcome,
            model_patch=model_patch,
            test_edit_contamination=contaminated,
            duration_seconds=duration,
            returncode=returncode,
            telemetry={
                "turns": turns,
                "tool_calls": tool_calls,
                "supervisor_state": poll_result.get("state"),
                "spawn_opts": opts,
            },
        )
    finally:
        if owns_supervisor and supervisor is not None:
            supervisor.close()
        if worktree is not None:
            materialize.cleanup(instance_id, repo)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="RDR-006 Arm A — qwen via MCP supervisor")
    ap.add_argument("instance_id")
    ap.add_argument("--predictions", default=str(DEFAULT_PREDICTIONS_PATH))
    ap.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    args = ap.parse_args()

    result = run_instance(
        args.instance_id,
        predictions_path=Path(args.predictions),
        model_name=args.model_name,
    )
    print(json.dumps({
        "instance_id": result.instance_id,
        "arm": result.arm,
        "outcome": result.outcome.value,
        "duration_seconds": round(result.duration_seconds, 1),
        "test_edit_contamination": result.test_edit_contamination,
        "telemetry": {k: v for k, v in result.telemetry.items() if k != "spawn_opts"},
        "patch_bytes": len(result.model_patch),
    }, indent=2))


if __name__ == "__main__":
    main()
