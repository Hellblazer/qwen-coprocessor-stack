"""Token-bucket rate limiter."""

import time
from typing import Callable, Optional


class TokenBucket:
    def __init__(self, capacity: int, refill_rate: float, clock: Optional[Callable[[], float]] = None):
        self._capacity = capacity
        self._refill_rate = refill_rate
        self._clock = clock or time.monotonic
        self._tokens = float(capacity)
        self._last = self._clock()

    def allow(self) -> bool:
        now = self._clock()
        elapsed = now - self._last
        self._last = now
        self._tokens = min(self._capacity, self._tokens + elapsed * self._refill_rate)
        if self._tokens >= 1:
            self._tokens -= 1
            return True
        return False
