"""Source adapters: parsing, availability and API failure handling (requirement 7)."""

from __future__ import annotations

import json

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.sources import available_sources, build_sources, record_to_lead
from lead_pipeline.sources.base import SearchQuery
from lead_pipeline.sources.bing import BingPlacesSource
from lead_pipeline.sources.companies_house import CompaniesHouseSource, years_since
from lead_pipeline.sources.directories import DirectorySource
from lead_pipeline.sources.fixture import FixtureSource
from lead_pipeline.sources.google_places import GooglePlacesSource
from lead_pipeline.sources.openstreetmap import OpenStreetMapSource
from lead_pipeline.sources.search import SearchSource
from lead_pipeline.utils.geo import parse_location
from lead_pipeline.utils.http import FakeTransport, HttpClient
from lead_pipeline.utils.rate_limit import RateLimiter

PACKAGE_FIXTURES = __import__("pathlib").Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture(scope="module")
def registry():
    return load_niches()


@pytest.fixture()
def newcastle():
    location = parse_location("Newcastle upon Tyne", radius_km=30)
    location.latitude, location.longitude, location.geocoded = 54.9783, -1.6178, True
    return location


def make_client(transport) -> HttpClient:
    return HttpClient(
        user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
        respect_robots=False, max_retries=1, backoff_base=0.0, backoff_max=0.0, jitter=False,
    )


async def collect(source, query, ctx):
    return [record async for record in source.search(query, ctx)]


# ---------------------------------------------------------------------------
class TestAvailability:
    def test_sources_report_missing_credentials(self, settings):
        rows = {row["name"]: row for row in available_sources(settings)}
        assert rows["google_places"]["available"] is False
        assert "GOOGLE_PLACES_API_KEY" in rows["google_places"]["reason"]
        assert rows["openstreetmap"]["available"] is True  # keyless
        assert rows["directory"]["available"] is False
        assert rows["fixture"]["available"] is False

    def test_fixture_becomes_available_with_a_path(self, settings):
        path = str(PACKAGE_FIXTURES / "sample_businesses.json")
        rows = {row["name"]: row for row in available_sources(settings, path)}
        assert rows["fixture"]["available"] is True

    def test_build_sources_rejects_unknown_name(self, settings):
        with pytest.raises(KeyError, match="Unknown source"):
            build_sources(settings, ["nope"])

    def test_build_sources_defaults(self, settings):
        names = [s.name for s in build_sources(settings)]
        assert "google_places" in names and "openstreetmap" in names

    def test_every_source_declares_attribution(self, settings):
        for row in available_sources(settings):
            assert row["description"]


