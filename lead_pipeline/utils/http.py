"""Async HTTP client: rate limiting, retries, caching, robots.txt, timeouts.

The client talks to a pluggable :class:`Transport`. The default transport uses
``aiohttp``; tests inject :class:`FakeTransport` so the whole pipeline can run
end-to-end with zero network access.
"""

from __future__ import annotations

import asyncio
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Protocol
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

from .cache import HttpCache, NullCache, cache_key
from .logging import get_logger
from .rate_limit import RateLimiter

logger = get_logger("http")

RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504, 522, 524}

# Browser-like headers help when fetching a business website (some sites vary
# their markup on them). They are wrong on an API endpoint: a server doing
# Apache-style content negotiation can reject the request outright with
# "406 Not Acceptable - an appropriate representation could not be found",
# before the application ever sees the query. API calls therefore send the
# minimal set that every working API client sends.
WEB_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}
API_HEADERS = {
    "Accept": "*/*",
}
DEFAULT_HEADERS = {"web": WEB_HEADERS, "api": API_HEADERS}


class HttpError(Exception):
    """Raised for a transport-level failure after retries are exhausted."""

    def __init__(self, message: str, *, url: str, kind: str = "transport", status: int | None = None):
        super().__init__(message)
        self.url = url
        self.kind = kind
        self.status = status


class RobotsDisallowed(HttpError):
    def __init__(self, url: str):
        super().__init__(f"robots.txt disallows {url}", url=url, kind="robots_disallowed")


@dataclass
class Request:
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    params: dict[str, Any] | None = None
    json_body: Any = None
    data: Any = None
    timeout: float = 20.0
    connect_timeout: float = 10.0
    max_bytes: int = 3_000_000
    allow_redirects: bool = True


@dataclass
class Response:
    url: str
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    text: str = ""
    final_url: str = ""
    elapsed_ms: float = 0.0
    from_cache: bool = False
    error: str | None = None
    error_kind: str | None = None
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.error is None and 200 <= self.status < 400

    @property
    def content_type(self) -> str:
        return (self.headers.get("content-type") or self.headers.get("Content-Type") or "").lower()

    @property
    def is_html(self) -> bool:
        return "html" in self.content_type or (not self.content_type and "<html" in self.text[:2000].lower())

    def json(self) -> Any:
        import json as _json

        if not self.text:
            return None
        try:
            return _json.loads(self.text)
        except ValueError as exc:
            raise HttpError(f"Invalid JSON from {self.url}: {exc}", url=self.url, kind="invalid_json") from exc


def _status_message(url: str, response: "Response", limit: int = 400) -> str:
    """HTTP status plus the server's own explanation.

    APIs almost always say why they refused; without this the caller only sees
    a bare status code and has nothing to act on.
    """
    body = re.sub(r"<[^>]+>", " ", response.text or "")
    body = re.sub(r"\s+", " ", body).strip()
    if not body:
        return f"HTTP {response.status} from {url}"
    if len(body) > limit:
        body = body[:limit] + "…"
    return f"HTTP {response.status} from {url}: {body}"


class Transport(Protocol):
    async def fetch(self, request: Request) -> Response: ...
    async def close(self) -> None: ...


