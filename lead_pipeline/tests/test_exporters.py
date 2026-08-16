"""Export tests: CSV columns, JSON structure, SQLite file (requirement 5)."""

from __future__ import annotations

import csv
import json
import sqlite3

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.exporters import CSV_COLUMNS, export_all, export_csv, export_json, export_sqlite
from lead_pipeline.models import AdvertisingAnalysis, Confidence, LeadScore, RunStats, WebsiteAnalysis
from lead_pipeline.scoring.opportunities import build_audit_record

from .conftest import make_lead


@pytest.fixture()
def exportable_lead():
    lead = make_lead()
    lead.sub_niche = "Invisalign"
    lead.business_email = "hello@riversidedentalstudio.co.uk"
    lead.facebook_url = "https://facebook.com/riversidedentalstudio"
    lead.instagram_url = "https://instagram.com/riversidedental"
    lead.google_maps_url = "https://maps.google.com/?cid=demo0001"
    lead.opportunities = ["No dedicated Invisalign landing page", "No visible Meta Pixel"]
    lead.strengths = ["4.8★ rating across 237 Google reviews"]
    lead.lead_reason = "Strong Newcastle dental practice, but paid traffic lands on the homepage."
    lead.recommended_service = "Landing Page + Google Ads"
    lead.website_analysis = WebsiteAnalysis(
        website_exists=True, website_loads=True, website_quality_score=72,
        landing_page_quality_score=41, has_meta_pixel=False,
    )
    lead.advertising_analysis = AdvertisingAnalysis(
        appears_to_be_running_google_ads=Confidence.CONFIRMED,
        appears_to_be_running_meta_ads=Confidence.NOT_DETECTED,
        ad_landing_page="https://riversidedentalstudio.co.uk",
        number_of_visible_ads=2,
        estimated_ad_activity="moderate",
        ad_quality_score=38,
    )
    lead.score = LeadScore(total=91.0, band="80-100", business_value=23, marketing_opportunity=21,
                           paid_acquisition=18, credibility=14, outreach_accessibility=15)
    return lead


class TestCsv:
    def test_columns_match_specification(self, exportable_lead, tmp_path):
        path = export_csv([exportable_lead], tmp_path / "leads.csv")
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            assert reader.fieldnames == CSV_COLUMNS
            rows = list(reader)
        assert len(rows) == 1
        row = rows[0]
        assert row["company_name"] == "Riverside Dental Studio"
        assert row["lead_score"] == "91.0"
        assert row["website_quality_score"] == "72"
        assert row["landing_page_quality_score"] == "41"
        assert row["advertising_status"] == "google:confirmed|meta:not_detected"
        assert row["opportunities"] == "No dedicated Invisalign landing page | No visible Meta Pixel"
        assert row["source"] == "google_places"
        assert row["date_discovered"]

    def test_missing_values_export_as_empty_strings(self, tmp_path):
        bare = make_lead(google_rating=None, google_review_count=None, website=None, business_phone=None)
        path = export_csv([bare], tmp_path / "bare.csv")
        row = list(csv.DictReader(path.open(encoding="utf-8")))[0]
        assert row["google_rating"] == ""
        assert row["website"] == ""
        assert row["lead_score"] == ""

    def test_empty_export_writes_header_only(self, tmp_path):
        path = export_csv([], tmp_path / "empty.csv")
        lines = path.read_text(encoding="utf-8").strip().splitlines()
        assert len(lines) == 1

    def test_commas_and_quotes_are_escaped(self, tmp_path):
        lead = make_lead(company_name='Smith, Jones & "Co" Dental')
        lead.lead_reason = 'Reason with, comma and "quotes"'
        path = export_csv([lead], tmp_path / "quoted.csv")
        row = list(csv.DictReader(path.open(encoding="utf-8")))[0]
        assert row["company_name"] == 'Smith, Jones & "Co" Dental'
        assert row["lead_reason"] == 'Reason with, comma and "quotes"'

    def test_audit_csv_written_alongside(self, exportable_lead, tmp_path):
        rule = load_niches().get("invisalign_dental_practices")
        record = build_audit_record(exportable_lead, rule)
        written = export_all(
            [exportable_lead], formats=["csv"], output_dir=tmp_path, basename="run1",
            audit_records=[record],
        )
        assert written["csv"].exists()
        assert written["audit_csv"].exists()
        audit_row = list(csv.DictReader(written["audit_csv"].open(encoding="utf-8")))[0]
        assert audit_row["company"] == "Riverside Dental Studio"
        assert audit_row["biggest_opportunity"]
        assert audit_row["recommended_service"]


