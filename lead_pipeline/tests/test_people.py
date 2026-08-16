"""Named business contacts: extraction, and the many things that are not names.

The negative cases matter more than the positive ones. A missed contact costs a
salesperson a personalised opening; an invented one puts a person who does not
exist in front of a prospect.
"""

from __future__ import annotations

import pytest

from lead_pipeline.config import load_niches
from lead_pipeline.enrichment.people import (
    MAX_PEOPLE_PER_SITE,
    best_contact,
    dedupe_people,
    extract_people,
    is_role_label,
    looks_like_person_name,
    match_role,
)
from lead_pipeline.enrichment.seo import analyse_page, parse_html, rank_internal_links
from lead_pipeline.enrichment.website import WebsiteAnalyzer, apply_website_analysis
from lead_pipeline.models import PersonMention
from lead_pipeline.scoring.lead_score import LeadScorer
from lead_pipeline.scoring.niche_rules import assess_niche

from .conftest import make_lead


def people_from(html: str, url: str = "https://example.co.uk/team", **kwargs):
    return extract_people(parse_html(html, url), **kwargs)


@pytest.fixture(scope="module")
def registry():
    return load_niches()


class TestNameValidation:
    @pytest.mark.parametrize(
        "candidate,expected",
        [
            ("John Smith", "John Smith"),
            ("Dr Jane Smith", "Jane Smith"),
            ("Prof. Alan Turing", "Alan Turing"),
            ("Sarah-Jane O'Neill", "Sarah-Jane O'Neill"),
            ("J. R. Hartley", "J. R. Hartley"),
            ("JANE SMITH", "Jane Smith"),
            ("Maria de Souza", "Maria de Souza"),
            ("Jan van Dijk", "Jan van Dijk"),
            ("Emma Mac Donald", "Emma Mac Donald"),
        ],
    )
    def test_accepts_real_names(self, candidate, expected):
        assert looks_like_person_name(candidate) == expected

    @pytest.mark.parametrize(
        "candidate",
        [
            "Meet The Team",
            "Our Practice Manager",
            "Book Your Consultation",
            "Emergency Call Out",
            "Free Quote",
            "Google Reviews",
            "Managing Director",  # a role is not a person
            "Smith",  # one token
            "Anna Maria Sofia Louise Berger",  # five tokens
            "A B",  # initials only
            "Team 2024",  # digits
            "hello@example.co.uk",
            "de Souza",  # a particle may not open a name
        ],
    )
    def test_rejects_everything_that_is_not_a_name(self, candidate):
        assert looks_like_person_name(candidate) is None

    @pytest.mark.parametrize(
        "place", ["Newcastle Upon Tyne", "Weston Super Mare", "Stratford Upon Avon"]
    )
    def test_rejects_place_names(self, place):
        assert looks_like_person_name(place) is None

    def test_rejects_the_businesss_own_trading_name(self):
        assert looks_like_person_name("Smith Roofing", company_name="Smith Roofing Ltd") is None
        # A real person who happens to share the founder's surname still counts.
        assert (
            looks_like_person_name("Daniel Smith", company_name="Smith Roofing Ltd")
            == "Daniel Smith"
        )

    def test_rejects_the_town_the_business_sits_in(self):
        assert looks_like_person_name("Chester Bridgford", locality="Chester Bridgford") is None


class TestRoleMatching:
    @pytest.mark.parametrize(
        "text,label,seniority",
        [
            ("Managing Director", "Managing Director", 1),
            ("Founder & CEO", "Founder", 1),
            ("Practice Owner", "Owner", 1),
            ("Principal Dentist", "Principal Practitioner", 2),
            ("Practice Manager", "Practice Manager", 3),
            ("Head of Marketing", "Marketing Lead", 4),
        ],
    )
    def test_canonicalises_and_ranks(self, text, label, seniority):
        assert match_role(text) == (label, seniority)

    @pytest.mark.parametrize(
        "text", ["Dental Nurse", "Receptionist", "Hygienist", "Apprentice", "Our Services"]
    )
    def test_ignores_roles_that_are_not_decision_makers(self, text):
        """Collecting the whole staff list would gather data we have no use for."""
        assert match_role(text) is None

    def test_prefers_the_more_specific_role(self):
        assert match_role("Managing Director")[0] == "Managing Director"
        assert match_role("Practice Manager")[0] == "Practice Manager"

    @pytest.mark.parametrize(
        "label", ["Practice Manager", "Founder & MD", "Head of Marketing", "Owner"]
    )
    def test_a_short_job_title_is_a_label(self, label):
        assert is_role_label(label) is True

    @pytest.mark.parametrize(
        "sentence",
        [
            "Our Director of Operations oversees every job.",
            "The practice has been owner-run since 1998 and always will be.",
            "Ask the manager!",
        ],
    )
    def test_prose_mentioning_a_role_is_not_a_label(self, sentence):
        """Pairing a sentence with the heading above it invents people."""
        assert is_role_label(sentence) is False


