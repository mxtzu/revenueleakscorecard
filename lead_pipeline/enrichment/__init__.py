"""Enrichment layer: website, SEO, advertising, social and review analysis."""

from .ads import AdMarketSnapshot, AdvertisingAnalyzer
from .reviews import ReviewProfile, enrich_reviews
from .seo import PageSignals, analyse_page, detect_tracking, estimate_page_speed
from .social import SocialPresence, canonical_profile_url, enrich_social
from .website import WebsiteAnalyzer, apply_website_analysis, compute_quality_scores

__all__ = [
    "AdvertisingAnalyzer",
    "AdMarketSnapshot",
    "WebsiteAnalyzer",
    "apply_website_analysis",
    "compute_quality_scores",
    "analyse_page",
    "detect_tracking",
    "estimate_page_speed",
    "PageSignals",
    "enrich_social",
    "canonical_profile_url",
    "SocialPresence",
    "enrich_reviews",
    "ReviewProfile",
]
