"""Website analysis: on-page signal extraction and failure handling."""

from __future__ import annotations

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.enrichment.seo import analyse_page, detect_tracking, estimate_page_speed, parse_html
from lead_pipeline.enrichment.website import WebsiteAnalyzer, apply_website_analysis
from lead_pipeline.utils.http import FakeTransport

from .conftest import (
    CONTACT_PAGE,
    GOOD_DENTAL_HOMEPAGE,
    INVISALIGN_LANDING_PAGE,
    POOR_ROOFER_HOMEPAGE,
    ROBOTS_ALLOW_ALL,
    ROBOTS_DISALLOW_ALL,
    make_lead,
)


@pytest.fixture(scope="module")
def registry():
    return load_niches()


class TestPageSignals:
    def test_rich_page_signals(self):
        signals = analyse_page(GOOD_DENTAL_HOMEPAGE, "https://riversidedentalstudio.co.uk",
                               keywords=["invisalign", "veneers", "composite bonding", "retainers"])
        assert signals.has_viewport is True
        assert signals.has_phone_cta is True
        assert signals.has_primary_cta is True
        assert signals.has_booking is True
        assert "Calendly" in signals.booking_providers
        assert signals.has_pricing is True
        assert signals.has_testimonials is True
        assert signals.has_reviews is True
        assert signals.has_before_after is True
        assert signals.has_finance is True
        assert signals.title.startswith("Riverside Dental Studio")
        assert signals.h1 == "Straighter teeth in Newcastle with Invisalign"
        assert "invisalign" in signals.keywords_found
        assert "retainers" not in signals.keywords_found
        assert signals.cms == "WordPress"
        assert signals.copyright_year == 2024
        assert len(signals.postcodes) == 2  # two locations in the footer

    def test_tracking_detection(self):
        tracking = detect_tracking(GOOD_DENTAL_HOMEPAGE)
        assert tracking.google_analytics is True
        assert tracking.google_ads_tag is True
        assert tracking.meta_pixel is True
        assert tracking.has_any_pixel is True
        assert tracking.ids["google_analytics"] == ["g-abc1234567"]
        assert tracking.ids["google_ads"] == ["aw-987654321"]
        assert tracking.ids["meta_pixel"] == ["123456789012345"]

    def test_no_tracking_on_bare_page(self):
        tracking = detect_tracking(POOR_ROOFER_HOMEPAGE)
        assert tracking.has_any_pixel is False
        assert tracking.meta_pixel is False

    def test_gtm_only_is_not_google_ads(self):
        html = '<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script>'
        tracking = detect_tracking(html)
        assert tracking.google_tag_manager is True
        assert tracking.google_ads_tag is False

    def test_poor_page_signals(self):
        signals = analyse_page(POOR_ROOFER_HOMEPAGE, "https://northernroofingsolutions.co.uk")
        assert signals.has_viewport is False
        assert signals.has_booking is False
        assert signals.has_contact_form is False
        assert signals.has_testimonials is False
        assert signals.word_count < 40

    def test_contact_form_detection(self):
        signals = analyse_page(INVISALIGN_LANDING_PAGE, "https://x.test/invisalign")
        assert signals.has_contact_form is True

    def test_search_form_is_not_a_contact_form(self):
        html = '<html><body><form class="search" action="/search"><input type="text" name="s"></form></body></html>'
        assert analyse_page(html, "https://x.test").has_contact_form is False

    def test_social_link_extraction_ignores_share_urls(self):
        html = """
        <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
        <a href="https://www.facebook.com/realbusiness">Facebook</a>
        <a href="https://instagram.com/realbusiness/">Instagram</a>
        """
        signals = analyse_page(html, "https://x.test")
        assert signals.social_links["facebook_url"] == "https://facebook.com/realbusiness"
        assert signals.social_links["instagram_url"] == "https://instagram.com/realbusiness"

    def test_email_extraction_prefers_mailto(self):
        signals = analyse_page(CONTACT_PAGE, "https://riversidedentalstudio.co.uk/contact")
        assert "hello@riversidedentalstudio.co.uk" in signals.emails

    def test_internal_links_are_scoped_to_the_host(self):
        signals = analyse_page(GOOD_DENTAL_HOMEPAGE, "https://riversidedentalstudio.co.uk")
        assert all("riversidedentalstudio.co.uk" in link for link in signals.internal_links)
        assert any(link.endswith("/invisalign") for link in signals.internal_links)

    def test_empty_html_is_safe(self):
        signals = analyse_page("", "https://x.test")
        assert signals.word_count == 0 and signals.has_primary_cta is False

    def test_malformed_html_does_not_raise(self):
        signals = analyse_page("<html><body><div><p>unclosed", "https://x.test")
        assert "unclosed" in signals.title + signals.h1 or signals.word_count >= 1

    def test_parse_html_extracts_forms_and_scripts(self):
        document = parse_html(GOOD_DENTAL_HOMEPAGE, "https://x.test")
        assert document.title
        assert any("googletagmanager" in src for src in document.scripts)


class TestPageSpeedHeuristic:
    def test_fast_light_page_scores_high(self):
        assert estimate_page_speed(load_time_ms=300, html_bytes=40_000, script_count=4, image_count=8) >= 90

    def test_slow_heavy_page_scores_low(self):
        assert estimate_page_speed(load_time_ms=7000, html_bytes=1_200_000, script_count=50,
                                   image_count=100) <= 30

    def test_bounded(self):
        assert 5 <= estimate_page_speed(load_time_ms=None, html_bytes=0, script_count=0, image_count=0) <= 100