class TestExtraction:
    def test_team_card_name_above_role(self):
        html = """
        <div class="card"><h3>Dr Jane Smith</h3><p>Principal Dentist</p></div>
        <div class="card"><h3>Mark O'Brien</h3><p>Practice Manager</p></div>
        """
        found = {p.name: p.role for p in people_from(html)}
        assert found == {"Jane Smith": "Principal Practitioner", "Mark O'Brien": "Practice Manager"}

    def test_a_run_of_cards_does_not_shift_roles_onto_the_next_person(self):
        """The bug this guards: greedy pairing, not overlapping windows."""
        html = """
        <h3>Alice Brown</h3><p>Owner</p>
        <h3>Bob Green</h3><p>Practice Manager</p>
        <h3>Cara White</h3><p>Marketing Manager</p>
        """
        found = {p.name: p.role for p in people_from(html)}
        assert found == {
            "Alice Brown": "Owner",
            "Bob Green": "Practice Manager",
            "Cara White": "Marketing Lead",
        }

    def test_role_above_name(self):
        html = "<div><p>Managing Director</p><h4>Helen Carter</h4></div>"
        assert people_from(html)[0].name == "Helen Carter"

    @pytest.mark.parametrize("separator", ["-", "–", "—", "|", ",", ":", "·"])
    def test_name_and_role_on_one_line(self, separator):
        html = f"<li>Tom Fletcher {separator} Marketing Manager</li>"
        found = people_from(html)
        assert len(found) == 1
        assert found[0].name == "Tom Fletcher"
        assert found[0].role == "Marketing Lead"

    def test_prose(self):
        html = "<p>The practice is owned by our managing director Helen Carter.</p>"
        assert people_from(html)[0].role == "Managing Director"

    def test_prose_with_the_name_first(self):
        html = "<p>Speak to Helen Carter, our practice manager, about availability.</p>"
        found = people_from(html)
        assert found[0].name == "Helen Carter"
        assert found[0].role == "Practice Manager"

    def test_structured_data(self):
        html = """
        <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Person",
         "name":"Helen Carter","jobTitle":"Managing Director"}
        </script>
        """
        found = people_from(html)
        assert found[0].name == "Helen Carter"
        assert found[0].role == "Managing Director"

    def test_structured_data_nested_in_an_organisation(self):
        html = """
        <script type="application/ld+json">
        {"@type":"Dentist","name":"Riverside","employee":[
          {"@type":"Person","name":"Helen Carter","jobTitle":"Practice Owner"}]}
        </script>
        """
        assert people_from(html)[0].role == "Owner"

    def test_malformed_structured_data_is_ignored(self):
        html = '<script type="application/ld+json">{not json at all</script>'
        assert people_from(html) == []

    def test_a_name_with_no_stated_role_is_never_recorded(self):
        """The central rule: no role, no person. Inferring one is fabrication."""
        html = "<h3>Jane Smith</h3><p>Has worked here for twelve years.</p>"
        assert people_from(html) == []

    def test_a_page_that_names_nobody_yields_nobody(self):
        html = """
        <h1>Sunderland Roofing Services</h1>
        <h2>Flat Roof Repairs</h2><h2>Emergency Call Out</h2><h2>Free Quotes</h2>
        <p>Read Our Reviews</p><h3>Why Choose Us</h3><p>Fully Insured</p>
        <p>Our Director of Operations oversees every job.</p>
        """
        assert people_from(html) == []

    def test_a_town_above_a_role_does_not_become_a_person(self):
        html = "<h3>Newcastle Upon Tyne</h3><p>Clinic Manager</p>"
        assert people_from(html) == []

    def test_every_mention_carries_its_evidence_and_page(self):
        html = "<h3>Helen Carter</h3><p>Managing Director</p>"
        found = people_from(html, url="https://riverside.co.uk/about")
        assert found[0].source == "company_website"
        assert found[0].source_url == "https://riverside.co.uk/about"
        assert "Helen Carter" in found[0].evidence and "Managing Director" in found[0].evidence

    def test_extraction_can_be_turned_off(self):
        html = "<h3>Helen Carter</h3><p>Managing Director</p>"
        assert analyse_page(html, "https://x.co.uk/", collect_people=False).people == []


