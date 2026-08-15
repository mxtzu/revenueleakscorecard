"""Geographic targeting: location parsing, CSV loading, geocoding, distance."""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .http import HttpClient, HttpError
from .logging import get_logger
from .normalization import clean_text, normalize_postcode

logger = get_logger("geo")

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

EARTH_RADIUS_KM = 6371.0088

#: Column names recognised in a locations CSV.
LOCATION_CSV_HEADERS = {
    "location", "city", "town", "postcode", "area", "region", "county", "country",
    "radius", "radius_km", "latitude", "longitude",
}


@dataclass
class Location:
    """A geographic target. Any subset of the fields may be supplied."""

    raw: str
    city: str | None = None
    town: str | None = None
    region: str | None = None
    postcode: str | None = None
    country: str = "UK"
    latitude: float | None = None
    longitude: float | None = None
    radius_km: float = 25.0
    display_name: str | None = None
    geocoded: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return self.city or self.town or self.postcode or self.raw

    @property
    def has_coordinates(self) -> bool:
        return self.latitude is not None and self.longitude is not None

    def query_string(self) -> str:
        parts = [p for p in (self.raw, self.region, self.country) if p]
        seen: list[str] = []
        for part in parts:
            if part.lower() not in {s.lower() for s in seen}:
                seen.append(part)
        return ", ".join(seen)

    def as_dict(self) -> dict[str, Any]:
        return {
            "raw": self.raw,
            "city": self.city,
            "town": self.town,
            "region": self.region,
            "postcode": self.postcode,
            "country": self.country,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "radius_km": self.radius_km,
            "display_name": self.display_name,
            "geocoded": self.geocoded,
        }


def parse_location(
    value: str,
    *,
    country: str = "UK",
    radius_km: float = 25.0,
    region: str | None = None,
) -> Location:
    """Build a :class:`Location` from a free-text string.

    Understands ``"NE1 4ST"``, ``"Newcastle upon Tyne"``, ``"Newcastle, Tyne and Wear"``
    and ``"54.9783,-1.6178"``.
    """
    raw = clean_text(value)
    location = Location(raw=raw, country=country, radius_km=radius_km, region=region)

    if "," in raw:
        head, _, tail = raw.partition(",")
        head, tail = clean_text(head), clean_text(tail)
        try:  # "lat,lon"
            lat, lon = float(head), float(tail)
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                location.latitude, location.longitude = lat, lon
                location.geocoded = True
                location.display_name = raw
                return location
        except ValueError:
            location.region = location.region or tail
            raw_head = head
            postcode = normalize_postcode(raw_head)
            if postcode:
                location.postcode = postcode
            else:
                location.city = raw_head
            return location

    postcode = normalize_postcode(raw)
    if postcode:
        location.postcode = postcode
    else:
        location.city = raw
    return location


def load_locations_csv(
    path: str | Path,
    *,
    country: str = "UK",
    radius_km: float = 25.0,
) -> list[Location]:
    """Read a locations CSV.

    Accepts a single ``location`` column (as in the brief) or any of
    ``location/city/town/postcode``, with optional ``region``, ``country``,
    ``radius_km``, ``latitude``, ``longitude``.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise FileNotFoundError(f"Locations CSV not found: {file_path}")

    locations: list[Location] = []
    with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
        first_row = next(csv.reader(handle), [])
        handle.seek(0)
        # A header is whatever names a column we understand; a one-column file
        # of place names (no header at all) is equally valid.
        has_header = any((cell or "").strip().lower() in LOCATION_CSV_HEADERS for cell in first_row)

        if not has_header:
            for row in csv.reader(handle):
                if row and clean_text(row[0]):
                    locations.append(parse_location(row[0], country=country, radius_km=radius_km))
            return locations

        reader = csv.DictReader(handle)
        for row in reader:
            normalized = { (k or "").strip().lower(): clean_text(v) for k, v in row.items() if k }
            raw = (
                normalized.get("location")
                or normalized.get("city")
                or normalized.get("town")
                or normalized.get("postcode")
                or normalized.get("area")
                or ""
            )
            if not raw:
                continue
            loc = parse_location(
                raw,
                country=normalized.get("country") or country,
                radius_km=_to_float(normalized.get("radius_km") or normalized.get("radius"), radius_km),
                region=normalized.get("region") or normalized.get("county") or None,
            )
            if normalized.get("postcode"):
                loc.postcode = normalize_postcode(normalized["postcode"]) or loc.postcode
            if normalized.get("town"):
                loc.town = normalized["town"]
            lat, lon = _to_float(normalized.get("latitude"), None), _to_float(normalized.get("longitude"), None)
            if lat is not None and lon is not None:
                loc.latitude, loc.longitude, loc.geocoded = lat, lon, True
            locations.append(loc)
    return locations


def _to_float(value: Any, default: Any) -> Any:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def bounding_box(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    """(south, west, north, east) box enclosing the radius."""
    lat_delta = radius_km / 110.574
    lon_delta = radius_km / max(1e-6, (111.320 * math.cos(math.radians(lat))))
    return (lat - lat_delta, lon - lon_delta, lat + lat_delta, lon + lon_delta)


def within_radius(location: Location, lat: float | None, lon: float | None, *, slack: float = 1.15) -> bool:
    """Is a point inside the location's radius? Unknown points are kept."""
    if lat is None or lon is None or not location.has_coordinates:
        return True
    distance = haversine_km(location.latitude, location.longitude, lat, lon)  # type: ignore[arg-type]
    return distance <= location.radius_km * slack


