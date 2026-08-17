"""Advertising intelligence.

Everything here is *observable* evidence, graded with an explicit confidence
level. We never state that a business is spending money unless the source
supports it:

============  ==========================================================
confirmed     A live ad was returned by an ads API (SerpAPI paid results,
              Meta Ad Library) for this business.
likely        Conversion-grade tracking is installed (Google Ads AW- tag,
              Meta Pixel with an init call) - strong but indirect.
possible      Generic tag manager / analytics only, or an ad platform
              fingerprint we cannot attribute with certainty.
not_detected  The site loaded and contained none of the above signals.
unknown       We could not observe the site (no site, blocked, error).
============  ==========================================================
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from ..config import NicheRule, Settings
from ..models import AdvertisingAnalysis, Confidence, Lead
from ..sources.base import SourceContext
from ..sources.search import SearchSource
from ..utils.geo import Location
from ..utils.http import HttpError
from ..utils.logging import get_logger
from ..utils.normalization import clean_text, company_name_similarity, normalize_url, root_domain

logger = get_logger("ads")

META_AD_LIBRARY_URL = "https://graph.facebook.com/v19.0/ads_archive"


@dataclass
class SerpAdObservation:
    domain: str
    landing_page: str
    title: str = ""
    position: int = 0
    query: str = ""
    count: int = 1


@dataclass
class AdMarketSnapshot:
    """Paid results observed for one niche x location search."""

    query: str
    total_ads: int = 0
    by_domain: dict[str, SerpAdObservation] = field(default_factory=dict)


class AdvertisingAnalyzer:
    """Grades Google/Meta advertising presence from public evidence."""

    def __init__(self, settings: Settings, search_source: SearchSource | None = None) -> None:
        self.settings = settings
        self.search = search_source
        self._market_cache: dict[str, AdMarketSnapshot] = {}
        self._meta_cache: dict[str, list[dict[str, Any]]] = {}

    @property
    def can_confirm_google(self) -> bool:
        return bool(self.settings.serpapi_api_key and self.search is not None)

    @property
    def can_confirm_meta(self) -> bool:
        return bool(self.settings.meta_ad_library_token)

    # ------------------------------------------------------------ SERP ads
    async def prepare_market(
        self, niche: NicheRule, location: Location, ctx: SourceContext
    ) -> AdMarketSnapshot | None:
        """Pull the paid results for a niche+location once and reuse them."""
        if not self.can_confirm_google or self.search is None:
            return None
        key = f"{niche.key}|{location.label.lower()}"
        if key in self._market_cache:
            return self._market_cache[key]

        snapshot = AdMarketSnapshot(query="")
        for term in (niche.search_terms or [niche.label])[:2]:
            phrase = f"{term} {location.label}"
            snapshot.query = snapshot.query or phrase
            hits = await self.search.run_query(phrase, ctx, count=10)
            for hit in hits:
                if not hit.is_ad or not hit.url:
                    continue
                snapshot.total_ads += 1
                domain = root_domain(hit.url)
                if not domain:
                    continue
                existing = snapshot.by_domain.get(domain)
                if existing:
                    existing.count += 1
                else:
                    snapshot.by_domain[domain] = SerpAdObservation(
                        domain=domain,
                        landing_page=normalize_url(hit.url) or hit.url,
                        title=hit.title,
                        position=hit.position,
                        query=phrase,
                    )
        self._market_cache[key] = snapshot
        return snapshot

    # -------------------------------------------------------- Meta library
    async def _meta_ads_for(self, lead: Lead, ctx: SourceContext) -> list[dict[str, Any]]:
        """Query the official Meta Ad Library API (needs a token).

        Coverage caveat: the Ad Library API returns everything only where local
        law requires full disclosure. A negative result therefore means "not
        detected", never "not advertising".
        """
        if not self.can_confirm_meta or not lead.company_name:
            return []
        key = lead.company_name.lower()
        if key in self._meta_cache:
            return self._meta_cache[key]

        params = {
            "search_terms": lead.company_name,
            "ad_reached_countries": '["GB"]',
            "ad_active_status": "ACTIVE",
            "ad_type": "ALL",
            "limit": "25",
            "fields": "id,page_name,ad_snapshot_url,ad_creative_link_captions,ad_creative_link_titles,ad_delivery_start_time",
            "access_token": self.settings.meta_ad_library_token,
        }
        try:
            payload = await ctx.client.get_json(
                META_AD_LIBRARY_URL,
                params=params,
                check_robots=False,  # authorised API call
                cache_ttl=self.settings.cache_ttl_seconds,
                label="meta_ad_library",
            )
        except HttpError as exc:
            ctx.record_error(stage="ads_analysis", source="meta_ad_library", target=lead.company_name,
                             error=exc, error_type=exc.kind)
            self._meta_cache[key] = []
            return []

        results = []
        for item in (payload or {}).get("data") or []:
            page_name = clean_text(item.get("page_name") or "")
            if page_name and company_name_similarity(lead.company_name, page_name) < 0.8:
                continue
            results.append(item)
        self._meta_cache[key] = results
        return results

    # ------------------------------------------------------------- analyse
    async def analyse(
        self,
        lead: Lead,
        niche: NicheRule,
        ctx: SourceContext,
        *,
        market: AdMarketSnapshot | None = None,
    ) -> AdvertisingAnalysis:
        analysis = AdvertisingAnalysis()
        website_analysis = lead.website_analysis
        evidence: list[str] = []
        sources: list[str] = []
        platforms: list[str] = []

        site_observed = bool(website_analysis and website_analysis.website_loads)
        domain = root_domain(lead.domain or lead.website)

        # --- Google -------------------------------------------------------
        google = Confidence.UNKNOWN
        if market is not None and domain:
            sources.append("serpapi_ads")
            observation = market.by_domain.get(domain)
            if observation:
                google = Confidence.CONFIRMED
                analysis.ad_landing_page = observation.landing_page
                analysis.number_of_visible_ads = observation.count
                evidence.append(
                    f"Live Google Ads result for {domain} on \"{observation.query}\" "
                    f"(position {observation.position})"
                )
                platforms.append("google_ads")
            elif market.total_ads > 0:
                google = Confidence.NOT_DETECTED
                evidence.append(
                    f"{market.total_ads} paid results seen for \"{market.query}\" but none from {domain}"
                )

        if google in (Confidence.UNKNOWN, Confidence.NOT_DETECTED) and website_analysis:
            if website_analysis.has_google_ads_tag:
                google = Confidence.LIKELY
                evidence.append("Google Ads conversion tag (AW-) present on the website")
                if "google_ads" not in platforms:
                    platforms.append("google_ads")
            elif website_analysis.has_google_tag_manager or website_analysis.has_google_analytics:
                if google is not Confidence.NOT_DETECTED:
                    google = Confidence.POSSIBLE
                evidence.append(
                    "Google Tag Manager / Analytics present but no Google Ads conversion tag detected"
                )
            elif site_observed:
                google = Confidence.NOT_DETECTED
                evidence.append("No Google Ads or analytics tags found on the website")

        # --- Meta ---------------------------------------------------------
        meta = Confidence.UNKNOWN
        meta_ads = await self._meta_ads_for(lead, ctx)
        if self.can_confirm_meta:
            sources.append("meta_ad_library")
            if meta_ads:
                meta = Confidence.CONFIRMED
                analysis.creative_count = len(meta_ads)
                evidence.append(f"{len(meta_ads)} active ad(s) in the Meta Ad Library")
                if "meta_ads" not in platforms:
                    platforms.append("meta_ads")
                snapshot = next((a.get("ad_snapshot_url") for a in meta_ads if a.get("ad_snapshot_url")), None)
                if snapshot and not analysis.ad_landing_page:
                    analysis.ad_landing_page = snapshot
            else:
                meta = Confidence.NOT_DETECTED
                evidence.append("No active ads returned by the Meta Ad Library for this business name")

        if meta in (Confidence.UNKNOWN, Confidence.NOT_DETECTED) and website_analysis:
            if website_analysis.has_meta_pixel:
                meta = Confidence.LIKELY
                evidence.append("Meta Pixel installed on the website")
                if "meta_ads" not in platforms:
                    platforms.append("meta_ads")
            elif site_observed and meta is Confidence.UNKNOWN:
                meta = Confidence.NOT_DETECTED
                evidence.append("No Meta Pixel found on the website")

        if website_analysis:
            if website_analysis.has_tiktok_pixel:
                platforms.append("tiktok_ads")
                evidence.append("TikTok pixel installed")
            if website_analysis.has_linkedin_insight:
                platforms.append("linkedin_ads")
                evidence.append("LinkedIn Insight tag installed")
            for pixel in website_analysis.__dict__.get("other_pixels", []) or []:
                evidence.append(f"{pixel} detected")

        if website_analysis and website_analysis.website_exists:
            sources.append("company_website")

        analysis.appears_to_be_running_google_ads = google
        analysis.appears_to_be_running_meta_ads = meta
        analysis.advertising_platform = sorted(set(platforms))
        analysis.evidence = evidence
        analysis.sources = sorted(set(sources))
        analysis.estimated_ad_activity = _estimate_activity(google, meta, analysis)
        analysis.ad_quality_score = _ad_quality_score(analysis, lead)
        return analysis


def _estimate_activity(google: Confidence, meta: Confidence, analysis: AdvertisingAnalysis) -> str:
    strongest = Confidence.strongest([google, meta])
    if strongest is Confidence.UNKNOWN:
        return "unknown"
    if strongest is Confidence.NOT_DETECTED:
        return "none"
    visible = (analysis.number_of_visible_ads or 0) + (analysis.creative_count or 0)
    if strongest is Confidence.CONFIRMED:
        if visible >= 6:
            return "high"
        if visible >= 2:
            return "moderate"
        return "low"
    if strongest is Confidence.LIKELY:
        both = google is Confidence.LIKELY and meta is Confidence.LIKELY
        return "moderate" if both else "low"
    return "low"


def _ad_quality_score(analysis: AdvertisingAnalysis, lead: Lead) -> int | None:
    """0-100 view of how well the observed ad experience converts.

    Only meaningful when we have actually seen an ad; ``None`` otherwise.
    """
    if analysis.appears_to_be_running_google_ads is not Confidence.CONFIRMED and (
        analysis.appears_to_be_running_meta_ads is not Confidence.CONFIRMED
    ):
        return None

    score = 50.0
    website = lead.website_analysis
    landing = analysis.ad_landing_page

    if landing and lead.website:
        landing_path = urlsplit(landing).path.strip("/")
        if not landing_path or landing_path in {"index.html", "home"}:
            score -= 20
            analysis.evidence.append("Paid traffic lands on the generic homepage")
        else:
            score += 12
            if website and website.service_pages:
                for name, url in website.service_pages.items():
                    if urlsplit(url).path.strip("/") == landing_path:
                        score += 10
                        analysis.evidence.append(f"Ad lands on the dedicated {name} page")
                        break

    if website:
        score += (website.landing_page_quality_score - 50) * 0.3
        if not website.mobile_friendly:
            score -= 12
        if not website.has_tracking_pixel:
            score -= 10
            analysis.evidence.append("Ads detected but no conversion tracking found on the site")
        if website.has_online_booking:
            score += 6

    return int(max(0, min(100, round(score))))
