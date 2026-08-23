# qwen-toolkit battery -- task-spec contract

Objective, repeatable tasks for measuring the qwen-toolkit extension
(`extensions/qwen-toolkit/`) against a coprocessor backend. This document
is the format only; `battery/driver.ts` (bead 3su.8) is the dispatch
driver built against it.

## Driver stdin envelope (bead 3su.8 addendum)

`battery/driver.ts` reads one JSON object on stdin, matching `task.json`
verbatim plus one additional optional field:

- **`cwd`** (string, absolute path) -- the already-materialized working
  tree for this task instance (i.e. `setup.copy_dir`'s contents, already
  copied into a fresh directory). The driver does no file materialization
  of its own -- "thin by design," per the driver's own bead -- so
  something upstream (the Python runner, bead 3su.9) must copy
  `setup.copy_dir` into a real directory and pass its path here. Omitting
  `cwd` is only for ad hoc/manual driver invocation; the inner session
  then runs wherever it defaults to (`process.cwd()`), which is never
  what a real battery run wants.

The driver also takes one CLI flag, `--arm toolkit|control`, selecting
which `opts.extensions.only` to dispatch with (see driver.ts's header
comment) -- not part of `task.json` itself, since the same task is
dispatched twice, once per arm, to get a toolkit/control pair.

## Relationship to `scripts/bench/cases.json`

`scripts/bench/cases.json` is this repo's existing house style for
measurement fixtures: a JSON array of objects, each with `name`,
`prompt`, and an optional `oracle` (`match` mode + `expected`) for
single-shot operator correctness checks (summarize/extract/rank/etc).
A battery task extends that shape rather than replacing it -- `name`
and `prompt` mean the same thing here. The extension is everything
below: a battery task exercises an agentic session against a working
tree, not a single completion, so it needs a way to say what tree to
start from and how to score the result once the session ends.

## Directory layout

```
battery/
  README.md                    -- this file
  tasks/
    <NNN>-<slug>/
      task.json                -- the task spec (see fields below)
      files/                   -- copied verbatim into the model's working tree
      solution/                -- gold fix; grader-only, NEVER copied to the model
```

Each task gets its own numbered directory (`001-interval-debug`, `002-...`).
`task.json` is the spec instance; `files/` is everything the model sees;
`solution/` is everything the grader uses to validate the fixture itself
before trusting it to score a model.

## Task-spec fields

- **`name`** (string) -- matches the directory name (`cases.json` convention).
- **`family`** (string) -- one of `debug` | `implement-tdd` | `docs-explain`,
  matching the three toolkit agents under `extensions/qwen-toolkit/agents/`.
- **`prompt`** (string) -- the exact instruction handed to the model. Must
  describe the task on its own terms, not in the vocabulary of
  `extensions/qwen-toolkit/QWEN.md` or the family agent file (see
  *Anti-leakage* below) -- the battery measures whether the model can debug,
  not whether it can pattern-match the contract's own phrasing back at itself.
- **`setup`** (object) -- how the working tree is materialized. Currently one
  form: `{"copy_dir": "files"}` -- copy the named directory's contents,
  recursively and verbatim, into the root of a fresh working tree. Nothing
  outside the named directory is visible to the model.
- **`verify`** (object) -- the command that decides pass/fail:
  - `command` (array) -- argv, run from the materialized working tree root
    (`cwd: "."`).
  - `expected_exit_code` (int) -- the exit code that means "passed".
  - **The grader runs this command. The model never runs it as its own
    success signal.** See *Verify semantics* below -- this is not optional
    and not a detail left to the runner; it is part of the contract.
- **`max_tool_calls`** / **`timeout_ms`** (int) -- ceilings passed to the
  dispatch driver (W4.8), generous relative to any known-good run, not
  tuned to it. A task should be solvable well inside these numbers by a
  competent agent; they exist to bound a stuck or looping session, not to
  reward speed.
- **`notes`** (string) -- prior measurement context, if any exists, framed
  as calibration (see *Baseline vs. calibration* below) -- never omitted
  when a real prior result exists, never phrased as a target.
- **`oracle`** (object, optional) -- inherited from `cases.json` unchanged
  (`match` + `expected`) for tasks whose correctness is a single structured
  comparison. Debug-family tasks generally omit it: `verify`'s exit code
  already is the pass/fail signal, so a second oracle would be redundant.

## Verify semantics

The grading sequence is always:

1. The grader materializes the working tree from `setup`.
2. The grader dispatches the model against that tree with the task's
   `prompt`.
3. Once the session ends, the grader -- not the model -- runs `verify.command`
   against the resulting tree and compares the exit code to
   `expected_exit_code`.

