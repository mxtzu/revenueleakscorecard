"""Bing Maps Local Search adapter.

Official REST endpoint (``dev.virtualearth.net``), requires
``BING_MAPS_API_KEY``. Returns name, address, phone and website for local
businesses inside a circular map view.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from ..models import SourceRecord
from ..utils.geo import MAX_SEARCH_RADIUS_KM, within_radius
from ..utils.http import HttpError
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

LOCAL_SEARCH_URL = "https://dev.virtualearth.net/REST/v1/LocalSearch/"


class BingPlacesSource(BaseSource):
    name = "bing_places"
    kind = "discovery"
    description = "Bing Maps Local Search API"
    attribution = "Bing Maps"
    requires_credentials = ("bing_maps_api_key",)

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        api_key = self.settings.bing_maps_api_key
        if not api_key:
            return
        if not query.location.has_coordinates:
            self.logger.info(
                "Bing local search needs coordinates; skipping",
                extra={"location": query.location.raw},
            )
            return

        emitted = 0
        radius_km = min(MAX_SEARCH_RADIUS_KM, max(1.0, query.radius_km))
        for term in query.terms():
            if emitted >= query.limit:
                break
            params = {
                "query": term,
                "userCircularMapView": (
                    f"{query.location.latitude},{query.location.longitude},{int(radius_km * 1000)}"
                ),
                "maxResults": "25",
                "key": api_key,
            }
            try:
                payload = await ctx.client.get_json(
                    LOCAL_SEARCH_URL,
                    params=params,
                    check_robots=False,  # authorised API call
                    cache_ttl=self.settings.cache_ttl_seconds,
                    label="bing_local_search",
                )
            except HttpError as exc:
                ctx.record_error(stage="discovery", source=self.name, target=term, error=exc,
                                 error_type=exc.kind)
                self.logger.warning("Bing local search failed", extra={"term": term, "error": str(exc)})
                continue

            for resource in _iter_resources(payload):
                record = self._to_record(resource, query)
                if record is None:
                    continue
                emitted += 1
                yield record
                if emitted >= query.limit:
                    break

    def _to_record(self, resource: dict[str, Any], query: SearchQuery) -> SourceRecord | None:
        name = clean_text(resource.get("name") or "")
        if not name:
            return None
        address = resource.get("Address") or resource.get("address") or {}
        point = resource.get("point") or {}
        coordinates = point.get("coordinates") or [None, None]
        latitude, longitude = (coordinates + [None, None])[:2]

        if not within_radius(query.location, latitude, longitude):
            return None

        formatted = clean_text(address.get("formattedAddress") or "")
        data = {
            "company_name": name,
            "address": formatted,
            "city": address.get("locality"),
            "postcode": address.get("postalCode"),
            "region": address.get("adminDistrict2") or address.get("adminDistrict"),
            "country": address.get("countryRegion"),
            "latitude": latitude,
            "longitude": longitude,
            "website": resource.get("Website") or resource.get("website"),
            "business_phone": resource.get("PhoneNumber") or resource.get("phone"),
            "google_category": ", ".join(resource.get("entityType", []) if isinstance(resource.get("entityType"), list) else [resource.get("entityType")] if resource.get("entityType") else []),
        }
        return self.make_record(data, source_url=resource.get("Website"), raw=resource)


def _iter_resources(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    resources: list[dict[str, Any]] = []
    for resource_set in payload.get("resourceSets") or []:
        for resource in resource_set.get("resources") or []:
            if isinstance(resource, dict):
                resources.append(resource)
    return resources
