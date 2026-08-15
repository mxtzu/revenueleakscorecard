"""SQLite schema.

Design goals:

* one persistent row per business (``leads``), updated in place across runs;
* full history preserved - every run appends to ``lead_scores``,
  ``website_analysis`` and ``advertising_analysis`` rather than overwriting;
* provenance kept for every source that contributed (``lead_sources``,
  ``lead_field_provenance``);
* leads can be deleted (soft or hard) on request.
"""

from __future__ import annotations

SCHEMA_VERSION = 1

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS scrape_runs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at         TEXT NOT NULL,
    finished_at        TEXT,
    status             TEXT NOT NULL DEFAULT 'running',
    niches             TEXT,
    locations          TEXT,
    sources            TEXT,
    radius_km          REAL,
    country            TEXT,
    min_score          REAL,
    params_json        TEXT,
    discovered         INTEGER DEFAULT 0,
    duplicates_removed INTEGER DEFAULT 0,
    enriched           INTEGER DEFAULT 0,
    qualified          INTEGER DEFAULT 0,
    error_count        INTEGER DEFAULT 0,
    interrupted        INTEGER DEFAULT 0,
    notes              TEXT
);

CREATE TABLE IF NOT EXISTS locations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    raw           TEXT NOT NULL,
    city          TEXT,
    region        TEXT,
    postcode      TEXT,
    country       TEXT,
    latitude      REAL,
    longitude     REAL,
    radius_km     REAL,
    first_used_at TEXT,
    last_used_at  TEXT,
    UNIQUE (raw, country)
);

