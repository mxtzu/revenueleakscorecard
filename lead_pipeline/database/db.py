"""Persistent SQLite storage.

The database is the pipeline's memory: businesses seen in earlier runs are
updated rather than duplicated, previous scores are preserved, and every
analysis is appended so change over time is queryable.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import (
    AdvertisingAnalysis,
    Confidence,
    Lead,
    LeadScore,
    PersonMention,
    PipelineError,
    ScoreComponent,
    SourceRecord,
    WebsiteAnalysis,
    iso_now,
)
from ..utils.email_validation import EmailAssessment
from ..utils.geo import Location
from ..utils.logging import get_logger
from .models import SCHEMA, SCHEMA_VERSION

logger = get_logger("db")


def _json(value: Any) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def _load_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _bool(value: Any) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


class Database:
    """Thin, explicit SQLite wrapper - no ORM, no magic."""

    def __init__(self, path: str | Path = "leads.sqlite") -> None:
        self.path = Path(path)
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.executescript(SCHEMA)
            self._add_missing_columns()
            self.conn.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(SCHEMA_VERSION),),
            )
            self.conn.commit()

    def _add_missing_columns(self) -> None:
        """Bring an existing database up to the current column set.

        ``CREATE TABLE IF NOT EXISTS`` silently does nothing to a table that
        already exists, so a database written by an older version keeps its old
        columns and every insert then fails on the new ones. Adding nullable
        columns is the one schema change SQLite does cheaply and safely, so it
        happens on open rather than requiring anyone to delete their leads file.
        """
        existing = {row["name"] for row in self.conn.execute("PRAGMA table_info(leads)")}
        for column, ddl in (
            ("contact_role", "TEXT"),
            ("contact_source_url", "TEXT"),
        ):
            if column not in existing:
                self.conn.execute(f"ALTER TABLE leads ADD COLUMN {column} {ddl}")

    # ------------------------------------------------------------------ runs
    def start_run(
        self,
        *,
        niches: Sequence[str],
        locations: Sequence[str],
        sources: Sequence[str],
        radius_km: float | None = None,
        country: str | None = None,
        min_score: float | None = None,
        params: dict[str, Any] | None = None,
    ) -> int:
        with self._lock:
            cursor = self.conn.execute(
                """
                INSERT INTO scrape_runs
                    (started_at, status, niches, locations, sources, radius_km, country, min_score, params_json)
                VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    iso_now(),
                    _json(list(niches)),
                    _json(list(locations)),
                    _json(list(sources)),
                    radius_km,
                    country,
                    min_score,
                    _json(params or {}),
                ),
            )
            self.conn.commit()
            return int(cursor.lastrowid)

    def finish_run(
        self,
        run_id: int,
        *,
        status: str = "completed",
        discovered: int = 0,
        duplicates_removed: int = 0,
        enriched: int = 0,
        qualified: int = 0,
        error_count: int = 0,
        interrupted: bool = False,
        notes: Sequence[str] | None = None,
    ) -> None:
        with self._lock:
            self.conn.execute(
                """
                UPDATE scrape_runs SET
                    finished_at = ?, status = ?, discovered = ?, duplicates_removed = ?,
                    enriched = ?, qualified = ?, error_count = ?, interrupted = ?, notes = ?
                WHERE id = ?
                """,
                (
                    iso_now(), status, discovered, duplicates_removed, enriched, qualified,
                    error_count, 1 if interrupted else 0, _json(list(notes or [])), run_id,
                ),
            )
            self.conn.commit()

    def get_run(self, run_id: int) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM scrape_runs WHERE id = ?", (run_id,)).fetchone()
        return dict(row) if row else None

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM scrape_runs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- locations
    def upsert_location(self, location: Location) -> int:
        now = iso_now()
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO locations (raw, city, region, postcode, country, latitude, longitude,
                                       radius_km, first_used_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(raw, country) DO UPDATE SET
                    city = COALESCE(excluded.city, locations.city),
                    region = COALESCE(excluded.region, locations.region),
                    postcode = COALESCE(excluded.postcode, locations.postcode),
                    latitude = COALESCE(excluded.latitude, locations.latitude),
                    longitude = COALESCE(excluded.longitude, locations.longitude),
                    radius_km = excluded.radius_km,
                    last_used_at = excluded.last_used_at
                """,
                (
                    location.raw, location.city, location.region, location.postcode,
                    location.country, location.latitude, location.longitude,
                    location.radius_km, now, now,
                ),
            )
            self.conn.commit()
            row = self.conn.execute(
                "SELECT id FROM locations WHERE raw = ? AND country IS ?", (location.raw, location.country)
            ).fetchone()
            return int(row["id"]) if row else 0

    # --------------------------------------------------------------- sources
    def upsert_source(self, name: str, kind: str = "discovery", attribution: str = "") -> int:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO sources (name, kind, attribution, first_seen_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    kind = excluded.kind,
                    attribution = COALESCE(NULLIF(excluded.attribution, ''), sources.attribution)
                """,
                (name, kind, attribution, iso_now()),
            )
            self.conn.commit()
            row = self.conn.execute("SELECT id FROM sources WHERE name = ?", (name,)).fetchone()
            return int(row["id"]) if row else 0

    # ----------------------------------------------------------------- leads
    def find_existing_lead(self, lead: Lead) -> dict[str, Any] | None:
        """Match against the persistent store using the same keys as dedupe."""
        queries: list[tuple[str, tuple[Any, ...]]] = [("SELECT * FROM leads WHERE id = ?", (lead.lead_id,))]
        if lead.google_place_id:
            queries.append(("SELECT * FROM leads WHERE google_place_id = ?", (lead.google_place_id,)))
        if lead.domain:
            queries.append(("SELECT * FROM leads WHERE domain = ? AND niche = ?", (lead.domain, lead.niche)))
        if lead.phone_key:
            queries.append(
                ("SELECT * FROM leads WHERE phone_key = ? AND niche = ?", (lead.phone_key, lead.niche))
            )
        if lead.normalized_name and (lead.postcode or lead.city):
            queries.append(
                (
                    "SELECT * FROM leads WHERE normalized_name = ? AND niche = ? "
                    "AND (postcode = ? OR city = ?)",
                    (lead.normalized_name, lead.niche, lead.postcode, lead.city),
                )
            )
        for sql, params in queries:
            row = self.conn.execute(sql, params).fetchone()
            if row and not row["deleted_at"]:
                return dict(row)
        return None

    def _row_by_id(self, lead_id: str) -> dict[str, Any] | None:
        """Any row with this id, deleted or not (used to avoid PK collisions)."""
        row = self.conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        return dict(row) if row else None

    def upsert_lead(self, lead: Lead, run_id: int | None = None) -> dict[str, Any]:
        """Insert or update a lead, preserving history. Returns a change summary."""
        existing = self.find_existing_lead(lead)
        if existing is None:
            # A previously soft-deleted lead still owns its primary key.
            # Re-discovering it restores the row rather than colliding on insert.
            existing = self._row_by_id(lead.lead_id)
        now = iso_now()

        if existing:
            lead.lead_id = existing["id"]
            lead.date_discovered = existing["date_discovered"] or lead.date_discovered
            previous_score = existing["lead_score"]
            lead.previous_score = previous_score
            merged_sources = sorted(set(_load_json(existing["sources"], []) + lead.sources))
            merged_locations = sorted(
                set(_load_json(existing["search_locations"], []) + lead.search_locations)
            )
            times_seen = int(existing["times_seen"] or 1) + 1
        else:
            previous_score = None
            merged_sources = sorted(set(lead.sources))
            merged_locations = sorted(set(lead.search_locations))
            times_seen = 1

        website = lead.website_analysis
        ads = lead.advertising_analysis
        values: dict[str, Any] = {
            "id": lead.lead_id,
            "company_name": lead.company_name,
            "normalized_name": lead.normalized_name,
            "trading_name": lead.trading_name,
            "legal_name": lead.legal_name,
            "niche": lead.niche,
            "sub_niche": lead.sub_niche,
            "description": lead.description,
            "website": lead.website,
            "domain": lead.domain,
            "business_phone": lead.business_phone,
            "phone_key": lead.phone_key,
            "business_email": lead.business_email,
            "contact_name": lead.contact_name,
            "contact_role": lead.contact_role,
            "contact_source_url": lead.contact_source_url,
            "address": lead.address,
            "city": lead.city,
            "postcode": lead.postcode,
            "region": lead.region,
            "country": lead.country,
            "latitude": lead.latitude,
            "longitude": lead.longitude,
            "google_maps_url": lead.google_maps_url,
            "facebook_url": lead.facebook_url,
            "instagram_url": lead.instagram_url,
            "linkedin_url": lead.linkedin_url,
            "tiktok_url": lead.tiktok_url,
            "youtube_url": lead.youtube_url,
            "google_rating": lead.google_rating,
            "google_review_count": lead.google_review_count,
            "google_category": lead.google_category,
            "google_place_id": lead.google_place_id,
            "opening_hours": _json(lead.opening_hours),
            "business_status": lead.business_status,
            "company_number": lead.company_number,
            "incorporation_date": lead.incorporation_date,
            "years_in_operation": lead.years_in_operation,
            "lead_score": round(lead.lead_score, 1) if lead.score else None,
            "previous_lead_score": previous_score,
            "score_band": lead.score.band if lead.score else None,
            "website_quality_score": website.website_quality_score if website else None,
            "landing_page_quality_score": website.landing_page_quality_score if website else None,
            "advertising_status": ads.status if ads else None,
            "opportunities": _json(lead.opportunities),
            "strengths": _json(lead.strengths),
            "lead_reason": lead.lead_reason,
            "recommended_service": lead.recommended_service,
            "emails_json": _json([a.as_dict() for a in lead.email_assessments]),
            "sources": _json(merged_sources),
            "field_sources_json": _json(lead.field_sources),
            "search_locations": _json(merged_locations),
            "date_discovered": lead.date_discovered,
            "last_seen": now,
            "last_checked": lead.last_checked,
            "times_seen": times_seen,
        }

        with self._lock:
            if existing:
                # COALESCE keeps previously known values when this run saw less.
                assignments = []
                params: list[Any] = []
                preserve = {
                    "date_discovered", "id", "times_seen", "last_seen", "previous_lead_score",
                }
                for column, value in values.items():
                    if column in preserve:
                        continue
                    if value is None:
                        continue
                    assignments.append(f"{column} = ?")
                    params.append(value)
                assignments.extend(
                    ["last_seen = ?", "times_seen = ?", "previous_lead_score = ?", "deleted_at = NULL"]
                )
                params.extend([now, times_seen, previous_score, lead.lead_id])
                self.conn.execute(
                    f"UPDATE leads SET {', '.join(assignments)} WHERE id = ?", params
                )
            else:
                columns = ", ".join(values)
                placeholders = ", ".join("?" for _ in values)
                self.conn.execute(
                    f"INSERT INTO leads ({columns}) VALUES ({placeholders})", list(values.values())
                )
            self.conn.commit()

        self._save_provenance(lead, run_id)
        if run_id is not None:
            self._save_run_appearance(lead, run_id)
        return {
            "lead_id": lead.lead_id,
            "is_new": existing is None,
            "previous_score": previous_score,
            "times_seen": times_seen,
        }

    def _save_provenance(self, lead: Lead, run_id: int | None) -> None:
        with self._lock:
            for record in lead.source_records:
                source_id = self.upsert_source(record.source, "discovery", "")
                self.conn.execute(
                    """
                    INSERT INTO lead_sources
                        (lead_id, source_id, source_name, source_url, source_record_id, retrieved_at, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(lead_id, source_name, source_record_id) DO UPDATE SET
                        source_url = COALESCE(excluded.source_url, lead_sources.source_url),
                        retrieved_at = excluded.retrieved_at
                    """,
                    (
                        lead.lead_id, source_id, record.source, record.source_url,
                        record.source_record_id or "", record.retrieved_at, _json(record.data),
                    ),
                )
            for field_name, source_name in lead.field_sources.items():
                self.conn.execute(
                    """
                    INSERT INTO lead_field_provenance (lead_id, field, source_name, observed_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(lead_id, field) DO UPDATE SET
                        source_name = excluded.source_name, observed_at = excluded.observed_at
                    """,
                    (lead.lead_id, field_name, source_name, iso_now()),
                )
            self.conn.commit()

    def _save_run_appearance(self, lead: Lead, run_id: int, location_id: int | None = None) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO lead_run_appearances (lead_id, run_id, location_id, seen_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(lead_id, run_id) DO UPDATE SET seen_at = excluded.seen_at
                """,
                (lead.lead_id, run_id, location_id, iso_now()),
            )
            self.conn.commit()

    # ------------------------------------------------------------- analyses
    def save_website_analysis(self, lead_id: str, analysis: WebsiteAnalysis, run_id: int | None = None) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO website_analysis (
                    lead_id, run_id, analysed_at, website_exists, website_loads, final_url, http_status,
                    ssl_enabled, mobile_friendly, page_speed_score, page_speed_source, load_time_ms,
                    page_bytes, has_booking_system, has_online_booking, has_contact_form, has_phone_cta,
                    has_primary_cta, has_pricing, has_testimonials, has_reviews, has_before_after,
                    has_case_studies, has_finance_option, has_live_chat, has_tracking_pixel,
                    has_google_analytics, has_meta_pixel, has_google_tag_manager, has_google_ads_tag,
                    landing_page_quality_score, website_quality_score, pages_checked, service_pages,
                    missing_service_pages, error, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lead_id, run_id, analysis.analysed_at, _bool(analysis.website_exists),
                    _bool(analysis.website_loads), analysis.final_url, analysis.http_status,
                    _bool(analysis.ssl_enabled), _bool(analysis.mobile_friendly),
                    analysis.page_speed_score, analysis.page_speed_source, analysis.load_time_ms,
                    analysis.page_bytes, _bool(analysis.has_booking_system),
                    _bool(analysis.has_online_booking), _bool(analysis.has_contact_form),
                    _bool(analysis.has_phone_cta), _bool(analysis.has_primary_cta),
                    _bool(analysis.has_pricing), _bool(analysis.has_testimonials),
                    _bool(analysis.has_reviews), _bool(analysis.has_before_after),
                    _bool(analysis.has_case_studies), _bool(analysis.has_finance_option),
                    _bool(analysis.has_live_chat), _bool(analysis.has_tracking_pixel),
                    _bool(analysis.has_google_analytics), _bool(analysis.has_meta_pixel),
                    _bool(analysis.has_google_tag_manager), _bool(analysis.has_google_ads_tag),
                    analysis.landing_page_quality_score, analysis.website_quality_score,
                    _json(analysis.pages_checked), _json(analysis.service_pages),
                    _json(analysis.missing_service_pages), analysis.error, _json(analysis.as_dict()),
                ),
            )
            self.conn.commit()

    def save_advertising_analysis(
        self, lead_id: str, analysis: AdvertisingAnalysis, run_id: int | None = None
    ) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO advertising_analysis (
                    lead_id, run_id, analysed_at, google_ads_confidence, meta_ads_confidence,
                    ad_landing_page, advertising_platform, number_of_visible_ads, creative_count,
                    estimated_ad_activity, ad_quality_score, evidence, sources, raw_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lead_id, run_id, analysis.analysed_at,
                    analysis.appears_to_be_running_google_ads.value,
                    analysis.appears_to_be_running_meta_ads.value,
                    analysis.ad_landing_page, _json(analysis.advertising_platform),
                    analysis.number_of_visible_ads, analysis.creative_count,
                    analysis.estimated_ad_activity, analysis.ad_quality_score,
                    _json(analysis.evidence), _json(analysis.sources), _json(analysis.as_dict()),
                ),
            )
            self.conn.commit()

    def save_score(self, lead_id: str, score: LeadScore, run_id: int | None = None) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO lead_scores (
                    lead_id, run_id, scored_at, total, band, business_value, marketing_opportunity,
                    paid_acquisition, credibility, outreach_accessibility, breakdown_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    lead_id, run_id, score.scored_at, score.total, score.band, score.business_value,
                    score.marketing_opportunity, score.paid_acquisition, score.credibility,
                    score.outreach_accessibility, _json(score.as_dict()),
                ),
            )
            self.conn.commit()

    def save_opportunities(self, lead_id: str, opportunities: Iterable[str], run_id: int | None = None) -> None:
        with self._lock:
            self.conn.execute(
                "DELETE FROM lead_opportunities WHERE lead_id = ? AND run_id IS ?", (lead_id, run_id)
            )
            self.conn.executemany(
                "INSERT INTO lead_opportunities (lead_id, run_id, opportunity, created_at) VALUES (?, ?, ?, ?)",
                [(lead_id, run_id, opportunity, iso_now()) for opportunity in opportunities],
            )
            self.conn.commit()

    def record_error(self, error: PipelineError, run_id: int | None = None) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO errors (run_id, stage, source, target, error_type, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (run_id, error.stage, error.source, error.target, error.error_type,
                 error.message[:2000], error.created_at),
            )
            self.conn.commit()

    def record_errors(self, errors: Iterable[PipelineError], run_id: int | None = None) -> int:
        count = 0
        for error in errors:
            self.record_error(error, run_id)
            count += 1
        return count

    # ---------------------------------------------------------- checkpoints
    def checkpoint(self, run_key: str, lead_id: str, stage: str) -> None:
        with self._lock:
            self.conn.execute(
                """
                INSERT INTO checkpoints (run_key, lead_id, stage, completed_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(run_key, lead_id, stage) DO UPDATE SET completed_at = excluded.completed_at
                """,
                (run_key, lead_id, stage, iso_now()),
            )
            self.conn.commit()

    def is_checkpointed(self, run_key: str, lead_id: str, stage: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM checkpoints WHERE run_key = ? AND lead_id = ? AND stage = ?",
            (run_key, lead_id, stage),
        ).fetchone()
        return row is not None

    def clear_checkpoints(self, run_key: str) -> int:
        with self._lock:
            cursor = self.conn.execute("DELETE FROM checkpoints WHERE run_key = ?", (run_key,))
            self.conn.commit()
            return cursor.rowcount

    # --------------------------------------------------------------- reads
    def get_lead(self, lead_id: str, include_deleted: bool = False) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
        if not row:
            return None
        record = dict(row)
        if record.get("deleted_at") and not include_deleted:
            return None
        return record

    def query_leads(
        self,
        *,
        niche: str | None = None,
        min_score: float | None = None,
        city: str | None = None,
        limit: int | None = None,
        include_deleted: bool = False,
        order_by: str = "lead_score DESC",
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if not include_deleted:
            clauses.append("deleted_at IS NULL")
        if niche:
            clauses.append("niche = ?")
            params.append(niche)
        if min_score is not None:
            clauses.append("COALESCE(lead_score, 0) >= ?")
            params.append(min_score)
        if city:
            clauses.append("LOWER(city) = ?")
            params.append(city.lower())
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        allowed_order = {
            "lead_score DESC", "lead_score ASC", "last_seen DESC", "company_name ASC",
            "date_discovered DESC",
        }
        order = order_by if order_by in allowed_order else "lead_score DESC"
        sql = f"SELECT * FROM leads {where} ORDER BY {order}"
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        return [dict(row) for row in self.conn.execute(sql, params).fetchall()]

    def lead_score_history(self, lead_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM lead_scores WHERE lead_id = ? ORDER BY id ASC", (lead_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def lead_sources(self, lead_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM lead_sources WHERE lead_id = ? ORDER BY id ASC", (lead_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def latest_website_analysis(self, lead_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM website_analysis WHERE lead_id = ? ORDER BY id DESC LIMIT 1", (lead_id,)
        ).fetchone()
        return dict(row) if row else None

    def latest_advertising_analysis(self, lead_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM advertising_analysis WHERE lead_id = ? ORDER BY id DESC LIMIT 1", (lead_id,)
        ).fetchone()
        return dict(row) if row else None

    def counts(self) -> dict[str, int]:
        tables = [
            "leads", "lead_sources", "website_analysis", "advertising_analysis", "lead_scores",
            "lead_opportunities", "scrape_runs", "errors", "locations", "sources",
        ]
        result: dict[str, int] = {}
        for table in tables:
            row = self.conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()
            result[table] = int(row["n"]) if row else 0
        row = self.conn.execute("SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NOT NULL").fetchone()
        result["leads_deleted"] = int(row["n"]) if row else 0
        return result

    # -------------------------------------------------------------- deletes
    def delete_lead(self, lead_id: str, *, hard: bool = False, reason: str = "") -> bool:
        """Remove a lead on request.

        Soft delete (default) keeps the row for audit but scrubs contact data
        and hides it from every query and export. ``hard=True`` removes the row
        and all dependent records.
        """
        with self._lock:
            if hard:
                cursor = self.conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
                for table in (
                    "lead_sources", "lead_field_provenance", "lead_run_appearances",
                    "website_analysis", "advertising_analysis", "lead_scores", "lead_opportunities",
                ):
                    self.conn.execute(f"DELETE FROM {table} WHERE lead_id = ?", (lead_id,))
                self.conn.commit()
                return cursor.rowcount > 0
            cursor = self.conn.execute(
                """
                UPDATE leads SET
                    deleted_at = ?, delete_reason = ?, business_email = NULL, business_phone = NULL,
                    phone_key = NULL, contact_name = NULL, contact_role = NULL,
                    contact_source_url = NULL, emails_json = '[]'
                WHERE id = ?
                """,
                (iso_now(), reason or "requested", lead_id),
            )
            self.conn.commit()
            return cursor.rowcount > 0

    def purge_deleted(self) -> int:
        rows = self.conn.execute("SELECT id FROM leads WHERE deleted_at IS NOT NULL").fetchall()
        for row in rows:
            self.delete_lead(row["id"], hard=True)
        return len(rows)

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


# --------------------------------------------------------------------------
# Row -> Lead reconstruction (used by --export-only)
# --------------------------------------------------------------------------
def row_to_lead(row: dict[str, Any], *, website: dict[str, Any] | None = None,
                advertising: dict[str, Any] | None = None) -> Lead:
    lead = Lead(
        lead_id=row["id"],
        company_name=row["company_name"] or "",
        trading_name=row.get("trading_name"),
        legal_name=row.get("legal_name"),
        niche=row.get("niche") or "",
        sub_niche=row.get("sub_niche"),
        description=row.get("description"),
        website=row.get("website"),
        domain=row.get("domain"),
        business_phone=row.get("business_phone"),
        business_email=row.get("business_email"),
        contact_name=row.get("contact_name"),
        contact_role=row.get("contact_role"),
        contact_source_url=row.get("contact_source_url"),
        address=row.get("address"),
        city=row.get("city"),
        postcode=row.get("postcode"),
        region=row.get("region"),
        country=row.get("country") or "UK",
        latitude=row.get("latitude"),
        longitude=row.get("longitude"),
        google_maps_url=row.get("google_maps_url"),
        facebook_url=row.get("facebook_url"),
        instagram_url=row.get("instagram_url"),
        linkedin_url=row.get("linkedin_url"),
        tiktok_url=row.get("tiktok_url"),
        youtube_url=row.get("youtube_url"),
        google_rating=row.get("google_rating"),
        google_review_count=row.get("google_review_count"),
        google_category=row.get("google_category"),
        google_place_id=row.get("google_place_id"),
        opening_hours=_load_json(row.get("opening_hours"), []),
        business_status=row.get("business_status"),
        company_number=row.get("company_number"),
        incorporation_date=row.get("incorporation_date"),
        years_in_operation=row.get("years_in_operation"),
        opportunities=_load_json(row.get("opportunities"), []),
        strengths=_load_json(row.get("strengths"), []),
        lead_reason=row.get("lead_reason") or "",
        recommended_service=row.get("recommended_service"),
        sources=_load_json(row.get("sources"), []),
        field_sources=_load_json(row.get("field_sources_json"), {}),
        search_locations=_load_json(row.get("search_locations"), []),
        date_discovered=row.get("date_discovered") or iso_now(),
        last_seen=row.get("last_seen") or iso_now(),
        last_checked=row.get("last_checked"),
        previous_score=row.get("previous_lead_score"),
    )
    lead.email_assessments = [
        EmailAssessment(**{k: v for k, v in payload.items() if k in EmailAssessment.__dataclass_fields__})
        for payload in _load_json(row.get("emails_json"), [])
    ]
    for record in _load_json(row.get("source_records"), []):
        lead.source_records.append(SourceRecord(**record))

    if row.get("lead_score") is not None:
        score = LeadScore(total=float(row["lead_score"]), band=row.get("score_band") or "")
        breakdown = None
        lead.score = score
        if breakdown:
            score.components = [ScoreComponent(**c) for c in breakdown]

    if website:
        payload = _load_json(website.get("raw_json"), {})
        if payload:
            lead.website_analysis = _website_from_payload(payload)
    if advertising:
        payload = _load_json(advertising.get("raw_json"), {})
        if payload:
            lead.advertising_analysis = _advertising_from_payload(payload)
    return lead


def _website_from_payload(payload: dict[str, Any]) -> WebsiteAnalysis:
    fields = WebsiteAnalysis.__dataclass_fields__
    nested = {"emails_found", "people_found"}
    kwargs = {k: v for k, v in payload.items() if k in fields and k not in nested}
    analysis = WebsiteAnalysis(**kwargs)
    analysis.emails_found = [
        EmailAssessment(**{k: v for k, v in item.items() if k in EmailAssessment.__dataclass_fields__})
        for item in payload.get("emails_found", [])
    ]
    analysis.people_found = [
        PersonMention(**{k: v for k, v in item.items() if k in PersonMention.__dataclass_fields__})
        for item in payload.get("people_found", [])
    ]
    return analysis


def _advertising_from_payload(payload: dict[str, Any]) -> AdvertisingAnalysis:
    fields = AdvertisingAnalysis.__dataclass_fields__
    kwargs = {
        k: v
        for k, v in payload.items()
        if k in fields and k not in {"appears_to_be_running_google_ads", "appears_to_be_running_meta_ads"}
    }
    analysis = AdvertisingAnalysis(**kwargs)
    analysis.appears_to_be_running_google_ads = Confidence(
        payload.get("appears_to_be_running_google_ads", "unknown")
    )
    analysis.appears_to_be_running_meta_ads = Confidence(
        payload.get("appears_to_be_running_meta_ads", "unknown")
    )
    return analysis


def lead_to_row(lead: Lead) -> dict[str, Any]:
    """Flatten a lead for ad-hoc exports/tests."""
    payload = asdict(lead)
    payload["lead_score"] = lead.lead_score
    return payload