class AiohttpTransport:
    """Default transport. Imports ``aiohttp`` lazily so the package stays usable
    (tests, offline fixture runs) when it is not installed."""

    def __init__(self, *, verify_ssl: bool = True) -> None:
        self._session: Any = None
        self._verify_ssl = verify_ssl

    async def _get_session(self) -> Any:
        if self._session is None:
            try:
                import aiohttp  # noqa: PLC0415
            except ImportError as exc:  # pragma: no cover - environment dependent
                raise HttpError(
                    "aiohttp is required for live requests: pip install -r requirements.txt",
                    url="",
                    kind="missing_dependency",
                ) from exc
            connector = aiohttp.TCPConnector(limit=0, ssl=None if self._verify_ssl else False)
            self._session = aiohttp.ClientSession(connector=connector, trust_env=True)
        return self._session

    async def fetch(self, request: Request) -> Response:
        import aiohttp  # noqa: PLC0415

        session = await self._get_session()
        started = time.monotonic()
        timeout = aiohttp.ClientTimeout(total=request.timeout, connect=request.connect_timeout)
        try:
            async with session.request(
                request.method,
                request.url,
                headers=request.headers,
                params=request.params,
                json=request.json_body,
                data=request.data,
                timeout=timeout,
                allow_redirects=request.allow_redirects,
            ) as resp:
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.content.iter_chunked(65536):
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= request.max_bytes:
                        break
                raw = b"".join(chunks)
                encoding = resp.charset or "utf-8"
                try:
                    text = raw.decode(encoding, errors="replace")
                except LookupError:
                    text = raw.decode("utf-8", errors="replace")
                return Response(
                    url=request.url,
                    status=resp.status,
                    headers={k.lower(): v for k, v in resp.headers.items()},
                    text=text,
                    final_url=str(resp.url),
                    elapsed_ms=(time.monotonic() - started) * 1000,
                )
        except asyncio.TimeoutError:
            return Response(
                url=request.url,
                status=0,
                elapsed_ms=(time.monotonic() - started) * 1000,
                error=f"Timeout after {request.timeout}s",
                error_kind="timeout",
            )
        except aiohttp.ClientSSLError as exc:
            return Response(
                url=request.url, status=0, error=f"SSL error: {exc}", error_kind="ssl",
                elapsed_ms=(time.monotonic() - started) * 1000,
            )
        except aiohttp.ClientError as exc:
            kind = "dns" if "Name or service not known" in str(exc) or "getaddrinfo" in str(exc) else "connection"
            return Response(
                url=request.url, status=0, error=f"{type(exc).__name__}: {exc}", error_kind=kind,
                elapsed_ms=(time.monotonic() - started) * 1000,
            )
        except (OSError, ValueError) as exc:  # malformed URL, socket issues
            return Response(
                url=request.url, status=0, error=f"{type(exc).__name__}: {exc}", error_kind="transport",
                elapsed_ms=(time.monotonic() - started) * 1000,
            )

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None


class FakeTransport:
    """Deterministic transport for tests and offline demos.

    ``routes`` maps a URL (or substring) to either a :class:`Response`, a dict
    of response kwargs, or a callable taking the :class:`Request`.
    """

    def __init__(
        self,
        routes: Mapping[str, Any] | None = None,
        *,
        default: Any = None,
        record: bool = True,
    ) -> None:
        self.routes: dict[str, Any] = dict(routes or {})
        self.default = default
        self.requests: list[Request] = []
        self.record = record

    def add(self, url_fragment: str, response: Any) -> None:
        self.routes[url_fragment] = response

    async def fetch(self, request: Request) -> Response:
        if self.record:
            self.requests.append(request)
        handler = self.routes.get(request.url)
        if handler is None:
            for fragment, candidate in self.routes.items():
                if fragment in request.url:
                    handler = candidate
                    break
        if handler is None:
            handler = self.default
        if handler is None:
            return Response(url=request.url, status=404, text="", final_url=request.url,
                            headers={"content-type": "text/plain"})
        if callable(handler):
            result = handler(request)
            if asyncio.iscoroutine(result):
                result = await result
            handler = result
        if isinstance(handler, Response):
            return Response(**{**handler.__dict__, "url": handler.url or request.url,
                               "final_url": handler.final_url or request.url})
        if isinstance(handler, Mapping):
            payload = dict(handler)
            payload.setdefault("url", request.url)
            payload.setdefault("final_url", request.url)
            payload.setdefault("status", 200)
            payload.setdefault("headers", {"content-type": "text/html; charset=utf-8"})
            return Response(**payload)
        return Response(url=request.url, status=200, text=str(handler), final_url=request.url,
                        headers={"content-type": "text/html; charset=utf-8"})

    async def close(self) -> None:
        return None


