"""Grading oracle for ratelimiter.py. Do not modify this file.

Run with: python3 -m unittest -v test_ratelimiter
"""

import unittest

from ratelimiter import TokenBucket


class FakeClock:
    """A controllable clock: starts at 0.0, advances only when told to."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> None:
        self.t += dt


class TokenBucketTests(unittest.TestCase):
    def test_starts_full(self) -> None:
        clock = FakeClock()
        b = TokenBucket(capacity=3, refill_rate=1.0, clock=clock)
        self.assertTrue(b.allow())
        self.assertTrue(b.allow())
        self.assertTrue(b.allow())
        self.assertFalse(b.allow())

    def test_refills_over_time(self) -> None:
        clock = FakeClock()
        b = TokenBucket(capacity=2, refill_rate=1.0, clock=clock)
        self.assertTrue(b.allow())
        self.assertTrue(b.allow())
        self.assertFalse(b.allow())
        clock.advance(1.0)
        self.assertTrue(b.allow())
        self.assertFalse(b.allow())

    def test_refill_caps_at_capacity(self) -> None:
        clock = FakeClock()
        b = TokenBucket(capacity=2, refill_rate=1.0, clock=clock)
        self.assertTrue(b.allow())
        self.assertTrue(b.allow())
        clock.advance(100.0)
        self.assertTrue(b.allow())
        self.assertTrue(b.allow())
        self.assertFalse(b.allow())

    def test_fractional_refill_accumulates_across_calls(self) -> None:
        clock = FakeClock()
        b = TokenBucket(capacity=5, refill_rate=2.0, clock=clock)
        for _ in range(5):
            self.assertTrue(b.allow())
        self.assertFalse(b.allow())
        clock.advance(0.4)  # 0.8 tokens accrued -- not enough for one yet
        self.assertFalse(b.allow())
        clock.advance(0.1)  # total 1.0 tokens accrued now
        self.assertTrue(b.allow())

    def test_no_time_elapsed_denies_when_exhausted(self) -> None:
        clock = FakeClock()
        b = TokenBucket(capacity=1, refill_rate=1.0, clock=clock)
        self.assertTrue(b.allow())
        self.assertFalse(b.allow())

    def test_default_clock_is_usable(self) -> None:
        # No clock argument -- must default to a real wall clock, not crash.
        b = TokenBucket(capacity=1, refill_rate=1.0)
        self.assertTrue(b.allow())


if __name__ == "__main__":
    unittest.main()
