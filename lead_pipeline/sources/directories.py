"""Configurable public-directory adapter.

Ships with **no directories enabled**. Add entries to
``config/directories.json`` only for sites whose Terms of Service permit
automated access. The adapter:

* checks robots.txt for every URL before fetching (never bypassed);
* honours a per-directory rate limit;
* parses only the public listing HTML with CSS selectors;
* never solves CAPTCHAs, logs in, or touches a paywalled page.

If a directory responds with 401/403 or a challenge page the adapter records an
error and moves on.
"""

from __future__ import annotations

from typing import Any, AsyncIterator
from urllib.parse import quote_plus, urljoin

from ..config import load_directories
from ..models import SourceRecord
from ..utils.http import HttpError, RobotsDisallowed
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

CHALLENGE_MARKERS = (
    "captcha",
    "are you a robot",
    "verify you are human",
    "cf-browser-verification",
    "access denied",
    "enable javascript and cookies to continue",
)


class DirectorySource(BaseSource):
    name = "directory"
    kind = "discovery"
    description = "Public business directories defined in config/directories.json"
    attribution = "Configured public directories"
    requires_credentials = ()

    def __init__(self, settings: Any) -> None:
        super().__init__(settings)
        try:
            self.directories = [
                d for d in load_directories(settings.directories_path) if d.get("enabled", False)
            ]
        except Exception as exc:  # pragma: no cover - malformed user config
            self.logger.warning("Could not load directory config", extra={"error": str(exc)})
            self.directories = []

    def is_available(self) -> bool:
        return bool(self.directories)

    def unavailable_reason(self) -> str:
        if not self.directories:
            return "no directories enabled in config/directories.json"
        return ""

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        if not self.directories:
            return
        try:
            from bs4 import BeautifulSoup  # noqa: PLC0415
        except ImportError:  # pragma: no cover - dependency guard
            self.logger.warning("beautifulsoup4 not installed; directory source disabled")
            return

        emitted = 0
        for directory in self.directories:
            if emitted >= query.limit:
                break
            directory_name = directory.get("name", "directory")
            rate = float(directory.get("rate_per_second", 0.5))
            template = directory.get("search_url")
            if not template:
                continue
            max_pages = int(directory.get("max_pages", 1))
            selector = directory.get("result_selector")
            fields: dict[str, dict[str, str]] = directory.get("fields", {})
            if not selector or not fields:
                continue

            for term in query.terms()[:2]:
                for page in range(1, max_pages + 1):
                    if emitted >= query.limit:
                        break
                    url = (
                        template.replace("{query}", quote_plus(term))
                        .replace("{location}", quote_plus(query.location.query_string()))
                        .replace("{page}", str(page))
                    )
                    host = url.split("/")[2] if "//" in url else ""
                    if host:
                        ctx.client.limiter.set_host_rate(host, rate)
                    try:
                        response = await ctx.client.get(
                            url,
                            check_robots=True,  # never bypassed
                            cache_ttl=self.settings.cache_ttl_seconds,
                            label=f"directory:{directory_name}",
                        )
                    except RobotsDisallowed:
                        self.logger.info(
                            "Skipping directory page disallowed by robots.txt",
                            extra={"directory": directory_name, "url": url},
                        )
                        ctx.record_error(
                            stage="discovery", source=f"{self.name}:{directory_name}", target=url,
                            error="robots.txt disallows this path", error_type="robots_disallowed",
                        )
                        break
                    except HttpError as exc:
                        ctx.record_error(stage="discovery", source=f"{self.name}:{directory_name}",
                                         target=url, error=exc, error_type=exc.kind)
                        break

                    if not response.ok:
                        ctx.record_error(
                            stage="discovery", source=f"{self.name}:{directory_name}", target=url,
                            error=response.error or f"HTTP {response.status}",
                            error_type=response.error_kind or "http_status",
                        )
                        break

                    lowered = response.text[:5000].lower()
                    if any(marker in lowered for marker in CHALLENGE_MARKERS):
                        self.logger.warning(
                            "Directory returned an anti-bot challenge; stopping (never bypassed)",
                            extra={"directory": directory_name, "url": url},
                        )
                        ctx.record_error(
                            stage="discovery", source=f"{self.name}:{directory_name}", target=url,
                            error="anti-bot challenge detected; adapter stopped by policy",
                            error_type="challenge_detected",
                        )
                        break

                    soup = BeautifulSoup(response.text, "html.parser")
                    nodes = soup.select(selector)
                    if not nodes:
                        break
                    for node in nodes:
                        data: dict[str, Any] = {}
                        for field_name, spec in fields.items():
                            value = _extract(node, spec, base_url=url)
                            if value:
                                data[field_name] = value
                        if not data.get("company_name"):
                            continue
                        data.setdefault("country", query.country)
                        data.setdefault("city", query.location.city or query.location.label)
                        record = self.make_record(
                            data,
                            source_url=data.get("source_url") or url,
                            raw={"directory": directory_name},
                        )
                        record.source = f"{self.name}:{directory_name}"
                        emitted += 1
                        yield record
                        if emitted >= query.limit:
                            break


def _extract(node: Any, spec: dict[str, str], *, base_url: str) -> str | None:
    selector = spec.get("selector")
    attribute = spec.get("attr", "text")
    target = node.select_one(selector) if selector else node
    if target is None:
        return None
    if attribute == "text":
        return clean_text(target.get_text(" ", strip=True)) or None
    value = target.get(attribute)
    if not value:
        return None
    value = clean_text(value)
    if attribute == "href" and value and not value.startswith(("http://", "https://")):
        value = urljoin(base_url, value)
    return value or None
