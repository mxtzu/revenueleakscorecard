"""Website analysis.

Fetches a business's public website (homepage plus a handful of high-value
internal pages), extracts on-page signals via :mod:`.seo`, and produces a
:class:`~lead_pipeline.models.WebsiteAnalysis`.

Rules:

* robots.txt is honoured for every fetch;
* per-host rate limits and a page budget cap the load we put on a site;
* only public pages are requested - no auth, no paywalls, no CAPTCHA solving;
* a failing site never stops the run - the failure is recorded on the analysis.
"""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlsplit

from ..config import NicheRule, Settings
from ..models import Lead, WebsiteAnalysis
from ..sources.base import SourceContext
from ..utils.email_validation import EmailAssessment, classify_email, pick_primary_email
from ..utils.http import HttpClient, HttpError, RobotsDisallowed
from ..utils.logging import get_logger
from ..utils.normalization import clean_text, extract_domain, normalize_url
from .people import MAX_PEOPLE_PER_SITE, best_contact, dedupe_people
from .seo import (
    PageSignals,
    analyse_page,
    estimate_page_speed,
    rank_internal_links,
)

logger = get_logger("website")

PAGESPEED_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"


class WebsiteAnalyzer:
    """Fetch and analyse one business website."""

    def __init__(self, settings: Settings, client: HttpClient) -> None:
        self.settings = settings
        self.client = client

    async def analyse(self, lead: Lead, niche: NicheRule, ctx: SourceContext) -> WebsiteAnalysis:
        analysis = WebsiteAnalysis()
        website = normalize_url(lead.website, keep_path=False)
        if not website:
            analysis.website_exists = False
            analysis.notes.append("No website found for this business")
            analysis.landing_page_quality_score = 0
            analysis.website_quality_score = 0
            return analysis

        analysis.website_exists = True
        keywords = niche.all_keywords()

        home = await self._fetch(website, ctx, lead)
        if home is not None and not home[0]:
            # Transport failure (not a robots refusal): a surprising number of
            # sites only resolve on the www host, so try that once. A robots
            # disallow is never worked around this way.
            alt = _www_variant(website)
            if alt:
                retry = await self._fetch(alt, ctx, lead)
                if retry is not None:
                    home = retry

        if home is None:
            analysis.website_loads = False
            analysis.error = "Fetch blocked by robots.txt"
            analysis.error_kind = "robots_disallowed"
            analysis.notes.append("robots.txt disallows crawling this site; analysis skipped")
            analysis.landing_page_quality_score = 0
            analysis.website_quality_score = 0
            return analysis

        response, signals = home
        analysis.http_status = response.status if response else None
        analysis.final_url = response.final_url if response else None
        analysis.load_time_ms = response.elapsed_ms if response else None
        analysis.page_bytes = len(response.text) if response else 0

        if response is None or not response.ok or signals is None:
            analysis.website_loads = False
            analysis.error = (response.error if response else None) or (
                f"HTTP {response.status}" if response else "No response"
            )
            analysis.error_kind = (response.error_kind if response else None) or "http_status"
            analysis.ssl_enabled = website.startswith("https://")
            analysis.notes.append("Website did not load - flagged as a technical problem, not scored as content")
            analysis.landing_page_quality_score = 0
            analysis.website_quality_score = 0
            return analysis

        analysis.website_loads = True
        final_url = response.final_url or website
        analysis.ssl_enabled = final_url.lower().startswith("https://")

        page_signals: list[PageSignals] = [signals]
        analysis.pages_checked = [final_url]

        # --- follow a small number of high-value internal pages ------------
        url_hints: list[str] = []
        for money_page in niche.money_pages:
            url_hints.extend(money_page.url_hints)
            url_hints.extend(k.replace(" ", "-") for k in money_page.keywords)
        budget = max(0, self.settings.max_pages_per_site - 1)
        candidates = rank_internal_links(signals.internal_links, url_hints=url_hints, limit=budget)

        for candidate in candidates:
            result = await self._fetch(candidate, ctx, lead, keywords=keywords)
            if result is None:
                continue
            page_response, page_signal = result
            if page_response is None or not page_response.ok or page_signal is None:
                continue
            page_signals.append(page_signal)
            analysis.pages_checked.append(page_response.final_url or candidate)

        self._aggregate(analysis, page_signals, niche, lead)
        await self._maybe_pagespeed(analysis, final_url, ctx)
        compute_quality_scores(analysis, niche)
        return analysis

    # ------------------------------------------------------------------
    async def _fetch(
        self, url: str, ctx: SourceContext, lead: Lead, *, keywords: list[str] | None = None
    ) -> tuple[Any, PageSignals | None] | None:
        """Fetch one page. Returns ``None`` when robots.txt forbids it."""
        try:
            response = await self.client.get(
                url,
                check_robots=True,
                cache_ttl=self.settings.cache_ttl_seconds,
                label="website",
            )
        except RobotsDisallowed:
            ctx.record_error(
                stage="website_analysis", source="company_website", target=url,
                error="robots.txt disallows this URL", error_type="robots_disallowed",
            )
            logger.info("Skipping page disallowed by robots.txt", extra={"url": url})
            return None
        except HttpError as exc:
            ctx.record_error(stage="website_analysis", source="company_website", target=url,
                             error=exc, error_type=exc.kind)
            return (None, None)
        except (asyncio.TimeoutError, OSError) as exc:  # pragma: no cover - defensive
            ctx.record_error(stage="website_analysis", source="company_website", target=url,
                             error=exc, error_type="transport")
            return (None, None)

        if not response.ok:
            ctx.record_error(
                stage="website_analysis", source="company_website", target=url,
                error=response.error or f"HTTP {response.status}",
                error_type=response.error_kind or "http_status",
            )
            return (response, None)
        if not response.is_html:
            return (response, None)

        signals = analyse_page(
            response.text,
            response.final_url or url,
            keywords=keywords or [],
            company_name=lead.company_name,
            locality=" ".join(filter(None, (lead.city, lead.region))),
            collect_people=self.settings.collect_contact_names,
        )
        return (response, signals)

    # ------------------------------------------------------------------
    def _aggregate(
        self, analysis: WebsiteAnalysis, pages: list[PageSignals], niche: NicheRule, lead: Lead
    ) -> None:
        home = pages[0]
        analysis.title = home.title or None
        analysis.meta_description = home.meta_description or None
        analysis.h1 = home.h1 or None
        analysis.word_count = sum(p.word_count for p in pages)
        analysis.cms = next((p.cms for p in pages if p.cms), None)
        analysis.copyright_year = max((p.copyright_year for p in pages if p.copyright_year), default=None)

        analysis.mobile_friendly = home.has_viewport and (home.responsive_css or home.word_count > 0)
        any_page = lambda attr: any(getattr(p, attr) for p in pages)  # noqa: E731

        analysis.has_contact_form = any_page("has_contact_form")
        analysis.has_phone_cta = any_page("has_phone_cta")
        analysis.has_primary_cta = any_page("has_primary_cta")
        analysis.has_booking_system = any_page("has_booking")
        analysis.has_online_booking = any_page("has_online_booking")
        analysis.has_live_chat = any_page("has_live_chat")
        analysis.has_pricing = any_page("has_pricing")
        analysis.has_testimonials = any_page("has_testimonials")
        analysis.has_reviews = any_page("has_reviews")
        analysis.has_before_after = any_page("has_before_after")
        analysis.has_case_studies = any_page("has_case_studies")
        analysis.has_finance_option = any_page("has_finance")

        analysis.booking_providers = sorted({p for page in pages for p in page.booking_providers})
        analysis.chat_providers = sorted({p for page in pages for p in page.chat_providers})

        analysis.has_google_analytics = any(p.tracking.google_analytics for p in pages)
        analysis.has_google_tag_manager = any(p.tracking.google_tag_manager for p in pages)
        analysis.has_google_ads_tag = any(p.tracking.google_ads_tag for p in pages)
        analysis.has_meta_pixel = any(p.tracking.meta_pixel for p in pages)
        analysis.has_tiktok_pixel = any(p.tracking.tiktok_pixel for p in pages)
        analysis.has_linkedin_insight = any(p.tracking.linkedin_insight for p in pages)
        analysis.has_tracking_pixel = any(p.tracking.has_any_pixel for p in pages)

        # --- niche money pages ------------------------------------------
        found_pages: dict[str, str] = {}
        for money_page in niche.money_pages:
            for page in pages:
                haystack = f"{page.url} {page.title} {page.h1}".lower()
                url_hit = any(hint and hint in page.url.lower() for hint in money_page.url_hints)
                title_hit = any(kw and kw in haystack for kw in money_page.keywords)
                if url_hit or (title_hit and page.url != pages[0].url):
                    found_pages[money_page.name] = page.url
                    break
        analysis.service_pages = found_pages
        analysis.missing_service_pages = [
            mp.name for mp in niche.money_pages if mp.name not in found_pages
        ]

        keywords = niche.all_keywords()
        found_keywords = {kw for page in pages for kw in page.keywords_found}
        combined_text = " ".join(f"{p.title} {p.h1} {p.meta_description}" for p in pages).lower()
        for keyword in keywords:
            if keyword in combined_text:
                found_keywords.add(keyword)
        analysis.niche_keywords_found = sorted(found_keywords)
        analysis.niche_keywords_missing = sorted(k for k in keywords if k not in found_keywords)

        # --- contact details --------------------------------------------
        domain = extract_domain(lead.website) or extract_domain(analysis.final_url)
        assessments: list[EmailAssessment] = []
        seen_emails: set[str] = set()
        for page in pages:
            for email in page.emails:
                if email in seen_emails:
                    continue
                seen_emails.add(email)
                assessment = classify_email(
                    email,
                    company_domain=domain,
                    allow_named_contacts=self.settings.allow_named_contact_emails,
                    source="company_website",
                    source_url=page.url,
                )
                if assessment.category in {"invalid", "blocked"}:
                    continue
                assessments.append(assessment)
        analysis.emails_found = assessments

        socials: dict[str, str] = {}
        for page in pages:
            for key, value in page.social_links.items():
                socials.setdefault(key, value)
        analysis.social_links = socials

        analysis.phones_found = sorted({tel for page in pages for tel in page.phone_links})

        # Named decision-makers the business publishes about itself. Capped so
        # the pipeline records who to address, not a staff directory.
        analysis.people_found = dedupe_people(
            person for page in pages for person in page.people
        )[:MAX_PEOPLE_PER_SITE]

        postcodes = {pc for page in pages for pc in page.postcodes}
        analysis.location_count = len(postcodes)
        analysis.multiple_locations = len(postcodes) >= 2

        analysis.page_speed_score = estimate_page_speed(
            load_time_ms=analysis.load_time_ms,
            html_bytes=analysis.page_bytes or 0,
            script_count=home.script_count,
            image_count=home.image_count,
        )
        analysis.page_speed_source = "heuristic"

    async def _maybe_pagespeed(self, analysis: WebsiteAnalysis, url: str, ctx: SourceContext) -> None:
        """Replace the heuristic speed estimate with a real Lighthouse score."""
        if not self.settings.pagespeed_api_key:
            return
        try:
            payload = await self.client.get_json(
                PAGESPEED_URL,
                params={
                    "url": url,
                    "strategy": "mobile",
                    "category": "performance",
                    "key": self.settings.pagespeed_api_key,
                },
                check_robots=False,  # authorised API call
                cache_ttl=self.settings.cache_ttl_seconds,
                timeout=90.0,
                label="pagespeed",
            )
        except HttpError as exc:
            ctx.record_error(stage="website_analysis", source="pagespeed", target=url, error=exc,
                             error_type=exc.kind)
            return
        try:
            score = (payload["lighthouseResult"]["categories"]["performance"]["score"]) * 100
            analysis.page_speed_score = int(round(score))
            analysis.page_speed_source = "pagespeed_insights"
        except (KeyError, TypeError, ValueError):
            return