class TestSelection:
    def test_dedupe_keeps_the_most_senior_stated_role(self):
        mentions = [
            PersonMention(name="Helen Carter", role="Marketing Lead", role_seniority=4),
            PersonMention(name="Helen Carter", role="Managing Director", role_seniority=1),
        ]
        deduped = dedupe_people(mentions)
        assert len(deduped) == 1
        assert deduped[0].role == "Managing Director"

    def test_best_contact_is_the_most_senior(self):
        mentions = [
            PersonMention(name="Mark O'Brien", role="Practice Manager", role_seniority=3),
            PersonMention(name="Helen Carter", role="Owner", role_seniority=1),
        ]
        assert best_contact(mentions).name == "Helen Carter"

    def test_best_contact_of_nothing_is_nothing(self):
        assert best_contact([]) is None


class TestPageRanking:
    def test_a_team_page_is_worth_fetching(self):
        links = [
            "https://x.co.uk/blog/2019/roof-tips",
            "https://x.co.uk/meet-the-team",
            "https://x.co.uk/gallery",
        ]
        assert "https://x.co.uk/meet-the-team" in rank_internal_links(
            links, url_hints=[], limit=2
        )

    def test_a_contact_page_still_outranks_a_team_page(self):
        links = ["https://x.co.uk/our-team", "https://x.co.uk/contact"]
        assert rank_internal_links(links, url_hints=[], limit=1) == ["https://x.co.uk/contact"]


class TestAnalyzerIntegration:
    @pytest.mark.asyncio
    async def test_the_analyzer_finds_the_published_decision_maker(
        self, settings, client, ctx, registry
    ):
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )

        names = {p.name for p in analysis.people_found}
        assert "Helen Carter" in names  # structured data
        assert "Jane Smith" in names  # team card
        assert "Aisha Rahman" not in names  # dental nurse: not a decision maker
        assert "Our Treatments" not in names
        assert len(analysis.people_found) <= MAX_PEOPLE_PER_SITE

        apply_website_analysis(lead, analysis)
        assert lead.contact_name == "Helen Carter"
        assert lead.contact_role == "Managing Director"
        assert lead.contact_source_url is not None
        assert lead.field_sources["contact_name"] == "company_website"

    @pytest.mark.asyncio
    async def test_a_site_with_no_named_owner_leaves_the_field_empty(
        self, settings, client, ctx, registry
    ):
        lead = make_lead(
            company_name="Northern Roofing Solutions",
            niche="roofers",
            website="https://northernroofingsolutions.co.uk",
        )
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("roofers"), ctx
        )
        apply_website_analysis(lead, analysis)
        assert analysis.people_found == []
        assert lead.contact_name is None
        assert lead.contact_role is None

    @pytest.mark.asyncio
    async def test_the_setting_switches_collection_off(
        self, settings, client, ctx, registry
    ):
        settings.collect_contact_names = False
        lead = make_lead()
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        apply_website_analysis(lead, analysis)
        assert analysis.people_found == []
        assert lead.contact_name is None

    @pytest.mark.asyncio
    async def test_an_existing_contact_name_is_not_overwritten(
        self, settings, client, ctx, registry
    ):
        lead = make_lead()
        lead.set_field("contact_name", "Someone Known", "manual")
        analysis = await WebsiteAnalyzer(settings, client).analyse(
            lead, registry.get("invisalign_dental_practices"), ctx
        )
        apply_website_analysis(lead, analysis)
        assert lead.contact_name == "Someone Known"


