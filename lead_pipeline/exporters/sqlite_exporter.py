"""SQLite export.

Writes a **portable** database containing just the exported leads (the main
``leads.sqlite`` stays the pipeline's persistent store). Useful for handing a
single file to a VA or importing into another tool.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import Lead, RunStats

EXPORT_SCHEMA = """
CREATE TABLE IF NOT EXISTS export_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS leads (
    lead_id                    TEXT PRIMARY KEY,
    company_name               TEXT,
    niche                      TEXT,
    sub_niche                  TEXT,
    website                    TEXT,
    domain                     TEXT,
    phone                      TEXT,
    email                      TEXT,
    address                    TEXT,
    city                       TEXT,
    postcode                   TEXT,
    region                     TEXT,
    country                    TEXT,
    latitude                   REAL,
    longitude                  REAL,
    google_rating              REAL,
    google_review_count        INTEGER,
    google_maps_url            TEXT,
    facebook_url               TEXT,
    instagram_url              TEXT,
    linkedin_url               TEXT,
    tiktok_url                 TEXT,
    youtube_url                TEXT,
    website_quality_score      INTEGER,
    landing_page_quality_score INTEGER,
    lead_score                 REAL,
    score_band                 TEXT,
    advertising_status         TEXT,
    opportunities              TEXT,
    lead_reason                TEXT,
    recommended_service        TEXT,
    sources                    TEXT,
    date_discovered            TEXT,
    last_seen                  TEXT
);

CREATE TABLE IF NOT EXISTS website_analysis (
    lead_id TEXT PRIMARY KEY,
    payload TEXT
);

CREATE TABLE IF NOT EXISTS advertising_analysis (
    lead_id TEXT PRIMARY KEY,
    payload TEXT
);

CREATE TABLE IF NOT EXISTS lead_scores (
    lead_id TEXT PRIMARY KEY,
    payload TEXT
);

CREATE TABLE IF NOT EXISTS audit_records (
    lead_id TEXT,
    company TEXT,
    payload TEXT
);
"""


def export_sqlite(
    leads: Iterable[Lead],
    path: str | Path,
    *,
    run: RunStats | None = None,
    audit_records: Sequence[Any] | None = None,
    overwrite: bool = True,
) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if overwrite and target.exists():
        target.unlink()

    conn = sqlite3.connect(str(target))
    try:
        conn.executescript(EXPORT_SCHEMA)
        from ..models import iso_now

        conn.execute(
            "INSERT INTO export_meta (key, value) VALUES ('generated_at', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (iso_now(),),
        )
        if run is not None:
            conn.execute(
                "INSERT INTO export_meta (key, value) VALUES ('run', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (json.dumps(run.as_dict(), default=str),),
            )

        for lead in leads:
            website = lead.website_analysis
            ads = lead.advertising_analysis
            conn.execute(
                """
                INSERT INTO leads VALUES (
                    :lead_id, :company_name, :niche, :sub_niche, :website, :domain, :phone, :email,
                    :address, :city, :postcode, :region, :country, :latitude, :longitude,
                    :google_rating, :google_review_count, :google_maps_url, :facebook_url,
                    :instagram_url, :linkedin_url, :tiktok_url, :youtube_url,
                    :website_quality_score, :landing_page_quality_score, :lead_score, :score_band,
                    :advertising_status, :opportunities, :lead_reason, :recommended_service,
                    :sources, :date_discovered, :last_seen
                )
                ON CONFLICT(lead_id) DO NOTHING
                """,
                {
                    "lead_id": lead.lead_id,
                    "company_name": lead.company_name,
                    "niche": lead.niche,
                    "sub_niche": lead.sub_niche,
                    "website": lead.website,
                    "domain": lead.domain,
                    "phone": lead.business_phone,
                    "email": lead.business_email,
                    "address": lead.address,
                    "city": lead.city,
                    "postcode": lead.postcode,
                    "region": lead.region,
                    "country": lead.country,
                    "latitude": lead.latitude,
                    "longitude": lead.longitude,
                    "google_rating": lead.google_rating,
                    "google_review_count": lead.google_review_count,
                    "google_maps_url": lead.google_maps_url,
                    "facebook_url": lead.facebook_url,
                    "instagram_url": lead.instagram_url,
                    "linkedin_url": lead.linkedin_url,
                    "tiktok_url": lead.tiktok_url,
                    "youtube_url": lead.youtube_url,
                    "website_quality_score": website.website_quality_score if website else None,
                    "landing_page_quality_score": website.landing_page_quality_score if website else None,
                    "lead_score": round(lead.lead_score, 1) if lead.score else None,
                    "score_band": lead.score.band if lead.score else None,
                    "advertising_status": ads.status if ads else None,
                    "opportunities": json.dumps(lead.opportunities, ensure_ascii=False),
                    "lead_reason": lead.lead_reason,
                    "recommended_service": lead.recommended_service,
                    "sources": json.dumps(lead.sources),
                    "date_discovered": lead.date_discovered,
                    "last_seen": lead.last_seen,
                },
            )
            if website:
                conn.execute(
                    "INSERT INTO website_analysis VALUES (?, ?) ON CONFLICT(lead_id) DO UPDATE SET payload = excluded.payload",
                    (lead.lead_id, json.dumps(website.as_dict(), default=str, ensure_ascii=False)),
                )
            if ads:
                conn.execute(
                    "INSERT INTO advertising_analysis VALUES (?, ?) ON CONFLICT(lead_id) DO UPDATE SET payload = excluded.payload",
                    (lead.lead_id, json.dumps(ads.as_dict(), default=str, ensure_ascii=False)),
                )
            if lead.score:
                conn.execute(
                    "INSERT INTO lead_scores VALUES (?, ?) ON CONFLICT(lead_id) DO UPDATE SET payload = excluded.payload",
                    (lead.lead_id, json.dumps(lead.score.as_dict(), default=str, ensure_ascii=False)),
                )

        for record in audit_records or []:
            payload = record.as_dict() if hasattr(record, "as_dict") else dict(record)
            conn.execute(
                "INSERT INTO audit_records (lead_id, company, payload) VALUES (?, ?, ?)",
                (
                    payload.get("lead_id", ""),
                    payload.get("company", ""),
                    json.dumps(payload, default=str, ensure_ascii=False),
                ),
            )
        conn.commit()
    finally:
        conn.close()
    return target