def apply_website_analysis(lead: Lead, analysis: WebsiteAnalysis) -> None:
    """Copy discovered contact details and socials onto the lead."""
    lead.website_analysis = analysis

    primary = pick_primary_email(analysis.emails_found)
    existing = {a.email for a in lead.email_assessments}
    for assessment in analysis.emails_found:
        if assessment.email not in existing:
            lead.email_assessments.append(assessment)
    if primary and not lead.business_email:
        lead.set_field("business_email", primary.email, "company_website")
    elif not lead.business_email and lead.email_assessments:
        best = pick_primary_email(lead.email_assessments)
        if best:
            lead.set_field("business_email", best.email, "company_website")

    for key, value in analysis.social_links.items():
        lead.set_field(key, value, "company_website")

    if not lead.business_phone and analysis.phones_found:
        raw = analysis.phones_found[0].split(":", 1)[-1]
        lead.set_field("business_phone", clean_text(raw), "company_website")
        lead.normalize()

    if not lead.description and analysis.meta_description:
        lead.set_field("description", analysis.meta_description, "company_website")

    # The most senior person the business names publicly. Recorded with the role
    # that justified it and the page it was read from - a name on its own is a
    # claim nobody can check, and the role is what tells a salesperson whether
    # this person can say yes.
    contact = best_contact(analysis.people_found)
    if contact and not lead.contact_name:
        lead.set_field("contact_name", contact.name, "company_website")
        lead.set_field("contact_role", contact.role, "company_website")
        lead.set_field("contact_source_url", contact.source_url, "company_website")


