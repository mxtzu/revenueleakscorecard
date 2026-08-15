"""Geographic targeting: parsing, CSV loading, distance and geocoding."""

from __future__ import annotations

import json

import pytest

from lead_pipeline.utils.geo import (
    Geocoder,
    bounding_box,
    haversine_km,
    load_locations_csv,
    parse_location,
    within_radius,
)
from lead_pipeline.utils.http import FakeTransport, HttpClient
from lead_pipeline.utils.rate_limit import RateLimiter


class TestParseLocation:
    def test_city(self):
        location = parse_location("Newcastle upon Tyne", radius_km=30)
        assert location.city == "Newcastle upon Tyne"
        assert location.radius_km == 30
        assert location.country == "UK"

    def test_postcode(self):
        location = parse_location("ne1 6ee")
        assert location.postcode == "NE1 6EE"
        assert location.city is None

    def test_city_and_region(self):
        location = parse_location("Newcastle, Tyne and Wear")
        assert location.city == "Newcastle"
        assert location.region == "Tyne and Wear"

    def test_coordinates(self):
        location = parse_location("54.9783,-1.6178")
        assert location.has_coordinates
        assert location.geocoded is True
        assert location.latitude == pytest.approx(54.9783)

    def test_query_string_includes_country(self):
        assert "UK" in parse_location("Durham").query_string()

    def test_label_prefers_city(self):
        assert parse_location("Sunderland").label == "Sunderland"
        assert parse_location("SR4 7AB").label == "SR4 7AB"


class TestLocationsCsv:
    def test_single_column_csv(self, tmp_path):
        path = tmp_path / "locations.csv"
        path.write_text("location\nSunderland\nNewcastle upon Tyne\nDurham\n", encoding="utf-8")
        locations = load_locations_csv(path, radius_km=25)
        assert [loc.raw for loc in locations] == ["Sunderland", "Newcastle upon Tyne", "Durham"]
        assert all(loc.radius_km == 25 for loc in locations)

    def test_rich_csv_with_overrides(self, tmp_path):
        path = tmp_path / "rich.csv"
        path.write_text(
            "location,region,radius_km,latitude,longitude\n"
            "Leeds,West Yorkshire,40,53.8008,-1.5491\n",
            encoding="utf-8",
        )
        location = load_locations_csv(path)[0]
        assert location.region == "West Yorkshire"
        assert location.radius_km == 40
        assert location.has_coordinates

    def test_headerless_csv(self, tmp_path):
        path = tmp_path / "bare.csv"
        path.write_text("Sunderland\nDurham\n", encoding="utf-8")
        locations = load_locations_csv(path)
        assert len(locations) == 2

    def test_blank_rows_skipped(self, tmp_path):
        path = tmp_path / "gaps.csv"
        path.write_text("location\nSunderland\n\nDurham\n", encoding="utf-8")
        assert len(load_locations_csv(path)) == 2

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_locations_csv(tmp_path / "nope.csv")

    def test_packaged_sample_loads(self):
        from pathlib import Path

        sample = Path(__file__).resolve().parents[1] / "fixtures" / "locations.csv"
        locations = load_locations_csv(sample)
        assert [loc.raw for loc in locations][:3] == ["Sunderland", "Newcastle upon Tyne", "Durham"]


class TestDistance:
    def test_haversine_known_distance(self):
        # Newcastle -> Sunderland is roughly 17 km.
        distance = haversine_km(54.9783, -1.6178, 54.9069, -1.3838)
        assert 14 < distance < 20

    def test_zero_distance(self):
        assert haversine_km(54.0, -1.0, 54.0, -1.0) == pytest.approx(0.0, abs=1e-9)

    def test_bounding_box_contains_point(self):
        south, west, north, east = bounding_box(54.9783, -1.6178, 10)
        assert south < 54.9783 < north
        assert west < -1.6178 < east

    def test_within_radius(self):
        location = parse_location("Newcastle upon Tyne", radius_km=10)
        location.latitude, location.longitude = 54.9783, -1.6178
        assert within_radius(location, 54.9714, -1.6132) is True
        assert within_radius(location, 51.5074, -0.1278) is False

    def test_unknown_coordinates_are_kept(self):
        location = parse_location("Newcastle upon Tyne", radius_km=10)
        location.latitude, location.longitude = 54.9783, -1.6178
        assert within_radius(location, None, None) is True


class TestGeocoder:
    @pytest.mark.asyncio
    async def test_geocode_populates_coordinates(self):
        payload = [
            {
                "lat": "54.9783",
                "lon": "-1.6178",
                "display_name": "Newcastle upon Tyne, England, UK",
                "address": {"city": "Newcastle upon Tyne", "county": "Tyne and Wear",
                            "postcode": "NE1 6EE"},
            }
        ]
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        client = HttpClient(user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
                            respect_robots=False, jitter=False)
        location = await Geocoder(client).geocode(parse_location("Newcastle upon Tyne"))
        assert location.has_coordinates and location.geocoded
        assert location.region == "Tyne and Wear"

    @pytest.mark.asyncio
    async def test_geocode_failure_is_not_fatal(self):
        transport = FakeTransport(default={"status": 500, "text": "error"})
        client = HttpClient(user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
                            respect_robots=False, max_retries=1, jitter=False)
        location = await Geocoder(client).geocode(parse_location("Nowhere Special"))
        assert location.has_coordinates is False

    @pytest.mark.asyncio
    async def test_already_geocoded_location_is_not_requeried(self):
        transport = FakeTransport(default={"status": 200, "text": "[]"})
        client = HttpClient(user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
                            respect_robots=False, jitter=False)
        location = parse_location("54.9783,-1.6178")
        await Geocoder(client).geocode(location)
        assert transport.requests == []
