"""Opportunity detection, lead reasons and personalisation audit records.

Every string produced here must be traceable to something we observed. No
claim is made about ad spend, revenue or intent that the evidence does not
support.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import NicheRule
from ..models import Confidence, Lead
from .niche_rules import NicheAssessment


@dataclass
class AuditRecord:
    """Compact per-lead brief used for personalised outreach."""

    company: str
    website: str | None
    niche: str
    location: str
    lead_score: float
    strengths: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    biggest_opportunity: str = ""
    recommended_service: str = ""
    why_good_prospect: str = ""
    contact: dict[str, Any] = field(default_factory=dict)
    evidence: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "company": self.company,
            "website": self.website,
            "niche": self.niche,
            "location": self.location,
            "lead_score": self.lead_score,
            "what_they_do_well": self.strengths,
            "top_3_problems": self.problems[:3],
            "biggest_opportunity": self.biggest_opportunity,
            "recommended_service": self.recommended_service,
            "why_they_are_a_good_prospect": self.why_good_prospect,
            "contact": self.contact,
            "evidence": self.evidence,
        }

    def render(self) -> str:
        lines = [
            f"Company: {self.company}",
            f"Website: {self.website or 'none found'}",
            f"Niche: {self.niche}",
            f"Location: {self.location}",
            f"Score: {self.lead_score:.0f}/100",
            "Strength:",
        ]
        lines.extend(f"  {s}" for s in (self.strengths or ["No standout strengths observed."]))
        lines.append("Problems:")
        for index, problem in enumerate(self.problems[:3] or ["None detected."], start=1):
            lines.append(f"  {index}. {problem}")
        lines.append("Biggest opportunity:")
        lines.append(f"  {self.biggest_opportunity or 'None identified.'}")
        lines.append("Recommended service:")
        lines.append(f"  {self.recommended_service}")
        lines.append("Why:")
        lines.append(f"  {self.why_good_prospect}")
        return "\n".join(lines)


def detect_opportunities(lead: Lead, rule: NicheRule, assessment: NicheAssessment | None = None) -> list[str]:
    """Concrete, evidence-backed problems worth mentioning in outreach."""
    opportunities: list[str] = []
    analysis = lead.website_analysis
    ads = lead.advertising_analysis

    if analysis is None:
        # Website analysis was skipped for this run - say nothing about the site.
        if not lead.website:
            opportunities.append("No website listed on any source - website not analysed this run")
    elif not analysis.website_exists:
        opportunities.append("No website found - all paid traffic would have nowhere to land")
    elif not analysis.website_loads:
        reason = analysis.error or "unknown error"
        opportunities.append(f"Website does not load ({reason})")
    else:
        if not analysis.ssl_enabled:
            opportunities.append("No HTTPS - browsers flag the site as not secure")
        if not analysis.mobile_friendly:
            opportunities.append("Site is not mobile-optimised (no responsive viewport)")
        if not analysis.has_primary_cta:
            opportunities.append("No clear primary call-to-action on the homepage")
        elif not analysis.has_phone_cta:
            opportunities.append("No click-to-call CTA - mobile visitors have to hunt for the number")
        if not analysis.has_online_booking:
            opportunities.append("No online booking")
        elif not analysis.has_booking_system:
            opportunities.append("No booking system")
        if not analysis.has_contact_form:
            opportunities.append("No contact form - enquiries depend on phone or email alone")
        if not (analysis.has_testimonials or analysis.has_reviews):
            opportunities.append("No testimonials or review proof on the site")
        if not analysis.has_before_after and rule.trust_keywords:
            opportunities.append("No before/after gallery despite a visually provable service")
        if not analysis.has_pricing and rule.ticket_value >= 7:
            opportunities.append("No pricing guidance on a high-ticket service")
        if not analysis.has_finance_option and rule.finance_keywords and rule.ticket_value >= 7:
            opportunities.append("No finance or payment-plan option promoted")
        if analysis.page_speed_score is not None and analysis.page_speed_score < 45:
            opportunities.append(
                f"Slow page speed ({analysis.page_speed_score}/100, {analysis.page_speed_source})"
            )
        if analysis.word_count and analysis.word_count < 350:
            opportunities.append(f"Very thin site copy ({analysis.word_count} words across checked pages)")

        # --- tracking ---
        if not analysis.has_tracking_pixel:
            opportunities.append("No analytics or advertising tracking detected at all")
        else:
            if not analysis.has_meta_pixel:
                opportunities.append("No visible Meta Pixel")
            if not analysis.has_google_analytics and not analysis.has_google_tag_manager:
                opportunities.append("No Google Analytics or Tag Manager detected")

    # --- reviews ---
    reviews = lead.google_review_count
    rating = lead.google_rating
    if reviews is not None and rating is not None:
        if rating >= 4.5 and reviews < 50:
            opportunities.append(
                f"Only {reviews} Google reviews despite a strong {rating}★ rating"
            )
        elif reviews == 0:
            opportunities.append("No Google reviews yet")
    if analysis and analysis.website_loads and reviews and reviews >= 50 and not analysis.has_reviews:
        opportunities.append(
            f"{reviews} Google reviews exist but are not surfaced anywhere on the website"
        )

    # --- advertising ---
    if ads is not None:
        google = ads.appears_to_be_running_google_ads
        meta = ads.appears_to_be_running_meta_ads
        if google is Confidence.CONFIRMED and ads.ad_landing_page:
            if analysis and not analysis.service_pages:
                opportunities.append(
                    "Google Ads detected but paid traffic lands on a generic homepage"
                )
            elif ads.ad_quality_score is not None and ads.ad_quality_score < 50:
                opportunities.append(
                    f"Google Ads detected but the landing experience scores {ads.ad_quality_score}/100"
                )
        if google is Confidence.LIKELY and analysis and not analysis.has_google_analytics:
            opportunities.append("Google Ads tag present but no analytics to measure the outcome")
        if meta is Confidence.NOT_DETECTED and rule.ticket_value >= 7:
            opportunities.append("No Meta advertising presence detected in a visual, high-ticket niche")

    # --- niche-specific ---
    if assessment:
        opportunities.extend(assessment.opportunities)

    # --- social ---
    if not lead.social_profiles:
        opportunities.append("No public social profiles linked from the website")

    seen: dict[str, None] = {}
    for opportunity in opportunities:
        seen.setdefault(opportunity, None)
    return list(seen)


def detect_strengths(lead: Lead, rule: NicheRule, assessment: NicheAssessment | None = None) -> list[str]:
    strengths: list[str] = []
    analysis = lead.website_analysis

    if lead.google_rating is not None and lead.google_review_count:
        if lead.google_rating >= 4.5 and lead.google_review_count >= 40:
            strengths.append(
                f"{lead.google_rating}★ rating across {lead.google_review_count} Google reviews"
            )
        elif lead.google_rating >= 4.5:
            strengths.append(f"{lead.google_rating}★ Google rating")
        elif lead.google_review_count >= 100:
            strengths.append(f"{lead.google_review_count} Google reviews")

    if analysis and analysis.website_loads:
        if analysis.website_quality_score >= 65:
            strengths.append(f"Professional website (quality {analysis.website_quality_score}/100)")
        if analysis.has_online_booking:
            provider = ", ".join(analysis.booking_providers) if analysis.booking_providers else "online booking"
            strengths.append(f"Online booking in place ({provider})")
        if analysis.has_before_after:
            strengths.append("Before/after results gallery published")
        if analysis.has_finance_option:
            strengths.append("Finance options promoted")
        if analysis.service_pages:
            strengths.append(
                f"Dedicated service pages: {', '.join(list(analysis.service_pages)[:3])}"
            )
        if analysis.has_tracking_pixel:
            tags = [
                label
                for label, present in (
                    ("GA4", analysis.has_google_analytics),
                    ("GTM", analysis.has_google_tag_manager),
                    ("Google Ads", analysis.has_google_ads_tag),
                    ("Meta Pixel", analysis.has_meta_pixel),
                )
                if present
            ]
            if tags:
                strengths.append(f"Tracking installed: {', '.join(tags)}")

    if lead.years_in_operation and lead.years_in_operation >= 5:
        strengths.append(f"Established {lead.years_in_operation:.0f}+ years (Companies House)")

    if assessment:
        strengths.extend(assessment.strengths)

    seen: dict[str, None] = {}
    for strength in strengths:
        seen.setdefault(strength, None)
    return list(seen)


def build_lead_reason(lead: Lead, rule: NicheRule, opportunities: list[str], strengths: list[str]) -> str:
    """One sentence a human can send, grounded in observed evidence."""
    location = lead.city or (lead.search_locations[0] if lead.search_locations else "") or lead.region or ""
    descriptor = _descriptor(rule)

    if lead.google_rating and lead.google_review_count:
        strength_clause = (
            f"{'Strong' if lead.google_rating >= 4.5 else 'Established'} "
            f"{location + ' ' if location else ''}{descriptor} with a {lead.google_rating}★ rating "
            f"and {lead.google_review_count} reviews"
        )
    elif strengths:
        strength_clause = f"{location + ' ' if location else ''}{descriptor} - {strengths[0].lower()}"
    else:
        strength_clause = f"{location + ' ' if location else ''}{descriptor}".strip().capitalize()

    if not opportunities:
        return f"{strength_clause}, with no obvious conversion gaps detected."

    gap = opportunities[0]
    secondary = opportunities[1] if len(opportunities) > 1 else None
    gap_clause = gap[0].lower() + gap[1:] if gap else ""
    reason = f"{strength_clause}, but {gap_clause}"
    if secondary:
        secondary_clause = secondary[0].lower() + secondary[1:]
        reason += f", and {secondary_clause}"
    return reason.rstrip(".") + "."


def _descriptor(rule: NicheRule) -> str:
    """Readable singular noun for a niche label like 'Invisalign / dental practices'."""
    label = (rule.label or "business").split("/")[-1].strip().lower()
    return label[:-1] if label.endswith("s") and not label.endswith("ss") else label


def recommend_service(lead: Lead, rule: NicheRule) -> str:
    """Which of the three offers fits the evidence."""
    analysis = lead.website_analysis
    ads = lead.advertising_analysis

    if analysis is None:
        if not lead.website:
            return "Landing Page build (no website listed)"
        return f"{rule.recommended_service} (website not analysed this run)"
    if not analysis.website_exists:
        return "Landing Page build (no website to advertise to)"
    if not analysis.website_loads:
        return "Landing Page build (current site does not load)"

    needs_landing_page = (
        analysis.landing_page_quality_score < 55
        or not analysis.service_pages
        or not analysis.has_primary_cta
    )

    google_active = ads and ads.appears_to_be_running_google_ads in (
        Confidence.CONFIRMED,
        Confidence.LIKELY,
    )
    meta_active = ads and ads.appears_to_be_running_meta_ads in (Confidence.CONFIRMED, Confidence.LIKELY)

    if google_active and needs_landing_page:
        return "Landing Page + Google Ads management (fix the destination, then the account)"
    if meta_active and needs_landing_page:
        return "Landing Page + Meta Ads management"
    if needs_landing_page:
        return rule.recommended_service
    if not google_active and rule.search_demand >= 7:
        return "Google Ads management (site converts, no paid search presence detected)"
    if not meta_active and rule.ticket_value >= 7:
        return "Meta Ads management (visual, high-ticket service with no paid social detected)"
    return rule.recommended_service


def build_audit_record(
    lead: Lead, rule: NicheRule, assessment: NicheAssessment | None = None
) -> AuditRecord:
    """The compact per-lead brief requested for personalised outreach."""
    opportunities = lead.opportunities or detect_opportunities(lead, rule, assessment)
    strengths = lead.strengths or detect_strengths(lead, rule, assessment)
    location = ", ".join(p for p in [lead.city, lead.postcode] if p) or (
        lead.search_locations[0] if lead.search_locations else lead.region or "unknown"
    )

    biggest = _biggest_opportunity(lead, opportunities)
    why = _why_good_prospect(lead, rule, strengths, opportunities)

    analysis = lead.website_analysis
    ads = lead.advertising_analysis
    record = AuditRecord(
        company=lead.company_name,
        website=lead.website,
        niche=rule.label,
        location=location,
        lead_score=round(lead.lead_score, 1),
        strengths=strengths[:3],
        problems=opportunities[:3],
        biggest_opportunity=biggest,
        recommended_service=lead.recommended_service or recommend_service(lead, rule),
        why_good_prospect=why,
        contact={
            "phone": lead.business_phone,
            "email": lead.business_email,
            "website": lead.website,
            "google_maps_url": lead.google_maps_url,
            "socials": lead.social_profiles,
        },
        evidence={
            "google_rating": lead.google_rating,
            "google_review_count": lead.google_review_count,
            "landing_page_quality_score": analysis.landing_page_quality_score if analysis else None,
            "website_quality_score": analysis.website_quality_score if analysis else None,
            "advertising_status": ads.status if ads else None,
            "advertising_evidence": ads.evidence if ads else [],
            "sources": lead.sources,
        },
    )
    return record


def _biggest_opportunity(lead: Lead, opportunities: list[str]) -> str:
    """The single highest-leverage fix, phrased as an action."""
    analysis = lead.website_analysis
    ads = lead.advertising_analysis

    if analysis is None:
        if not lead.website:
            return (
                "Find or build a web presence - no website was listed by any source, so there is "
                "nowhere for paid traffic to land."
            )
        return (
            "Run a website and conversion audit - the site was not analysed in this run, so the "
            "specific bottleneck is not yet evidenced."
        )
    if not analysis.website_exists:
        return (
            "Build a conversion-focused landing page for the core service and point paid traffic at it - "
            "there is currently no website to advertise to."
        )
    if not analysis.website_loads:
        return "Get a working, fast landing page live - the current site does not load for visitors."

    if ads and ads.appears_to_be_running_google_ads is Confidence.CONFIRMED and not analysis.service_pages:
        return (
            "Build a dedicated landing page for the highest-value service and route the existing "
            "Google Ads traffic straight to it instead of the homepage."
        )
    if analysis.missing_service_pages:
        target = analysis.missing_service_pages[0]
        return (
            f"Build a dedicated {target} landing page with a single consultation CTA and send paid "
            f"search traffic directly to it."
        )
    if not analysis.has_online_booking:
        return "Add an online booking/consultation funnel so paid clicks convert without a phone call."
    if not analysis.has_tracking_pixel:
        return "Install conversion tracking (GA4 + Google Ads + Meta Pixel) so spend can be measured and optimised."
    if opportunities:
        return f"Fix the biggest conversion gap: {opportunities[0].lower()}."
    return "Scale paid acquisition - the conversion fundamentals are already in place."


def _why_good_prospect(lead: Lead, rule: NicheRule, strengths: list[str], opportunities: list[str]) -> str:
    parts: list[str] = []
    if rule.ticket_value >= 8:
        parts.append("high-ticket service")
    elif rule.ticket_value >= 6:
        parts.append("solid job value")
    if lead.google_rating and lead.google_rating >= 4.5 and (lead.google_review_count or 0) >= 40:
        parts.append("strong reputation")
    elif strengths:
        parts.append("credible operator")
    if opportunities:
        parts.append("obvious conversion bottleneck")
    if rule.search_demand >= 8:
        parts.append("high local search demand")
    if not parts:
        parts.append("qualified local business")
    return " + ".join(parts[:4]).capitalize() + "."