class TestWebsiteAnalyzer:
    @pytest.mark.asyncio
    async def test_full_analysis_of_a_strong_site(self, settings, client, ctx, registry):
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.website_exists and analysis.website_loads
        assert analysis.ssl_enabled and analysis.mobile_friendly
        assert analysis.has_online_booking and analysis.has_phone_cta and analysis.has_primary_cta
        assert analysis.has_meta_pixel and analysis.has_google_ads_tag and analysis.has_google_analytics
        assert "Invisalign" in analysis.service_pages
        assert analysis.multiple_locations is True
        assert analysis.landing_page_quality_score > 60
        assert analysis.website_quality_score > 55
        assert len(analysis.pages_checked) >= 2
        assert any(a.email == "hello@riversidedentalstudio.co.uk" for a in analysis.emails_found)

    @pytest.mark.asyncio
    async def test_named_individual_email_is_not_used_for_outreach(self, settings, client, ctx, registry):
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        personal = [a for a in analysis.emails_found if a.email.startswith("sarah.jones@")]
        assert personal and personal[0].accept_for_outreach is False
        apply_website_analysis(lead, analysis)
        assert lead.business_email == "hello@riversidedentalstudio.co.uk"

    @pytest.mark.asyncio
    async def test_weak_site_scores_low(self, settings, client, ctx, registry):
        lead = make_lead(
            company_name="Northern Roofing Solutions", niche="roofers",
            website="https://northernroofingsolutions.co.uk",
        )
        analysis = await WebsiteAnalyzer(settings, client).analyse(lead, registry.get("roofers"), ctx)
        assert analysis.website_loads is True
        assert analysis.mobile_friendly is False
        assert analysis.has_tracking_pixel is False
        assert analysis.landing_page_quality_score < 30
        assert analysis.missing_service_pages

    @pytest.mark.asyncio
    async def test_no_website_is_reported_not_crashed(self, settings, client, ctx, registry):
        lead = make_lead(website=None)
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.website_exists is False
        assert analysis.landing_page_quality_score == 0

    @pytest.mark.asyncio
    async def test_dead_site_records_the_error_and_continues(self, settings, ctx, registry):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 404, "text": ""}},
            default={"status": 0, "text": "", "error": "Timeout after 20s", "error_kind": "timeout"},
        )
        from lead_pipeline.utils.http import HttpClient
        from lead_pipeline.utils.rate_limit import RateLimiter

        client = HttpClient(
            user_agent="Test/1.0", transport=transport,
            limiter=RateLimiter(1000.0), respect_robots=True, max_retries=1,
            backoff_base=0.0, backoff_max=0.0, jitter=False,
        )
        ctx.client = client
        lead = make_lead(website="https://dead-site.test")
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.website_exists is True
        assert analysis.website_loads is False
        assert analysis.error_kind == "timeout"
        assert analysis.landing_page_quality_score == 0
        assert any(e.error_type == "timeout" for e in ctx.errors)

    @pytest.mark.asyncio
    async def test_robots_disallowed_site_is_skipped_politely(self, settings, ctx, registry):
        transport = FakeTransport(
            routes={
                "/robots.txt": {"status": 200, "text": ROBOTS_DISALLOW_ALL,
                                "headers": {"content-type": "text/plain"}},
            },
            default={"status": 200, "text": GOOD_DENTAL_HOMEPAGE},
        )
        from lead_pipeline.utils.http import HttpClient
        from lead_pipeline.utils.rate_limit import RateLimiter

        client = HttpClient(
            user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
            respect_robots=True, max_retries=1, backoff_base=0.0, jitter=False,
        )
        ctx.client = client
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.error_kind == "robots_disallowed"
        assert analysis.website_loads is False
        assert any(e.error_type == "robots_disallowed" for e in ctx.errors)
        # The homepage itself must never have been fetched.
        assert all("robots.txt" in r.url for r in transport.requests)

    @pytest.mark.asyncio
    async def test_page_budget_is_respected(self, settings, client, ctx, registry):
        settings = settings.with_overrides(max_pages_per_site=2)
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert len(analysis.pages_checked) <= 2

    @pytest.mark.asyncio
    async def test_non_html_response_is_not_parsed(self, settings, ctx, registry):
        transport = FakeTransport(
            routes={"/robots.txt": {"status": 404, "text": ""}},
            default={"status": 200, "text": "%PDF-1.4 binary",
                     "headers": {"content-type": "application/pdf"}},
        )
        from lead_pipeline.utils.http import HttpClient
        from lead_pipeline.utils.rate_limit import RateLimiter

        client = HttpClient(user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
                            respect_robots=True, max_retries=1, jitter=False)
        ctx.client = client
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            make_lead(website="https://pdfonly.test"), registry.get("roofers"), ctx
        )
        assert analysis.website_loads is False


class TestApplyAnalysis:
    @pytest.mark.asyncio
    async def test_socials_and_contacts_are_copied_to_the_lead(self, settings, client, ctx, registry):
        lead = make_lead()
        lead.facebook_url = None
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        apply_website_analysis(lead, analysis)
        assert lead.facebook_url == "https://facebook.com/riversidedentalstudio"
        assert lead.business_email == "hello@riversidedentalstudio.co.uk"
        assert lead.field_sources["facebook_url"] == "company_website"


def test_robots_fixture_is_permissive():
    assert "Allow" in ROBOTS_ALLOW_ALL
