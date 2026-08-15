"""Advertising intelligence, social normalisation and review signals."""

from __future__ import annotations

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.enrichment.ads import AdMarketSnapshot, AdvertisingAnalyzer, SerpAdObservation
from lead_pipeline.enrichment.reviews import enrich_reviews, rating_band, volume_band
from lead_pipeline.enrichment.social import canonical_profile_url, enrich_social
from lead_pipeline.models import Confidence, WebsiteAnalysis

from .conftest import make_lead


@pytest.fixture(scope="module")
def registry():
    return load_niches()


def website(**overrides) -> WebsiteAnalysis:
    analysis = WebsiteAnalysis(website_exists=True, website_loads=True, mobile_friendly=True,
                              landing_page_quality_score=50)
    for key, value in overrides.items():
        setattr(analysis, key, value)
    return analysis


class TestConfidenceVocabulary:
    def test_ranking(self):
        assert Confidence.CONFIRMED.rank > Confidence.LIKELY.rank > Confidence.POSSIBLE.rank
        assert Confidence.POSSIBLE.rank > Confidence.NOT_DETECTED.rank > Confidence.UNKNOWN.rank

    def test_strongest(self):
        assert Confidence.strongest([Confidence.NOT_DETECTED, Confidence.LIKELY]) is Confidence.LIKELY
        assert Confidence.strongest([]) is Confidence.UNKNOWN