class TestScoring:
    def test_a_named_decision_maker_earns_the_accessibility_points(self, registry):
        rule = registry.get("invisalign_dental_practices")
        without = make_lead()
        with_contact = make_lead()
        with_contact.contact_name = "Helen Carter"
        with_contact.contact_role = "Managing Director"

        base = LeadScorer().score(without, rule, assessment=assess_niche(without, rule))
        improved = LeadScorer().score(
            with_contact, rule, assessment=assess_niche(with_contact, rule)
        )

        assert improved.outreach_accessibility > base.outreach_accessibility
        reasons = " ".join(
            r for c in improved.components if c.name == "outreach_accessibility" for r in c.reasons
        )
        assert "Helen Carter" in reasons and "Managing Director" in reasons


class TestPersistenceAndExport:
    def test_the_contact_survives_a_database_round_trip(self, tmp_path):
        """An older leads.sqlite gains the new columns instead of failing."""
        from lead_pipeline.database.db import Database, row_to_lead

        db = Database(tmp_path / "leads.sqlite")
        lead = make_lead()
        lead.contact_name = "Helen Carter"
        lead.contact_role = "Managing Director"
        lead.contact_source_url = "https://riversidedentalstudio.co.uk/meet-the-team"
        db.upsert_lead(lead)

        restored = row_to_lead(db.get_lead(lead.lead_id))
        assert restored.contact_name == "Helen Carter"
        assert restored.contact_role == "Managing Director"
        assert restored.contact_source_url.endswith("/meet-the-team")

    def test_a_database_written_before_this_feature_still_opens(self, tmp_path):
        """`CREATE TABLE IF NOT EXISTS` will not add a column to an existing table.

        Without the ALTER on open, every insert against an older leads.sqlite
        fails with "no such column" and the user's history is unusable.
        """
        from lead_pipeline.database.db import Database, row_to_lead

        path = tmp_path / "legacy.sqlite"
        old = Database(path)
        old.conn.execute("ALTER TABLE leads DROP COLUMN contact_role")
        old.conn.execute("ALTER TABLE leads DROP COLUMN contact_source_url")
        old.conn.commit()
        old.close()

        upgraded = Database(path)
        lead = make_lead()
        lead.contact_name = "Helen Carter"
        lead.contact_role = "Managing Director"
        upgraded.upsert_lead(lead)
        assert row_to_lead(upgraded.get_lead(lead.lead_id)).contact_role == "Managing Director"

    def test_deleting_a_lead_removes_the_named_person(self, tmp_path):
        """A deletion request has to take the person with it, not just the row."""
        from lead_pipeline.database.db import Database

        db = Database(tmp_path / "leads.sqlite")
        lead = make_lead()
        lead.contact_name = "Helen Carter"
        lead.contact_role = "Managing Director"
        lead.contact_source_url = "https://riversidedentalstudio.co.uk/meet-the-team"
        db.upsert_lead(lead)

        assert db.delete_lead(lead.lead_id) is True
        row = db.conn.execute(
            "SELECT contact_name, contact_role, contact_source_url FROM leads WHERE id = ?",
            (lead.lead_id,),
        ).fetchone()
        assert row["contact_name"] is None
        assert row["contact_role"] is None
        assert row["contact_source_url"] is None

    def test_the_csv_carries_the_name_and_the_role(self):
        from lead_pipeline.exporters.csv_exporter import CSV_COLUMNS, lead_to_csv_row

        assert "contact_name" in CSV_COLUMNS and "contact_role" in CSV_COLUMNS
        lead = make_lead()
        lead.contact_name = "Helen Carter"
        lead.contact_role = "Managing Director"
        row = lead_to_csv_row(lead)
        assert row["contact_name"] == "Helen Carter"
        assert row["contact_role"] == "Managing Director"

    def test_the_json_export_carries_the_source_url(self):
        lead = make_lead()
        lead.contact_name = "Helen Carter"
        lead.contact_role = "Managing Director"
        lead.contact_source_url = "https://riversidedentalstudio.co.uk/meet-the-team"
        payload = lead.as_dict()
        assert payload["contact_name"] == "Helen Carter"
        assert payload["contact_role"] == "Managing Director"
        assert payload["contact_source_url"].endswith("/meet-the-team")
