"""End-to-end run over a small dataset (requirement 10).

Fully offline: discovery comes from a fixture file, all HTTP goes through
:class:`FakeTransport`. Exercises discovery -> dedupe -> enrichment ->
website analysis -> ads grading -> scoring -> SQLite -> exports -> summary,
including a deliberately dead website and a robots-blocked site so failure
handling is covered by the same run.
"""

from __future__ import annotations

import csv
import json
import sqlite3

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.database import Database
from lead_pipeline.models import Confidence
from lead_pipeline.report import render_summary
from lead_pipeline.runner import Pipeline, PipelineConfig
from lead_pipeline.utils.geo import parse_location
from lead_pipeline.utils.http import FakeTransport

from .conftest import (
    CONTACT_PAGE,
    GOOD_DENTAL_HOMEPAGE,
    INVISALIGN_LANDING_PAGE,
    POOR_ROOFER_HOMEPAGE,
    ROBOTS_ALLOW_ALL,
    ROBOTS_DISALLOW_ALL,
)

E2E_BUSINESSES = {
    "businesses": [
        {
            "company_name": "Riverside Dental Studio",
            "niche": "invisalign_dental_practices",
            "source": "google_places",
            "google_place_id": "ChIJe2e0001",
            "website": "https://riversidedentalstudio.co.uk",
            "phone": "0191 555 0101",
            "address": "12 Grey Street, Newcastle upon Tyne, NE1 6EE",
            "city": "Newcastle upon Tyne",
            "postcode": "NE1 6EE",
            "latitude": 54.9714,
            "longitude": -1.6132,
            "rating": 4.8,
            "reviews": 237,
            "category": "Dentist",
            "maps_url": "https://maps.google.com/?cid=e2e0001",
        },
        {
            "company_name": "Riverside Dental Studio Ltd",
            "niche": "invisalign_dental_practices",
            "source": "openstreetmap",
            "website": "http://www.riversidedentalstudio.co.uk/",
            "phone": "+44 191 555 0101",
            "address": "12 Grey St, Newcastle upon Tyne NE1 6EE",
            "city": "Newcastle upon Tyne",
            "postcode": "NE1 6EE",
        },
        {
            "company_name": "Quayside Smile Clinic",
            "niche": "invisalign_dental_practices",
            "source": "google_places",
            "google_place_id": "ChIJe2e0002",
            "website": "https://quaysidesmileclinic.co.uk",
            "phone": "0191 555 0202",
            "address": "5 Sandhill, Newcastle upon Tyne, NE1 3AF",
            "city": "Newcastle upon Tyne",
            "postcode": "NE1 3AF",
            "rating": 4.6,
            "reviews": 34,
        },
        {
            "company_name": "Blocked Dental Practice",
            "niche": "invisalign_dental_practices",
            "source": "google_places",
            "google_place_id": "ChIJe2e0003",
            "website": "https://blockeddental.test",
            "phone": "0191 555 0909",
            "address": "9 Blocked Lane, Newcastle upon Tyne, NE2 1AA",
            "city": "Newcastle upon Tyne",
            "postcode": "NE2 1AA",
            "rating": 4.4,
            "reviews": 61,
        },
    ]
}


@pytest.fixture()
def e2e_fixture_file(tmp_path):
    path = tmp_path / "e2e_businesses.json"
    path.write_text(json.dumps(E2E_BUSINESSES), encoding="utf-8")
    return path


@pytest.fixture()
def e2e_transport():
    """One good site, one dead site, one robots-blocked site."""
    return FakeTransport(
        routes={
            "blockeddental.test/robots.txt": {
                "status": 200, "text": ROBOTS_DISALLOW_ALL, "headers": {"content-type": "text/plain"}
            },
            "/robots.txt": {"status": 200, "text": ROBOTS_ALLOW_ALL,
                            "headers": {"content-type": "text/plain"}},
            "riversidedentalstudio.co.uk/invisalign": {"status": 200, "text": INVISALIGN_LANDING_PAGE},
            "riversidedentalstudio.co.uk/contact": {"status": 200, "text": CONTACT_PAGE},
            "riversidedentalstudio.co.uk": {"status": 200, "text": GOOD_DENTAL_HOMEPAGE},
            "quaysidesmileclinic.co.uk": {
                "status": 0, "text": "", "error": "Timeout after 20s", "error_kind": "timeout"
            },
            "blockeddental.test": {"status": 200, "text": GOOD_DENTAL_HOMEPAGE},
        },
        default={"status": 404, "text": "", "headers": {"content-type": "text/html"}},
    )


