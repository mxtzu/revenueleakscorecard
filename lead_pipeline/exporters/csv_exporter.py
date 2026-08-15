"""CSV export.

Column set is exactly the one specified for the agency workflow, plus an
``audit`` companion file with the personalisation brief for each lead.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import Lead

CSV_COLUMNS: list[str] = [
    "company_name",
    "niche",
    "sub_niche",
    "website",
    "phone",
    "email",
    "address",
    "city",
    "postcode",
    "google_rating",
    "google_review_count",
    "website_quality_score",
    "landing_page_quality_score",
    "lead_score",
    "advertising_status",
    "opportunities",
    "lead_reason",
    "google_maps_url",
    "facebook_url",
    "instagram_url",
    "linkedin_url",
    "source",
    "date_discovered",
]

AUDIT_COLUMNS: list[str] = [
    "company",
    "website",
    "niche",
    "location",
    "lead_score",
    "what_they_do_well",
    "problem_1",
    "problem_2",
    "problem_3",
    "biggest_opportunity",
    "recommended_service",
    "why_good_prospect",
    "phone",
    "email",
]


def lead_to_csv_row(lead: Lead) -> dict[str, Any]:
    website = lead.website_analysis
    ads = lead.advertising_analysis
    return {
        "company_name": lead.company_name,
        "niche": lead.niche,
        "sub_niche": lead.sub_niche or "",
        "website": lead.website or "",
        "phone": lead.business_phone or "",
        "email": lead.business_email or "",
        "address": lead.address or "",
        "city": lead.city or "",
        "postcode": lead.postcode or "",
        "google_rating": lead.google_rating if lead.google_rating is not None else "",
        "google_review_count": lead.google_review_count if lead.google_review_count is not None else "",
        "website_quality_score": website.website_quality_score if website else "",
        "landing_page_quality_score": website.landing_page_quality_score if website else "",
        "lead_score": round(lead.lead_score, 1) if lead.score else "",
        "advertising_status": ads.status if ads else "unknown",
        "opportunities": " | ".join(lead.opportunities),
        "lead_reason": lead.lead_reason,
        "google_maps_url": lead.google_maps_url or "",
        "facebook_url": lead.facebook_url or "",
        "instagram_url": lead.instagram_url or "",
        "linkedin_url": lead.linkedin_url or "",
        "source": ", ".join(lead.sources),
        "date_discovered": lead.date_discovered,
    }


def export_csv(
    leads: Iterable[Lead],
    path: str | Path,
    *,
    columns: Sequence[str] | None = None,
) -> Path:
    """Write the standard lead CSV. Returns the path written."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(columns or CSV_COLUMNS)
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for lead in leads:
            writer.writerow(lead_to_csv_row(lead))
    return target


def export_audit_csv(records: Iterable[Any], path: str | Path) -> Path:
    """Write the personalisation audit records (one row per qualified lead)."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=AUDIT_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            payload = record.as_dict() if hasattr(record, "as_dict") else dict(record)
            problems = list(payload.get("top_3_problems") or [])
            problems += [""] * (3 - len(problems))
            contact = payload.get("contact") or {}
            writer.writerow(
                {
                    "company": payload.get("company", ""),
                    "website": payload.get("website") or "",
                    "niche": payload.get("niche", ""),
                    "location": payload.get("location", ""),
                    "lead_score": payload.get("lead_score", ""),
                    "what_they_do_well": " | ".join(payload.get("what_they_do_well") or []),
                    "problem_1": problems[0],
                    "problem_2": problems[1],
                    "problem_3": problems[2],
                    "biggest_opportunity": payload.get("biggest_opportunity", ""),
                    "recommended_service": payload.get("recommended_service", ""),
                    "why_good_prospect": payload.get("why_they_are_a_good_prospect", ""),
                    "phone": contact.get("phone") or "",
                    "email": contact.get("email") or "",
                }
            )
    return target
