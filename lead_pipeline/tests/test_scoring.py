"""Lead scoring, niche rules and opportunity detection (requirement 3)."""

from __future__ import annotations

import pytest

from lead_pipeline.config import ScoringWeights, load_niches
from lead_pipeline.models import AdvertisingAnalysis, Confidence, WebsiteAnalysis
from lead_pipeline.scoring.lead_score import LeadScorer, qualify
from lead_pipeline.scoring.niche_rules import assess_niche, detect_sub_niche
from lead_pipeline.scoring.opportunities import (
    build_audit_record,
    build_lead_reason,
    detect_opportunities,
    detect_strengths,
    recommend_service,
)
from lead_pipeline.utils.email_validation import classify_email

from .conftest import make_lead


@pytest.fixture(scope="module")
def registry():
    return load_niches()


def strong_website(**overrides) -> WebsiteAnalysis:
    analysis = WebsiteAnalysis(
        website_exists=True,
        website_loads=True,
        ssl_enabled=True,
        mobile_friendly=True,
        page_speed_score=82,
        has_booking_system=True,
        has_online_booking=True,
        has_contact_form=True,
        has_phone_cta=True,
        has_primary_cta=True,
        has_pricing=True,
        has_testimonials=True,
        has_reviews=True,
        has_before_after=True,
        has_finance_option=True,
        has_tracking_pixel=True,
        has_google_analytics=True,
        has_google_tag_manager=True,
        has_meta_pixel=True,
        has_google_ads_tag=True,
        word_count=1400,
        title="Riverside Dental Studio | Invisalign Newcastle",
        service_pages={"Invisalign": "https://riversidedentalstudio.co.uk/invisalign"},
        niche_keywords_found=["invisalign", "clear aligners", "teeth straightening"],
        niche_keywords_missing=["retainers"],
        website_quality_score=85,
        landing_page_quality_score=88,
    )
    for key, value in overrides.items():
        setattr(analysis, key, value)
    return analysis


def weak_website(**overrides) -> WebsiteAnalysis:
    analysis = WebsiteAnalysis(
        website_exists=True,
        website_loads=True,
        ssl_enabled=False,
        mobile_friendly=False,
        page_speed_score=32,
        word_count=120,
        title="Northern Roofing Solutions",
        niche_keywords_found=["roof repair"],
        niche_keywords_missing=["emergency roofing", "roof replacement", "flat roof", "commercial roofing"],
        missing_service_pages=["Emergency roofing", "Roof replacement", "Roof repair"],
        website_quality_score=28,
        landing_page_quality_score=12,
    )
    for key, value in overrides.items():
        setattr(analysis, key, value)
    return analysis


class TestScoreShape:
    def test_score_is_bounded_and_sums_to_total(self, registry):
        lead = make_lead()
        lead.website_analysis = strong_website()
        rule = registry.get("invisalign_dental_practices")
        score = LeadScorer().score(lead, rule, assessment=assess_niche(lead, rule))

        assert 0 <= score.total <= 100
        parts = (
            score.business_value + score.marketing_opportunity + score.paid_acquisition
            + score.credibility + score.outreach_accessibility
        )
        assert score.total == pytest.approx(parts, abs=0.11)

    def test_category_caps_respected(self, registry):
        lead = make_lead()
        lead.website_analysis = weak_website()
        rule = registry.get("roofers")
        score = LeadScorer().score(lead, rule, assessment=assess_niche(lead, rule))
        assert score.business_value <= 25
        assert score.marketing_opportunity <= 25
        assert score.paid_acquisition <= 20
        assert score.credibility <= 15
        assert score.outreach_accessibility <= 15

    def test_every_component_carries_evidence(self, registry):
        lead = make_lead()
        lead.website_analysis = strong_website()
        rule = registry.get("invisalign_dental_practices")
        score = LeadScorer().score(lead, rule, assessment=assess_niche(lead, rule))
        assert len(score.components) == 5
        for component in score.components:
            assert component.reasons, f"{component.name} produced no reasons"

    def test_bands(self):
        from lead_pipeline.models import LeadScore

        assert LeadScore.band_for(94) == "80-100"
        assert LeadScore.band_for(72) == "70-79"
        assert LeadScore.band_for(61) == "60-69"
        assert LeadScore.band_for(12) == "0-39"


