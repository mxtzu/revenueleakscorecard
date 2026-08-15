"""HTTP client behaviour: failures, retries, backoff, caching, robots.txt.

Covers requirements 6 (failed website requests), 7 (API failures) and the
caching/backoff parts of 8.
"""

from __future__ import annotations

import pytest

from lead_pipeline.utils.cache import HttpCache, cache_key
from lead_pipeline.utils.http import (
    FakeTransport,
    HttpClient,
    HttpError,
    Request,
    Response,
    RobotsDisallowed,
)
from lead_pipeline.utils.rate_limit import RateLimiter


def build_client(transport, **kwargs) -> HttpClient:
    defaults = dict(
        user_agent="LeadPipelineTest/1.0",
        transport=transport,
        limiter=RateLimiter(1000.0, global_concurrency=8, per_host_concurrency=4),
        respect_robots=False,
        max_retries=3,
        backoff_base=0.0,
        backoff_max=0.0,
        jitter=False,
    )
    defaults.update(kwargs)
    return HttpClient(**defaults)


class TestFailureHandling:
    @pytest.mark.asyncio
    async def test_timeout_is_returned_not_raised(self):
        transport = FakeTransport(
            default={"status": 0, "text": "", "error": "Timeout after 20s", "error_kind": "timeout"}
        )
        client = build_client(transport)
        response = await client.get("https://slow.test/")
        assert response.ok is False
        assert response.error_kind == "timeout"
        assert client.stats.errors == 1

    @pytest.mark.asyncio
    async def test_dns_failure_is_handled(self):
        transport = FakeTransport(
            default={"status": 0, "text": "", "error": "getaddrinfo failed", "error_kind": "dns"}
        )
        response = await build_client(transport).get("https://does-not-exist.invalid/")
        assert response.ok is False and response.error_kind == "dns"

    @pytest.mark.asyncio
    async def test_404_is_not_retried(self):
        transport = FakeTransport(default={"status": 404, "text": "nope"})
        client = build_client(transport)
        response = await client.get("https://site.test/missing")
        assert response.status == 404
        assert len(transport.requests) == 1
        assert client.stats.retries == 0

    @pytest.mark.asyncio
    async def test_malformed_url_returns_error_response(self):
        response = await build_client(FakeTransport()).get("not-a-url")
        assert response.error_kind == "bad_url"

    @pytest.mark.asyncio
    async def test_ssl_error_surfaces(self):
        transport = FakeTransport(
            default={"status": 0, "text": "", "error": "SSL error: cert expired", "error_kind": "ssl"}
        )
        response = await build_client(transport).get("https://expired.test/")
        assert response.error_kind == "ssl"


class TestRetries:
    @pytest.mark.asyncio
    async def test_retries_then_succeeds(self):
        attempts = {"n": 0}

        def handler(request: Request) -> Response:
            attempts["n"] += 1
            if attempts["n"] < 3:
                return Response(url=request.url, status=503, text="unavailable")
            return Response(url=request.url, status=200, text="<html>ok</html>",
                            headers={"content-type": "text/html"})

        client = build_client(FakeTransport(default=handler))
        response = await client.get("https://flaky.test/")
        assert response.status == 200
        assert response.attempts == 3
        assert client.stats.retries == 2

    @pytest.mark.asyncio
    async def test_gives_up_after_max_retries(self):
        transport = FakeTransport(default={"status": 500, "text": "server error"})
        client = build_client(transport, max_retries=3)
        response = await client.get("https://broken.test/")
        assert response.status == 500
        assert len(transport.requests) == 3

    @pytest.mark.asyncio
    async def test_429_slows_the_host_down(self):
        transport = FakeTransport(default={"status": 429, "text": "slow down"})
        client = build_client(transport, max_retries=2)
        await client.get("https://ratelimited.test/")
        assert client.limiter.overrides["ratelimited.test"] < 1000.0

    @pytest.mark.asyncio
    async def test_retry_after_header_is_honoured(self):
        transport = FakeTransport(
            default={"status": 429, "text": "", "headers": {"retry-after": "7"}}
        )
        client = build_client(transport, backoff_max=30.0)
        delay = client._backoff_delay(1, Response(url="x", status=429, headers={"retry-after": "7"}))
        assert delay == 7.0
        await client.get("https://ratelimited.test/")

    @pytest.mark.asyncio
    async def test_exponential_backoff_grows(self):
        client = build_client(FakeTransport(), backoff_base=1.0, backoff_max=60.0)
        delays = [client._backoff_delay(attempt, Response(url="x", status=503)) for attempt in (1, 2, 3, 4)]
        assert delays == [1.0, 2.0, 4.0, 8.0]

    @pytest.mark.asyncio
    async def test_backoff_capped_at_max(self):
        client = build_client(FakeTransport(), backoff_base=1.0, backoff_max=5.0)
        assert client._backoff_delay(10, Response(url="x", status=503)) == 5.0