class TestGoogleAdsGrading:
    @pytest.mark.asyncio
    async def test_conversion_tag_is_likely_not_confirmed(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website(has_google_ads_tag=True, has_tracking_pixel=True,
                                        has_google_analytics=True)
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.LIKELY
        assert "google_ads" in analysis.advertising_platform
        assert any("AW-" in e for e in analysis.evidence)

    @pytest.mark.asyncio
    async def test_analytics_only_is_possible(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website(has_google_analytics=True, has_google_tag_manager=True,
                                        has_tracking_pixel=True)
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.POSSIBLE

    @pytest.mark.asyncio
    async def test_no_tags_is_not_detected(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website()
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.NOT_DETECTED
        assert analysis.appears_to_be_running_meta_ads is Confidence.NOT_DETECTED
        assert analysis.estimated_ad_activity == "none"

    @pytest.mark.asyncio
    async def test_unobservable_site_stays_unknown(self, settings, ctx, registry):
        lead = make_lead(website=None)
        lead.website_analysis = WebsiteAnalysis(website_exists=False)
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.UNKNOWN
        assert analysis.appears_to_be_running_meta_ads is Confidence.UNKNOWN
        assert analysis.estimated_ad_activity == "unknown"
        assert analysis.ad_quality_score is None

    @pytest.mark.asyncio
    async def test_serp_ad_confirms_and_flags_homepage_landing(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website(service_pages={}, has_tracking_pixel=True,
                                        has_google_analytics=True)
        market = AdMarketSnapshot(
            query="invisalign provider Newcastle",
            total_ads=4,
            by_domain={
                "riversidedentalstudio.co.uk": SerpAdObservation(
                    domain="riversidedentalstudio.co.uk",
                    landing_page="https://riversidedentalstudio.co.uk",
                    title="Invisalign Newcastle",
                    position=1,
                    query="invisalign provider Newcastle",
                    count=2,
                )
            },
        )
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx, market=market
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.CONFIRMED
        assert analysis.number_of_visible_ads == 2
        assert analysis.ad_landing_page == "https://riversidedentalstudio.co.uk"
        assert analysis.ad_quality_score is not None and analysis.ad_quality_score < 50
        assert any("generic homepage" in e.lower() for e in analysis.evidence)
        assert analysis.estimated_ad_activity in {"low", "moderate", "high"}

    @pytest.mark.asyncio
    async def test_serp_market_without_our_domain_is_not_detected(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website()
        market = AdMarketSnapshot(query="invisalign Newcastle", total_ads=3, by_domain={})
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx, market=market
        )
        assert analysis.appears_to_be_running_google_ads is Confidence.NOT_DETECTED
        assert any("none from" in e for e in analysis.evidence)

    @pytest.mark.asyncio
    async def test_dedicated_landing_page_scores_better(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website(
            service_pages={"Invisalign": "https://riversidedentalstudio.co.uk/invisalign"},
            has_tracking_pixel=True, has_google_analytics=True, has_online_booking=True,
            landing_page_quality_score=80,
        )
        market = AdMarketSnapshot(
            query="invisalign Newcastle",
            total_ads=2,
            by_domain={
                "riversidedentalstudio.co.uk": SerpAdObservation(
                    domain="riversidedentalstudio.co.uk",
                    landing_page="https://riversidedentalstudio.co.uk/invisalign",
                    count=1,
                )
            },
        )
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx, market=market
        )
        assert analysis.ad_quality_score is not None and analysis.ad_quality_score >= 60

    @pytest.mark.asyncio
    async def test_meta_pixel_is_likely(self, settings, ctx, registry):
        lead = make_lead()
        lead.website_analysis = website(has_meta_pixel=True, has_tracking_pixel=True)
        analysis = await AdvertisingAnalyzer(settings).analyse(
            lead, registry.get("aesthetic_clinics"), ctx
        )
        assert analysis.appears_to_be_running_meta_ads is Confidence.LIKELY
        assert "meta_ads" in analysis.advertising_platform

    def test_status_string_for_export(self):
        from lead_pipeline.models import AdvertisingAnalysis

        analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.CONFIRMED,
            appears_to_be_running_meta_ads=Confidence.POSSIBLE,
        )
        assert analysis.status == "google:confirmed|meta:possible"

    def test_capability_flags_reflect_configuration(self, settings):
        assert AdvertisingAnalyzer(settings).can_confirm_google is False
        assert AdvertisingAnalyzer(settings).can_confirm_meta is False
        with_keys = settings.with_overrides(serpapi_api_key="x", meta_ad_library_token="y")
        from lead_pipeline.sources.search import SearchSource

        analyzer = AdvertisingAnalyzer(with_keys, SearchSource(with_keys))
        assert analyzer.can_confirm_google is True
        assert analyzer.can_confirm_meta is True


class TestSocial:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("https://www.facebook.com/RiversideDental/posts/12345",
             ("facebook", "https://facebook.com/RiversideDental")),
            ("instagram.com/riversidedental/", ("instagram", "https://instagram.com/riversidedental")),
            ("https://uk.linkedin.com/company/riverside-dental",
             ("linkedin", "https://uk.linkedin.com/company/riverside-dental")),
            ("https://www.tiktok.com/riversidedental", ("tiktok", "https://tiktok.com/@riversidedental")),
            ("https://youtube.com/channel/UC123", ("youtube", "https://youtube.com/channel/UC123")),
        ],
    )
    def test_canonicalisation(self, raw, expected):
        assert canonical_profile_url(raw) == expected

    @pytest.mark.parametrize(
        "raw",
        [
            None, "", "https://facebook.com/", "https://facebook.com/sharer/sharer.php?u=x",
            "https://example.com/about", "https://facebook.com/login",
        ],
    )
    def test_rejects_non_profiles(self, raw):
        assert canonical_profile_url(raw) is None

    def test_enrich_social_populates_and_scores(self):
        lead = make_lead()
        lead.website_analysis = WebsiteAnalysis(
            website_exists=True, website_loads=True,
            social_links={
                "facebook_url": "https://facebook.com/riversidedental",
                "instagram_url": "https://instagram.com/riversidedental",
            },
        )
        presence = enrich_social(lead)
        assert presence.platform_count == 2
        assert presence.has_visual_platform is True
        assert lead.facebook_url == "https://facebook.com/riversidedental"
        assert presence.presence_score > 0

    def test_invalid_stored_profile_is_cleared(self):
        lead = make_lead()
        lead.facebook_url = "https://facebook.com/sharer/sharer.php?u=x"
        enrich_social(lead)
        assert lead.facebook_url is None

    def test_no_profiles_produces_a_note(self):
        presence = enrich_social(make_lead())
        assert presence.platform_count == 0
        assert presence.notes


class TestReviews:
    def test_bands(self):
        assert rating_band(4.9) == "excellent"
        assert rating_band(4.4) == "strong"
        assert rating_band(3.9) == "mixed"
        assert rating_band(3.1) == "weak"
        assert rating_band(None) == "unknown"
        assert volume_band(300) == "high"
        assert volume_band(120) == "good"
        assert volume_band(50) == "moderate"
        assert volume_band(3) == "low"
        assert volume_band(0) == "none"

    def test_strong_rating_low_volume_is_flagged(self):
        lead = make_lead(google_rating=4.8, google_review_count=34)
        profile = enrich_reviews(lead)
        assert profile.rating_band == "excellent"
        assert profile.volume_band == "low"
        assert any("review generation upside" in note for note in profile.notes)

    def test_reputation_score_rewards_volume_and_rating(self):
        strong = enrich_reviews(make_lead(google_rating=4.9, google_review_count=312))
        weak = enrich_reviews(make_lead(google_rating=3.6, google_review_count=6))
        assert strong.reputation_score > weak.reputation_score

    def test_reviews_not_shown_on_site_is_flagged(self):
        lead = make_lead(google_review_count=180, google_rating=4.6)
        lead.website_analysis = WebsiteAnalysis(website_exists=True, website_loads=True, has_reviews=False)
        profile = enrich_reviews(lead)
        assert any("not surfaced" in note for note in profile.notes)
