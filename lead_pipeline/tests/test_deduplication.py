"""Deduplication tests (requirements 2 and 9)."""

from __future__ import annotations

from lead_pipeline.models import Lead, SourceRecord
from lead_pipeline.utils.deduplication import Deduplicator, find_duplicate_pairs

from .conftest import make_lead


def lead_from(source: str, **overrides) -> Lead:
    lead = make_lead(source_name=source, **overrides)
    return lead


class TestBlockingKeys:
    def test_place_id_domain_phone_and_address_keys_present(self):
        lead = make_lead()
        keys = Deduplicator().blocking_keys(lead)
        prefixes = {key.split(":")[0] for key in keys}
        assert {"place", "domain", "phone", "addr", "name_loc"} <= prefixes

    def test_social_domains_are_not_used_as_identity(self):
        lead = make_lead(website="https://facebook.com/somepage", google_place_id=None)
        keys = Deduplicator().blocking_keys(lead)
        assert not any(k.startswith("domain:facebook.com") for k in keys)
        assert not any(k.startswith("host:facebook.com") for k in keys)

    def test_the_full_host_is_a_key_alongside_the_registrable_domain(self):
        lead = make_lead(website="https://book.riverside.co.uk/appointments")
        keys = Deduplicator().blocking_keys(lead)
        assert "host:book.riverside.co.uk" in keys
        assert "domain:riverside.co.uk" in keys

    def test_a_site_builder_subdomain_still_identifies_the_business(self):
        """`salonone.wixsite.com` is an identity; `wixsite.com` is not."""
        lead = make_lead(
            company_name="Salon One", website="https://salonone.wixsite.com/home",
            google_place_id=None,
        )
        keys = Deduplicator().blocking_keys(lead)
        assert "host:salonone.wixsite.com" in keys
        assert not any(k.startswith("domain:wixsite.com") for k in keys)


class TestDeduplication:
    def test_same_place_id_merges(self):
        a = lead_from("google_places")
        b = lead_from("bing_places", company_name="Riverside Dental", website=None, business_phone=None)
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 1
        assert result.duplicates_removed == 1

    def test_same_domain_different_name_merges(self):
        a = lead_from("google_places", google_place_id=None)
        b = lead_from(
            "openstreetmap",
            company_name="Riverside Dental Studio Ltd",
            google_place_id=None,
            business_phone=None,
        )
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 1

    def test_same_phone_merges_when_no_domain(self):
        a = lead_from("openstreetmap", website=None, google_place_id=None, company_name="Riverside Dental")
        b = lead_from("directory", website=None, google_place_id=None, company_name="Riverside Dental Studio")
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 1

    def test_fuzzy_name_same_postcode_merges(self):
        a = lead_from(
            "openstreetmap", company_name="Quayside Smile Clinic", website=None,
            business_phone=None, google_place_id=None, postcode="NE1 3AF",
        )
        b = lead_from(
            "directory", company_name="Quayside Smile Clinic Newcastle", website=None,
            business_phone=None, google_place_id=None, postcode="NE1 3AF",
        )
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 1

    def test_different_businesses_are_kept_apart(self):
        a = lead_from("google_places", company_name="Riverside Dental Studio")
        b = lead_from(
            "google_places",
            company_name="Quayside Smile Clinic",
            google_place_id="ChIJtest0002",
            website="https://quaysidesmileclinic.co.uk",
            business_phone="0191 555 0202",
            postcode="NE1 3AF",
            address="5 Sandhill, Newcastle upon Tyne, NE1 3AF",
        )
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 2
        assert result.duplicates_removed == 0

    def test_similar_names_different_domains_stay_separate(self):
        a = lead_from(
            "search", company_name="Elite Roofing", website="https://eliteroofing.co.uk",
            google_place_id=None, business_phone=None, postcode="SR4 7AB", niche="roofers",
        )
        b = lead_from(
            "search", company_name="Elite Roofing", website="https://eliteroofingne.co.uk",
            google_place_id=None, business_phone=None, postcode="SR4 7AB", niche="roofers",
        )
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 2

    def test_cross_niche_records_are_not_merged_by_default(self):
        a = lead_from("google_places", niche="cosmetic_dentists")
        b = lead_from("google_places", niche="invisalign_dental_practices")
        result = Deduplicator().dedupe([a, b])
        assert len(result.leads) == 2


