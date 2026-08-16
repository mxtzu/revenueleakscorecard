"""The 0-100 lead score.

Five categories, each accumulating raw points that are rescaled to the caps in
``config/scoring_weights.json``:

===========================  ====  =========================================
Business value                 25  can they afford GBP 1-3k/month?
Marketing opportunity          25  how much is broken that we would fix?
Paid acquisition opportunity   20  is there a paid-search/social opening?
Business credibility           15  are they a real, reputable operator?
Outreach accessibility         15  can we actually reach them?
===========================  ====  =========================================

Every component records the evidence behind its points, so a score can always
be explained back to the operator.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import NicheRule, ScoringWeights
from ..models import Confidence, Lead, LeadScore, ScoreComponent
from ..utils.email_validation import pick_primary_email
from .niche_rules import NicheAssessment

RAW_MAX = {
    "business_value": 25.0,
    "marketing_opportunity": 25.0,
    "paid_acquisition": 20.0,
    "credibility": 15.0,
    "outreach_accessibility": 15.0,
}


@dataclass
class ScoringInputs:
    """Optional enrichment context; the scorer degrades gracefully without it."""

    assessment: NicheAssessment | None = None
    review_profile: object | None = None
    social_presence: object | None = None


class LeadScorer:
    def __init__(self, weights: ScoringWeights | None = None) -> None:
        self.weights = weights or ScoringWeights()

    def score(
        self,
        lead: Lead,
        rule: NicheRule,
        *,
        assessment: NicheAssessment | None = None,
        review_profile: object | None = None,
        social_presence: object | None = None,
    ) -> LeadScore:
        components = [
            self._business_value(lead, rule, assessment),
            self._marketing_opportunity(lead, rule, assessment),
            self._paid_acquisition(lead, rule, assessment),
            self._credibility(lead, rule, review_profile),
            self._outreach_accessibility(lead, social_presence),
        ]

        weights = self.weights.as_dict()
        scaled: dict[str, float] = {}
        for component in components:
            cap = weights.get(component.name, RAW_MAX[component.name])
            raw_max = component.max_points or RAW_MAX[component.name]
            points = max(0.0, min(component.points, raw_max))
            scaled_points = (points / raw_max) * cap if raw_max else 0.0
            scaled[component.name] = round(scaled_points, 2)
            component.points = points
            component.max_points = raw_max

        total = round(sum(scaled.values()), 1)
        score = LeadScore(
            total=total,
            business_value=scaled["business_value"],
            marketing_opportunity=scaled["marketing_opportunity"],
            paid_acquisition=scaled["paid_acquisition"],
            credibility=scaled["credibility"],
            outreach_accessibility=scaled["outreach_accessibility"],
            components=components,
        )
        score.band = LeadScore.band_for(total)
        return score

    # ------------------------------------------------------------------
    def _business_value(
        self, lead: Lead, rule: NicheRule, assessment: NicheAssessment | None
    ) -> ScoreComponent:
        component = ScoreComponent(name="business_value", points=0.0, max_points=RAW_MAX["business_value"])
        analysis = lead.website_analysis

        ticket_points = (rule.ticket_value / 10.0) * 10.0
        component.points += ticket_points
        component.reasons.append(
            f"{rule.label}: typical customer value rated {rule.ticket_value}/10 (+{ticket_points:.1f})"
        )

        premium = len(assessment.premium_signals) if assessment else 0
        if premium:
            points = min(4.0, premium * 2.0)
            component.points += points
            component.reasons.append(
                f"Premium positioning signals x{premium} (+{points:.1f})"
            )

        if analysis and analysis.multiple_locations:
            component.points += 3.0
            component.reasons.append(
                f"{analysis.location_count} locations referenced on the website (+3.0)"
            )

        ability = 0.0
        reviews = lead.google_review_count or 0
        if reviews >= 200:
            ability += 3.0
        elif reviews >= 80:
            ability += 2.0
        elif reviews >= 25:
            ability += 1.0
        if analysis and analysis.website_loads:
            if analysis.website_quality_score >= 65:
                ability += 2.0
            elif analysis.website_quality_score >= 40:
                ability += 1.0
        if analysis and (analysis.has_pricing or analysis.has_finance_option):
            ability += 1.0
        ability = min(5.0, ability)
        if ability:
            component.points += ability
            component.reasons.append(f"Scale/ability-to-pay signals (+{ability:.1f})")

        high_value = len(assessment.high_value_services) if assessment else 0
        if high_value:
            points = min(3.0, float(high_value))
            component.points += points
            component.reasons.append(
                f"Sells {high_value} high-value service(s) from the niche list (+{points:.1f})"
            )

        component.points = min(component.points, component.max_points)
        return component

    # ------------------------------------------------------------------
    def _marketing_opportunity(
        self, lead: Lead, rule: NicheRule, assessment: NicheAssessment | None
    ) -> ScoreComponent:
        component = ScoreComponent(
            name="marketing_opportunity", points=0.0, max_points=RAW_MAX["marketing_opportunity"]
        )
        analysis = lead.website_analysis

        if analysis is None:
            component.points = 8.0
            component.reasons.append("Website not analysed - opportunity unproven (+8.0 placeholder)")
            return component

        if not analysis.website_exists:
            component.points = 17.0
            component.reasons.append(
                "No website found: needs a landing page before any paid traffic (+17.0)"
            )
            return component

        if not analysis.website_loads:
            component.points = 20.0
            component.reasons.append(
                f"Website does not load ({analysis.error or 'unknown error'}) - urgent, blocking problem (+20.0)"
            )
            return component

        if rule.money_pages:
            missing_ratio = len(assessment.missing_money_pages) / len(rule.money_pages) if assessment else 0.0
            if missing_ratio:
                points = min(6.0, 6.0 * missing_ratio)
                component.points += points
                missing = ", ".join((assessment.missing_money_pages if assessment else [])[:3])
                component.reasons.append(f"Missing dedicated pages for {missing} (+{points:.1f})")

        if not analysis.has_primary_cta:
            component.points += 4.0
            component.reasons.append("No clear primary call-to-action (+4.0)")
        if not analysis.has_phone_cta:
            component.points += 2.0
            component.reasons.append("No click-to-call phone CTA (+2.0)")
        if not analysis.mobile_friendly:
            component.points += 3.0
            component.reasons.append("No mobile viewport / not responsive (+3.0)")
        if not analysis.has_booking_system:
            component.points += 3.0
            component.reasons.append("No booking system or appointment flow (+3.0)")
        if not analysis.has_tracking_pixel:
            component.points += 4.0
            component.reasons.append("No analytics or advertising pixels detected (+4.0)")
        elif not (analysis.has_meta_pixel or analysis.has_google_ads_tag):
            component.points += 2.0
            component.reasons.append("Analytics present but no conversion/remarketing pixels (+2.0)")
        if not (analysis.has_testimonials or analysis.has_reviews):
            component.points += 3.0
            component.reasons.append("No testimonials or reviews shown on site (+3.0)")
        speed = analysis.page_speed_score if analysis.page_speed_score is not None else 60
        if speed < 40:
            component.points += 3.0
            component.reasons.append(f"Slow page speed ({speed}/100) (+3.0)")
        elif speed < 60:
            component.points += 1.5
            component.reasons.append(f"Mediocre page speed ({speed}/100) (+1.5)")
        if analysis.word_count < 400:
            component.points += 2.0
            component.reasons.append(f"Thin site copy ({analysis.word_count} words) (+2.0)")
        if analysis.landing_page_quality_score < 40:
            points = min(4.0, (40 - analysis.landing_page_quality_score) / 10.0)
            component.points += points
            component.reasons.append(
                f"Weak landing-page conversion score ({analysis.landing_page_quality_score}/100) (+{points:.1f})"
            )

        component.points = min(component.points, component.max_points)
        if not component.reasons:
            component.reasons.append("Website already covers the main conversion fundamentals")
        return component

    # ------------------------------------------------------------------
    def _paid_acquisition(
        self, lead: Lead, rule: NicheRule, assessment: NicheAssessment | None
    ) -> ScoreComponent:
        component = ScoreComponent(
            name="paid_acquisition", points=0.0, max_points=RAW_MAX["paid_acquisition"]
        )

        demand = (rule.search_demand / 10.0) * 6.0
        component.points += demand
        component.reasons.append(f"Search demand rated {rule.search_demand}/10 (+{demand:.1f})")

        competition = (rule.competition / 10.0) * 3.0
        component.points += competition
        component.reasons.append(f"Competitive local auction {rule.competition}/10 (+{competition:.1f})")

        ticket = (rule.ticket_value / 10.0) * 3.0
        component.points += ticket
        component.reasons.append(f"High service value supports CPCs (+{ticket:.1f})")

        ads = lead.advertising_analysis
        analysis = lead.website_analysis
        if ads is None:
            component.points += 2.0
            component.reasons.append("Advertising not analysed (+2.0 placeholder)")
        else:
            google = ads.appears_to_be_running_google_ads
            meta = ads.appears_to_be_running_meta_ads
            strongest = Confidence.strongest([google, meta])
            generic_landing = bool(
                ads.ad_landing_page
                and analysis
                and not analysis.service_pages
            )
            if strongest is Confidence.CONFIRMED:
                if generic_landing or (ads.ad_quality_score is not None and ads.ad_quality_score < 50):
                    component.points += 5.0
                    component.reasons.append(
                        "Ads confirmed but the landing experience is weak - immediate optimisation win (+5.0)"
                    )
                else:
                    component.points += 1.5
                    component.reasons.append("Ads confirmed and reasonably well routed (+1.5)")
            elif strongest is Confidence.LIKELY:
                component.points += 3.0
                component.reasons.append("Conversion tags installed - likely already buying traffic (+3.0)")
            elif strongest is Confidence.POSSIBLE:
                component.points += 4.0
                component.reasons.append("Only generic tags found - paid presence unclear (+4.0)")
            elif strongest is Confidence.NOT_DETECTED:
                component.points += 5.0
                component.reasons.append("No paid advertising detected in a high-demand niche (+5.0)")
            else:
                component.points += 2.0
                component.reasons.append("Advertising presence unknown (+2.0)")

        if analysis and analysis.website_loads:
            all_keywords = len(analysis.niche_keywords_found) + len(analysis.niche_keywords_missing)
            if all_keywords:
                gap = len(analysis.niche_keywords_missing) / all_keywords
                points = min(3.0, 3.0 * gap)
                component.points += points
                component.reasons.append(
                    f"{len(analysis.niche_keywords_missing)} niche keywords absent from the site (+{points:.1f})"
                )

        component.points = min(component.points, component.max_points)
        return component

    # ------------------------------------------------------------------
    def _credibility(
        self, lead: Lead, rule: NicheRule, review_profile: object | None
    ) -> ScoreComponent:
        component = ScoreComponent(name="credibility", points=0.0, max_points=RAW_MAX["credibility"])

        reviews = lead.google_review_count or 0
        if reviews >= 250:
            points = 6.0
        elif reviews >= 100:
            points = 5.0
        elif reviews >= 40:
            points = 3.5
        elif reviews >= 15:
            points = 2.0
        elif reviews > 0:
            points = 1.0
        else:
            points = 0.0
        if points:
            component.points += points
            component.reasons.append(f"{reviews} Google reviews (+{points:.1f})")

        rating = lead.google_rating
        if rating is not None:
            if rating >= 4.8:
                points = 4.0
            elif rating >= 4.5:
                points = 3.2
            elif rating >= 4.2:
                points = 2.4
            elif rating >= 3.8:
                points = 1.2
            else:
                points = 0.0
            if points:
                component.points += points
                component.reasons.append(f"{rating}★ Google rating (+{points:.1f})")

        analysis = lead.website_analysis
        if analysis and analysis.website_loads:
            quality = analysis.website_quality_score
            points = min(3.0, quality / 100 * 3.0)
            component.points += points
            component.reasons.append(f"Website quality {quality}/100 (+{points:.1f})")

        years = lead.years_in_operation
        if years is None and analysis and analysis.copyright_year:
            years = None  # copyright year alone is not proof of trading years
        if years is not None:
            if years >= 10:
                points = 2.0
            elif years >= 5:
                points = 1.5
            elif years >= 2:
                points = 1.0
            else:
                points = 0.5
            component.points += points
            component.reasons.append(f"{years} years since incorporation (+{points:.1f})")

        component.points = min(component.points, component.max_points)
        if not component.reasons:
            component.reasons.append("No public credibility signals found")
        return component

    # ------------------------------------------------------------------
    def _outreach_accessibility(self, lead: Lead, social_presence: object | None) -> ScoreComponent:
        component = ScoreComponent(
            name="outreach_accessibility", points=0.0, max_points=RAW_MAX["outreach_accessibility"]
        )

        primary = pick_primary_email(lead.email_assessments)
        if primary:
            points = 5.0 if primary.category in {"generic_business", "role_based"} else 4.0
            component.points += points
            component.reasons.append(
                f"Public business email ({primary.category}): {primary.email} (+{points:.1f})"
            )
        elif lead.business_email:
            component.points += 3.0
            component.reasons.append("Business email available (+3.0)")

        if lead.business_phone:
            component.points += 4.0
            component.reasons.append(f"Public phone number {lead.business_phone} (+4.0)")

        analysis = lead.website_analysis
        if analysis and analysis.has_contact_form:
            component.points += 2.0
            component.reasons.append("Website contact form available (+2.0)")

        profiles = len(lead.social_profiles)
        if profiles >= 2:
            component.points += 2.0
            component.reasons.append(f"{profiles} public social profiles (+2.0)")
        elif profiles == 1:
            component.points += 1.0
            component.reasons.append("1 public social profile (+1.0)")

        if lead.contact_name:
            component.points += 2.0
            role = f", {lead.contact_role}" if lead.contact_role else ""
            component.reasons.append(
                f"Decision-maker named on the company website: {lead.contact_name}{role} (+2.0)"
            )
        elif lead.linkedin_url:
            component.points += 1.0
            component.reasons.append("Company LinkedIn page available for contact routing (+1.0)")

        component.points = min(component.points, component.max_points)
        if not component.reasons:
            component.reasons.append("No public contact route discovered")
        return component


def qualify(lead: Lead, min_score: float) -> bool:
    return lead.lead_score >= min_score
