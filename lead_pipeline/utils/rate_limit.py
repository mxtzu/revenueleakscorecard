"""Async rate limiting and concurrency control.

The clock and sleep function are injectable so the limiter can be tested
deterministically without real waiting.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

TimeFn = Callable[[], float]
SleepFn = Callable[[float], Awaitable[None]]


class TokenBucket:
    """Classic token bucket: ``rate`` tokens/second with a burst allowance."""

    def __init__(
        self,
        rate: float,
        burst: float | None = None,
        *,
        time_fn: TimeFn | None = None,
        sleep_fn: SleepFn | None = None,
    ) -> None:
        if rate <= 0:
            raise ValueError("rate must be > 0")
        self.rate = float(rate)
        self.burst = float(burst if burst is not None else max(1.0, rate))
        self._time = time_fn or time.monotonic
        self._sleep = sleep_fn or asyncio.sleep
        self._tokens = self.burst
        self._updated = self._time()
        self._lock = asyncio.Lock()

    @property
    def tokens(self) -> float:
        return self._tokens

    def set_rate(self, rate: float) -> None:
        if rate > 0:
            self.rate = float(rate)
            self.burst = max(1.0, min(self.burst, max(1.0, rate)))

    def _refill(self) -> None:
        now = self._time()
        elapsed = max(0.0, now - self._updated)
        self._updated = now
        self._tokens = min(self.burst, self._tokens + elapsed * self.rate)

    async def acquire(self, amount: float = 1.0) -> float:
        """Block until ``amount`` tokens are available. Returns seconds waited."""
        waited = 0.0
        async with self._lock:
            while True:
                self._refill()
                if self._tokens >= amount:
                    self._tokens -= amount
                    return waited
                deficit = amount - self._tokens
                delay = deficit / self.rate
                waited += delay
                await self._sleep(delay)


@dataclass
class HostPolicy:
    rate_per_second: float
    concurrency: int


class RateLimiter:
    """Per-host token buckets plus global and per-host concurrency caps."""

    def __init__(
        self,
        default_rate: float = 1.0,
        *,
        global_concurrency: int = 10,
        per_host_concurrency: int = 2,
        overrides: dict[str, float] | None = None,
        time_fn: TimeFn | None = None,
        sleep_fn: SleepFn | None = None,
    ) -> None:
        self.default_rate = max(0.01, float(default_rate))
        self.global_concurrency = max(1, int(global_concurrency))
        self.per_host_concurrency = max(1, int(per_host_concurrency))
        self.overrides = {k.lower(): float(v) for k, v in (overrides or {}).items()}
        self._time = time_fn
        self._sleep = sleep_fn
        self._buckets: dict[str, TokenBucket] = {}
        self._host_semaphores: dict[str, asyncio.Semaphore] = {}
        self._global_semaphore: asyncio.Semaphore | None = None
        self.total_wait_seconds = 0.0

    def _global_sem(self) -> asyncio.Semaphore:
        if self._global_semaphore is None:
            self._global_semaphore = asyncio.Semaphore(self.global_concurrency)
        return self._global_semaphore

    def bucket_for(self, host: str) -> TokenBucket:
        key = (host or "").lower()
        bucket = self._buckets.get(key)
        if bucket is None:
            rate = self.overrides.get(key, self.default_rate)
            bucket = TokenBucket(rate, burst=max(1.0, rate), time_fn=self._time, sleep_fn=self._sleep)
            self._buckets[key] = bucket
        return bucket

    def set_host_rate(self, host: str, rate: float) -> None:
        """Lower a host's rate (used to honour ``Crawl-delay`` / 429 responses)."""
        key = (host or "").lower()
        if rate <= 0:
            return
        self.overrides[key] = rate
        bucket = self._buckets.get(key)
        if bucket is not None:
            bucket.set_rate(min(bucket.rate, rate))
        else:
            self._buckets[key] = TokenBucket(
                rate, burst=max(1.0, rate), time_fn=self._time, sleep_fn=self._sleep
            )

    def apply_crawl_delay(self, host: str, delay_seconds: float | None) -> None:
        if delay_seconds and delay_seconds > 0:
            self.set_host_rate(host, min(self.default_rate, 1.0 / delay_seconds))

    def host_semaphore(self, host: str) -> asyncio.Semaphore:
        key = (host or "").lower()
        sem = self._host_semaphores.get(key)
        if sem is None:
            sem = asyncio.Semaphore(self.per_host_concurrency)
            self._host_semaphores[key] = sem
        return sem

    async def acquire(self, host: str) -> float:
        waited = await self.bucket_for(host).acquire()
        self.total_wait_seconds += waited
        return waited

    def slot(self, host: str) -> "_LimiterSlot":
        """Async context manager holding global + per-host concurrency slots."""
        return _LimiterSlot(self, host)


class _LimiterSlot:
    def __init__(self, limiter: RateLimiter, host: str) -> None:
        self._limiter = limiter
        self._host = host
        self._global = limiter._global_sem()
        self._host_sem = limiter.host_semaphore(host)

    async def __aenter__(self) -> "_LimiterSlot":
        await self._global.acquire()
        try:
            await self._host_sem.acquire()
        except BaseException:
            self._global.release()
            raise
        try:
            await self._limiter.acquire(self._host)
        except BaseException:
            self._host_sem.release()
            self._global.release()
            raise
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._host_sem.release()
        self._global.release()
