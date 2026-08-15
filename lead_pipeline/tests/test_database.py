"""Database insert/update, history preservation and deletion (requirement 4)."""

from __future__ import annotations

from lead_pipeline.database import Database, row_to_lead
from lead_pipeline.models import (
    AdvertisingAnalysis,
    Confidence,
    LeadScore,
    PipelineError,
    WebsiteAnalysis,
)
from lead_pipeline.utils.geo import parse_location

from .conftest import make_lead


def scored(lead, total=82.0, band="80-100"):
    lead.score = LeadScore(total=total, band=band, business_value=20, marketing_opportunity=22,
                           paid_acquisition=16, credibility=13, outreach_accessibility=11)
    return lead


class TestSchema:
    def test_tables_exist(self, db: Database):
        counts = db.counts()
        for table in (
            "leads", "lead_sources", "website_analysis", "advertising_analysis", "lead_scores",
            "scrape_runs", "errors", "locations", "sources",
        ):
            assert table in counts

    def test_reopening_the_same_file_is_safe(self, tmp_path):
        path = tmp_path / "persist.sqlite"
        first = Database(path)
        first.upsert_lead(scored(make_lead()))
        first.close()
        second = Database(path)
        assert second.counts()["leads"] == 1
        second.close()


class TestInsertAndUpdate:
    def test_insert_then_update_preserves_discovery_date_and_previous_score(self, db: Database):
        lead = scored(make_lead(), 74.0, "70-79")
        first = db.upsert_lead(lead)
        assert first["is_new"] is True
        original_row = db.get_lead(lead.lead_id)
        assert original_row["lead_score"] == 74.0

        again = scored(make_lead(), 88.0, "80-100")
        again.description = "Updated description"
        result = db.upsert_lead(again)

        assert result["is_new"] is False
        assert result["previous_score"] == 74.0
        assert result["times_seen"] == 2

        row = db.get_lead(lead.lead_id)
        assert row["lead_score"] == 88.0
        assert row["previous_lead_score"] == 74.0
        assert row["date_discovered"] == original_row["date_discovered"]
        assert row["last_seen"] >= original_row["last_seen"]
        assert row["description"] == "Updated description"

    def test_update_does_not_wipe_known_values_with_nulls(self, db: Database):
        rich = scored(make_lead())
        rich.business_email = "hello@riversidedentalstudio.co.uk"
        db.upsert_lead(rich)

        sparse = make_lead(business_email=None, google_rating=None, google_review_count=None)
        db.upsert_lead(scored(sparse))

        row = db.get_lead(rich.lead_id)
        assert row["business_email"] == "hello@riversidedentalstudio.co.uk"
        assert row["google_rating"] == 4.8

    def test_match_by_domain_when_place_id_absent(self, db: Database):
        first = scored(make_lead())
        db.upsert_lead(first)
        second = scored(make_lead(google_place_id=None, company_name="Riverside Dental"))
        result = db.upsert_lead(second)
        assert result["is_new"] is False
        assert db.counts()["leads"] == 1

    def test_score_history_is_appended(self, db: Database):
        lead = scored(make_lead(), 70.0, "70-79")
        db.upsert_lead(lead)
        db.save_score(lead.lead_id, lead.score)
        lead2 = scored(make_lead(), 85.0, "80-100")
        db.upsert_lead(lead2)
        db.save_score(lead2.lead_id, lead2.score)

        history = db.lead_score_history(lead.lead_id)
        assert [round(h["total"]) for h in history] == [70, 85]

    def test_analyses_are_appended_not_overwritten(self, db: Database):
        lead = scored(make_lead())
        db.upsert_lead(lead)
        for score in (40, 55):
            db.save_website_analysis(
                lead.lead_id,
                WebsiteAnalysis(website_exists=True, website_loads=True, landing_page_quality_score=score),
            )
        assert db.counts()["website_analysis"] == 2
        assert db.latest_website_analysis(lead.lead_id)["landing_page_quality_score"] == 55

    def test_provenance_recorded_for_every_source(self, db: Database):
        lead = scored(make_lead())
        from lead_pipeline.models import SourceRecord

        lead.add_source(SourceRecord(source="openstreetmap", source_record_id="node/1"))
        lead.add_source(SourceRecord(source="companies_house", source_record_id="12345678"))
        db.upsert_lead(lead)
        sources = {row["source_name"] for row in db.lead_sources(lead.lead_id)}
        assert {"google_places", "openstreetmap", "companies_house"} <= sources

    def test_field_provenance_saved(self, db: Database):
        lead = scored(make_lead())
        lead.field_sources["business_phone"] = "google_places"
        db.upsert_lead(lead)
        rows = db.conn.execute(
            "SELECT field, source_name FROM lead_field_provenance WHERE lead_id = ?", (lead.lead_id,)
        ).fetchall()
        mapping = {row["field"]: row["source_name"] for row in rows}
        assert mapping.get("business_phone") == "google_places"