class RobotsRegistry:
    """Per-host robots.txt fetch + cache + decision."""

    def __init__(self, client: "HttpClient", user_agent: str, *, enabled: bool = True) -> None:
        self._client = client
        self._user_agent = user_agent
        self.enabled = enabled
        self._parsers: dict[str, RobotFileParser | None] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.blocked_count = 0

    def _ua_token(self) -> str:
        return self._user_agent.split("/")[0] or "*"

    async def _parser_for(self, host_key: str, scheme: str, host: str) -> RobotFileParser | None:
        if host_key in self._parsers:
            return self._parsers[host_key]
        lock = self._locks.setdefault(host_key, asyncio.Lock())
        async with lock:
            if host_key in self._parsers:
                return self._parsers[host_key]
            robots_url = f"{scheme}://{host}/robots.txt"
            parser: RobotFileParser | None = None
            try:
                response = await self._client.request(
                    "GET",
                    robots_url,
                    check_robots=False,
                    cache_ttl=24 * 3600,
                    retries=1,
                    timeout=10.0,
                    label="robots",
                )
                if response.ok and response.text.strip():
                    parser = RobotFileParser()
                    parser.parse(response.text.splitlines())
                elif response.status in (401, 403):
                    # Explicitly protected: treat as disallowed.
                    parser = RobotFileParser()
                    parser.parse(["User-agent: *", "Disallow: /"])
                else:
                    parser = None  # missing robots.txt == allowed
            except HttpError:
                parser = None
            self._parsers[host_key] = parser
            return parser

    async def allowed(self, url: str) -> bool:
        if not self.enabled:
            return True
        parts = urlsplit(url)
        if not parts.hostname:
            return True
        host_key = f"{parts.scheme}://{parts.netloc}".lower()
        parser = await self._parser_for(host_key, parts.scheme or "https", parts.netloc)
        if parser is None:
            return True
        ua = self._ua_token()
        allowed = parser.can_fetch(ua, url) or parser.can_fetch("*", url)
        if not allowed:
            self.blocked_count += 1
        return allowed

    async def crawl_delay(self, url: str) -> float | None:
        if not self.enabled:
            return None
        parts = urlsplit(url)
        if not parts.hostname:
            return None
        host_key = f"{parts.scheme}://{parts.netloc}".lower()
        parser = self._parsers.get(host_key)
        if parser is None:
            return None
        for ua in (self._ua_token(), "*"):
            try:
                delay = parser.crawl_delay(ua)
            except Exception:  # pragma: no cover - defensive
                delay = None
            if delay:
                return float(delay)
        return None


@dataclass
class HttpStats:
    requests: int = 0
    cache_hits: int = 0
    retries: int = 0
    errors: int = 0
    robots_blocked: int = 0
    bytes_downloaded: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "requests": self.requests,
            "cache_hits": self.cache_hits,
            "retries": self.retries,
            "errors": self.errors,
            "robots_blocked": self.robots_blocked,
            "bytes_downloaded": self.bytes_downloaded,
        }