class Geocoder:
    """Nominatim geocoder.

    Complies with the OSM usage policy: identifying User-Agent (set via
    ``USER_AGENT``/``CONTACT_EMAIL``), max 1 request/second, and aggressive
    caching so repeat runs never re-query.
    """

    def __init__(self, client: HttpClient, *, country: str = "UK", email: str | None = None) -> None:
        self._client = client
        self._country = country
        self._email = email
        self._client.limiter.set_host_rate("nominatim.openstreetmap.org", 1.0)
        self._memo: dict[str, Location | None] = {}

    async def geocode(self, location: Location) -> Location:
        if location.has_coordinates:
            return location
        query = location.query_string()
        memo_key = query.lower()
        if memo_key in self._memo:
            cached = self._memo[memo_key]
            if cached is not None:
                location.latitude = cached.latitude
                location.longitude = cached.longitude
                location.display_name = cached.display_name
                location.geocoded = True
                location.city = location.city or cached.city
                location.region = location.region or cached.region
                location.postcode = location.postcode or cached.postcode
            return location

        params = {
            "q": query,
            "format": "jsonv2",
            "limit": "1",
            "addressdetails": "1",
        }
        if self._email:
            params["email"] = self._email
        country_code = _country_code(location.country or self._country)
        if country_code:
            params["countrycodes"] = country_code

        try:
            payload = await self._client.get_json(
                NOMINATIM_URL,
                params=params,
                check_robots=False,  # documented public API endpoint
                cache_ttl=30 * 24 * 3600,
                label="geocode",
            )
        except HttpError as exc:
            logger.warning("Geocoding failed", extra={"location": query, "error": str(exc)})
            self._memo[memo_key] = None
            return location

        if not payload:
            logger.warning("No geocoding result", extra={"location": query})
            self._memo[memo_key] = None
            return location

        top = payload[0]
        try:
            location.latitude = float(top["lat"])
            location.longitude = float(top["lon"])
        except (KeyError, TypeError, ValueError):
            self._memo[memo_key] = None
            return location
        location.geocoded = True
        location.display_name = top.get("display_name")
        address = top.get("address") or {}
        location.city = location.city or address.get("city") or address.get("town") or address.get("village")
        location.region = location.region or address.get("county") or address.get("state")
        location.postcode = location.postcode or normalize_postcode(address.get("postcode"))
        self._memo[memo_key] = location
        return location

    async def geocode_all(self, locations: Iterable[Location]) -> list[Location]:
        results = []
        for location in locations:
            results.append(await self.geocode(location))
        return results


def _country_code(country: str | None) -> str | None:
    if not country:
        return None
    mapping = {
        "uk": "gb",
        "gb": "gb",
        "united kingdom": "gb",
        "great britain": "gb",
        "england": "gb",
        "scotland": "gb",
        "wales": "gb",
        "northern ireland": "gb",
        "ireland": "ie",
        "usa": "us",
        "us": "us",
        "united states": "us",
        "canada": "ca",
        "australia": "au",
        "new zealand": "nz",
    }
    return mapping.get(country.strip().lower())
