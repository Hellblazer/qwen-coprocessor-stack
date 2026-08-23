# solution/ -- grader use only, never shown to the model

This directory holds the gold fix for `intervals.py`. It exists so the
grader can validate the fixture itself, independent of any model run:

1. Copy `solution/intervals.py` over `files/intervals.py` (test file
   unchanged) and run the fixture's test command. It must pass in full.
2. Run the test command against the unmodified `files/` tree. It must
   fail (see `battery/README.md` for which tests are expected to fail
   and why).

Both checks are asserted in this fixture's validation record. Nothing
under `solution/` is copied into a model's working tree — the `setup`
step in `task.json` only ever materializes `files/`.
