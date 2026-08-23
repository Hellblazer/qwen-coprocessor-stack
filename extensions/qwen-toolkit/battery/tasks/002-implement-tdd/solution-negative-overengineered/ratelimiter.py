"""Token-bucket style rate limiting utilities.

This module provides a configurable, extensible rate-limiting framework
supporting pluggable limiting strategies via the RateLimiterStrategy
abstract base class. Currently only TokenBucketStrategy is implemented,
but the architecture is designed to support LeakyBucketStrategy and
SlidingWindowStrategy in the future without breaking the public API.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class RateLimiterError(Exception):
    """Base class for all rate limiter errors."""


class InvalidConfigurationError(RateLimiterError):
    """Raised when a RateLimiterConfig is constructed with invalid values."""


@dataclass
class RateLimiterConfig:
    """Configuration for a rate limiter instance."""

    capacity: int
    refill_rate: float
    clock: Optional[Callable[[], float]] = None

    def __post_init__(self) -> None:
        if self.capacity <= 0:
            raise InvalidConfigurationError("capacity must be positive")
        if self.refill_rate <= 0:
            raise InvalidConfigurationError("refill_rate must be positive")


class RateLimiterStrategy(ABC):
    """Abstract base class for pluggable rate-limiting strategies."""

    @abstractmethod
    def allow(self) -> bool:
        """Return True and consume capacity if a request should be allowed."""
        raise NotImplementedError

    @abstractmethod
    def reset(self) -> None:
        """Reset the limiter to its initial full-capacity state."""
        raise NotImplementedError


class TokenBucketStrategy(RateLimiterStrategy):
    """Token-bucket implementation of RateLimiterStrategy."""

    def __init__(self, config: RateLimiterConfig) -> None:
        self._config = config
        self._clock = config.clock or time.monotonic
        self._tokens = float(config.capacity)
        self._last_refill_ts = self._clock()
        logger.debug("TokenBucketStrategy initialized with config=%s", config)

    def _refill(self) -> None:
        now = self._clock()
        elapsed = now - self._last_refill_ts
        self._last_refill_ts = now
        refill_amount = elapsed * self._config.refill_rate
        self._tokens = min(self._config.capacity, self._tokens + refill_amount)
        logger.debug("Refilled %.4f tokens; total now %.4f", refill_amount, self._tokens)

    def allow(self) -> bool:
        self._refill()
        if self._tokens >= 1:
            self._tokens -= 1
            logger.debug("Request allowed; %.4f tokens remaining", self._tokens)
            return True
        logger.debug("Request denied; %.4f tokens available", self._tokens)
        return False

    def reset(self) -> None:
        self._tokens = float(self._config.capacity)
        self._last_refill_ts = self._clock()


def create_rate_limiter(
    capacity: int, refill_rate: float, clock: Optional[Callable[[], float]] = None
) -> RateLimiterStrategy:
    """Factory function for constructing a configured rate limiter strategy."""
    config = RateLimiterConfig(capacity=capacity, refill_rate=refill_rate, clock=clock)
    return TokenBucketStrategy(config)


class TokenBucket:
    """Backwards-compatible facade over TokenBucketStrategy exposing the
    spec's required public interface."""

    def __init__(self, capacity: int, refill_rate: float, clock: Optional[Callable[[], float]] = None) -> None:
        self._strategy = create_rate_limiter(capacity, refill_rate, clock)

    def allow(self) -> bool:
        return self._strategy.allow()

    def reset(self) -> None:
        self._strategy.reset()