CREATE TABLE IF NOT EXISTS sources (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    kind          TEXT,
    attribution   TEXT,
    first_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS leads (
    id                         TEXT PRIMARY KEY,
    company_name               TEXT NOT NULL,
    normalized_name            TEXT,
    trading_name               TEXT,
    legal_name                 TEXT,
    niche                      TEXT,
    sub_niche                  TEXT,
    description                TEXT,
    website                    TEXT,
    domain                     TEXT,
    business_phone             TEXT,
    phone_key                  TEXT,
    business_email             TEXT,
    contact_name               TEXT,
    address                    TEXT,
    city                       TEXT,
    postcode                   TEXT,
    region                     TEXT,
    country                    TEXT,
    latitude                   REAL,
    longitude                  REAL,
    google_maps_url            TEXT,
    facebook_url               TEXT,
    instagram_url              TEXT,
    linkedin_url               TEXT,
    tiktok_url                 TEXT,
    youtube_url                TEXT,
    google_rating              REAL,
    google_review_count        INTEGER,
    google_category            TEXT,
    google_place_id            TEXT,
    opening_hours              TEXT,
    business_status            TEXT,
    company_number             TEXT,
    incorporation_date         TEXT,
    years_in_operation         REAL,
    lead_score                 REAL,
    previous_lead_score        REAL,
    score_band                 TEXT,
    website_quality_score      INTEGER,
    landing_page_quality_score INTEGER,
    advertising_status         TEXT,
    opportunities              TEXT,
    strengths                  TEXT,
    lead_reason                TEXT,
    recommended_service        TEXT,
    emails_json                TEXT,
    sources                    TEXT,
    field_sources_json         TEXT,
    search_locations           TEXT,
    date_discovered            TEXT,
    last_seen                  TEXT,
    last_checked               TEXT,
    times_seen                 INTEGER DEFAULT 1,
    deleted_at                 TEXT,
    delete_reason              TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_domain      ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_leads_place       ON leads(google_place_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone       ON leads(phone_key);
CREATE INDEX IF NOT EXISTS idx_leads_niche       ON leads(niche);
CREATE INDEX IF NOT EXISTS idx_leads_score       ON leads(lead_score);
CREATE INDEX IF NOT EXISTS idx_leads_city        ON leads(city);
CREATE INDEX IF NOT EXISTS idx_leads_deleted     ON leads(deleted_at);

CREATE TABLE IF NOT EXISTS lead_sources (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    source_id        INTEGER REFERENCES sources(id),
    source_name      TEXT NOT NULL,
    source_url       TEXT,
    source_record_id TEXT,
    retrieved_at     TEXT,
    payload_json     TEXT,
    UNIQUE (lead_id, source_name, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_sources_lead ON lead_sources(lead_id);

CREATE TABLE IF NOT EXISTS lead_field_provenance (
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    field       TEXT NOT NULL,
    source_name TEXT NOT NULL,
    observed_at TEXT,
    PRIMARY KEY (lead_id, field)
);

CREATE TABLE IF NOT EXISTS lead_run_appearances (
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    run_id      INTEGER NOT NULL REFERENCES scrape_runs(id) ON DELETE CASCADE,
    location_id INTEGER REFERENCES locations(id),
    seen_at     TEXT,
    PRIMARY KEY (lead_id, run_id)
);

CREATE TABLE IF NOT EXISTS website_analysis (
    id                         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id                    TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    run_id                     INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
    analysed_at                TEXT,
    website_exists             INTEGER,
    website_loads              INTEGER,
    final_url                  TEXT,
    http_status                INTEGER,
    ssl_enabled                INTEGER,
    mobile_friendly            INTEGER,
    page_speed_score           INTEGER,
    page_speed_source          TEXT,
    load_time_ms               REAL,
    page_bytes                 INTEGER,
    has_booking_system         INTEGER,
    has_online_booking         INTEGER,
    has_contact_form           INTEGER,
    has_phone_cta              INTEGER,
    has_primary_cta            INTEGER,
    has_pricing                INTEGER,
    has_testimonials           INTEGER,
    has_reviews                INTEGER,
    has_before_after           INTEGER,
    has_case_studies           INTEGER,
    has_finance_option         INTEGER,
    has_live_chat              INTEGER,
    has_tracking_pixel         INTEGER,
    has_google_analytics       INTEGER,
    has_meta_pixel             INTEGER,
    has_google_tag_manager     INTEGER,
    has_google_ads_tag         INTEGER,
    landing_page_quality_score INTEGER,
    website_quality_score      INTEGER,
    pages_checked              TEXT,
    service_pages              TEXT,
    missing_service_pages      TEXT,
    error                      TEXT,
    raw_json                   TEXT
);
CREATE INDEX IF NOT EXISTS idx_website_analysis_lead ON website_analysis(lead_id);

CREATE TABLE IF NOT EXISTS advertising_analysis (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id               TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    run_id                INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
    analysed_at           TEXT,
    google_ads_confidence TEXT,
    meta_ads_confidence   TEXT,
    ad_landing_page       TEXT,
    advertising_platform  TEXT,
    number_of_visible_ads INTEGER,
    creative_count        INTEGER,
    estimated_ad_activity TEXT,
    ad_quality_score      INTEGER,
    evidence              TEXT,
    sources               TEXT,
    raw_json              TEXT
);
CREATE INDEX IF NOT EXISTS idx_advertising_analysis_lead ON advertising_analysis(lead_id);

CREATE TABLE IF NOT EXISTS lead_scores (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id                TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    run_id                 INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
    scored_at              TEXT,
    total                  REAL,
    band                   TEXT,
    business_value         REAL,
    marketing_opportunity  REAL,
    paid_acquisition       REAL,
    credibility            REAL,
    outreach_accessibility REAL,
    breakdown_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_scores_lead ON lead_scores(lead_id);

CREATE TABLE IF NOT EXISTS lead_opportunities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    run_id      INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL,
    opportunity TEXT NOT NULL,
    created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_opportunities_lead ON lead_opportunities(lead_id);

CREATE TABLE IF NOT EXISTS errors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER REFERENCES scrape_runs(id) ON DELETE CASCADE,
    stage      TEXT,
    source     TEXT,
    target     TEXT,
    error_type TEXT,
    message    TEXT,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_errors_run ON errors(run_id);

CREATE TABLE IF NOT EXISTS checkpoints (
    run_key      TEXT NOT NULL,
    lead_id      TEXT NOT NULL,
    stage        TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (run_key, lead_id, stage)
);
"""

LEAD_COLUMNS = [
    "id", "company_name", "normalized_name", "trading_name", "legal_name", "niche", "sub_niche",
    "description", "website", "domain", "business_phone", "phone_key", "business_email",
    "contact_name", "address", "city", "postcode", "region", "country", "latitude", "longitude",
    "google_maps_url", "facebook_url", "instagram_url", "linkedin_url", "tiktok_url", "youtube_url",
    "google_rating", "google_review_count", "google_category", "google_place_id", "opening_hours",
    "business_status", "company_number", "incorporation_date", "years_in_operation", "lead_score",
    "previous_lead_score", "score_band", "website_quality_score", "landing_page_quality_score",
    "advertising_status", "opportunities", "strengths", "lead_reason", "recommended_service",
    "emails_json", "sources", "field_sources_json", "search_locations", "date_discovered",
    "last_seen", "last_checked", "times_seen", "deleted_at", "delete_reason",
]
