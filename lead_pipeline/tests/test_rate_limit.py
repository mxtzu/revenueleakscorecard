"""Rate limiting and concurrency control (requirement 8).

Uses an injected fake clock so the assertions are exact and the suite stays
fast - no real sleeping.
"""

from __future__ import annotations

import asyncio

import pytest

from lead_pipeline.utils.rate_limit import RateLimiter, TokenBucket


class FakeClock:
    """Monotonic clock that only advances when someone sleeps."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.now += delay

    @property
    def total_slept(self) -> float:
        return sum(self.sleeps)


class TestTokenBucket:
    @pytest.mark.asyncio
    async def test_burst_is_free_then_throttles(self):
        clock = FakeClock()
        bucket = TokenBucket(2.0, burst=2, time_fn=clock.time, sleep_fn=clock.sleep)

        assert await bucket.acquire() == 0.0
        assert await bucket.acquire() == 0.0
        third = await bucket.acquire()
        assert third == pytest.approx(0.5, abs=1e-6)
        assert clock.total_slept == pytest.approx(0.5, abs=1e-6)

    @pytest.mark.asyncio
    async def test_sustained_rate_matches_configuration(self):
        clock = FakeClock()
        bucket = TokenBucket(1.0, burst=1, time_fn=clock.time, sleep_fn=clock.sleep)
        for _ in range(5):
            await bucket.acquire()
        # 1 free burst token, then 4 x 1s.
        assert clock.total_slept == pytest.approx(4.0, abs=1e-6)

    @pytest.mark.asyncio
    async def test_tokens_refill_over_time(self):
        clock = FakeClock()
        bucket = TokenBucket(4.0, burst=4, time_fn=clock.time, sleep_fn=clock.sleep)
        for _ in range(4):
            await bucket.acquire()
        clock.now += 1.0  # a second passes
        assert await bucket.acquire() == 0.0

    def test_invalid_rate_rejected(self):
        with pytest.raises(ValueError):
            TokenBucket(0)


class TestRateLimiter:
    @pytest.mark.asyncio
    async def test_hosts_are_limited_independently(self):
        clock = FakeClock()
        limiter = RateLimiter(1.0, time_fn=clock.time, sleep_fn=clock.sleep)
        await limiter.acquire("a.test")
        await limiter.acquire("b.test")
        assert clock.total_slept == 0.0  # separate buckets, both had a burst token
        await limiter.acquire("a.test")
        assert clock.total_slept == pytest.approx(1.0, abs=1e-6)

    @pytest.mark.asyncio
    async def test_per_host_override(self):
        clock = FakeClock()
        limiter = RateLimiter(
            10.0, overrides={"slow.test": 0.5}, time_fn=clock.time, sleep_fn=clock.sleep
        )
        await limiter.acquire("slow.test")
        await limiter.acquire("slow.test")
        assert clock.total_slept == pytest.approx(2.0, abs=1e-6)

    @pytest.mark.asyncio
    async def test_crawl_delay_lowers_the_rate(self):
        clock = FakeClock()
        limiter = RateLimiter(2.0, time_fn=clock.time, sleep_fn=clock.sleep)
        limiter.apply_crawl_delay("polite.test", 5.0)  # 0.2 req/s
        await limiter.acquire("polite.test")
        await limiter.acquire("polite.test")
        assert clock.total_slept == pytest.approx(5.0, abs=1e-6)

    @pytest.mark.asyncio
    async def test_per_host_concurrency_is_capped(self):
        limiter = RateLimiter(1000.0, global_concurrency=10, per_host_concurrency=2)
        active = 0
        peak = 0

        async def task():
            nonlocal active, peak
            async with limiter.slot("busy.test"):
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1

        await asyncio.gather(*(task() for _ in range(8)))
        assert peak <= 2

    @pytest.mark.asyncio
    async def test_global_concurrency_is_capped(self):
        limiter = RateLimiter(1000.0, global_concurrency=3, per_host_concurrency=3)
        active = 0
        peak = 0

        async def task(index: int):
            nonlocal active, peak
            async with limiter.slot(f"host{index}.test"):
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.01)
                active -= 1

        await asyncio.gather(*(task(i) for i in range(9)))
        assert peak <= 3

    @pytest.mark.asyncio
    async def test_slot_releases_on_exception(self):
        limiter = RateLimiter(1000.0, global_concurrency=1, per_host_concurrency=1)
        with pytest.raises(RuntimeError):
            async with limiter.slot("x.test"):
                raise RuntimeError("boom")
        # If the semaphores leaked this would deadlock.
        async with limiter.slot("x.test"):
            pass