class TestApiFailures:
    @pytest.mark.asyncio
    async def test_get_json_raises_httperror_on_failure(self):
        transport = FakeTransport(default={"status": 403, "text": '{"error":"forbidden"}'})
        client = build_client(transport)
        with pytest.raises(HttpError) as exc_info:
            await client.get_json("https://api.test/v1/places")
        assert exc_info.value.status == 403

    @pytest.mark.asyncio
    async def test_invalid_json_raises_httperror(self):
        transport = FakeTransport(default={"status": 200, "text": "<html>not json</html>"})
        client = build_client(transport)
        with pytest.raises(HttpError) as exc_info:
            await client.get_json("https://api.test/v1/places")
        assert exc_info.value.kind == "invalid_json"

    @pytest.mark.asyncio
    async def test_json_parses_successfully(self):
        transport = FakeTransport(
            default={"status": 200, "text": '{"places":[{"id":"x"}]}',
                     "headers": {"content-type": "application/json"}}
        )
        payload = await build_client(transport).get_json("https://api.test/v1/places")
        assert payload["places"][0]["id"] == "x"


class TestCaching:
    @pytest.mark.asyncio
    async def test_second_request_is_served_from_cache(self, tmp_path):
        transport = FakeTransport(default={"status": 200, "text": "<html>cached</html>"})
        cache = HttpCache(tmp_path / "cache.sqlite", default_ttl=3600)
        client = build_client(transport, cache=cache)

        first = await client.get("https://site.test/page")
        second = await client.get("https://site.test/page")

        assert first.from_cache is False
        assert second.from_cache is True
        assert len(transport.requests) == 1
        assert client.stats.cache_hits == 1

    @pytest.mark.asyncio
    async def test_no_cache_flag_bypasses_cache(self, tmp_path):
        transport = FakeTransport(default={"status": 200, "text": "<html>x</html>"})
        cache = HttpCache(tmp_path / "cache.sqlite")
        client = build_client(transport, cache=cache)
        await client.get("https://site.test/p")
        await client.get("https://site.test/p", use_cache=False)
        assert len(transport.requests) == 2

    @pytest.mark.asyncio
    async def test_errors_are_not_cached(self, tmp_path):
        transport = FakeTransport(default={"status": 500, "text": "boom"})
        cache = HttpCache(tmp_path / "cache.sqlite")
        client = build_client(transport, cache=cache, max_retries=1)
        await client.get("https://bad.test/")
        assert cache.get(cache_key("GET", "https://bad.test/")) is None

    def test_expired_entries_are_evicted(self, tmp_path):
        cache = HttpCache(tmp_path / "cache.sqlite", default_ttl=10)
        cache.set("k", url="https://x.test", method="GET", status=200, headers={}, body="body", now=0.0)
        assert cache.get("k", now=5.0) is not None
        assert cache.get("k", now=100.0) is None

    def test_purge_expired(self, tmp_path):
        cache = HttpCache(tmp_path / "cache.sqlite", default_ttl=1)
        cache.set("a", url="https://x.test", method="GET", status=200, headers={}, body="b", now=0.0)
        assert cache.purge_expired(now=100.0) == 1

    def test_cache_key_ignores_ordering_of_params(self):
        assert cache_key("GET", "https://x.test", params={"a": 1, "b": 2}) == cache_key(
            "GET", "https://x.test", params={"b": 2, "a": 1}
        )

    def test_cache_key_distinguishes_bodies(self):
        assert cache_key("POST", "https://x.test", body={"q": "a"}) != cache_key(
            "POST", "https://x.test", body={"q": "b"}
        )


