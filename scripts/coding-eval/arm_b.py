# SPDX-License-Identifier: MIT
"""Arm B driver — raw ``qwen-code`` CLI against qwentescence (RDR-006 40v.5).

Arm B is the **control arm**: it runs the *same model* (qwen3.6-35b-a3b, served
by qwentescence at ``http://qwentescence:1234/v1``) as Arm A, but through the
raw ``qwen-code`` CLI instead of the MCP supervisor wrapper. Comparing A vs B
isolates the effect of the supervisor wrapper from the underlying model. The
fairness/validity spine (prompt, patch extraction, timeout, outcome
classification, prediction writer) is shared verbatim with arms A and C; only
the *invocation flags* are arm-specific.

Spike invocation (RF-3, verified)::

    qwen --auth-type openai \\
         --openai-base-url http://qwentescence:1234/v1 \\
         --openai-api-key sk-local \\
         -m qwen3.6-35b-a3b --yolo <prompt>

Iso-config / fairness notes (stated in the report):

  * **Iso-prompt.** The prompt is ``run_arm.build_prompt`` verbatim — the
    positional prompt argument is the shared task prompt, never branched per arm.

  * **Tool-surface isolation (mandatory).** The developer's real ``~/.qwen``
    installs an ``nx`` extension that registers an ``nx`` MCP server, giving the
    raw CLI a *larger* tool surface than Arm A's supervisor. To make the two
    arms comparable we run the qwen CLI with ``HOME`` pointed at a pinned,
    committed clean config fixture (``fixtures/qwen-clean/``) whose
    ``.qwen/extensions/`` is empty. ``qwen-code`` resolves its user config and
    user-extensions directory from ``os.homedir()`` (the bundled constant is
    ``QWEN_DIR = ".qwen"``, joined onto the home dir), so overriding ``HOME``
    yields ``<fixture>/.qwen/extensions`` — empty — and the nx extension is OFF.

    Mechanism verification (how we know nx is disabled):
      - ``qwen extensions list`` with the real HOME prints ``✓ nx (0.1.0)`` with
        ``MCP servers: nx``; with ``HOME=fixtures/qwen-clean`` it prints
        ``No extensions installed.``
      - The ``-o json`` *init* event under the clean HOME reports
        ``"mcp_servers": []`` and a ``tools`` array of only the qwen *core*
        tools (read_file, edit, write_file, run_shell_command, glob,
        grep_search, …) — no nx tools. ``init_event_tools()`` extracts this
        list so the report can state the active tool set per arm.

    NOTE on ``QWEN_CONFIG_DIR``: despite the name, the bundled
    ``QWEN_CONFIG_DIR`` variable controls the *context filename* (QWEN.md /
    GEMINI.md), NOT the config/home directory. The user-config + extensions dir
    is anchored on ``os.homedir()``. Overriding ``HOME`` is therefore the
    correct, verified mechanism — not ``QWEN_CONFIG_DIR``.

  * **Per-turn completion budget (>=16K).** Qwen starves reasoning if the
    per-request output cap is too low (the bundled default caps at 8K). The CLI
    honours the ``QWEN_CODE_MAX_OUTPUT_TOKENS`` env var as the per-request
    max-output-tokens; we set it to ``run_arm.MIN_COMPLETION_TOKENS`` (16384) so
    a starved-reasoning run is not mis-scored as a false failure. (bd memory
    ``shakeout-2026-06-06-reasoning-token-budget``.)

  * **Turn cap.** ``--max-session-turns run_arm.MAX_TURNS`` pins the same turn
    ceiling every arm uses; the resulting ``num_turns`` (telemetry) funnels
    through the shared ``run_arm.classify_outcome``.

Patch provenance (locked): the prediction's ``model_patch`` comes from
``run_arm.extract_source_patch`` off the worktree — the arm-uniform ``git diff``
against ``base_commit`` — NEVER from any field of the qwen JSON output. All three
arms therefore have identical patch semantics.

Telemetry parseability finding (resolved here): YES — the qwen-code CLI emits
structured turn/token counts in yolo mode. Running with ``-o json`` produces a
JSON *array* of events; the final ``{"type":"result", ...}`` object carries
``num_turns``, ``usage`` (input/output/total tokens), ``duration_ms``,
``duration_api_ms``, ``is_error``, ``subtype`` and a ``stats`` block. This is a
clean structured parse — NOT fragile stdout scraping — so we capture it into
``RunResult.telemetry``. ``num_turns`` feeds ``classify_outcome``. qwen runs on
local hardware, so cost is recorded as ``$0`` (no ``total_cost_usd`` field).
If the envelope is ever absent/malformed (shape drift), ``parse_telemetry``
degrades to ``telemetry_parseable=False`` rather than crashing — the
git-extracted patch remains the source of truth regardless.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import materialize
import run_arm

ARM = "B"
MODEL = "qwen3.6-35b-a3b"
MODEL_NAME = "qwen3.6-35b-a3b.arm-b"
DEFAULT_PREDICTIONS_PATH = Path("predictions.B.jsonl")

OPENAI_BASE_URL = "http://qwentescence:1234/v1"
OPENAI_API_KEY = "sk-local"

# Clean-HOME fixture + per-run copy live on the spine (run_arm) so both qwen
# arms share one definition. Re-exported here for back-compat with callers/tests
# that reference arm_b.CLEAN_HOME / arm_b.ephemeral_home.
HERE = Path(__file__).resolve().parent
CLEAN_HOME = run_arm.CLEAN_HOME
ephemeral_home = run_arm.ephemeral_home


def build_argv(prompt: str) -> list[str]:
    """The arm-specific raw ``qwen-code`` invocation (RF-3 spike + iso-config).

    ``--auth-type openai`` + ``--openai-base-url`` + ``--openai-api-key`` route
    the CLI at the qwentescence-served model. ``-m qwen3.6-35b-a3b`` pins the
    model. ``--yolo`` auto-accepts all tool actions (non-interactive editing).
    ``-o json`` yields the structured telemetry envelope (turns/tokens).
    ``--max-session-turns`` pins the shared turn ceiling. The prompt is the
    final positional argument (the shared verbatim prompt).
    """
    return [
        "qwen",
        "--auth-type",
        "openai",
        "--openai-base-url",
        OPENAI_BASE_URL,
        "--openai-api-key",
        OPENAI_API_KEY,
        "-m",
        MODEL,
        "--yolo",
        "-o",
        "json",
        "--max-session-turns",
        str(run_arm.MAX_TURNS),
        prompt,
    ]


def build_env(clean_home: Path = CLEAN_HOME) -> dict:
    """Arm-specific env overlay layered on top of os.environ by run_with_timeout.

    ``HOME`` -> the pinned clean config fixture: empty ``.qwen/extensions`` so
    the nx MCP extension is OFF and Arm B's tool surface matches Arm A.
    ``QWEN_CODE_MAX_OUTPUT_TOKENS`` -> the >=16K per-request completion budget
    (``run_arm.MIN_COMPLETION_TOKENS``) so qwen reasoning is not starved.
    """
    return {
        "HOME": str(clean_home),
        "QWEN_CODE_MAX_OUTPUT_TOKENS": str(run_arm.MIN_COMPLETION_TOKENS),
    }


def _iter_events(stdout: str) -> list[dict]:
    """Parse the ``-o json`` stdout into a list of event dicts.

    The CLI emits a JSON array of events. Be tolerant of shape drift: accept a
    bare object too, and return [] on empty / non-JSON / unexpected shapes.
    """
    text = (stdout or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return []
    if isinstance(parsed, list):
        return [e for e in parsed if isinstance(e, dict)]
    if isinstance(parsed, dict):
        return [parsed]
    return []


def init_event_tools(stdout: str) -> list[str]:
    """The active tool set, from the ``-o json`` init event's ``tools`` array.

    Reported per arm so the eval states each arm's tool surface. Empty list if
    no init event is present (e.g. malformed output)."""
    for ev in _iter_events(stdout):
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            tools = ev.get("tools")
            if isinstance(tools, list):
                return [str(t) for t in tools]
    return []


def init_event_mcp_servers(stdout: str) -> list:
    """The MCP servers active in the run, from the init event. Expected ``[]``
    under the clean-config fixture (proves the nx MCP server is OFF)."""
    for ev in _iter_events(stdout):
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            servers = ev.get("mcp_servers")
            if isinstance(servers, list):
                return servers
    return []


def parse_telemetry(stdout: str) -> dict:
    """Parse structured turn/token telemetry from the ``-o json`` output.

    The qwen-code CLI DOES emit structured telemetry in yolo mode (verified):
    a JSON array whose terminal ``{"type":"result", ...}`` object carries
    ``num_turns``, ``usage``, ``duration_ms``, etc. We parse that — never scrape
    free-text stdout. ``cost_usd`` is fixed at 0.0 (qwen runs on local hardware;
    there is no ``total_cost_usd`` field). On absent/malformed output we degrade
    to ``telemetry_parseable=False`` (the git-extracted patch is authoritative
    regardless), so a shape drift never crashes the run.
    """
    telemetry: dict = {
        "num_turns": None,
        "usage": None,
        "duration_ms": None,
        "duration_api_ms": None,
        "is_error": None,
        "subtype": None,
        "cost_usd": 0.0,  # qwen on local hardware — no metered cost
        "tools": [],
        "mcp_servers": None,
        "telemetry_parseable": False,
    }
    events = _iter_events(stdout)
    if not events:
        return telemetry

    telemetry["tools"] = init_event_tools(stdout)
    telemetry["mcp_servers"] = init_event_mcp_servers(stdout)

    result = next(
        (e for e in reversed(events) if e.get("type") == "result"), None
    )
    if result is None:
        return telemetry

    telemetry["telemetry_parseable"] = True
    telemetry["num_turns"] = result.get("num_turns")
    telemetry["usage"] = result.get("usage")
    telemetry["duration_ms"] = result.get("duration_ms")
    telemetry["duration_api_ms"] = result.get("duration_api_ms")
    telemetry["is_error"] = result.get("is_error")
    telemetry["subtype"] = result.get("subtype")
    return telemetry


def run_instance(
    instance_id: str,
    *,
    rows: dict | None = None,
    runner=run_arm.run_with_timeout,
    predictions_path: Path = DEFAULT_PREDICTIONS_PATH,
    model_name: str = MODEL_NAME,
) -> run_arm.RunResult:
    """Run Arm B (raw qwen-code CLI) for one instance, end to end.

    ``runner`` is injectable (defaults to ``run_arm.run_with_timeout``) so unit
    tests inject a fake returning a canned ``-o json`` envelope + leave a real
    worktree git repo to extract from — no live ``qwen`` call, no network.

    Returns a ``run_arm.RunResult`` and writes the swebench prediction line.
    """
    if rows is None:
        from subset import load_full_rows  # local import: network on first use

        rows = load_full_rows()

    row = rows[instance_id]
    repo = row["repo"]
    base_commit = row["base_commit"]
    extra_test_paths = run_arm.gold_test_globs(row["test_patch"])
    prompt = run_arm.build_prompt(row["problem_statement"], repo)
    argv = build_argv(prompt)
    # Per-run throwaway HOME copy so qwen's runtime writes never pollute the
    # committed clean-HOME fixture (tool surface stays fixed across the eval).
    home = ephemeral_home()
    env = build_env(clean_home=home)

    # Nested finally: rmtree(home) ALWAYS runs — even if materialize() raises
    # before the worktree exists, or if materialize.cleanup() raises (its
    # `git worktree prune` is outside cleanup's own except guard). Otherwise the
    # temp HOME leaks under /tmp across the 40-instance run.
    try:
        worktree = materialize.materialize(instance_id, repo, base_commit)
        try:
            outcome, returncode, stdout, _stderr, duration = runner(
                argv,
                timeout_seconds=run_arm.WALL_CLOCK_SECONDS,
                cwd=worktree,
                env=env,
            )

            telemetry = parse_telemetry(stdout)

            # model_patch comes from the arm-uniform git extraction off the
            # worktree (against base_commit) — NOT from the json envelope.
            model_patch, contaminated = run_arm.extract_source_patch(
                worktree,
                extra_test_paths=extra_test_paths,
                base=base_commit,
            )

            # The spine's runner owns TIMEOUT. For any non-timeout terminal
            # state, funnel through classify_outcome with qwen's num_turns.
            if outcome is not run_arm.Outcome.TIMEOUT:
                outcome = run_arm.classify_outcome(
                    returncode,
                    turns_used=telemetry.get("num_turns"),
                )

            run_arm.write_prediction(
                predictions_path, instance_id, model_name, model_patch
            )

            return run_arm.RunResult(
                instance_id=instance_id,
                arm=ARM,
                outcome=outcome,
                model_patch=model_patch,
                base_commit=base_commit,
                test_edit_contamination=contaminated,
                duration_seconds=duration,
                returncode=returncode,
                telemetry=telemetry,
            )
        finally:
            materialize.cleanup(instance_id, repo)
    finally:
        shutil.rmtree(home, ignore_errors=True)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Arm B (raw qwen-code CLI) driver")
    ap.add_argument("instance_id")
    ap.add_argument("--predictions", default=str(DEFAULT_PREDICTIONS_PATH))
    args = ap.parse_args()

    result = run_instance(
        args.instance_id, predictions_path=Path(args.predictions)
    )
    print(
        json.dumps(
            {
                "instance_id": result.instance_id,
                "arm": result.arm,
                "outcome": result.outcome.value,
                "test_edit_contamination": result.test_edit_contamination,
                "duration_seconds": result.duration_seconds,
                "returncode": result.returncode,
                "telemetry": result.telemetry,
                "patch_bytes": len(result.model_patch),
            }
        )
    )


if __name__ == "__main__":
    main()
