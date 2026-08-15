"""Search-engine adapter (official APIs only).

Providers, in preference order: SerpAPI, Brave Search API, Google Programmable
Search (CSE). All are authorised APIs - the adapter never scrapes an engine's
HTML results page.

Two jobs:

* **discovery** - find business websites for a niche + location;
* **website lookup** - find the official site for a business we already know
  about (used by the enrichment stage when a source had no website).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator
from urllib.parse import urlsplit

from ..models import SourceRecord
from ..utils.http import HttpError
from ..utils.normalization import clean_text, company_name_similarity, extract_domain, root_domain
from .base import BaseSource, SearchQuery, SourceContext

SERPAPI_URL = "https://serpapi.com/search.json"
BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
GOOGLE_CSE_URL = "https://www.googleapis.com/customsearch/v1"

# Aggregators and social platforms are useful context but are not the
# business's own website.
NON_BUSINESS_DOMAINS = {
    "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
    "tiktok.com", "youtube.com", "pinterest.com", "yelp.com", "yell.com",
    "checkatrade.com", "trustpilot.com", "thomsonlocal.com", "cylex-uk.co.uk",
    "freeindex.co.uk", "bark.com", "mybuilder.com", "ratedpeople.com",
    "houzz.co.uk", "trustatrader.com", "google.com", "bing.com", "reddit.com",
    "wikipedia.org", "gov.uk", "nhs.uk", "companieshouse.gov.uk", "indeed.com",
    "glassdoor.co.uk", "tripadvisor.co.uk", "amazon.co.uk", "ebay.co.uk",
    "which.co.uk", "192.com", "scoot.co.uk", "hotfrog.co.uk", "brownbook.net",
}


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str = ""
    position: int = 0
    is_ad: bool = False
    provider: str = ""


class SearchSource(BaseSource):
    name = "search"
    kind = "discovery"
    description = "Search-engine discovery via SerpAPI / Brave / Google Programmable Search"
    attribution = "Search engine API results"
    requires_credentials = ()

    def is_available(self) -> bool:
        return bool(self.provider)

    def unavailable_reason(self) -> str:
        if not self.provider:
            return "no search API key (set SERPAPI_API_KEY, BRAVE_SEARCH_API_KEY or GOOGLE_CSE_API_KEY+GOOGLE_CSE_CX)"
        return ""

    @property
    def provider(self) -> str | None:
        if self.settings.serpapi_api_key:
            return "serpapi"
        if self.settings.brave_search_api_key:
            return "brave"
        if self.settings.google_cse_api_key and self.settings.google_cse_cx:
            return "google_cse"
        return None

    # ------------------------------------------------------------ discovery
    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        if not self.provider:
            return
        emitted = 0
        for term in query.terms()[:4]:
            if emitted >= query.limit:
                break
            phrase = f"{term} {query.location.query_string()}"
            hits = await self.run_query(phrase, ctx, count=10)
            for hit in hits:
                if hit.is_ad:
                    continue
                domain = extract_domain(hit.url)
                if not domain or root_domain(domain) in NON_BUSINESS_DOMAINS:
                    continue
                company_name = _company_from_hit(hit, domain)
                if not company_name:
                    continue
                data = {
                    "company_name": company_name,
                    "website": f"https://{domain}",
                    "description": clean_text(hit.snippet) or None,
                    "city": query.location.city or query.location.label,
                    "country": query.country,
                }
                emitted += 1
                yield self.make_record(
                    data,
                    source_url=hit.url,
                    source_record_id=domain,
                    raw={"provider": hit.provider, "title": hit.title, "snippet": hit.snippet},
                )
                if emitted >= query.limit:
                    break

    # -------------------------------------------------------- website lookup
    async def find_official_website(
        self, company_name: str, locality: str | None, ctx: SourceContext
    ) -> tuple[str, SearchHit] | tuple[None, None]:
        """Best-guess official website for a known business, or ``(None, None)``."""
        if not self.provider or not company_name:
            return (None, None)
        phrase = " ".join(p for p in [company_name, locality or "", "official website"] if p)
        hits = await self.run_query(phrase, ctx, count=5)
        for hit in hits:
            if hit.is_ad:
                continue
            domain = extract_domain(hit.url)
            if not domain or root_domain(domain) in NON_BUSINESS_DOMAINS:
                continue
            # Only accept when the domain plausibly belongs to this business.
            domain_words = (root_domain(domain) or "").split(".")[0].replace("-", " ")
            if company_name_similarity(company_name, domain_words) >= 0.62 or company_name_similarity(
                company_name, hit.title
            ) >= 0.6:
                return (f"https://{domain}", hit)
        return (None, None)

    # ------------------------------------------------------------- providers
    async def run_query(self, phrase: str, ctx: SourceContext, *, count: int = 10) -> list[SearchHit]:
        provider = self.provider
        try:
            if provider == "serpapi":
                return await self._serpapi(phrase, ctx, count)
            if provider == "brave":
                return await self._brave(phrase, ctx, count)
            if provider == "google_cse":
                return await self._google_cse(phrase, ctx, count)
        except HttpError as exc:
            ctx.record_error(stage="discovery", source=f"{self.name}:{provider}", target=phrase,
                             error=exc, error_type=exc.kind)
            self.logger.warning("Search API call failed", extra={"provider": provider, "error": str(exc)})
        return []

    async def _serpapi(self, phrase: str, ctx: SourceContext, count: int) -> list[SearchHit]:
        params = {
            "q": phrase,
            "engine": "google",
            "num": str(min(20, count)),
            "gl": "uk",
            "hl": "en",
            "api_key": self.settings.serpapi_api_key,
        }
        payload = await ctx.client.get_json(
            SERPAPI_URL, params=params, check_robots=False,
            cache_ttl=self.settings.cache_ttl_seconds, label="serpapi",
        )
        hits: list[SearchHit] = []
        for position, item in enumerate((payload or {}).get("organic_results") or [], start=1):
            hits.append(
                SearchHit(
                    title=clean_text(item.get("title") or ""),
                    url=item.get("link") or "",
                    snippet=clean_text(item.get("snippet") or ""),
                    position=position,
                    provider="serpapi",
                )
            )
        for position, item in enumerate((payload or {}).get("ads") or [], start=1):
            hits.append(
                SearchHit(
                    title=clean_text(item.get("title") or ""),
                    url=item.get("tracking_link") or item.get("link") or "",
                    snippet=clean_text(item.get("description") or ""),
                    position=position,
                    is_ad=True,
                    provider="serpapi",
                )
            )
        return hits

    async def _brave(self, phrase: str, ctx: SourceContext, count: int) -> list[SearchHit]:
        payload = await ctx.client.get_json(
            BRAVE_URL,
            params={"q": phrase, "count": str(min(20, count)), "country": "GB"},
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": self.settings.brave_search_api_key or "",
            },
            check_robots=False,
            cache_ttl=self.settings.cache_ttl_seconds,
            label="brave_search",
        )
        results = ((payload or {}).get("web") or {}).get("results") or []
        return [
            SearchHit(
                title=clean_text(item.get("title") or ""),
                url=item.get("url") or "",
                snippet=clean_text(item.get("description") or ""),
                position=position,
                provider="brave",
            )
            for position, item in enumerate(results, start=1)
        ]

    async def _google_cse(self, phrase: str, ctx: SourceContext, count: int) -> list[SearchHit]:
        payload = await ctx.client.get_json(
            GOOGLE_CSE_URL,
            params={
                "key": self.settings.google_cse_api_key,
                "cx": self.settings.google_cse_cx,
                "q": phrase,
                "num": str(min(10, count)),
                "gl": "uk",
            },
            check_robots=False,
            cache_ttl=self.settings.cache_ttl_seconds,
            label="google_cse",
        )
        return [
            SearchHit(
                title=clean_text(item.get("title") or ""),
                url=item.get("link") or "",
                snippet=clean_text(item.get("snippet") or ""),
                position=position,
                provider="google_cse",
            )
            for position, item in enumerate((payload or {}).get("items") or [], start=1)
        ]


def _company_from_hit(hit: SearchHit, domain: str) -> str | None:
    """Derive a business name from a result title, falling back to the domain."""
    title = clean_text(hit.title)
    if title:
        for separator in (" | ", " - ", " – ", " — ", ": "):
            if separator in title:
                candidate = title.split(separator)[0].strip()
                if len(candidate) >= 3:
                    return candidate
        if len(title) <= 70:
            return title
    host = urlsplit(f"https://{domain}").hostname or domain
    label = (root_domain(host) or host).split(".")[0].replace("-", " ").strip()
    return label.title() if label else None