class HttpClient:
    """Polite async HTTP client used by every source and enricher."""

    def __init__(
        self,
        *,
        user_agent: str,
        transport: Transport | None = None,
        cache: HttpCache | NullCache | None = None,
        limiter: RateLimiter | None = None,
        respect_robots: bool = True,
        timeout: float = 20.0,
        connect_timeout: float = 10.0,
        max_retries: int = 3,
        backoff_base: float = 0.5,
        backoff_max: float = 30.0,
        max_response_bytes: int = 3_000_000,
        default_cache_ttl: int = 7 * 24 * 3600,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
        jitter: bool = True,
    ) -> None:
        self.user_agent = user_agent
        self.transport: Transport = transport or AiohttpTransport()
        self.cache = cache if cache is not None else NullCache()
        self.limiter = limiter or RateLimiter()
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.max_retries = max(1, int(max_retries))
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.max_response_bytes = max_response_bytes
        self.default_cache_ttl = default_cache_ttl
        self._sleep = sleep_fn or asyncio.sleep
        self._jitter = jitter
        self.stats = HttpStats()
        self.robots = RobotsRegistry(self, user_agent, enabled=respect_robots)

    # -- public helpers ---------------------------------------------------
    async def get(self, url: str, **kwargs: Any) -> Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> Response:
        return await self.request("POST", url, **kwargs)

    async def get_json(self, url: str, **kwargs: Any) -> Any:
        kwargs.setdefault("headers_profile", "api")
        response = await self.get(url, **kwargs)
        if not response.ok:
            raise HttpError(
                response.error or _status_message(url, response),
                url=url,
                kind=response.error_kind or "http_status",
                status=response.status,
            )
        return response.json()

    async def post_json(self, url: str, **kwargs: Any) -> Any:
        kwargs.setdefault("headers_profile", "api")
        response = await self.post(url, **kwargs)
        if not response.ok:
            raise HttpError(
                response.error or _status_message(url, response),
                url=url,
                kind=response.error_kind or "http_status",
                status=response.status,
            )
        return response.json()

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, Any] | None = None,
        json_body: Any = None,
        data: Any = None,
        timeout: float | None = None,
        retries: int | None = None,
        cache_ttl: int | None = None,
        use_cache: bool = True,
        check_robots: bool = True,
        allow_redirects: bool = True,
        label: str | None = None,
        headers_profile: str = "web",
    ) -> Response:
        """Perform a request with rate limiting, caching, retries and backoff.

        Never raises for HTTP status; returns a :class:`Response` whose
        ``error`` field is populated on transport failure. Raises
        :class:`RobotsDisallowed` when robots.txt forbids the URL.
        """
        method = method.upper()
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if not host:
            return Response(url=url, status=0, error=f"Malformed URL: {url!r}", error_kind="bad_url")

        if check_robots and self.robots.enabled:
            if not await self.robots.allowed(url):
                self.stats.robots_blocked += 1
                logger.debug("robots.txt disallows fetch", extra={"url": url})
                raise RobotsDisallowed(url)
            delay = await self.robots.crawl_delay(url)
            if delay:
                self.limiter.apply_crawl_delay(host, delay)

        key = cache_key(method, url, params=params, body=json_body or data)
        if use_cache:
            entry = self.cache.get(key)
            if entry is not None:
                self.stats.cache_hits += 1
                return Response(
                    url=url,
                    status=entry.status,
                    headers=entry.headers,
                    text=entry.body,
                    final_url=entry.final_url,
                    from_cache=True,
                )

        request_headers = dict(DEFAULT_HEADERS.get(headers_profile, WEB_HEADERS))
        request_headers["User-Agent"] = self.user_agent
        request_headers.update({k: v for k, v in (headers or {}).items()})

        request = Request(
            method=method,
            url=url,
            headers=request_headers,
            params=dict(params) if params else None,
            json_body=json_body,
            data=data,
            timeout=timeout or self.timeout,
            connect_timeout=self.connect_timeout,
            max_bytes=self.max_response_bytes,
            allow_redirects=allow_redirects,
        )

        attempts = max(1, retries if retries is not None else self.max_retries)
        response = Response(url=url, status=0, error="not attempted", error_kind="unknown")

        for attempt in range(1, attempts + 1):
            async with self.limiter.slot(host):
                self.stats.requests += 1
                response = await self.transport.fetch(request)
            response.attempts = attempt
            self.stats.bytes_downloaded += len(response.text or "")

            retryable = response.error_kind in {"timeout", "connection", "dns", "transport"} or (
                response.status in RETRY_STATUSES
            )
            if not retryable:
                break
            if attempt >= attempts:
                break

            self.stats.retries += 1
            delay = self._backoff_delay(attempt, response)
            if response.status == 429:
                # Sustained 429s: permanently slow this host down for the run.
                self.limiter.set_host_rate(host, max(0.1, self.limiter.default_rate / (2 * attempt)))
            logger.debug(
                "retrying request",
                extra={"url": url, "attempt": attempt, "status": response.status,
                       "error": response.error, "delay_s": round(delay, 2), "label": label},
            )
            await self._sleep(delay)

        if response.error or response.status >= 400:
            self.stats.errors += 1

        if use_cache and response.ok and response.text:
            self.cache.set(
                key,
                url=url,
                method=method,
                status=response.status,
                headers=response.headers,
                body=response.text,
                final_url=response.final_url or url,
                ttl=cache_ttl if cache_ttl is not None else self.default_cache_ttl,
            )
        return response

    def _backoff_delay(self, attempt: int, response: Response) -> float:
        retry_after = response.headers.get("retry-after") if response.headers else None
        if retry_after:
            try:
                return min(self.backoff_max, float(retry_after))
            except ValueError:
                pass
        delay = min(self.backoff_max, self.backoff_base * (2 ** (attempt - 1)))
        if self._jitter:
            delay *= 0.5 + random.random()  # full-ish jitter, keeps ordering sane
        return min(self.backoff_max, delay)

    async def close(self) -> None:
        await self.transport.close()

    async def __aenter__(self) -> "HttpClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()
