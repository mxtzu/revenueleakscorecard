"""Source adapter contract.

Adding a source means subclassing :class:`BaseSource`, implementing
``search()``, and registering it in ``sources/__init__.py``. Nothing else in
the pipeline changes.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterable

from ..config import NicheRule, Settings
from ..models import Lead, PipelineError, SourceRecord, iso_now
from ..utils.geo import Location
from ..utils.http import HttpClient
from ..utils.logging import get_logger
from ..utils.normalization import (
    clean_text,
    extract_domain,
    normalize_phone,
    normalize_postcode,
    normalize_url,
    parse_address_components,
)


@dataclass
class SearchQuery:
    """One (niche x location) discovery request."""

    niche: NicheRule
    location: Location
    limit: int = 60
    country: str = "UK"
    extra_terms: list[str] = field(default_factory=list)

    @property
    def radius_km(self) -> float:
        return self.location.radius_km

    def terms(self) -> list[str]:
        terms = list(self.niche.search_terms) or [self.niche.label]
        terms.extend(self.extra_terms)
        seen: dict[str, None] = {}
        for term in terms:
            seen.setdefault(term.strip(), None)
        return [t for t in seen if t]


@dataclass
class SourceContext:
    """Everything a source needs at run time."""

    settings: Settings
    client: HttpClient
    run_id: int | None = None
    errors: list[PipelineError] = field(default_factory=list)

    def record_error(self, *, stage: str, source: str, target: str | None, error: BaseException | str,
                     error_type: str | None = None) -> PipelineError:
        message = str(error)
        err = PipelineError(
            stage=stage,
            source=source,
            target=target,
            error_type=error_type or type(error).__name__ if isinstance(error, BaseException) else (error_type or "error"),
            message=message,
        )
        self.errors.append(err)
        return err


class BaseSource(abc.ABC):
    """Abstract discovery source."""

    name: str = "base"
    kind: str = "discovery"  # discovery | enrichment
    description: str = ""
    attribution: str = ""
    requires_credentials: tuple[str, ...] = ()
    default_rate_per_second: float | None = None

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.logger = get_logger(f"source.{self.name}")

    # -- availability ------------------------------------------------------
    def missing_credentials(self) -> list[str]:
        missing = []
        for credential in self.requires_credentials:
            attribute = credential.lower()
            if not getattr(self.settings, attribute, None):
                missing.append(credential.upper())
        return missing

    def is_available(self) -> bool:
        return not self.missing_credentials()

    def unavailable_reason(self) -> str:
        missing = self.missing_credentials()
        if missing:
            return f"missing credentials: {', '.join(missing)}"
        return ""

    # -- discovery ---------------------------------------------------------
    @abc.abstractmethod
    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        """Yield :class:`SourceRecord` objects for the query."""
        raise NotImplementedError
        yield  # pragma: no cover - makes this an async generator for type checkers

    # -- helpers -----------------------------------------------------------
    def make_record(
        self,
        data: dict[str, Any],
        *,
        source_url: str | None = None,
        source_record_id: str | None = None,
        raw: dict[str, Any] | None = None,
    ) -> SourceRecord:
        return SourceRecord(
            source=self.name,
            source_url=source_url,
            source_record_id=source_record_id,
            retrieved_at=iso_now(),
            data={k: v for k, v in data.items() if v not in (None, "", [], {})},
            raw=raw or {},
        )


def record_to_lead(record: SourceRecord, *, niche: str, location: Location | None = None,
                   country: str = "UK") -> Lead | None:
    """Convert a raw source record into a :class:`Lead` with provenance."""
    data = record.data
    company_name = clean_text(data.get("company_name") or data.get("name") or "")
    if not company_name:
        return None

    address_bits = parse_address_components(data.get("address"), country_hint=country)
    website = normalize_url(data.get("website"), keep_path=False)

    lead = Lead(
        company_name=company_name,
        trading_name=clean_text(data.get("trading_name")) or None,
        legal_name=clean_text(data.get("legal_name")) or None,
        niche=niche,
        sub_niche=data.get("sub_niche"),
        description=clean_text(data.get("description")) or None,
        website=website,
        domain=extract_domain(website),
        business_phone=normalize_phone(data.get("business_phone") or data.get("phone"), country),
        address=data.get("address") or address_bits["address"],
        city=clean_text(data.get("city") or address_bits["city"] or "") or None,
        postcode=normalize_postcode(data.get("postcode")) or address_bits["postcode"],
        region=clean_text(data.get("region") or address_bits["region"] or "") or None,
        country=data.get("country") or address_bits["country"] or country,
        latitude=_as_float(data.get("latitude")),
        longitude=_as_float(data.get("longitude")),
        google_maps_url=normalize_url(data.get("google_maps_url")),
        facebook_url=normalize_url(data.get("facebook_url")),
        instagram_url=normalize_url(data.get("instagram_url")),
        linkedin_url=normalize_url(data.get("linkedin_url")),
        tiktok_url=normalize_url(data.get("tiktok_url")),
        youtube_url=normalize_url(data.get("youtube_url")),
        google_rating=_as_float(data.get("google_rating")),
        google_review_count=_as_int(data.get("google_review_count")),
        google_category=clean_text(data.get("google_category") or "") or None,
        google_place_id=clean_text(data.get("google_place_id") or "") or None,
        opening_hours=list(data.get("opening_hours") or []),
        business_status=data.get("business_status"),
        company_number=clean_text(data.get("company_number") or "") or None,
        incorporation_date=data.get("incorporation_date"),
    )
    if data.get("business_email"):
        lead.business_email = data["business_email"]

    lead.add_source(record)
    for field_name in (
        "company_name", "trading_name", "legal_name", "website", "domain", "business_phone",
        "address", "city", "postcode", "region", "country", "latitude", "longitude",
        "google_maps_url", "facebook_url", "instagram_url", "linkedin_url", "tiktok_url",
        "youtube_url", "google_rating", "google_review_count", "google_category",
        "google_place_id", "business_email", "description", "company_number",
    ):
        if getattr(lead, field_name, None) not in (None, "", [], {}):
            lead.field_sources.setdefault(field_name, record.source)

    if location is not None:
        lead.search_locations = [location.label]
    lead.normalize()
    return lead


def _as_float(value: Any) -> float | None:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def limit_iter(iterable: Iterable[Any], limit: int | None) -> list[Any]:
    items = list(iterable)
    if limit is None or limit <= 0:
        return items
    return items[:limit]