# ---------------------------------------------------------------------------
class TestGooglePlaces:
    @pytest.fixture()
    def payload(self):
        return {
            "places": [
                {
                    "id": "ChIJabc123",
                    "displayName": {"text": "Riverside Dental Studio"},
                    "formattedAddress": "12 Grey Street, Newcastle upon Tyne NE1 6EE, UK",
                    "addressComponents": [
                        {"types": ["postal_town"], "longText": "Newcastle upon Tyne"},
                        {"types": ["postal_code"], "longText": "NE1 6EE"},
                        {"types": ["country"], "longText": "United Kingdom"},
                    ],
                    "location": {"latitude": 54.9714, "longitude": -1.6132},
                    "rating": 4.8,
                    "userRatingCount": 237,
                    "websiteUri": "https://riversidedentalstudio.co.uk/",
                    "internationalPhoneNumber": "+44 191 555 0101",
                    "primaryTypeDisplayName": {"text": "Dentist"},
                    "googleMapsUri": "https://maps.google.com/?cid=1",
                    "businessStatus": "OPERATIONAL",
                    "regularOpeningHours": {"weekdayDescriptions": ["Monday: 9:00 AM – 5:00 PM"]},
                },
                {
                    "id": "ChIJclosed",
                    "displayName": {"text": "Closed Dental"},
                    "formattedAddress": "1 Nowhere St, Newcastle NE1 1AA, UK",
                    "location": {"latitude": 54.97, "longitude": -1.61},
                    "businessStatus": "CLOSED_PERMANENTLY",
                },
            ]
        }

    @pytest.mark.asyncio
    async def test_parses_places_and_skips_closed(self, settings, ctx, registry, newcastle, payload):
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        settings = settings.with_overrides(google_places_api_key="test-key")
        source = GooglePlacesSource(settings)
        query = SearchQuery(niche=registry.get("invisalign_dental_practices"), location=newcastle, limit=5)

        records = await collect(source, query, ctx)
        assert len(records) == 1
        record = records[0]
        assert record.source == "google_places"
        assert record.data["google_place_id"] == "ChIJabc123"
        assert record.data["google_rating"] == 4.8
        assert record.data["city"] == "Newcastle upon Tyne"
        assert record.source_url == "https://maps.google.com/?cid=1"

        lead = record_to_lead(record, niche="invisalign_dental_practices", location=newcastle)
        assert lead.company_name == "Riverside Dental Studio"
        assert lead.website == "https://riversidedentalstudio.co.uk"
        assert lead.business_phone == "+441915550101"
        assert lead.postcode == "NE1 6EE"
        assert lead.field_sources["google_rating"] == "google_places"

    @pytest.mark.asyncio
    async def test_api_key_is_sent_in_the_header(self, settings, ctx, registry, newcastle, payload):
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = GooglePlacesSource(settings.with_overrides(google_places_api_key="secret-key"))
        query = SearchQuery(niche=registry.get("cosmetic_dentists"), location=newcastle, limit=2)
        await collect(source, query, ctx)
        assert transport.requests[0].headers["X-Goog-Api-Key"] == "secret-key"
        assert "locationBias" in transport.requests[0].json_body

    @pytest.mark.asyncio
    async def test_api_failure_is_recorded_and_does_not_raise(self, settings, ctx, registry, newcastle):
        transport = FakeTransport(default={"status": 403, "text": '{"error":{"message":"denied"}}'})
        ctx.client = make_client(transport)
        source = GooglePlacesSource(settings.with_overrides(google_places_api_key="bad-key"))
        query = SearchQuery(niche=registry.get("roofers"), location=newcastle, limit=5)

        records = await collect(source, query, ctx)
        assert records == []
        assert ctx.errors and ctx.errors[0].source == "google_places"

    @pytest.mark.asyncio
    async def test_no_key_yields_nothing(self, settings, ctx, registry, newcastle):
        source = GooglePlacesSource(settings)
        query = SearchQuery(niche=registry.get("roofers"), location=newcastle, limit=5)
        assert await collect(source, query, ctx) == []

    @pytest.mark.asyncio
    async def test_results_outside_the_radius_are_dropped(self, settings, ctx, registry, newcastle):
        far_payload = {
            "places": [
                {
                    "id": "ChIJfar",
                    "displayName": {"text": "London Dental"},
                    "formattedAddress": "1 Oxford Street, London W1D 1AN, UK",
                    "location": {"latitude": 51.5155, "longitude": -0.1418},
                    "businessStatus": "OPERATIONAL",
                }
            ]
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(far_payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = GooglePlacesSource(settings.with_overrides(google_places_api_key="k"))
        query = SearchQuery(niche=registry.get("cosmetic_dentists"), location=newcastle, limit=5)
        assert await collect(source, query, ctx) == []


# ---------------------------------------------------------------------------
class TestOpenStreetMap:
    @pytest.mark.asyncio
    async def test_parses_overpass_elements(self, settings, ctx, registry, newcastle):
        payload = {
            "elements": [
                {
                    "type": "node",
                    "id": 1234,
                    "lat": 54.9714,
                    "lon": -1.6132,
                    "tags": {
                        "name": "Riverside Dental Studio",
                        "amenity": "dentist",
                        "website": "https://riversidedentalstudio.co.uk",
                        "phone": "+44 191 555 0101",
                        "addr:housenumber": "12",
                        "addr:street": "Grey Street",
                        "addr:city": "Newcastle upon Tyne",
                        "addr:postcode": "NE1 6EE",
                        "contact:facebook": "https://facebook.com/riversidedental",
                        "opening_hours": "Mo-Fr 09:00-17:00",
                    },
                },
                {"type": "node", "id": 2, "lat": 54.97, "lon": -1.61, "tags": {"amenity": "cafe",
                                                                              "name": "Coffee Shop"}},
                {"type": "way", "id": 3, "center": {"lat": 54.97, "lon": -1.61}, "tags": {}},
            ]
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = OpenStreetMapSource(settings)
        query = SearchQuery(niche=registry.get("invisalign_dental_practices"), location=newcastle, limit=10)

        records = await collect(source, query, ctx)
        assert len(records) == 1
        record = records[0]
        assert record.data["company_name"] == "Riverside Dental Studio"
        assert record.data["facebook_url"] == "https://facebook.com/riversidedental"
        assert record.source_record_id == "node/1234"
        assert "openstreetmap.org" in record.source_url

    @pytest.mark.asyncio
    async def test_requires_coordinates(self, settings, ctx, registry):
        source = OpenStreetMapSource(settings)
        query = SearchQuery(
            niche=registry.get("roofers"), location=parse_location("Nowhere"), limit=5
        )
        assert await collect(source, query, ctx) == []

    @pytest.mark.asyncio
    async def test_overpass_failure_is_recorded(self, settings, ctx, registry, newcastle):
        transport = FakeTransport(default={"status": 504, "text": "gateway timeout"})
        ctx.client = make_client(transport)
        source = OpenStreetMapSource(settings)
        query = SearchQuery(niche=registry.get("roofers"), location=newcastle, limit=5)
        assert await collect(source, query, ctx) == []
        assert any(e.source == "openstreetmap" for e in ctx.errors)

    def test_query_includes_radius_and_tag_filters(self, settings, registry, newcastle):
        source = OpenStreetMapSource(settings)
        query = SearchQuery(niche=registry.get("cosmetic_dentists"), location=newcastle, limit=5)
        overpass = source._build_query(query, 30000)
        assert "around:30000,54.9783,-1.6178" in overpass
        assert 'amenity"="dentist' in overpass
        assert overpass.startswith("[out:json]")


# ---------------------------------------------------------------------------
class TestBing:
    @pytest.mark.asyncio
    async def test_parses_local_search(self, settings, ctx, registry, newcastle):
        payload = {
            "resourceSets": [
                {
                    "resources": [
                        {
                            "name": "Northern Roofing Solutions",
                            "PhoneNumber": "0191 555 0303",
                            "Website": "https://northernroofingsolutions.co.uk",
                            "Address": {
                                "formattedAddress": "Unit 4, Hylton Road, Sunderland SR4 7AB",
                                "locality": "Sunderland",
                                "postalCode": "SR4 7AB",
                                "adminDistrict": "England",
                                "countryRegion": "United Kingdom",
                            },
                            "point": {"coordinates": [54.9069, -1.3838]},
                            "entityType": ["Roofing"],
                        }
                    ]
                }
            ]
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = BingPlacesSource(settings.with_overrides(bing_maps_api_key="key"))
        location = parse_location("Sunderland", radius_km=30)
        location.latitude, location.longitude, location.geocoded = 54.9069, -1.3838, True
        query = SearchQuery(niche=registry.get("roofers"), location=location, limit=5)

        records = await collect(source, query, ctx)
        assert records and records[0].data["company_name"] == "Northern Roofing Solutions"
        assert records[0].data["postcode"] == "SR4 7AB"

    @pytest.mark.asyncio
    async def test_no_key_yields_nothing(self, settings, ctx, registry, newcastle):
        source = BingPlacesSource(settings)
        query = SearchQuery(niche=registry.get("roofers"), location=newcastle, limit=5)
        assert await collect(source, query, ctx) == []


# ---------------------------------------------------------------------------
class TestSearchSource:
    @pytest.mark.asyncio
    async def test_brave_results_become_records(self, settings, ctx, registry, newcastle):
        payload = {
            "web": {
                "results": [
                    {"title": "Riverside Dental Studio | Invisalign Newcastle",
                     "url": "https://riversidedentalstudio.co.uk/", "description": "Invisalign provider"},
                    {"title": "Best dentists in Newcastle - Yell",
                     "url": "https://www.yell.com/s/dentists-newcastle.html", "description": "Directory"},
                ]
            }
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = SearchSource(settings.with_overrides(brave_search_api_key="key"))
        query = SearchQuery(niche=registry.get("cosmetic_dentists"), location=newcastle, limit=5)

        records = await collect(source, query, ctx)
        names = [r.data["company_name"] for r in records]
        assert "Riverside Dental Studio" in names
        assert not any("Yell" in n for n in names)  # aggregators filtered out

    @pytest.mark.asyncio
    async def test_official_website_lookup_requires_a_plausible_match(self, settings, ctx):
        payload = {
            "web": {
                "results": [
                    {"title": "Riverside Dental Studio", "url": "https://riversidedentalstudio.co.uk/",
                     "description": ""},
                ]
            }
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = SearchSource(settings.with_overrides(brave_search_api_key="key"))
        website, hit = await source.find_official_website("Riverside Dental Studio", "Newcastle", ctx)
        assert website == "https://riversidedentalstudio.co.uk"

        unrelated, _ = await source.find_official_website("Completely Different Ltd", "Leeds", ctx)
        assert unrelated is None

    @pytest.mark.asyncio
    async def test_provider_priority(self, settings):
        assert SearchSource(settings).provider is None
        assert SearchSource(settings.with_overrides(brave_search_api_key="b")).provider == "brave"
        assert SearchSource(
            settings.with_overrides(brave_search_api_key="b", serpapi_api_key="s")
        ).provider == "serpapi"

    @pytest.mark.asyncio
    async def test_serpapi_returns_ads_flagged(self, settings, ctx, registry, newcastle):
        payload = {
            "organic_results": [{"title": "Organic", "link": "https://organic.test/"}],
            "ads": [{"title": "Ad", "link": "https://advertiser.test/lp", "description": "Book now"}],
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = SearchSource(settings.with_overrides(serpapi_api_key="key"))
        hits = await source.run_query("invisalign newcastle", ctx)
        assert any(hit.is_ad for hit in hits)
        assert any(not hit.is_ad for hit in hits)

    @pytest.mark.asyncio
    async def test_api_failure_returns_empty(self, settings, ctx):
        transport = FakeTransport(default={"status": 500, "text": "server error"})
        ctx.client = make_client(transport)
        source = SearchSource(settings.with_overrides(brave_search_api_key="key"))
        assert await source.run_query("anything", ctx) == []
        assert ctx.errors


# ---------------------------------------------------------------------------
class TestCompaniesHouse:
    @pytest.mark.asyncio
    async def test_confident_match_returns_registry_data(self, settings, ctx):
        payload = {
            "items": [
                {
                    "title": "RIVERSIDE DENTAL STUDIO LIMITED",
                    "company_number": "09876543",
                    "company_status": "active",
                    "date_of_creation": "2015-04-02",
                    "address": {"postal_code": "NE1 6EE", "address_line_1": "12 Grey Street",
                                "locality": "Newcastle upon Tyne"},
                }
            ]
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = CompaniesHouseSource(settings.with_overrides(companies_house_api_key="key"))
        record = await source.lookup("Riverside Dental Studio", ctx, postcode="NE1 6EE")
        assert record is not None
        assert record.data["company_number"] == "09876543"
        assert record.data["legal_name"] == "RIVERSIDE DENTAL STUDIO LIMITED"
        assert years_since("2015-04-02") > 5

    @pytest.mark.asyncio
    async def test_weak_match_is_rejected(self, settings, ctx):
        payload = {
            "items": [
                {"title": "COMPLETELY UNRELATED HOLDINGS LTD", "company_number": "111",
                 "company_status": "active", "date_of_creation": "2001-01-01", "address": {}}
            ]
        }
        transport = FakeTransport(
            default={"status": 200, "text": json.dumps(payload),
                     "headers": {"content-type": "application/json"}}
        )
        ctx.client = make_client(transport)
        source = CompaniesHouseSource(settings.with_overrides(companies_house_api_key="key"))
        assert await source.lookup("Riverside Dental Studio", ctx) is None

    @pytest.mark.asyncio
    async def test_no_key_returns_none(self, settings, ctx):
        assert await CompaniesHouseSource(settings).lookup("Anything", ctx) is None

    def test_years_since_handles_bad_input(self):
        assert years_since(None) is None
        assert years_since("not-a-date") is None


# ---------------------------------------------------------------------------
class TestDirectorySource:
    def test_ships_disabled(self, settings):
        source = DirectorySource(settings)
        assert source.is_available() is False
        assert "no directories enabled" in source.unavailable_reason()

    @pytest.mark.asyncio
    async def test_respects_robots_and_stops_on_challenge(self, settings, ctx, registry, newcastle, tmp_path):
        config = tmp_path / "directories.json"
        config.write_text(
            json.dumps(
                {
                    "directories": [
                        {
                            "name": "example_dir",
                            "enabled": True,
                            "search_url": "https://directory.test/search?what={query}&where={location}&page={page}",
                            "max_pages": 1,
                            "result_selector": "div.listing",
                            "fields": {"company_name": {"selector": "h2", "attr": "text"}},
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        settings = settings.with_overrides(directories_path=config)
        transport = FakeTransport(
            routes={
                "/robots.txt": {"status": 200, "text": "User-agent: *\nAllow: /\n",
                                "headers": {"content-type": "text/plain"}},
            },
            default={"status": 200,
                     "text": "<html><body>Please verify you are human (captcha)</body></html>"},
        )
        ctx.client = HttpClient(
            user_agent="Test/1.0", transport=transport, limiter=RateLimiter(1000.0),
            respect_robots=True, max_retries=1, jitter=False,
        )
        source = DirectorySource(settings)
        assert source.is_available() is True
        query = SearchQuery(niche=registry.get("roofers"), location=newcastle, limit=5)
        records = await collect(source, query, ctx)
        assert records == []
        assert any(e.error_type == "challenge_detected" for e in ctx.errors)


# ---------------------------------------------------------------------------
class TestFixtureSource:
    @pytest.mark.asyncio
    async def test_loads_sample_dataset(self, settings, ctx, registry, newcastle):
        source = FixtureSource(settings, PACKAGE_FIXTURES / "sample_businesses.json")
        assert source.is_available() is True
        query = SearchQuery(niche=registry.get("invisalign_dental_practices"), location=newcastle, limit=50)
        records = await collect(source, query, ctx)
        names = {r.data["company_name"] for r in records}
        assert "Riverside Dental Studio" in names
        assert "Quayside Smile Clinic" in names
        assert all(r.data.get("niche") == "invisalign_dental_practices" for r in records)

    @pytest.mark.asyncio
    async def test_fixture_rows_can_declare_their_upstream_source(self, settings, ctx, registry, newcastle):
        source = FixtureSource(settings, PACKAGE_FIXTURES / "sample_businesses.json")
        query = SearchQuery(niche=registry.get("invisalign_dental_practices"), location=newcastle, limit=50)
        records = await collect(source, query, ctx)
        assert {r.source for r in records} >= {"google_places", "openstreetmap"}

    @pytest.mark.asyncio
    async def test_csv_fixture(self, settings, ctx, registry, newcastle, tmp_path):
        csv_path = tmp_path / "businesses.csv"
        csv_path.write_text(
            "name,website,phone,city,postcode,rating,reviews\n"
            "Test Dental,https://testdental.co.uk,0191 555 1111,Newcastle upon Tyne,NE1 1AA,4.5,60\n",
            encoding="utf-8",
        )
        source = FixtureSource(settings, csv_path)
        query = SearchQuery(niche=registry.get("cosmetic_dentists"), location=newcastle, limit=5)
        records = await collect(source, query, ctx)
        assert records[0].data["company_name"] == "Test Dental"
        assert records[0].data["google_rating"] == "4.5"

    def test_missing_file_is_reported(self, settings):
        source = FixtureSource(settings, "/nope/missing.json")
        assert source.is_available() is False
        assert "not found" in source.unavailable_reason()