class TestScoreDirection:
    def test_broken_site_scores_higher_marketing_opportunity(self, registry):
        rule = registry.get("invisalign_dental_practices")
        good = make_lead()
        good.website_analysis = strong_website()
        bad = make_lead()
        bad.website_analysis = weak_website()

        good_score = LeadScorer().score(good, rule, assessment=assess_niche(good, rule))
        bad_score = LeadScorer().score(bad, rule, assessment=assess_niche(bad, rule))
        assert bad_score.marketing_opportunity > good_score.marketing_opportunity

    def test_reviews_and_rating_drive_credibility(self, registry):
        rule = registry.get("invisalign_dental_practices")
        strong = make_lead(google_rating=4.9, google_review_count=312)
        weak = make_lead(google_rating=3.6, google_review_count=4)
        strong.website_analysis = strong_website()
        weak.website_analysis = strong_website()
        assert (
            LeadScorer().score(strong, rule).credibility
            > LeadScorer().score(weak, rule).credibility
        )

    def test_contactability_drives_accessibility(self, registry):
        rule = registry.get("roofers")
        reachable = make_lead()
        reachable.email_assessments = [
            classify_email("info@riversidedentalstudio.co.uk",
                           company_domain="riversidedentalstudio.co.uk")
        ]
        reachable.business_email = "info@riversidedentalstudio.co.uk"
        reachable.facebook_url = "https://facebook.com/riverside"
        reachable.instagram_url = "https://instagram.com/riverside"
        reachable.website_analysis = strong_website()

        unreachable = make_lead(business_phone=None)
        unreachable.website_analysis = strong_website(has_contact_form=False)

        assert (
            LeadScorer().score(reachable, rule).outreach_accessibility
            > LeadScorer().score(unreachable, rule).outreach_accessibility
        )

    def test_no_ads_detected_raises_paid_opportunity(self, registry):
        rule = registry.get("invisalign_dental_practices")
        quiet = make_lead()
        quiet.website_analysis = strong_website()
        quiet.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.NOT_DETECTED,
            appears_to_be_running_meta_ads=Confidence.NOT_DETECTED,
        )
        active = make_lead()
        active.website_analysis = strong_website()
        active.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.CONFIRMED,
            appears_to_be_running_meta_ads=Confidence.CONFIRMED,
            ad_landing_page="https://riversidedentalstudio.co.uk/invisalign",
            ad_quality_score=82,
        )
        assert (
            LeadScorer().score(quiet, rule).paid_acquisition
            > LeadScorer().score(active, rule).paid_acquisition
        )

    def test_high_ticket_niche_scores_more_business_value(self, registry):
        hair = registry.get("hair_transplant_clinics")
        detailing = registry.get("car_detailing_wrapping")
        lead = make_lead()
        lead.website_analysis = strong_website()
        assert (
            LeadScorer().score(lead, hair).business_value
            > LeadScorer().score(lead, detailing).business_value
        )


class TestWeights:
    def test_custom_weights_change_the_split(self, registry):
        rule = registry.get("roofers")
        lead = make_lead()
        lead.website_analysis = weak_website()
        default = LeadScorer().score(lead, rule)
        reweighted = LeadScorer(
            ScoringWeights(
                business_value=10, marketing_opportunity=50, paid_acquisition=20,
                credibility=10, outreach_accessibility=10,
            )
        ).score(lead, rule)
        assert reweighted.marketing_opportunity > default.marketing_opportunity
        assert reweighted.business_value < default.business_value
        assert 0 <= reweighted.total <= 100

    def test_qualify_threshold(self):
        lead = make_lead()
        from lead_pipeline.models import LeadScore

        lead.score = LeadScore(total=71.0)
        assert qualify(lead, 70) is True
        assert qualify(lead, 80) is False


