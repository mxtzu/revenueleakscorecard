"""Email discovery hygiene and B2B outreach policy."""

from __future__ import annotations

import pytest

from lead_pipeline.utils.email_validation import (
    classify_email,
    extract_emails,
    pick_primary_email,
    validate_email_syntax,
)


class TestSyntax:
    @pytest.mark.parametrize(
        "email",
        ["info@example.co.uk", "hello.there@sub.domain.com", "bookings+web@clinic.io", "a@b.co"],
    )
    def test_valid(self, email):
        assert validate_email_syntax(email) is True

    @pytest.mark.parametrize(
        "email",
        ["", None, "notanemail", "@nope.com", "user@", "user@@host.com", "user@host",
         ".leading@host.com", "double..dot@host.com"],
    )
    def test_invalid(self, email):
        assert validate_email_syntax(email) is False


class TestClassification:
    @pytest.mark.parametrize(
        "email",
        ["info@clinic.co.uk", "hello@clinic.co.uk", "enquiries@clinic.co.uk", "sales@clinic.co.uk",
         "bookings@clinic.co.uk", "office@clinic.co.uk"],
    )
    def test_generic_addresses_are_accepted(self, email):
        assessment = classify_email(email, company_domain="clinic.co.uk")
        assert assessment.accept_for_outreach is True
        assert assessment.category in {"generic_business", "role_based"}
        assert assessment.matches_company_domain is True

    def test_role_based_detected(self):
        assessment = classify_email("accounts@clinic.co.uk", company_domain="clinic.co.uk")
        assert assessment.is_role_based is True
        assert assessment.category == "role_based"

    def test_named_individual_excluded_by_default(self):
        assessment = classify_email("sarah.jones@clinic.co.uk", company_domain="clinic.co.uk")
        assert assessment.is_likely_personal is True
        assert assessment.accept_for_outreach is False
        assert "excluded from outreach by policy" in assessment.reason

    def test_named_individual_can_be_opted_in_on_company_domain(self):
        assessment = classify_email(
            "sarah.jones@clinic.co.uk", company_domain="clinic.co.uk", allow_named_contacts=True
        )
        assert assessment.accept_for_outreach is True

    def test_named_individual_on_free_provider_stays_excluded(self):
        assessment = classify_email(
            "sarah.jones@gmail.com", company_domain="clinic.co.uk", allow_named_contacts=True
        )
        assert assessment.accept_for_outreach is False

    def test_free_provider_generic_is_accepted(self):
        assessment = classify_email("info@gmail.com", company_domain="roofing.co.uk")
        assert assessment.is_free_provider is True
        assert assessment.accept_for_outreach is True

    def test_placeholder_and_tooling_addresses_blocked(self):
        for email in (
            "user@example.com", "abc123@sentry.wixpress.com", "logo@2x", "test@example.org",
        ):
            assessment = classify_email(email)
            assert assessment.accept_for_outreach is False

    def test_invalid_input_is_categorised_not_raised(self):
        assessment = classify_email("nonsense")
        assert assessment.category == "invalid"
        assert assessment.accept_for_outreach is False

    def test_normalisation_lowercases_domain_only(self):
        assessment = classify_email(" MAILTO:Info@Clinic.CO.UK ")
        assert assessment.email == "Info@clinic.co.uk"
        assert assessment.is_generic is True


class TestSelection:
    def test_generic_beats_role_and_personal(self):
        assessments = [
            classify_email("sarah.jones@clinic.co.uk", company_domain="clinic.co.uk",
                           allow_named_contacts=True),
            classify_email("accounts@clinic.co.uk", company_domain="clinic.co.uk"),
            classify_email("hello@clinic.co.uk", company_domain="clinic.co.uk"),
        ]
        assert pick_primary_email(assessments).email == "hello@clinic.co.uk"

    def test_returns_none_when_nothing_acceptable(self):
        assessments = [classify_email("sarah.jones@clinic.co.uk", company_domain="clinic.co.uk")]
        assert pick_primary_email(assessments) is None

    def test_empty_list(self):
        assert pick_primary_email([]) is None


class TestExtraction:
    def test_finds_addresses_in_text(self):
        text = "Contact info@clinic.co.uk or bookings@clinic.co.uk. Not an email: @handle"
        assert extract_emails(text) == ["info@clinic.co.uk", "bookings@clinic.co.uk"]

    def test_deduplicates(self):
        assert extract_emails("a@b.com a@b.com") == ["a@b.com"]

    def test_empty(self):
        assert extract_emails(None) == []

    def test_never_invents_addresses(self):
        """The module must only report addresses that literally appear."""
        assert extract_emails("Riverside Dental Studio, Newcastle") == []