def build_config(fixture_path, tmp_path, **overrides) -> PipelineConfig:
    registry = load_niches()
    location = parse_location("Newcastle upon Tyne", radius_km=30)
    location.latitude, location.longitude, location.geocoded = 54.9783, -1.6178, True
    config = PipelineConfig(
        niches=[registry.get("invisalign_dental_practices")],
        locations=[location],
        source_names=["fixture"],
        fixture_path=str(fixture_path),
        min_score=40.0,
        formats=["csv", "json", "sqlite"],
        output_dir=tmp_path / "output",
        basename="e2e",
        limit_per_query=50,
    )
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


@pytest.mark.asyncio
class TestEndToEnd:
    async def test_full_run(self, settings, tmp_path, e2e_fixture_file, e2e_transport):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(e2e_fixture_file, tmp_path)
        result = await Pipeline(settings, config, database=db, transport=e2e_transport).run()

        # --- discovery + dedupe ---------------------------------------
        assert result.run.discovered == 4
        assert result.run.duplicates_removed == 1
        assert len(result.leads) == 3
        assert result.run.enriched == 3

        riverside = next(lead for lead in result.leads if "Riverside" in lead.company_name)
        assert set(riverside.sources) == {"google_places", "openstreetmap"}

        # --- website analysis of the healthy site ---------------------
        analysis = riverside.website_analysis
        assert analysis.website_loads is True
        assert analysis.has_online_booking is True
        assert analysis.has_meta_pixel is True
        assert "Invisalign" in analysis.service_pages
        assert riverside.business_email == "hello@riversidedentalstudio.co.uk"
        assert riverside.facebook_url == "https://facebook.com/riversidedentalstudio"

        # --- the dead site did not break the run ----------------------
        quayside = next(lead for lead in result.leads if "Quayside" in lead.company_name)
        assert quayside.website_analysis.website_loads is False
        assert quayside.website_analysis.error_kind == "timeout"
        assert any("does not load" in o for o in quayside.opportunities)

        # --- robots-blocked site was skipped, not crawled -------------
        blocked = next(lead for lead in result.leads if "Blocked" in lead.company_name)
        assert blocked.website_analysis.error_kind == "robots_disallowed"
        assert not any(
            r.url.startswith("https://blockeddental.test") and "robots.txt" not in r.url
            for r in e2e_transport.requests
        )

        # --- scoring ---------------------------------------------------
        for lead in result.leads:
            assert lead.score is not None
            assert 0 <= lead.score.total <= 100
            assert lead.lead_reason.endswith(".")
            assert lead.recommended_service
        assert riverside.lead_score >= 55
        assert result.run.score_bands

        # --- advertising grading --------------------------------------
        ads = riverside.advertising_analysis
        assert ads.appears_to_be_running_google_ads is Confidence.LIKELY
        assert ads.appears_to_be_running_meta_ads is Confidence.LIKELY
        assert ads.evidence

        # --- qualification and audits ---------------------------------
        assert result.qualified == sorted(result.qualified, key=lambda x: -x.lead_score)
        assert len(result.audit_records) == len(result.qualified)
        if result.audit_records:
            record = result.audit_records[0]
            assert record.biggest_opportunity and record.recommended_service
            assert "Company:" in record.render()

        # --- exports ---------------------------------------------------
        assert set(result.exports) >= {"csv", "json", "sqlite"}
        csv_rows = list(csv.DictReader(result.exports["csv"].open(encoding="utf-8")))
        assert len(csv_rows) == len(result.qualified)
        payload = json.loads(result.exports["json"].read_text(encoding="utf-8"))
        assert payload["lead_count"] == len(result.qualified)
        assert payload["run"]["discovered"] == 4

        conn = sqlite3.connect(result.exports["sqlite"])
        try:
            assert conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0] == len(result.qualified)
        finally:
            conn.close()

        # --- persistence ------------------------------------------------
        counts = db.counts()
        assert counts["leads"] == 3
        assert counts["website_analysis"] == 3
        assert counts["advertising_analysis"] == 3
        assert counts["lead_scores"] == 3
        assert counts["scrape_runs"] == 1
        run_row = db.get_run(result.run.run_id)
        assert run_row["status"] == "completed"
        assert run_row["discovered"] == 4 and run_row["duplicates_removed"] == 1

        # errors from the dead site and robots block were recorded, not raised
        error_rows = db.conn.execute("SELECT error_type FROM errors").fetchall()
        error_types = {row[0] for row in error_rows}
        assert "timeout" in error_types
        assert "robots_disallowed" in error_types

        # --- summary ----------------------------------------------------
        summary = render_summary(result.run, result.leads, result.qualified, exports=result.exports)
        assert "SCRAPE COMPLETE" in summary
        assert "Businesses discovered: 4" in summary
        assert "Duplicates removed:    1" in summary
        db.close()

    async def test_second_run_updates_instead_of_duplicating(
        self, settings, tmp_path, e2e_fixture_file, e2e_transport
    ):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(e2e_fixture_file, tmp_path)
        first = await Pipeline(settings, config, database=db, transport=e2e_transport).run()

        second_config = build_config(e2e_fixture_file, tmp_path, basename="e2e2")
        second = await Pipeline(settings, second_config, database=db, transport=e2e_transport).run()

        assert db.counts()["leads"] == 3  # updated in place
        assert db.counts()["scrape_runs"] == 2
        for lead in second.leads:
            row = db.get_lead(lead.lead_id)
            assert row["times_seen"] == 2
            assert row["previous_lead_score"] is not None

        # score history is preserved across runs
        riverside = next(lead for lead in first.leads if "Riverside" in lead.company_name)
        assert len(db.lead_score_history(riverside.lead_id)) == 2

        # Recently checked leads are reused rather than re-fetched, and the
        # reused analyses are not re-recorded as new history.
        assert second.run.enriched == 0
        assert any("reused analyses" in note for note in second.run.notes)
        assert db.counts()["website_analysis"] == 3
        assert second.leads[0].website_analysis is not None  # reused, still exported
        db.close()

    async def test_no_resume_forces_a_recheck(
        self, settings, tmp_path, e2e_fixture_file, e2e_transport
    ):
        db = Database(tmp_path / "e2e.sqlite")
        await Pipeline(
            settings, build_config(e2e_fixture_file, tmp_path), database=db, transport=e2e_transport
        ).run()
        forced = build_config(e2e_fixture_file, tmp_path, basename="forced", resume=False)
        second = await Pipeline(settings, forced, database=db, transport=e2e_transport).run()
        assert second.run.enriched == 3
        assert db.counts()["website_analysis"] == 6
        db.close()

    async def test_min_score_filters_exports(self, settings, tmp_path, e2e_fixture_file, e2e_transport):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(e2e_fixture_file, tmp_path, min_score=99.0)
        result = await Pipeline(settings, config, database=db, transport=e2e_transport).run()
        assert result.qualified == []
        # Everything is still stored; only the export is filtered.
        assert db.counts()["leads"] == 3
        summary = render_summary(result.run, result.leads, result.qualified)
        assert "No leads met the minimum score" in summary
        db.close()

    async def test_dry_run_writes_no_leads(self, settings, tmp_path, e2e_fixture_file, e2e_transport):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(e2e_fixture_file, tmp_path, dry_run=True)
        result = await Pipeline(settings, config, database=db, transport=e2e_transport).run()
        assert result.leads
        assert db.counts()["leads"] == 0
        db.close()

    async def test_website_and_ads_analysis_can_be_disabled(
        self, settings, tmp_path, e2e_fixture_file, e2e_transport
    ):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(
            e2e_fixture_file, tmp_path, analyse_websites=False, analyse_ads=False, formats=["csv"]
        )
        result = await Pipeline(settings, config, database=db, transport=e2e_transport).run()
        assert all(lead.website_analysis is None for lead in result.leads)
        assert all(lead.advertising_analysis is None for lead in result.leads)
        # No site was fetched at all.
        assert not any("riversidedentalstudio" in r.url for r in e2e_transport.requests)
        db.close()

    async def test_no_usable_sources_raises_a_clear_error(self, settings, tmp_path, e2e_transport):
        db = Database(tmp_path / "e2e.sqlite")
        config = build_config(tmp_path / "missing.json", tmp_path)
        with pytest.raises(RuntimeError, match="No usable data sources"):
            await Pipeline(settings, config, database=db, transport=e2e_transport).run()
        db.close()

    async def test_multi_niche_multi_location_run(self, settings, tmp_path, e2e_transport):
        registry = load_niches()
        path = tmp_path / "multi.json"
        path.write_text(
            json.dumps(
                {
                    "businesses": [
                        {
                            "company_name": "Riverside Dental Studio",
                            "niche": "invisalign_dental_practices",
                            "source": "google_places",
                            "website": "https://riversidedentalstudio.co.uk",
                            "city": "Newcastle upon Tyne", "postcode": "NE1 6EE",
                            "phone": "0191 555 0101", "rating": 4.8, "reviews": 237,
                        },
                        {
                            "company_name": "Northern Roofing Solutions",
                            "niche": "roofers",
                            "source": "google_places",
                            "website": "https://northernroofingsolutions.co.uk",
                            "city": "Sunderland", "postcode": "SR4 7AB",
                            "phone": "0191 555 0303", "rating": 4.9, "reviews": 118,
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        newcastle = parse_location("Newcastle upon Tyne", radius_km=30)
        newcastle.latitude, newcastle.longitude, newcastle.geocoded = 54.9783, -1.6178, True
        sunderland = parse_location("Sunderland", radius_km=30)
        sunderland.latitude, sunderland.longitude, sunderland.geocoded = 54.9069, -1.3838, True

        config = PipelineConfig(
            niches=[registry.get("invisalign_dental_practices"), registry.get("roofers")],
            locations=[newcastle, sunderland],
            source_names=["fixture"],
            fixture_path=str(path),
            min_score=0.0,
            formats=["json"],
            output_dir=tmp_path / "out",
            basename="multi",
        )
        db = Database(tmp_path / "multi.sqlite")
        result = await Pipeline(settings, config, database=db, transport=e2e_transport).run()

        niches = {lead.niche for lead in result.leads}
        assert niches == {"invisalign_dental_practices", "roofers"}
        assert len(result.leads) == 2
        roofer = next(lead for lead in result.leads if lead.niche == "roofers")
        assert roofer.website_analysis.mobile_friendly is False
        assert roofer.website_analysis.landing_page_quality_score < 30
        db.close()


@pytest.mark.asyncio
async def test_repeatedly_failing_source_is_dropped(settings, tmp_path):
    """A public API having a bad day must not cost one timeout per niche."""
    from lead_pipeline.sources.base import BaseSource, SourceContext
    from lead_pipeline.utils.http import HttpError

    attempts = {"n": 0}

    class FlakySource(BaseSource):
        name = "openstreetmap"          # reuse a registered name
        kind = "discovery"
        description = "always fails"
        requires_credentials = ()

        async def search(self, query, ctx: SourceContext):
            attempts["n"] += 1
            ctx.record_error(stage="discovery", source=self.name, target="x",
                             error=HttpError("boom", url="http://x", kind="timeout"),
                             error_type="timeout")
            return
            yield  # pragma: no cover

    registry = load_niches()
    location = parse_location("Sunderland", radius_km=20)
    location.latitude, location.longitude, location.geocoded = 54.9069, -1.3838, True
    config = PipelineConfig(
        niches=registry.all(),                # all 10 niches
        locations=[location],
        source_names=["openstreetmap"],
        min_score=0.0, formats=[], output_dir=tmp_path / "out",
    )
    db = Database(tmp_path / "flaky.sqlite")
    pipeline = Pipeline(settings, config, database=db, transport=FakeTransport())
    pipeline._sources = [FlakySource(settings)]

    # Drive discovery directly so the source list is not rebuilt.
    await pipeline._discover(pipeline._sources)

    assert attempts["n"] == Pipeline.SOURCE_FAILURE_LIMIT, (
        "should stop after the failure limit, not try all 10 niches"
    )
    assert any("skipped for the rest of this run" in n for n in pipeline.stats.notes)
    db.close()