class TestNicheRules:
    def test_assessment_finds_services_and_missing_pages(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website()
        assessment = assess_niche(lead, rule)
        assert "invisalign" in assessment.detected_services
        assert "Invisalign" in assessment.present_money_pages
        assert "Teeth straightening" in assessment.missing_money_pages
        assert 0 < assessment.keyword_coverage <= 1

    def test_sub_niche_detection(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website()
        assert detect_sub_niche(lead, rule) == "Invisalign"

    def test_every_configured_niche_scores(self, registry):
        lead = make_lead()
        lead.website_analysis = weak_website()
        assert len(registry) == 10
        for rule in registry.all():
            score = LeadScorer().score(lead, rule, assessment=assess_niche(lead, rule))
            assert 0 <= score.total <= 100


class TestOpportunities:
    def test_weak_site_produces_actionable_opportunities(self, registry):
        rule = registry.get("roofers")
        lead = make_lead(niche="roofers", company_name="Northern Roofing Solutions")
        lead.website_analysis = weak_website()
        opportunities = detect_opportunities(lead, rule, assess_niche(lead, rule))
        joined = " | ".join(opportunities).lower()
        assert "no online booking" in joined
        assert "not mobile-optimised" in joined
        assert any("tracking" in o.lower() for o in opportunities)
        assert len(opportunities) == len(set(opportunities))

    def test_ads_confirmed_on_generic_homepage_is_flagged(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website(service_pages={}, missing_service_pages=["Invisalign"])
        lead.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.CONFIRMED,
            ad_landing_page="https://riversidedentalstudio.co.uk",
            ad_quality_score=35,
        )
        opportunities = detect_opportunities(lead, rule, assess_niche(lead, rule))
        assert any("generic homepage" in o.lower() for o in opportunities)

    def test_review_gap_opportunity(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead(google_rating=4.7, google_review_count=34)
        lead.website_analysis = strong_website()
        opportunities = detect_opportunities(lead, rule, assess_niche(lead, rule))
        assert any("34 Google reviews" in o for o in opportunities)

    def test_no_website_is_the_headline_problem(self, registry):
        rule = registry.get("builders")
        lead = make_lead(website=None, niche="builders")
        lead.website_analysis = WebsiteAnalysis(website_exists=False)
        opportunities = detect_opportunities(lead, rule)
        assert opportunities[0].startswith("No website found")

    def test_strengths_are_evidence_based(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website()
        strengths = detect_strengths(lead, rule, assess_niche(lead, rule))
        assert any("4.8" in s for s in strengths)
        assert any("booking" in s.lower() for s in strengths)

    def test_lead_reason_mentions_rating_and_gap(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website(service_pages={}, has_online_booking=False,
                                               has_booking_system=False)
        opportunities = detect_opportunities(lead, rule, assess_niche(lead, rule))
        reason = build_lead_reason(lead, rule, opportunities, detect_strengths(lead, rule))
        assert "4.8" in reason and "237" in reason
        assert reason.endswith(".")
        assert ", but " in reason

    def test_recommended_service_matches_evidence(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website(service_pages={}, landing_page_quality_score=30)
        lead.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.CONFIRMED, ad_quality_score=30
        )
        assert "Google Ads" in recommend_service(lead, rule)

        no_site = make_lead(website=None)
        no_site.website_analysis = WebsiteAnalysis(website_exists=False)
        assert "Landing Page" in recommend_service(no_site, rule)


class TestAuditRecord:
    def test_audit_record_contains_every_required_field(self, registry):
        rule = registry.get("invisalign_dental_practices")
        lead = make_lead()
        lead.website_analysis = strong_website(service_pages={}, has_online_booking=False)
        lead.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.CONFIRMED,
            ad_landing_page="https://riversidedentalstudio.co.uk",
            ad_quality_score=40,
        )
        assessment = assess_niche(lead, rule)
        lead.opportunities = detect_opportunities(lead, rule, assessment)
        lead.strengths = detect_strengths(lead, rule, assessment)
        lead.score = LeadScorer().score(lead, rule, assessment=assessment)

        record = build_audit_record(lead, rule, assessment)
        payload = record.as_dict()
        for key in (
            "company", "website", "niche", "location", "lead_score", "what_they_do_well",
            "top_3_problems", "biggest_opportunity", "recommended_service",
            "why_they_are_a_good_prospect",
        ):
            assert key in payload
        assert len(payload["top_3_problems"]) <= 3
        assert payload["biggest_opportunity"]
        rendered = record.render()
        assert "Company:" in rendered and "Recommended service:" in rendered
