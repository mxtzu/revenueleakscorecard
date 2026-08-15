"""Review signal enrichment.

Consolidates the public review data we legitimately have (Google rating and
review count from the Places API, review platforms referenced on the business
website) into a reputation view used by the credibility score and by
opportunity detection.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import Lead

REVIEW_PLATFORM_TOKENS = {
    "trustpilot": "Trustpilot",
    "checkatrade": "Checkatrade",
    "trustatrader": "TrustATrader",
    "reviews.io": "Reviews.io",
    "feefo": "Feefo",
    "yell.com": "Yell",
    "google reviews": "Google",
    "facebook reviews": "Facebook",
    "which trusted trader": "Which? Trusted Trader",
    "ratedpeople": "Rated People",
    "mybuilder": "MyBuilder",
    "doctify": "Doctify",
    "treatwell": "Treatwell",
}


@dataclass
class ReviewProfile:
    google_rating: float | None = None
    google_review_count: int | None = None
    rating_band: str = "unknown"          # excellent / strong / mixed / weak / unknown
    volume_band: str = "unknown"          # high / good / moderate / low / none / unknown
    platforms_on_site: list[str] = field(default_factory=list)
    displays_reviews_on_site: bool = False
    reputation_score: int = 0             # 0-100
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "google_rating": self.google_rating,
            "google_review_count": self.google_review_count,
            "rating_band": self.rating_band,
            "volume_band": self.volume_band,
            "platforms_on_site": self.platforms_on_site,
            "displays_reviews_on_site": self.displays_reviews_on_site,
            "reputation_score": self.reputation_score,
            "notes": self.notes,
        }


def rating_band(rating: float | None) -> str:
    if rating is None:
        return "unknown"
    if rating >= 4.7:
        return "excellent"
    if rating >= 4.3:
        return "strong"
    if rating >= 3.8:
        return "mixed"
    return "weak"


def volume_band(count: int | None) -> str:
    if count is None:
        return "unknown"
    if count >= 250:
        return "high"
    if count >= 100:
        return "good"
    if count >= 40:
        return "moderate"
    if count >= 1:
        return "low"
    return "none"


def enrich_reviews(lead: Lead) -> ReviewProfile:
    profile = ReviewProfile(
        google_rating=lead.google_rating,
        google_review_count=lead.google_review_count,
    )
    profile.rating_band = rating_band(lead.google_rating)
    profile.volume_band = volume_band(lead.google_review_count)

    analysis = lead.website_analysis
    if analysis:
        haystack = " ".join(
            filter(
                None,
                [
                    (analysis.title or "").lower(),
                    (analysis.meta_description or "").lower(),
                    " ".join(analysis.niche_keywords_found),
                    " ".join(analysis.pages_checked).lower(),
                ],
            )
        )
        for token, label in REVIEW_PLATFORM_TOKENS.items():
            if token in haystack:
                profile.platforms_on_site.append(label)
        profile.displays_reviews_on_site = bool(analysis.has_reviews or analysis.has_testimonials)
        profile.platforms_on_site = sorted(set(profile.platforms_on_site))

    score = 0.0
    if lead.google_rating is not None:
        score += max(0.0, (lead.google_rating - 3.0) / 2.0) * 45
    count = lead.google_review_count or 0
    if count >= 250:
        score += 40
    elif count >= 100:
        score += 32
    elif count >= 40:
        score += 22
    elif count >= 15:
        score += 12
    elif count > 0:
        score += 5
    if profile.displays_reviews_on_site:
        score += 10
    if profile.platforms_on_site:
        score += 5
    profile.reputation_score = int(max(0, min(100, round(score))))

    if profile.rating_band in {"excellent", "strong"} and profile.volume_band in {"low", "moderate"}:
        profile.notes.append(
            f"Strong {lead.google_rating}★ rating but only {count} Google reviews - review generation upside"
        )
    if profile.rating_band == "weak":
        profile.notes.append("Google rating below 3.8 - reputation work needed before scaling paid traffic")
    if not profile.displays_reviews_on_site and count >= 40:
        profile.notes.append("Good Google review volume but reviews are not surfaced on the website")
    return profile