class TestMergeSemantics:
    def test_provenance_from_every_source_is_preserved(self):
        a = lead_from("google_places")
        b = lead_from("openstreetmap", company_name="Riverside Dental Studio Ltd")
        c = lead_from("companies_house", company_name="RIVERSIDE DENTAL STUDIO LIMITED")
        merged = Deduplicator().dedupe([a, b, c]).leads[0]
        assert set(merged.sources) == {"google_places", "openstreetmap", "companies_house"}
        assert len(merged.source_records) == 3

    def test_merge_fills_missing_fields_from_lower_priority_source(self):
        a = lead_from("google_places", business_email=None)
        b = lead_from("openstreetmap")
        b.business_email = "hello@riversidedentalstudio.co.uk"
        b.field_sources["business_email"] = "openstreetmap"
        merged = Deduplicator().dedupe([a, b]).leads[0]
        assert merged.business_email == "hello@riversidedentalstudio.co.uk"
        assert merged.field_sources["business_email"] == "openstreetmap"

    def test_higher_review_count_wins(self):
        a = lead_from("google_places", google_review_count=100, google_rating=4.5)
        b = lead_from("google_places", google_review_count=237, google_rating=4.8)
        merged = Deduplicator().dedupe([a, b]).leads[0]
        assert merged.google_review_count == 237
        assert merged.google_rating == 4.8

    def test_first_seen_ordering_is_stable(self):
        a = lead_from("google_places", company_name="Alpha Dental", google_place_id="A", website=None,
                      business_phone=None, postcode="NE1 1AA")
        b = lead_from("google_places", company_name="Beta Dental", google_place_id="B", website=None,
                      business_phone=None, postcode="NE1 2BB")
        result = Deduplicator().dedupe([a, b])
        assert [lead.company_name for lead in result.leads] == ["Alpha Dental", "Beta Dental"]

    def test_empty_input(self):
        result = Deduplicator().dedupe([])
        assert result.leads == [] and result.duplicates_removed == 0


def test_find_duplicate_pairs_reports_without_merging():
    a = make_lead(company_name="Riverside Dental Studio")
    b = make_lead(company_name="Riverside Dental Studio Ltd")
    pairs = find_duplicate_pairs([a, b])
    assert pairs and pairs[0][2] >= 0.88


def test_records_from_three_sources_collapse_to_one_lead():
    """Requirement 9: the same business found by three sources becomes one lead."""
    google = make_lead(source_name="google_places")
    osm = make_lead(
        source_name="openstreetmap", google_place_id=None,
        company_name="Riverside Dental Studio Limited",
    )
    directory = make_lead(
        source_name="directory", google_place_id=None, website=None,
        company_name="Riverside Dental",
    )
    directory.add_source(SourceRecord(source="directory", source_url="https://example-directory.test/x"))
    result = Deduplicator().dedupe([google, osm, directory])
    assert len(result.leads) == 1
    assert result.duplicates_removed == 2
    assert len(result.leads[0].sources) >= 3


class TestSharedParentDomains:
    """Two businesses under one registrable domain are two businesses.

    `root_domain()` reduces `a.example.co.uk` and `b.example.co.uk` to the same
    string. Treating that as proof of identity merged unrelated leads and
    silently destroyed one of them — the failure mode is invisible, because the
    survivor looks like a normal lead.
    """

    def _distinct(self, count: int) -> list[Lead]:
        leads = []
        for i in range(count):
            lead = make_lead(
                company_name=f"Sunderland Dental {i + 1}",
                website=f"https://practice{i + 1}.dentalgroup.co.uk",
                business_phone=f"0191 555 {1000 + i}",
                address=f"{i + 1} High Street West, Sunderland",
                postcode=f"SR1 3{i}A",
                city="Sunderland",
                google_place_id=None,
            )
            leads.append(lead)
        return leads

    def test_distinct_businesses_on_one_parent_domain_are_kept_apart(self):
        leads = self._distinct(4)
        result = Deduplicator().dedupe(leads)
        assert len(result.leads) == 4
        assert result.duplicates_removed == 0

    def test_near_identical_names_do_not_merge_them_either(self):
        """The fuzzy pass needs corroboration; a shared parent domain is not it."""
        leads = self._distinct(3)
        for lead in leads:
            lead.business_phone = None  # phone_key is derived, so it clears too
            lead.normalize()
        result = Deduplicator().dedupe(leads)
        assert len(result.leads) == 3

    def test_two_site_builder_tenants_are_kept_apart(self):
        leads = [
            make_lead(company_name="Salon One", website="https://salonone.wixsite.com/home",
                      business_phone=None, postcode="SR1 1AA", city="Sunderland",
                      address="1 Fawcett Street, Sunderland", google_place_id=None),
            make_lead(company_name="Salon Two", website="https://salontwo.wixsite.com/home",
                      business_phone=None, postcode="SR1 2BB", city="Sunderland",
                      address="2 Fawcett Street, Sunderland", google_place_id=None),
        ]
        assert len(Deduplicator().dedupe(leads).leads) == 2

    def test_one_business_across_apex_www_and_subdomain_still_merges(self):
        """The registrable-domain key still does its job when nothing conflicts."""
        leads = [
            make_lead(company_name="Riverside Dental Studio", website="https://riverside.co.uk",
                      business_phone="0191 555 0101", postcode="NE1 6EE", google_place_id=None),
            make_lead(company_name="Riverside Dental Studio",
                      website="https://www.riverside.co.uk/contact",
                      business_phone="0191 555 0101", postcode="NE1 6EE", google_place_id=None),
            make_lead(company_name="Riverside Dental", website="https://book.riverside.co.uk",
                      business_phone=None, postcode="NE1 6EE", google_place_id=None),
        ]
        assert len(Deduplicator().dedupe(leads).leads) == 1

    def test_the_same_host_from_two_sources_still_merges(self):
        leads = [
            make_lead(source_name="google_places", website="https://riverside.co.uk",
                      google_place_id=None),
            make_lead(source_name="openstreetmap", company_name="Riverside Dental",
                      website="https://riverside.co.uk/about", google_place_id=None),
        ]
        result = Deduplicator().dedupe(leads)
        assert len(result.leads) == 1
        assert result.duplicates_removed == 1
