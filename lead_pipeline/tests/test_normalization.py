"""Unit tests for normalization helpers (requirement 1)."""

from __future__ import annotations

import pytest

from lead_pipeline.utils.normalization import (
    address_key,
    clean_text,
    company_name_similarity,
    extract_domain,
    normalize_address,
    normalize_company_name,
    normalize_email,
    normalize_phone,
    normalize_postcode,
    normalize_url,
    parse_address_components,
    phone_digits,
    postcode_outward,
    root_domain,
    slugify,
    title_case_company,
    token_set_ratio,
)


class TestCompanyName:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("The Smile Studio (Newcastle) Ltd.", "smile studio newcastle"),
            ("NORTHERN ROOFING SOLUTIONS LIMITED", "northern roofing solutions"),
            ("Café Aesthetics & Co", "cafe aesthetics"),
            ("  Riverside   Dental   Studio  ", "riverside dental studio"),
            ("Smith & Sons T/A Smith Roofing", "smith sons smith roofing"),
        ],
    )
    def test_normalize_company_name(self, raw, expected):
        assert normalize_company_name(raw) == expected

    def test_name_of_only_suffixes_is_not_empty(self):
        assert normalize_company_name("Limited Ltd") != ""

    def test_empty_input(self):
        assert normalize_company_name(None) == ""
        assert normalize_company_name("") == ""

    def test_similarity_matches_variants(self):
        assert company_name_similarity("Northern Roofing Solutions", "Northern Roofing Solutions Ltd") == 1.0
        assert company_name_similarity("Riverside Dental", "Riverside Dental Studio") >= 0.9
        assert company_name_similarity("Riverside Dental", "Quayside Smile Clinic") < 0.6

    def test_token_set_ratio_is_order_insensitive(self):
        assert token_set_ratio("dental riverside studio", "riverside studio dental") == 1.0


class TestPhone:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("0191 555 0101", "+441915550101"),
            ("+44 191 555 0101", "+441915550101"),
            ("(0191) 555-0101", "+441915550101"),
            ("0044 191 555 0101", "+441915550101"),
            ("07700 900123", "+447700900123"),
        ],
    )
    def test_uk_numbers_normalize_identically(self, raw, expected):
        assert normalize_phone(raw) == expected

    @pytest.mark.parametrize("raw", ["", None, "123", "abc", "0000000000000"])
    def test_rejects_implausible(self, raw):
        assert normalize_phone(raw) is None

    def test_phone_key_ignores_formatting(self):
        assert phone_digits("0191 555 0101") == phone_digits("+44 (0)191 555 0101")

    def test_us_country(self):
        assert normalize_phone("(415) 555-2671", country="US") == "+14155552671"


class TestUrls:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("riversidedental.co.uk", "https://riversidedental.co.uk"),
            ("http://www.riversidedental.co.uk/", "http://riversidedental.co.uk"),
            ("https://WWW.Riversidedental.CO.UK/invisalign/", "https://riversidedental.co.uk/invisalign"),
            ("https://x.co.uk/page?utm_source=google&id=7", "https://x.co.uk/page?id=7"),
        ],
    )
    def test_normalize_url(self, raw, expected):
        assert normalize_url(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "mailto:a@b.com", "tel:+441", "javascript:void(0)", "notaurl"])
    def test_rejects_non_urls(self, raw):
        assert normalize_url(raw) is None

    def test_extract_domain_strips_www(self):
        assert extract_domain("https://www.riversidedental.co.uk/contact") == "riversidedental.co.uk"

    def test_root_domain_handles_multi_part_tld(self):
        assert root_domain("https://booking.riversidedental.co.uk") == "riversidedental.co.uk"
        assert root_domain("https://shop.example.com") == "example.com"


class TestPostcodeAndAddress:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("ne16ee", "NE1 6EE"),
            ("NE1 6EE", "NE1 6EE"),
            ("12 Grey Street, Newcastle upon Tyne, ne1 6ee, UK", "NE1 6EE"),
            ("SR4 7AB", "SR4 7AB"),
        ],
    )
    def test_normalize_postcode(self, raw, expected):
        assert normalize_postcode(raw) == expected

    def test_invalid_postcode(self):
        assert normalize_postcode("not a postcode") is None

    def test_outward_code(self):
        assert postcode_outward("NE1 6EE") == "NE1"

    def test_normalize_address_abbreviates(self):
        assert normalize_address("12 Grey Street, Newcastle") == "12 grey st newcastle"

    def test_address_key_matches_variants(self):
        a = address_key("12 Grey Street, Newcastle upon Tyne", "NE1 6EE")
        b = address_key("12 Grey St, Newcastle upon Tyne NE1 6EE")
        assert a == b and a is not None

    def test_parse_address_components(self):
        parsed = parse_address_components("12 Grey Street, Newcastle upon Tyne, NE1 6EE, United Kingdom")
        assert parsed["postcode"] == "NE1 6EE"
        assert parsed["country"] == "UK"
        assert parsed["city"] == "Newcastle upon Tyne"


class TestMisc:
    def test_clean_text_collapses_whitespace_and_entities(self):
        assert clean_text("  Riverside &amp;  Dental \n Studio ") == "Riverside & Dental Studio"

    def test_normalize_email(self):
        assert normalize_email(" MAILTO:Hello@Example.CO.UK ") == "Hello@example.co.uk"
        assert normalize_email("nope") is None

    def test_slugify(self):
        assert slugify("Newcastle upon Tyne") == "newcastle-upon-tyne"

    def test_title_case_company(self):
        assert title_case_company("NORTHERN ROOFING") == "Northern Roofing"
        assert title_case_company("Riverside Dental Studio") == "Riverside Dental Studio"