A model reporting "tests pass" or printing its own test output is not a
result. Only the grader's own invocation of `verify.command`, against the
tree as the model left it, counts. This mirrors the toolkit's own
`debug` agent contract (which tells the model to report what the tools
printed, not a self-assessment) but is enforced one level up: even a
compliant, well-behaved model transcript is not the source of truth here.

## Gold self-check (fixture validation)

A fixture is only trustworthy if its own gold solution actually solves
it. Every task directory ships a `solution/` alongside `files/`:

- **`solution/` is never part of `setup`.** It is not copied into any
  model's working tree under any task; the model never sees it.
- Before a fixture is trusted to grade a model, the grader (or, at
  authoring time, the fixture author) runs `verify.command` twice:
  - Against `files/` as shipped -- **must fail** (the seeded defect(s)
    should reproduce).
  - Against `files/` with `intervals.py`-equivalent files replaced by
    their `solution/` counterparts -- **must pass at
    `expected_exit_code`**.
- A fixture whose gold solution does not score 100% is a broken fixture,
  full stop -- this is caught at authoring time, not discovered later
  from a batch of confusing model failures.

## Baseline vs. calibration

A `notes` field carrying a prior result (tool-call count, wall time,
pass rate) is a **difficulty calibration**, not a baseline to beat. It
tells a reader "this is roughly how hard this task is, on this hardware
and model pairing, on the date it was measured" -- not "future runs are
scored against this number." A regression investigation might use it as
one data point among others; a battery run is not failed or degraded
for taking longer or using more tool calls than a single prior sample.

## Anti-leakage

A task's `prompt` must describe the defect/feature/topic on its own
terms. It must not echo the phrasing of
`extensions/qwen-toolkit/QWEN.md` (the coding contract every dispatched
session already receives) or of the matching family agent file under
`extensions/qwen-toolkit/agents/`. If a prompt leans on that shared
vocabulary, the battery starts measuring whether the model recognizes
its own contract's language rather than whether it can do the task --
the contract text is present in every session already; it doesn't need
restating in the prompt, and restating it would make the task easier in
a way that doesn't generalize.

## Test command

Battery fixtures are pure stdlib Python. Tests are written as
`unittest.TestCase` classes so they run with zero dependencies:

```
python3 -m unittest -v test_intervals
```

run from the materialized working tree root. This is the exact command
in each debug-family task's `verify.command` and requires nothing beyond
a system `python3` -- no venv, no `pytest` install. (`unittest.TestCase`
classes are also auto-discovered by `pytest`, so a pytest-equipped
interpreter, e.g. `scripts/coding-eval/.venv/bin/python -m pytest`, runs
the same suite too -- but the canonical, always-available command is the
`unittest` one above, and that is what `verify.command` in every fixture
uses.)

## Fixture 001: interval-debug

`tasks/001-interval-debug/` recreates the interval-arithmetic debugging
task first run cold against the box's Qwen3.8-27B on 2026-08-16
(`bd recall qwen3.8-27b-post-promotion-battery-2026-08-16`). `files/`
ships `intervals.py` (a `merge()`/`subtract()` pair over half-open
`[start, end)` ranges) with three seeded conditions:

1. **Merge-adjacency bug (real).** `merge()`'s adjacency check uses a
   strict `<` where half-open semantics require `<=` -- two touching
   intervals like `(1, 3)` and `(3, 5)` fail to combine into `(1, 5)`.
2. **Subtract skip-ahead bug (real).** `subtract()`'s cursor-retirement
   check compares a b-interval's *start* against the cursor instead of
   its *end*, so it retires (permanently skips) b-intervals that still
   overlap the interval currently being processed.
3. **Red herring (correct, not a bug).** The line
   `bi = k - 1 if k > bi else bi` looks like a suspicious "undo" of
   progress just made and is a natural thing to flag or "fix away" --
   but it is required: a b-interval that outlasts the current
   a-interval can still overlap the next one, and this line is what
   keeps it available for that. `battery/tasks/001-interval-debug/`
   was validated by breaking this exact line (`bi = k`) with the other
   two bugs already fixed -- it reintroduces a test failure
   (`test_b_interval_spans_across_a_intervals`), confirming the line is
   load-bearing rather than decorative.

`files/test_intervals.py` ships 14 tests. Against `files/intervals.py`
as shipped, 4 fail (`test_touching_intervals_combine`,
`test_full_cover`, `test_b_interval_extends_past_a_start`,
`test_b_interval_spans_across_a_intervals`). Against
`solution/intervals.py`, all 14 pass.
