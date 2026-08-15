"""OpenStreetMap / Overpass API adapter.

The only discovery source that needs no API key, which makes it the default
when nothing is configured. Data is ODbL-licensed and must be attributed to
"© OpenStreetMap contributors".

Politeness: the Overpass usage policy asks for a real User-Agent, modest query
rates and cached results - all enforced here (host rate is pinned to one
request every two seconds and responses are cached for the run TTL).
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator

from ..models import SourceRecord
from ..utils.geo import within_radius
from ..utils.http import HttpError
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_HOST = "overpass-api.de"

_TAG_FILTER_RE = re.compile(r'\["([a-zA-Z:_]+)"\s*=\s*"([^"]+)"\]')

SOCIAL_TAGS = {
    "contact:facebook": "facebook_url",
    "facebook": "facebook_url",
    "contact:instagram": "instagram_url",
    "instagram": "instagram_url",
    "contact:linkedin": "linkedin_url",
    "contact:tiktok": "tiktok_url",
    "contact:youtube": "youtube_url",
}


class OpenStreetMapSource(BaseSource):
    name = "openstreetmap"
    kind = "discovery"
    description = "OpenStreetMap business POIs via the Overpass API (no API key required)"
    attribution = "© OpenStreetMap contributors (ODbL)"
    requires_credentials = ()
    default_rate_per_second = 0.5

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        location = query.location
        if not location.has_coordinates:
            self.logger.info(
                "OpenStreetMap search needs coordinates; skipping",
                extra={"location": location.raw},
            )
            return

        ctx.client.limiter.set_host_rate(OVERPASS_HOST, self.default_rate_per_second or 0.5)

        radius_m = int(min(50_000, max(1_000, query.radius_km * 1000)))
        overpass_query = self._build_query(query, radius_m)
        accepted_tags = self._accepted_tags(query)

        try:
            payload = await ctx.client.post_json(
                OVERPASS_URL,
                data={"data": overpass_query},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                check_robots=False,  # documented public API endpoint
                cache_ttl=self.settings.cache_ttl_seconds,
                timeout=90.0,
                label="overpass",
            )
        except HttpError as exc:
            ctx.record_error(stage="discovery", source=self.name, target=location.label, error=exc,
                             error_type=exc.kind)
            self.logger.warning(
                "Overpass query failed", extra={"location": location.label, "error": str(exc)}
            )
            return

        elements = (payload or {}).get("elements") or []
        emitted = 0
        seen: set[str] = set()
        for element in elements:
            if emitted >= query.limit:
                break
            record = self._to_record(element, query, accepted_tags)
            if record is None:
                continue
            key = record.source_record_id or record.data.get("company_name", "")
            if key in seen:
                continue
            seen.add(key)
            emitted += 1
            yield record

    # ------------------------------------------------------------------
    def _build_query(self, query: SearchQuery, radius_m: int) -> str:
        lat, lon = query.location.latitude, query.location.longitude
        around = f"(around:{radius_m},{lat},{lon})"
        clauses: list[str] = []

        for raw_filter in query.niche.osm_filters:
            clause = raw_filter.strip().rstrip(";")
            if not clause:
                continue
            clauses.append(f"{clause}{around};")

        for keyword in self._name_keywords(query.niche):
            escaped = re.sub(r'[^a-z0-9 ]', "", keyword.lower()).strip()
            if not escaped:
                continue
            clauses.append(f'nwr["name"~"{escaped}",i]{around};')

        if not clauses:
            clauses.append(f'nwr["shop"]{around};')

        body = "\n  ".join(clauses)
        return f"[out:json][timeout:60];\n(\n  {body}\n);\nout center tags 400;"

    def _name_keywords(self, niche: Any) -> list[str]:
        keywords: list[str] = []
        for term in niche.search_terms[:6]:
            head = term.split()[0]
            if len(head) >= 4:
                keywords.append(head)
        for keyword in niche.service_keywords[:6]:
            head = keyword.split()[0]
            if len(head) >= 5:
                keywords.append(head)
        seen: dict[str, None] = {}
        for keyword in keywords:
            seen.setdefault(keyword.lower(), None)
        return list(seen)[:8]

    def _accepted_tags(self, query: SearchQuery) -> set[tuple[str, str]]:
        accepted: set[tuple[str, str]] = set()
        for raw_filter in query.niche.osm_filters:
            for key, value in _TAG_FILTER_RE.findall(raw_filter):
                accepted.add((key, value.lower()))
        return accepted

    def _to_record(
        self, element: dict[str, Any], query: SearchQuery, accepted_tags: set[tuple[str, str]]
    ) -> SourceRecord | None:
        tags = element.get("tags") or {}
        name = clean_text(tags.get("name") or tags.get("brand") or tags.get("operator") or "")
        if not name:
            return None

        center = element.get("center") or {}
        latitude = element.get("lat") if element.get("lat") is not None else center.get("lat")
        longitude = element.get("lon") if element.get("lon") is not None else center.get("lon")
        if not within_radius(query.location, latitude, longitude):
            return None

        if not self._is_relevant(name, tags, query, accepted_tags):
            return None

        street = clean_text(tags.get("addr:street") or "")
        house = clean_text(tags.get("addr:housenumber") or "")
        city = clean_text(tags.get("addr:city") or tags.get("addr:town") or "")
        postcode = clean_text(tags.get("addr:postcode") or "")
        address_parts = [p for p in [" ".join(x for x in (house, street) if x), city, postcode] if p]

        data: dict[str, Any] = {
            "company_name": name,
            "website": tags.get("website") or tags.get("contact:website") or tags.get("url"),
            "business_phone": tags.get("phone") or tags.get("contact:phone") or tags.get("contact:mobile"),
            "business_email": tags.get("email") or tags.get("contact:email"),
            "address": ", ".join(address_parts) or None,
            "city": city or None,
            "postcode": postcode or None,
            "country": query.country,
            "latitude": latitude,
            "longitude": longitude,
            "opening_hours": [tags["opening_hours"]] if tags.get("opening_hours") else [],
            "google_category": tags.get("amenity") or tags.get("shop") or tags.get("craft")
            or tags.get("healthcare") or tags.get("office"),
            "description": tags.get("description"),
        }
        for tag_key, field_name in SOCIAL_TAGS.items():
            if tags.get(tag_key) and not data.get(field_name):
                data[field_name] = tags[tag_key]

        element_id = f"{element.get('type', 'node')}/{element.get('id')}"
        return self.make_record(
            data,
            source_url=f"https://www.openstreetmap.org/{element_id}",
            source_record_id=element_id,
            raw={"osm": element},
        )

    def _is_relevant(
        self, name: str, tags: dict[str, Any], query: SearchQuery, accepted_tags: set[tuple[str, str]]
    ) -> bool:
        for key, value in accepted_tags:
            if str(tags.get(key, "")).lower() == value:
                return True
        haystack = " ".join(
            [name.lower()]
            + [str(tags.get(k, "")).lower() for k in ("description", "shop", "craft", "amenity", "office", "healthcare")]
        )
        for keyword in query.niche.service_keywords + [t.lower() for t in query.niche.search_terms]:
            if keyword and keyword in haystack:
                return True
        for keyword in self._name_keywords(query.niche):
            if keyword in haystack:
                return True
        return False