class TestRobots:
    @pytest.mark.asyncio
    async def test_disallowed_path_raises(self):
        transport = FakeTransport(
            routes={
                "/robots.txt": {"status": 200, "text": "User-agent: *\nDisallow: /private\n",
                                "headers": {"content-type": "text/plain"}},
            },
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        with pytest.raises(RobotsDisallowed):
            await client.get("https://site.test/private/page")
        assert client.stats.robots_blocked == 1

    @pytest.mark.asyncio
    async def test_allowed_path_passes(self):
        transport = FakeTransport(
            routes={
                "/robots.txt": {"status": 200, "text": "User-agent: *\nDisallow: /private\n",
                                "headers": {"content-type": "text/plain"}},
            },
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        response = await client.get("https://site.test/public")
        assert response.ok

    @pytest.mark.asyncio
    async def test_missing_robots_means_allowed(self):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 404, "text": ""}},
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        assert (await client.get("https://site.test/anything")).ok

    @pytest.mark.asyncio
    async def test_forbidden_robots_means_disallowed(self):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 403, "text": "forbidden"}},
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        with pytest.raises(RobotsDisallowed):
            await client.get("https://protected.test/page")

    @pytest.mark.asyncio
    async def test_crawl_delay_applied_to_limiter(self):
        transport = FakeTransport(
            routes={
                "/robots.txt": {
                    "status": 200,
                    "text": "User-agent: *\nCrawl-delay: 10\nAllow: /\n",
                    "headers": {"content-type": "text/plain"},
                }
            },
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        await client.get("https://polite.test/page")
        assert client.limiter.overrides.get("polite.test") == pytest.approx(0.1)

    @pytest.mark.asyncio
    async def test_robots_is_fetched_once_per_host(self):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 200, "text": "User-agent: *\nAllow: /\n",
                                    "headers": {"content-type": "text/plain"}}},
            default={"status": 200, "text": "<html>ok</html>"},
        )
        client = build_client(transport, respect_robots=True)
        await client.get("https://site.test/a")
        await client.get("https://site.test/b")
        robots_requests = [r for r in transport.requests if r.url.endswith("/robots.txt")]
        assert len(robots_requests) == 1

    @pytest.mark.asyncio
    async def test_api_calls_can_opt_out_of_robots_checks(self):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 200, "text": "User-agent: *\nDisallow: /\n",
                                    "headers": {"content-type": "text/plain"}}},
            default={"status": 200, "text": '{"ok":true}',
                     "headers": {"content-type": "application/json"}},
        )
        client = build_client(transport, respect_robots=True)
        payload = await client.get_json("https://api.test/v1/thing", check_robots=False)
        assert payload["ok"] is True


class TestHeaders:
    @pytest.mark.asyncio
    async def test_user_agent_is_always_sent(self):
        transport = FakeTransport(default={"status": 200, "text": "ok"})
        client = build_client(transport)
        await client.get("https://site.test/")
        assert transport.requests[0].headers["User-Agent"] == "LeadPipelineTest/1.0"

    @pytest.mark.asyncio
    async def test_custom_headers_merge(self):
        transport = FakeTransport(default={"status": 200, "text": "ok"})
        client = build_client(transport)
        await client.get("https://site.test/", headers={"X-Goog-Api-Key": "secret"})
        assert transport.requests[0].headers["X-Goog-Api-Key"] == "secret"
        assert "User-Agent" in transport.requests[0].headers
