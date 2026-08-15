"""Niche-specific analysis.

Each vertical in ``config/niches.json`` carries its own keyword sets and
"money pages" (the high-intent service pages a serious advertiser should own).
This module turns those rules into an assessment of one business: which
high-value services it sells, which conversion assets exist, and which are
missing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import NicheRule
from ..models import Lead


@dataclass
class NicheAssessment:
    niche: str
    sub_niche: str | None = None
    detected_services: list[str] = field(default_factory=list)
    high_value_services: list[str] = field(default_factory=list)
    present_money_pages: list[str] = field(default_factory=list)
    missing_money_pages: list[str] = field(default_factory=list)
    premium_signals: list[str] = field(default_factory=list)
    trust_signals: list[str] = field(default_factory=list)
    conversion_signals: list[str] = field(default_factory=list)
    finance_signals: list[str] = field(default_factory=list)
    keyword_coverage: float = 0.0
    opportunities: list[str] = field(default_factory=list)
    strengths: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "niche": self.niche,
            "sub_niche": self.sub_niche,
            "detected_services": self.detected_services,
            "high_value_services": self.high_value_services,
            "present_money_pages": self.present_money_pages,
            "missing_money_pages": self.missing_money_pages,
            "premium_signals": self.premium_signals,
            "trust_signals": self.trust_signals,
            "conversion_signals": self.conversion_signals,
            "finance_signals": self.finance_signals,
            "keyword_coverage": round(self.keyword_coverage, 3),
            "opportunities": self.opportunities,
            "strengths": self.strengths,
        }


def _haystack(lead: Lead) -> str:
    parts = [
        lead.company_name or "",
        lead.description or "",
        lead.google_category or "",
        lead.sub_niche or "",
    ]
    analysis = lead.website_analysis
    if analysis:
        parts.extend(
            [
                analysis.title or "",
                analysis.meta_description or "",
                analysis.h1 or "",
                " ".join(analysis.niche_keywords_found),
                " ".join(analysis.pages_checked),
                " ".join(analysis.service_pages.keys()),
            ]
        )
    return " ".join(parts).lower()


def assess_niche(lead: Lead, rule: NicheRule) -> NicheAssessment:
    """Score one business against its niche's rules."""
    assessment = NicheAssessment(niche=rule.key)
    haystack = _haystack(lead)
    analysis = lead.website_analysis

    found_keywords: set[str] = set()
    if analysis:
        found_keywords.update(analysis.niche_keywords_found)
    for keyword in rule.all_keywords():
        if keyword and keyword in haystack:
            found_keywords.add(keyword)

    assessment.detected_services = sorted(k for k in rule.service_keywords if k in found_keywords)
    assessment.premium_signals = sorted(k for k in rule.premium_keywords if k in found_keywords)
    assessment.trust_signals = sorted(k for k in rule.trust_keywords if k in found_keywords)
    assessment.conversion_signals = sorted(k for k in rule.conversion_keywords if k in found_keywords)
    assessment.finance_signals = sorted(k for k in rule.finance_keywords if k in found_keywords)

    all_keywords = rule.all_keywords()
    assessment.keyword_coverage = (
        len(found_keywords & set(all_keywords)) / len(all_keywords) if all_keywords else 0.0
    )

    # Money pages: present if the analyser matched a dedicated page, else if the
    # keyword shows up anywhere we call it "mentioned but not a dedicated page".
    present: list[str] = []
    missing: list[str] = []
    for money_page in rule.money_pages:
        if analysis and money_page.name in analysis.service_pages:
            present.append(money_page.name)
        else:
            missing.append(money_page.name)
    assessment.present_money_pages = present
    assessment.missing_money_pages = missing

    # High-value services: the top-of-list service keywords the business sells.
    priority_services = rule.service_keywords[:6]
    assessment.high_value_services = [s for s in priority_services if s in found_keywords]
    assessment.sub_niche = detect_sub_niche(lead, rule, found_keywords)

    assessment.opportunities = _niche_opportunities(lead, rule, assessment)
    assessment.strengths = _niche_strengths(lead, rule, assessment)
    return assessment


def detect_sub_niche(lead: Lead, rule: NicheRule, found_keywords: set[str] | None = None) -> str | None:
    """Pick the most prominent money-page service as the sub-niche."""
    haystack = _haystack(lead)
    found = found_keywords if found_keywords is not None else {
        kw for kw in rule.all_keywords() if kw in haystack
    }
    best: tuple[int, str] | None = None
    for money_page in rule.money_pages:
        hits = sum(1 for kw in money_page.keywords if kw in found)
        analysis = lead.website_analysis
        if analysis and money_page.name in analysis.service_pages:
            hits += 2
        if hits and (best is None or hits > best[0]):
            best = (hits, money_page.name)
    if best:
        return best[1]
    if lead.google_category:
        return lead.google_category
    return None


def _niche_opportunities(lead: Lead, rule: NicheRule, assessment: NicheAssessment) -> list[str]:
    """Niche-specific, evidence-backed gaps usable in outreach."""
    analysis = lead.website_analysis
    opportunities: list[str] = []
    if not analysis or not analysis.website_exists:
        return opportunities
    if not analysis.website_loads:
        return opportunities

    haystack = _haystack(lead)
    for money_page in rule.money_pages:
        if money_page.name in assessment.present_money_pages:
            continue
        mentioned = any(kw in haystack for kw in money_page.keywords)
        if mentioned:
            opportunities.append(
                f"{money_page.name} is mentioned but has no dedicated landing page"
            )
        elif money_page.name in (assessment.missing_money_pages or []) and rule.money_pages.index(money_page) < 3:
            opportunities.append(f"No dedicated {money_page.name} page")

    if rule.finance_keywords and not (assessment.finance_signals or analysis.has_finance_option):
        opportunities.append("No finance or payment-plan messaging for a high-ticket service")
    if rule.trust_keywords and not assessment.trust_signals and not analysis.has_before_after:
        opportunities.append("No before/after or results gallery for a visual, proof-driven service")
    if rule.conversion_keywords and not assessment.conversion_signals and not analysis.has_primary_cta:
        opportunities.append("No clear consultation or quote call-to-action")
    if not analysis.has_online_booking and any(
        "book" in kw or "consultation" in kw for kw in rule.conversion_keywords
    ):
        opportunities.append("No online booking for a consultation-led service")
    if not analysis.has_pricing and rule.ticket_value >= 7:
        opportunities.append("No pricing or 'from' guidance on a high-ticket service")
    return opportunities[:8]


def _niche_strengths(lead: Lead, rule: NicheRule, assessment: NicheAssessment) -> list[str]:
    strengths: list[str] = []
    analysis = lead.website_analysis
    if assessment.premium_signals:
        strengths.append(
            f"Premium positioning signals: {', '.join(assessment.premium_signals[:3])}"
        )
    if assessment.present_money_pages:
        strengths.append(
            f"Dedicated service pages for {', '.join(assessment.present_money_pages[:3])}"
        )
    if analysis and analysis.has_before_after:
        strengths.append("Before/after gallery published")
    if analysis and analysis.has_finance_option:
        strengths.append("Finance options promoted")
    if assessment.high_value_services:
        strengths.append(
            f"Sells high-value services: {', '.join(assessment.high_value_services[:3])}"
        )
    return strengths
