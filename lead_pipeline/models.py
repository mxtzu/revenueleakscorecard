"""Core data model: raw source records, leads, analyses and scores.

Plain dataclasses (no ORM) so records move cheaply between sources,
enrichers, the scorer, SQLite and the exporters.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Iterable

from .utils.email_validation import EmailAssessment
from .utils.normalization import (
    clean_text,
    dedupe_preserve_order,
    extract_domain,
    normalize_company_name,
    normalize_phone,
    normalize_postcode,
    normalize_url,
    phone_digits,
    title_case_company,
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().isoformat(timespec="seconds")


class Confidence(str, Enum):
    """Evidence strength vocabulary used across advertising intelligence.

    Never upgrade a value beyond what the underlying source can support.
    """

    CONFIRMED = "confirmed"
    LIKELY = "likely"
    POSSIBLE = "possible"
    NOT_DETECTED = "not_detected"
    UNKNOWN = "unknown"

    @property
    def rank(self) -> int:
        return {"confirmed": 4, "likely": 3, "possible": 2, "not_detected": 1, "unknown": 0}[self.value]

    @classmethod
    def strongest(cls, values: Iterable["Confidence"]) -> "Confidence":
        best = cls.UNKNOWN
        for value in values:
            if value.rank > best.rank:
                best = value
        return best


@dataclass
class SourceRecord:
    """One business as reported by one source, before merging."""

    source: str
    source_url: str | None = None
    source_record_id: str | None = None
    retrieved_at: str = field(default_factory=iso_now)
    data: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)


@dataclass
class WebsiteAnalysis:
    """Observable facts about the business website."""

    website_exists: bool = False
    website_loads: bool = False
    final_url: str | None = None
    http_status: int | None = None
    ssl_enabled: bool = False
    mobile_friendly: bool = False
    page_speed_score: int | None = None
    page_speed_source: str = "heuristic"
    load_time_ms: float | None = None
    page_bytes: int | None = None

    has_booking_system: bool = False
    has_online_booking: bool = False
    has_contact_form: bool = False
    has_phone_cta: bool = False
    has_primary_cta: bool = False
    has_pricing: bool = False
    has_testimonials: bool = False
    has_reviews: bool = False
    has_before_after: bool = False
    has_case_studies: bool = False
    has_finance_option: bool = False
    has_live_chat: bool = False

    has_tracking_pixel: bool = False
    has_google_analytics: bool = False
    has_meta_pixel: bool = False
    has_google_tag_manager: bool = False
    has_google_ads_tag: bool = False
    has_tiktok_pixel: bool = False
    has_linkedin_insight: bool = False

    title: str | None = None
    meta_description: str | None = None
    h1: str | None = None
    word_count: int = 0
    pages_checked: list[str] = field(default_factory=list)
    service_pages: dict[str, str] = field(default_factory=dict)  # money page name -> url
    missing_service_pages: list[str] = field(default_factory=list)
    niche_keywords_found: list[str] = field(default_factory=list)
    niche_keywords_missing: list[str] = field(default_factory=list)
    booking_providers: list[str] = field(default_factory=list)
    chat_providers: list[str] = field(default_factory=list)
    cms: str | None = None
    copyright_year: int | None = None
    multiple_locations: bool = False
    location_count: int = 0
    emails_found: list[EmailAssessment] = field(default_factory=list)
    social_links: dict[str, str] = field(default_factory=dict)
    phones_found: list[str] = field(default_factory=list)
    landing_page_quality_score: int = 0
    website_quality_score: int = 0
    analysed_at: str = field(default_factory=iso_now)
    error: str | None = None
    error_kind: str | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["emails_found"] = [e.as_dict() for e in self.emails_found]
        return payload


@dataclass
class AdvertisingAnalysis:
    """Publicly observable advertising signals, with honest confidence levels."""

    appears_to_be_running_google_ads: Confidence = Confidence.UNKNOWN
    appears_to_be_running_meta_ads: Confidence = Confidence.UNKNOWN
    ad_landing_page: str | None = None
    advertising_platform: list[str] = field(default_factory=list)
    number_of_visible_ads: int | None = None
    creative_count: int | None = None
    estimated_ad_activity: str = "unknown"  # none / low / moderate / high / unknown
    ad_quality_score: int | None = None
    evidence: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    analysed_at: str = field(default_factory=iso_now)
    error: str | None = None

    @property
    def status(self) -> str:
        """Compact status string for CSV export."""
        google = self.appears_to_be_running_google_ads.value
        meta = self.appears_to_be_running_meta_ads.value
        return f"google:{google}|meta:{meta}"

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["appears_to_be_running_google_ads"] = self.appears_to_be_running_google_ads.value
        payload["appears_to_be_running_meta_ads"] = self.appears_to_be_running_meta_ads.value
        payload["status"] = self.status
        return payload


@dataclass
class ScoreComponent:
    name: str
    points: float
    max_points: float
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "points": round(self.points, 2),
            "max_points": round(self.max_points, 2),
            "reasons": self.reasons,
        }


@dataclass
class LeadScore:
    total: float = 0.0
    business_value: float = 0.0
    marketing_opportunity: float = 0.0
    paid_acquisition: float = 0.0
    credibility: float = 0.0
    outreach_accessibility: float = 0.0
    components: list[ScoreComponent] = field(default_factory=list)
    scored_at: str = field(default_factory=iso_now)
    band: str = "unscored"

    def as_dict(self) -> dict[str, Any]:
        return {
            "total": round(self.total, 1),
            "band": self.band,
            "business_value": round(self.business_value, 1),
            "marketing_opportunity": round(self.marketing_opportunity, 1),
            "paid_acquisition": round(self.paid_acquisition, 1),
            "credibility": round(self.credibility, 1),
            "outreach_accessibility": round(self.outreach_accessibility, 1),
            "components": [c.as_dict() for c in self.components],
            "scored_at": self.scored_at,
        }

    @staticmethod
    def band_for(total: float) -> str:
        if total >= 80:
            return "80-100"
        if total >= 70:
            return "70-79"
        if total >= 60:
            return "60-69"
        if total >= 40:
            return "40-59"
        return "0-39"


@dataclass
class Lead:
    """A single de-duplicated business with everything we know about it."""

    # --- identity ---
    lead_id: str = ""
    company_name: str = ""
    trading_name: str | None = None
    legal_name: str | None = None
    niche: str = ""
    sub_niche: str | None = None
    description: str | None = None

    # --- contact ---
    website: str | None = None
    domain: str | None = None
    business_phone: str | None = None
    business_email: str | None = None
    email_assessments: list[EmailAssessment] = field(default_factory=list)
    contact_name: str | None = None

    # --- address ---
    address: str | None = None
    city: str | None = None
    postcode: str | None = None
    region: str | None = None
    country: str = "UK"
    latitude: float | None = None
    longitude: float | None = None

    # --- online presence ---
    google_maps_url: str | None = None
    facebook_url: str | None = None
    instagram_url: str | None = None
    linkedin_url: str | None = None
    tiktok_url: str | None = None
    youtube_url: str | None = None

    # --- google / local ---
    google_rating: float | None = None
    google_review_count: int | None = None
    google_category: str | None = None
    google_place_id: str | None = None
    opening_hours: list[str] = field(default_factory=list)
    business_status: str | None = None

    # --- companies house / longevity ---
    company_number: str | None = None
    incorporation_date: str | None = None
    years_in_operation: float | None = None

    # --- analyses ---
    website_analysis: WebsiteAnalysis | None = None
    advertising_analysis: AdvertisingAnalysis | None = None
    score: LeadScore | None = None
    opportunities: list[str] = field(default_factory=list)
    strengths: list[str] = field(default_factory=list)
    lead_reason: str = ""
    recommended_service: str | None = None

    # --- provenance / lifecycle ---
    sources: list[str] = field(default_factory=list)
    source_records: list[SourceRecord] = field(default_factory=list)
    field_sources: dict[str, str] = field(default_factory=dict)
    search_locations: list[str] = field(default_factory=list)
    date_discovered: str = field(default_factory=iso_now)
    last_seen: str = field(default_factory=iso_now)
    last_checked: str | None = None
    previous_score: float | None = None
    run_ids: list[int] = field(default_factory=list)

    # ---------------------------------------------------------------- utils
    def __post_init__(self) -> None:
        self.normalize()

    def normalize(self) -> None:
        self.company_name = title_case_company(clean_text(self.company_name))
        if self.trading_name:
            self.trading_name = clean_text(self.trading_name)
        if self.legal_name:
            self.legal_name = clean_text(self.legal_name)
        if self.website:
            self.website = normalize_url(self.website, keep_path=False) or None
            self.domain = extract_domain(self.website)
        elif self.domain:
            self.domain = extract_domain(self.domain)
        if self.business_phone:
            self.business_phone = normalize_phone(self.business_phone, self.country or "UK") or self.business_phone
        if self.postcode:
            self.postcode = normalize_postcode(self.postcode) or self.postcode
        if not self.lead_id:
            self.lead_id = self.compute_id()

    def compute_id(self) -> str:
        """Stable identity: place id > domain > normalized name + locality."""
        if self.google_place_id:
            basis = f"place:{self.google_place_id}"
        elif self.domain:
            basis = f"domain:{self.domain}"
        else:
            locality = (self.postcode or self.city or "").lower()
            basis = f"name:{normalize_company_name(self.company_name)}|{locality}|{self.niche}"
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]

    @property
    def normalized_name(self) -> str:
        return normalize_company_name(self.company_name)

    @property
    def phone_key(self) -> str | None:
        return phone_digits(self.business_phone, self.country or "UK")

    @property
    def social_profiles(self) -> dict[str, str]:
        return {
            key: value
            for key, value in {
                "facebook": self.facebook_url,
                "instagram": self.instagram_url,
                "linkedin": self.linkedin_url,
                "tiktok": self.tiktok_url,
                "youtube": self.youtube_url,
            }.items()
            if value
        }

    @property
    def lead_score(self) -> float:
        return self.score.total if self.score else 0.0

    def add_source(self, record: SourceRecord) -> None:
        self.source_records.append(record)
        if record.source not in self.sources:
            self.sources.append(record.source)

    def set_field(self, name: str, value: Any, source: str, *, overwrite: bool = False) -> bool:
        """Set a field and remember which source it came from."""
        if value is None or value == "" or value == []:
            return False
        current = getattr(self, name, None)
        if current not in (None, "", [], {}) and not overwrite:
            return False
        setattr(self, name, value)
        self.field_sources[name] = source
        return True

    def merge(self, other: "Lead", *, source_priority: dict[str, int] | None = None) -> "Lead":
        """Fold ``other`` into this lead, keeping the better-sourced values."""
        priority = source_priority or {}

        def rank(source: str | None) -> int:
            return priority.get(source or "", 50)

        simple_fields = [
            "company_name", "trading_name", "legal_name", "sub_niche", "description",
            "website", "domain", "business_phone", "business_email", "contact_name",
            "address", "city", "postcode", "region", "country",
            "google_maps_url", "facebook_url", "instagram_url", "linkedin_url",
            "tiktok_url", "youtube_url", "google_category", "google_place_id",
            "business_status", "company_number", "incorporation_date",
        ]
        for name in simple_fields:
            mine, theirs = getattr(self, name, None), getattr(other, name, None)
            if theirs in (None, ""):
                continue
            if mine in (None, ""):
                setattr(self, name, theirs)
                if name in other.field_sources:
                    self.field_sources[name] = other.field_sources[name]
            else:
                mine_rank = rank(self.field_sources.get(name))
                theirs_rank = rank(other.field_sources.get(name))
                if theirs_rank < mine_rank or (theirs_rank == mine_rank and len(str(theirs)) > len(str(mine)) * 1.5):
                    setattr(self, name, theirs)
                    self.field_sources[name] = other.field_sources.get(name, self.field_sources.get(name, ""))

        for name in ("latitude", "longitude", "google_rating", "google_review_count", "years_in_operation"):
            if getattr(self, name, None) is None and getattr(other, name, None) is not None:
                setattr(self, name, getattr(other, name))
                if name in other.field_sources:
                    self.field_sources[name] = other.field_sources[name]

        # A higher Google review count is the fresher observation.
        if (other.google_review_count or 0) > (self.google_review_count or 0):
            self.google_review_count = other.google_review_count
            if other.google_rating is not None:
                self.google_rating = other.google_rating

        self.opening_hours = self.opening_hours or other.opening_hours
        self.opportunities = dedupe_preserve_order(self.opportunities + other.opportunities)
        self.strengths = dedupe_preserve_order(self.strengths + other.strengths)
        self.sources = dedupe_preserve_order(self.sources + other.sources)
        self.search_locations = dedupe_preserve_order(self.search_locations + other.search_locations)
        self.source_records.extend(other.source_records)
        self.run_ids = list(dict.fromkeys(self.run_ids + other.run_ids))

        existing_emails = {a.email for a in self.email_assessments}
        for assessment in other.email_assessments:
            if assessment.email not in existing_emails:
                self.email_assessments.append(assessment)

        if self.website_analysis is None:
            self.website_analysis = other.website_analysis
        if self.advertising_analysis is None:
            self.advertising_analysis = other.advertising_analysis
        if self.score is None:
            self.score = other.score

        for name, source in other.field_sources.items():
            self.field_sources.setdefault(name, source)

        self.date_discovered = min(self.date_discovered, other.date_discovered)
        self.last_seen = max(self.last_seen, other.last_seen)
        if other.last_checked and (not self.last_checked or other.last_checked > self.last_checked):
            self.last_checked = other.last_checked

        self.normalize()
        return self

    def as_dict(self, *, include_raw: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "lead_id": self.lead_id,
            "company_name": self.company_name,
            "trading_name": self.trading_name,
            "legal_name": self.legal_name,
            "niche": self.niche,
            "sub_niche": self.sub_niche,
            "description": self.description,
            "website": self.website,
            "domain": self.domain,
            "business_phone": self.business_phone,
            "business_email": self.business_email,
            "contact_name": self.contact_name,
            "address": self.address,
            "city": self.city,
            "postcode": self.postcode,
            "region": self.region,
            "country": self.country,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "online_presence": {
                "website": self.website,
                "google_maps_url": self.google_maps_url,
                "facebook_url": self.facebook_url,
                "instagram_url": self.instagram_url,
                "linkedin_url": self.linkedin_url,
                "tiktok_url": self.tiktok_url,
                "youtube_url": self.youtube_url,
            },
            "google": {
                "google_rating": self.google_rating,
                "google_review_count": self.google_review_count,
                "google_category": self.google_category,
                "google_place_id": self.google_place_id,
                "google_maps_url": self.google_maps_url,
                "opening_hours": self.opening_hours,
                "business_status": self.business_status,
            },
            "company_registry": {
                "company_number": self.company_number,
                "incorporation_date": self.incorporation_date,
                "years_in_operation": self.years_in_operation,
            },
            "website_analysis": self.website_analysis.as_dict() if self.website_analysis else None,
            "advertising_analysis": self.advertising_analysis.as_dict() if self.advertising_analysis else None,
            "score": self.score.as_dict() if self.score else None,
            "lead_score": round(self.lead_score, 1),
            "opportunities": self.opportunities,
            "strengths": self.strengths,
            "lead_reason": self.lead_reason,
            "recommended_service": self.recommended_service,
            "emails": [a.as_dict() for a in self.email_assessments],
            "sources": self.sources,
            "field_sources": self.field_sources,
            "search_locations": self.search_locations,
            "date_discovered": self.date_discovered,
            "last_seen": self.last_seen,
            "last_checked": self.last_checked,
            "previous_score": self.previous_score,
            "source_provenance": [
                {
                    "source": r.source,
                    "source_url": r.source_url,
                    "source_record_id": r.source_record_id,
                    "retrieved_at": r.retrieved_at,
                }
                for r in self.source_records
            ],
        }
        if include_raw:
            payload["raw_source_data"] = [
                {"source": r.source, "raw": r.raw} for r in self.source_records
            ]
        return payload


@dataclass
class PipelineError:
    """One recoverable failure; the run continues and reports these at the end."""

    stage: str
    source: str | None
    target: str | None
    error_type: str
    message: str
    created_at: str = field(default_factory=iso_now)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class RunStats:
    run_id: int | None = None
    started_at: str = field(default_factory=iso_now)
    finished_at: str | None = None
    status: str = "running"
    niches: list[str] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)
    sources_used: list[str] = field(default_factory=list)
    discovered: int = 0
    duplicates_removed: int = 0
    enriched: int = 0
    qualified: int = 0
    score_bands: dict[str, int] = field(default_factory=dict)
    errors: list[PipelineError] = field(default_factory=list)
    http: dict[str, int] = field(default_factory=dict)
    cache: dict[str, int] = field(default_factory=dict)
    interrupted: bool = False
    notes: list[str] = field(default_factory=list)

    def add_error(self, error: PipelineError) -> None:
        self.errors.append(error)

    def as_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["errors"] = [e.as_dict() for e in self.errors]
        payload["error_count"] = len(self.errors)
        return payload