class TestRunsAndErrors:
    def test_run_lifecycle(self, db: Database):
        run_id = db.start_run(
            niches=["roofers"], locations=["Sunderland"], sources=["openstreetmap"],
            radius_km=25, country="UK", min_score=60,
        )
        db.finish_run(run_id, discovered=12, duplicates_removed=3, enriched=9, qualified=4, error_count=1)
        run = db.get_run(run_id)
        assert run["status"] == "completed"
        assert run["discovered"] == 12 and run["qualified"] == 4
        assert db.list_runs()[0]["id"] == run_id

    def test_errors_recorded_against_run(self, db: Database):
        run_id = db.start_run(niches=["roofers"], locations=["Sunderland"], sources=["fixture"])
        db.record_errors(
            [
                PipelineError(stage="website_analysis", source="company_website",
                              target="https://x.test", error_type="timeout", message="Timeout after 20s"),
                PipelineError(stage="discovery", source="google_places", target="roofers@Sunderland",
                              error_type="http_status", message="HTTP 403"),
            ],
            run_id,
        )
        rows = db.conn.execute("SELECT * FROM errors WHERE run_id = ?", (run_id,)).fetchall()
        assert len(rows) == 2
        assert {row["error_type"] for row in rows} == {"timeout", "http_status"}

    def test_locations_upsert_is_idempotent(self, db: Database):
        location = parse_location("Newcastle upon Tyne", radius_km=30)
        first = db.upsert_location(location)
        location.latitude, location.longitude = 54.9783, -1.6178
        second = db.upsert_location(location)
        assert first == second
        row = db.conn.execute("SELECT * FROM locations WHERE id = ?", (first,)).fetchone()
        assert row["latitude"] == 54.9783

    def test_checkpoints(self, db: Database):
        assert db.is_checkpointed("runkey", "lead1", "enrichment") is False
        db.checkpoint("runkey", "lead1", "enrichment")
        assert db.is_checkpointed("runkey", "lead1", "enrichment") is True
        assert db.clear_checkpoints("runkey") == 1


class TestQueriesAndDeletion:
    def test_query_filters(self, db: Database):
        db.upsert_lead(scored(make_lead(), 85.0, "80-100"))
        db.upsert_lead(
            scored(
                make_lead(
                    company_name="Wear Valley Roofing", niche="roofers", google_place_id="ChIJtest9",
                    website="https://wearvalleyroofing.co.uk", business_phone="0191 555 0404",
                    city="Durham", postcode="DH1 3QQ",
                ),
                52.0,
                "40-59",
            )
        )
        assert len(db.query_leads(min_score=60)) == 1
        assert len(db.query_leads(niche="roofers")) == 1
        assert len(db.query_leads(city="durham")) == 1
        assert len(db.query_leads()) == 2

    def test_soft_delete_hides_lead_and_scrubs_contacts(self, db: Database):
        lead = scored(make_lead())
        lead.business_email = "hello@riversidedentalstudio.co.uk"
        db.upsert_lead(lead)
        assert db.delete_lead(lead.lead_id, reason="client request") is True
        assert db.get_lead(lead.lead_id) is None
        assert db.query_leads() == []
        row = db.get_lead(lead.lead_id, include_deleted=True)
        assert row["deleted_at"] and row["business_email"] is None
        assert row["delete_reason"] == "client request"

    def test_hard_delete_removes_dependent_rows(self, db: Database):
        lead = scored(make_lead())
        db.upsert_lead(lead)
        db.save_website_analysis(lead.lead_id, WebsiteAnalysis(website_exists=True))
        db.save_advertising_analysis(
            lead.lead_id,
            AdvertisingAnalysis(appears_to_be_running_google_ads=Confidence.LIKELY),
        )
        db.save_score(lead.lead_id, lead.score)
        db.save_opportunities(lead.lead_id, ["No online booking"])

        assert db.delete_lead(lead.lead_id, hard=True) is True
        counts = db.counts()
        assert counts["leads"] == 0
        assert counts["website_analysis"] == 0
        assert counts["advertising_analysis"] == 0
        assert counts["lead_scores"] == 0
        assert counts["lead_opportunities"] == 0

    def test_deleting_unknown_lead_returns_false(self, db: Database):
        assert db.delete_lead("nope") is False

    def test_reinsert_after_soft_delete_restores(self, db: Database):
        lead = scored(make_lead())
        db.upsert_lead(lead)
        db.delete_lead(lead.lead_id)
        db.upsert_lead(scored(make_lead()))
        assert db.get_lead(lead.lead_id) is not None


class TestRoundTrip:
    def test_row_to_lead_restores_analyses(self, db: Database):
        lead = scored(make_lead())
        lead.opportunities = ["No online booking", "No visible Meta Pixel"]
        lead.lead_reason = "Strong practice, weak funnel."
        lead.website_analysis = WebsiteAnalysis(
            website_exists=True, website_loads=True, landing_page_quality_score=44,
            website_quality_score=61, has_meta_pixel=False,
        )
        lead.advertising_analysis = AdvertisingAnalysis(
            appears_to_be_running_google_ads=Confidence.LIKELY,
            appears_to_be_running_meta_ads=Confidence.NOT_DETECTED,
            evidence=["Google Ads conversion tag (AW-) present on the website"],
        )
        db.upsert_lead(lead)
        db.save_website_analysis(lead.lead_id, lead.website_analysis)
        db.save_advertising_analysis(lead.lead_id, lead.advertising_analysis)

        row = db.get_lead(lead.lead_id)
        restored = row_to_lead(
            row,
            website=db.latest_website_analysis(lead.lead_id),
            advertising=db.latest_advertising_analysis(lead.lead_id),
        )
        assert restored.company_name == lead.company_name
        assert restored.opportunities == lead.opportunities
        assert restored.website_analysis.landing_page_quality_score == 44
        assert restored.advertising_analysis.appears_to_be_running_google_ads is Confidence.LIKELY
        assert restored.lead_score == 82.0