def compute_quality_scores(analysis: WebsiteAnalysis, niche: NicheRule) -> None:
    """Two 0-100 scores: overall site quality and landing-page conversion quality."""
    if not analysis.website_exists:
        analysis.website_quality_score = 0
        analysis.landing_page_quality_score = 0
        return
    if not analysis.website_loads:
        analysis.website_quality_score = 5
        analysis.landing_page_quality_score = 0
        return

    # --- technical / trust foundation (website_quality_score) -------------
    technical = 0.0
    technical += 12 if analysis.ssl_enabled else 0
    technical += 16 if analysis.mobile_friendly else 0
    speed = analysis.page_speed_score if analysis.page_speed_score is not None else 55
    technical += min(18.0, speed * 0.18)
    technical += 8 if analysis.title else 0
    technical += 6 if analysis.meta_description else 0
    technical += 6 if analysis.h1 else 0
    technical += min(10.0, analysis.word_count / 120.0)
    technical += 8 if analysis.has_tracking_pixel else 0
    technical += 6 if analysis.cms else 0
    coverage = (
        len(analysis.niche_keywords_found)
        / max(1, len(analysis.niche_keywords_found) + len(analysis.niche_keywords_missing))
    )
    technical += 10 * coverage
    analysis.website_quality_score = int(max(0, min(100, round(technical))))

    # --- conversion quality (landing_page_quality_score) ------------------
    conversion = 0.0
    conversion += 14 if analysis.has_primary_cta else 0
    conversion += 10 if analysis.has_phone_cta else 0
    conversion += 10 if analysis.has_contact_form else 0
    conversion += 12 if analysis.has_online_booking else (7 if analysis.has_booking_system else 0)
    conversion += 8 if analysis.has_testimonials else 0
    conversion += 6 if analysis.has_reviews else 0
    conversion += 6 if analysis.has_before_after else 0
    conversion += 4 if analysis.has_case_studies else 0
    conversion += 6 if analysis.has_pricing else 0
    conversion += 5 if analysis.has_finance_option else 0
    conversion += 3 if analysis.has_live_chat else 0
    if niche.money_pages:
        page_coverage = len(analysis.service_pages) / len(niche.money_pages)
    else:
        page_coverage = 1.0 if analysis.niche_keywords_found else 0.0
    conversion += 16 * page_coverage
    if not analysis.mobile_friendly:
        conversion -= 10
    if (analysis.page_speed_score or 55) < 40:
        conversion -= 6
    analysis.landing_page_quality_score = int(max(0, min(100, round(conversion))))


def _www_variant(url: str) -> str | None:
    parts = urlsplit(url)
    host = parts.hostname or ""
    if not host or host.startswith("www."):
        return None
    return f"{parts.scheme}://www.{host}{parts.path or ''}"
