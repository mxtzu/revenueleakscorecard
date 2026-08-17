"""CLI argument handling and admin commands."""

from __future__ import annotations

import json

import pytest

from lead_pipeline.config import Settings, load_niches
from lead_pipeline.database import Database
from lead_pipeline.models import LeadScore
from lead_pipeline.pipeline import build_parser, main

from .conftest import make_lead


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch, tmp_path):
    """Keep the CLI away from any real .env / database on this machine."""
    for key in list(Settings.__dataclass_fields__):
        monkeypatch.delenv(key.upper(), raising=False)
    for key in (
        "GOOGLE_PLACES_API_KEY", "BING_MAPS_API_KEY", "SERPAPI_API_KEY", "BRAVE_SEARCH_API_KEY",
        "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_CX", "COMPANIES_HOUSE_API_KEY", "META_AD_LIBRARY_TOKEN",
        "PAGESPEED_API_KEY", "CONTACT_EMAIL",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env").write_text("", encoding="utf-8")
    return tmp_path


class TestParser:
    def test_every_documented_option_exists(self):
        parser = build_parser()
        options = {action.option_strings[0] for action in parser._actions if action.option_strings}
        for flag in (
            "--niche", "--location", "--radius", "--country", "--min-score", "--limit", "--output",
            "--format", "--source", "--all-niches", "--analyse-websites", "--analyse-ads", "--input",
        ):
            assert flag in options

    def test_repeatable_options(self):
        args = build_parser().parse_args(
            ["--niche", "roofers", "--niche", "builders", "--location", "Leeds", "--location", "York"]
        )
        assert args.niche == ["roofers", "builders"]
        assert args.location == ["Leeds", "York"]

    def test_negation_flags(self):
        args = build_parser().parse_args(["--no-analyse-websites", "--no-analyse-ads"])
        assert args.analyse_websites is False and args.analyse_ads is False
        default = build_parser().parse_args([])
        assert default.analyse_websites is None and default.analyse_ads is None


class TestInfoCommands:
    def test_list_niches(self, capsys):
        assert main(["--list-niches"]) == 0
        output = capsys.readouterr().out
        for key in load_niches().keys:
            assert key in output

    def test_list_sources_shows_availability(self, capsys):
        assert main(["--list-sources"]) == 0
        output = capsys.readouterr().out
        assert "google_places" in output
        assert "unavailable" in output
        assert "openstreetmap" in output
        assert "GOOGLE_PLACES_API_KEY" in output

    def test_db_stats(self, capsys, tmp_path):
        assert main(["--db-stats", "--db", str(tmp_path / "x.sqlite")]) == 0
        assert "leads" in capsys.readouterr().out

    def test_list_runs_empty(self, capsys, tmp_path):
        assert main(["--list-runs", "--db", str(tmp_path / "y.sqlite")]) == 0
        assert "No runs recorded yet." in capsys.readouterr().out

    def test_version(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["--version"])
        assert exc.value.code == 0


class TestValidation:
    def test_unknown_niche_is_rejected(self, capsys):
        assert main(["--niche", "astronauts", "--location", "Leeds"]) == 2
        assert "Unknown niche" in capsys.readouterr().err

    def test_missing_niche_exits(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["--location", "Leeds"])
        assert exc.value.code == 2

    def test_missing_location_exits(self, capsys):
        with pytest.raises(SystemExit) as exc:
            main(["--niche", "roofers"])
        assert exc.value.code == 2

    def test_no_usable_sources_returns_2(self, capsys, tmp_path):
        code = main([
            "--niche", "roofers", "--location", "Sunderland", "--source", "google_places",
            "--db", str(tmp_path / "z.sqlite"), "--quiet",
        ])
        assert code == 2
        assert "No usable data sources" in capsys.readouterr().err


class TestAdminCommands:
    def test_delete_and_purge(self, capsys, tmp_path):
        db_path = tmp_path / "admin.sqlite"
        db = Database(db_path)
        lead = make_lead()
        lead.score = LeadScore(total=80.0, band="80-100")
        db.upsert_lead(lead)
        db.close()

        assert main(["--delete-lead", lead.lead_id, "--db", str(db_path)]) == 0
        assert "Soft-deleted" in capsys.readouterr().out

        db = Database(db_path)
        assert db.get_lead(lead.lead_id) is None
        db.close()

        assert main(["--purge-lead", lead.lead_id, "--db", str(db_path)]) == 0
        assert "Purged" in capsys.readouterr().out
        db = Database(db_path)
        assert db.counts()["leads"] == 0
        db.close()

    def test_delete_unknown_lead_reports_not_found(self, capsys, tmp_path):
        assert main(["--delete-lead", "doesnotexist", "--db", str(tmp_path / "a.sqlite")]) == 0
        assert "Not found" in capsys.readouterr().out

    def test_export_only(self, capsys, tmp_path):
        db_path = tmp_path / "export.sqlite"
        db = Database(db_path)
        lead = make_lead()
        lead.score = LeadScore(total=88.0, band="80-100")
        lead.opportunities = ["No online booking"]
        lead.lead_reason = "Strong practice, weak funnel."
        db.upsert_lead(lead)
        db.close()

        code = main([
            "--export-only", "--niche", "invisalign_dental_practices", "--db", str(db_path),
            "--output", str(tmp_path / "out"), "--format", "csv,json", "--basename", "stored",
        ])
        assert code == 0
        output = capsys.readouterr().out
        assert "Exported 1 leads" in output
        assert (tmp_path / "out" / "stored.csv").exists()
        payload = json.loads((tmp_path / "out" / "stored.json").read_text(encoding="utf-8"))
        assert payload["leads"][0]["company_name"] == "Riverside Dental Studio"

    def test_export_only_with_no_matches(self, capsys, tmp_path):
        code = main([
            "--export-only", "--db", str(tmp_path / "empty.sqlite"), "--output", str(tmp_path / "o"),
        ])
        assert code == 0
        assert "No stored leads" in capsys.readouterr().out


class TestFullCliRun:
    def test_offline_run_with_fixture(self, capsys, tmp_path):
        fixture = tmp_path / "businesses.json"
        fixture.write_text(
            json.dumps(
                {
                    "businesses": [
                        {
                            "company_name": "Riverside Dental Studio",
                            "niche": "invisalign_dental_practices",
                            "source": "google_places",
                            "city": "Newcastle upon Tyne",
                            "postcode": "NE1 6EE",
                            "phone": "0191 555 0101",
                            "rating": 4.8,
                            "reviews": 237,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        code = main([
            "--niche", "invisalign_dental_practices",
            "--location", "Newcastle upon Tyne",
            "--fixture", str(fixture),
            "--source", "fixture",
            "--no-analyse-websites",
            "--no-analyse-ads",
            "--min-score", "0",
            "--db", str(tmp_path / "cli.sqlite"),
            "--output", str(tmp_path / "out"),
            "--format", "csv",
            "--basename", "clirun",
            "--quiet",
        ])
        assert code == 0
        output = capsys.readouterr().out
        assert "SCRAPE COMPLETE" in output
        assert "Businesses discovered: 1" in output
        assert (tmp_path / "out" / "clirun.csv").exists()

        db = Database(tmp_path / "cli.sqlite")
        assert db.counts()["leads"] == 1
        db.close()
