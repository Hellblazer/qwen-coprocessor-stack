# solution/ -- grader use only, never shown to the model

This directory holds the minimal correct `ratelimiter.py` (23 lines).
It exists so the grader can validate the fixture itself, independent of
any model run:

1. Copy `solution/ratelimiter.py` into a fresh copy of `files/` and run
   `verify.py` against it. It must pass (exit 0).
2. Run `verify.py` against the unmodified `files/` tree (no
   `ratelimiter.py` at all). It must fail.
3. See the sibling `solution-negative-overengineered/` directory: a
   different, functionally-correct-but-109-line implementation that must
   FAIL `verify.py` on the line-count check alone, despite passing every
   test. Proves the fixture actually catches over-engineering, not just
   test failure.

Nothing under `solution/` or `solution-negative-*/` is copied into a
model's working tree — the `setup` step in `task.json` only ever
materializes `files/`.