class TestJson:
    def test_structure_is_complete(self, exportable_lead, tmp_path):
        run = RunStats(discovered=7, duplicates_removed=2, enriched=5, qualified=1)
        path = export_json([exportable_lead], tmp_path / "leads.json", run=run)
        payload = json.loads(path.read_text(encoding="utf-8"))

        assert payload["lead_count"] == 1
        assert payload["run"]["discovered"] == 7
        lead = payload["leads"][0]
        for key in (
            "company_name", "niche", "website", "online_presence", "google", "website_analysis",
            "advertising_analysis", "score", "opportunities", "lead_reason", "sources",
            "field_sources", "source_provenance", "date_discovered",
        ):
            assert key in lead
        assert lead["advertising_analysis"]["appears_to_be_running_google_ads"] == "confirmed"
        assert lead["score"]["total"] == 91.0
        assert lead["online_presence"]["facebook_url"].startswith("https://facebook.com/")

    def test_json_is_serialisable_without_analyses(self, tmp_path):
        path = export_json([make_lead()], tmp_path / "min.json")
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["leads"][0]["website_analysis"] is None


class TestSqlite:
    def test_portable_sqlite_contains_leads_and_analyses(self, exportable_lead, tmp_path):
        path = export_sqlite([exportable_lead], tmp_path / "leads.sqlite")
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM leads").fetchone()
            assert row["company_name"] == "Riverside Dental Studio"
            assert row["lead_score"] == 91.0
            assert json.loads(row["opportunities"])[0] == "No dedicated Invisalign landing page"
            assert conn.execute("SELECT COUNT(*) FROM website_analysis").fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM advertising_analysis").fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM lead_scores").fetchone()[0] == 1
        finally:
            conn.close()


class TestExportAll:
    def test_all_formats(self, exportable_lead, tmp_path):
        written = export_all(
            [exportable_lead], formats=["all"], output_dir=tmp_path / "out", basename="every"
        )
        assert set(written) >= {"csv", "json", "sqlite"}
        for path in written.values():
            assert path.exists() and path.stat().st_size > 0

    def test_comma_separated_formats(self, exportable_lead, tmp_path):
        written = export_all(
            [exportable_lead], formats=["csv,json"], output_dir=tmp_path, basename="two"
        )
        assert set(written) == {"csv", "json"}

    def test_unknown_format_raises(self, exportable_lead, tmp_path):
        with pytest.raises(ValueError, match="Unknown export format"):
            export_all([exportable_lead], formats=["xlsx"], output_dir=tmp_path, basename="bad")


class TestSurveyReport:
    """A niche whose source failed must never read as a niche with no businesses."""

    def _run(self, **overrides):
        from lead_pipeline.models import PipelineError, RunStats

        run = RunStats(
            niches=["cosmetic_dentists", "roofers", "builders"],
            locations=["Sunderland"],
            sources_used=["openstreetmap"],
            discovered=17,
            niche_counts={"roofers": 17},
        )
        run.errors.append(
            PipelineError(
                stage="discovery",
                source="openstreetmap",
                target="cosmetic_dentists@Sunderland",
                error_type="overpass_runtime_error",
                message="runtime error",
            )
        )
        for key, value in overrides.items():
            setattr(run, key, value)
        return run

    def test_an_errored_niche_is_unmeasured_not_zero(self):
        from lead_pipeline.report import render_survey

        text = render_survey(self._run(), [])
        assert "cosmetic_dentists" in text
        assert "unmeasured (source errors)" in text
        # builders had no error and no results: that genuinely is a zero.
        assert "builders" in text and "none found" in text

    def test_it_names_the_niches_to_retry(self):
        from lead_pipeline.report import render_survey

        text = render_survey(self._run(), [])
        assert "1 of 3 niches went unmeasured" in text
        assert "--niche cosmetic_dentists" in text

    def test_the_winner_comes_from_measured_niches_only(self):
        from lead_pipeline.report import render_survey

        text = render_survey(self._run(), [])
        assert "Densest measured niche: roofers (17 businesses)" in text

    def test_a_run_that_measured_nothing_says_so(self):
        from lead_pipeline.report import render_survey

        text = render_survey(self._run(niche_counts={}, discovered=0), [])
        assert "Nothing was measured" in text
        assert "Densest" not in text
