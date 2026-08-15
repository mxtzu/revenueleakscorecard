"""Google Places API (New) adapter.

Uses the official ``places:searchText`` endpoint with a circular location bias
and a field mask, then optionally pulls Place Details for the fields Text
Search does not return. Requires ``GOOGLE_PLACES_API_KEY``; usage is governed
by the Google Maps Platform terms (including the caching/display rules) - see
README "Compliance".
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

from ..models import SourceRecord
from ..utils.geo import within_radius
from ..utils.http import HttpError
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"

SEARCH_FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.addressComponents",
        "places.location",
        "places.rating",
        "places.userRatingCount",
        "places.primaryTypeDisplayName",
        "places.types",
        "places.websiteUri",
        "places.nationalPhoneNumber",
        "places.internationalPhoneNumber",
        "places.googleMapsUri",
        "places.businessStatus",
        "places.regularOpeningHours.weekdayDescriptions",
        "places.editorialSummary",
        "nextPageToken",
    ]
)

DETAILS_FIELD_MASK = ",".join(
    [
        "id",
        "displayName",
        "formattedAddress",
        "addressComponents",
        "location",
        "rating",
        "userRatingCount",
        "primaryTypeDisplayName",
        "types",
        "websiteUri",
        "nationalPhoneNumber",
        "internationalPhoneNumber",
        "googleMapsUri",
        "businessStatus",
        "regularOpeningHours.weekdayDescriptions",
        "editorialSummary",
    ]
)

MAX_PAGES = 3  # Text Search caps out at 3 pages / 60 results per query.


class GooglePlacesSource(BaseSource):
    name = "google_places"
    kind = "discovery"
    description = "Google Places API (New) text search + place details"
    attribution = "Google Maps Platform"
    requires_credentials = ("google_places_api_key",)

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        api_key = self.settings.google_places_api_key
        if not api_key:
            return

        headers = {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": api_key,
            "X-Goog-FieldMask": SEARCH_FIELD_MASK,
        }
        seen_ids: set[str] = set()
        emitted = 0

        for term in query.terms():
            if emitted >= query.limit:
                break
            text_query = f"{term} in {query.location.query_string()}"
            page_token: str | None = None

            for _ in range(MAX_PAGES):
                body: dict[str, Any] = {
                    "textQuery": text_query,
                    "languageCode": "en",
                    "maxResultCount": 20,
                }
                region_code = _region_code(query.country or query.location.country)
                if region_code:
                    body["regionCode"] = region_code
                if query.location.has_coordinates:
                    body["locationBias"] = {
                        "circle": {
                            "center": {
                                "latitude": query.location.latitude,
                                "longitude": query.location.longitude,
                            },
                            "radius": min(50_000.0, max(1.0, query.radius_km * 1000)),
                        }
                    }
                if page_token:
                    body["pageToken"] = page_token

                try:
                    payload = await ctx.client.post_json(
                        TEXT_SEARCH_URL,
                        headers=headers,
                        json_body=body,
                        check_robots=False,  # authorised API call, not crawling
                        cache_ttl=self.settings.cache_ttl_seconds,
                        label="google_places_text_search",
                    )
                except HttpError as exc:
                    ctx.record_error(
                        stage="discovery", source=self.name, target=text_query, error=exc,
                        error_type=exc.kind,
                    )
                    self.logger.warning(
                        "Google Places search failed",
                        extra={"query": text_query, "error": str(exc), "status": exc.status},
                    )
                    break

                places = (payload or {}).get("places") or []
                for place in places:
                    place_id = place.get("id")
                    if not place_id or place_id in seen_ids:
                        continue
                    seen_ids.add(place_id)
                    record = self._to_record(place, query)
                    if record is None:
                        continue
                    emitted += 1
                    yield record
                    if emitted >= query.limit:
                        break

                page_token = (payload or {}).get("nextPageToken")
                if not page_token or emitted >= query.limit:
                    break
                # Google requires a short delay before a page token is valid.
                await asyncio.sleep(1.5)

    async def fetch_details(self, place_id: str, ctx: SourceContext) -> SourceRecord | None:
        """Place Details lookup for a known place id (used for enrichment)."""
        api_key = self.settings.google_places_api_key
        if not api_key or not place_id:
            return None
        headers = {"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": DETAILS_FIELD_MASK}
        try:
            payload = await ctx.client.get_json(
                DETAILS_URL.format(place_id=place_id),
                headers=headers,
                check_robots=False,
                cache_ttl=self.settings.cache_ttl_seconds,
                label="google_places_details",
            )
        except HttpError as exc:
            ctx.record_error(stage="enrichment", source=self.name, target=place_id, error=exc,
                             error_type=exc.kind)
            return None
        if not payload:
            return None
        return self._to_record(payload, None)

    # ------------------------------------------------------------------
    def _to_record(self, place: dict[str, Any], query: SearchQuery | None) -> SourceRecord | None:
        name = clean_text((place.get("displayName") or {}).get("text") or "")
        if not name:
            return None

        location = place.get("location") or {}
        latitude = location.get("latitude")
        longitude = location.get("longitude")

        if query is not None and latitude is not None and longitude is not None:
            if not within_radius(query.location, latitude, longitude):
                return None

        components = {}
        for component in place.get("addressComponents") or []:
            for component_type in component.get("types") or []:
                components.setdefault(component_type, component.get("longText") or component.get("shortText"))

        status = place.get("businessStatus")
        if status and status != "OPERATIONAL":
            return None

        data = {
            "company_name": name,
            "google_place_id": place.get("id"),
            "address": clean_text(place.get("formattedAddress") or ""),
            "city": components.get("postal_town") or components.get("locality"),
            "postcode": components.get("postal_code"),
            "region": components.get("administrative_area_level_2")
            or components.get("administrative_area_level_1"),
            "country": components.get("country"),
            "latitude": latitude,
            "longitude": longitude,
            "website": place.get("websiteUri"),
            "business_phone": place.get("internationalPhoneNumber") or place.get("nationalPhoneNumber"),
            "google_rating": place.get("rating"),
            "google_review_count": place.get("userRatingCount"),
            "google_category": (place.get("primaryTypeDisplayName") or {}).get("text")
            or (place.get("types") or [None])[0],
            "google_maps_url": place.get("googleMapsUri"),
            "opening_hours": ((place.get("regularOpeningHours") or {}).get("weekdayDescriptions") or []),
            "business_status": status,
            "description": (place.get("editorialSummary") or {}).get("text"),
        }
        return self.make_record(
            data,
            source_url=place.get("googleMapsUri"),
            source_record_id=place.get("id"),
            raw=place,
        )


def _region_code(country: str | None) -> str | None:
    if not country:
        return None
    mapping = {
        "uk": "GB", "gb": "GB", "united kingdom": "GB", "england": "GB",
        "scotland": "GB", "wales": "GB", "northern ireland": "GB",
        "ireland": "IE", "us": "US", "usa": "US", "united states": "US",
        "canada": "CA", "australia": "AU", "new zealand": "NZ",
    }
    return mapping.get(country.strip().lower())
