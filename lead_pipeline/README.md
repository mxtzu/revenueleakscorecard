# Local Business Lead Pipeline

Finds, enriches, deduplicates, scores and exports local businesses that are
plausible clients for three services:

1. High-converting landing pages
2. Google Ads management
3. Meta Ads management

It is a **lead research and enrichment system**. It does not send anything to
anyone — no email, no messages, no form fills. Output is a scored, evidenced
list you review before doing outreach yourself.

```
discover → deduplicate → enrich → analyse ads → score → persist → export
```

---

## Contents

- [Quick start](#quick-start)
- [Installation](#installation)
- [API keys and `.env`](#api-keys-and-env)
- [Running the pipeline](#running-the-pipeline)
- [CLI reference](#cli-reference)
- [What gets collected](#what-gets-collected)
- [Lead scoring](#lead-scoring)
- [Advertising intelligence and confidence levels](#advertising-intelligence-and-confidence-levels)
- [Deduplication](#deduplication)
- [Email policy](#email-policy)
- [Output formats](#output-formats)
- [Database structure](#database-structure)
- [Extending: niches, sources, scoring weights](#extending)
- [Performance and politeness](#performance-and-politeness)
- [Compliance](#compliance)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
cd lead_pipeline
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # set CONTACT_EMAIL at minimum

# Offline demo - no API keys, no network, uses the bundled sample dataset
python pipeline.py --niche invisalign_dental_practices \
                   --location "Newcastle upon Tyne" \
                   --fixture fixtures/sample_businesses.json --source fixture \
                   --no-analyse-websites --no-analyse-ads --min-score 0

# Real run with no API keys at all (OpenStreetMap discovery + website analysis)
python pipeline.py --niche roofers --location "Sunderland" --radius 25 --source openstreetmap

# Best quality (needs GOOGLE_PLACES_API_KEY)
python pipeline.py --niche roofers --location "Sunderland" --radius 25 --min-score 70
```

Check what is available before a run:

```bash
python pipeline.py --list-sources
python pipeline.py --list-niches
```

---

## Installation

**Python 3.10 or newer** (developed and tested on 3.11).

```bash
pip install -r requirements.txt
```

| Dependency | Why | Required? |
| --- | --- | --- |
| `aiohttp` | async HTTP transport | Yes for live runs |
| `beautifulsoup4` | HTML parsing for website analysis | Recommended (a stdlib parser fallback exists) |
| `python-dotenv` | `.env` loading | Optional (stdlib fallback built in) |
| `pytest`, `pytest-asyncio` | test suite | Dev only |

Everything else — scoring, dedupe, database, exports, rate limiting, caching —
is standard library.

---

## API keys and `.env`

**No key is required to run.** Each source reports itself unavailable when its
credential is missing and the run continues with whatever is left.

Copy `.env.example` to `.env` and fill in what you have. Keys are read from the
environment only — nothing is ever hard-coded, and `.env` is git-ignored.

| Variable | Unlocks | Get it from |
| --- | --- | --- |
| `CONTACT_EMAIL` | Identifies you in the User-Agent (required by the OSM usage policy) | — |
| `GOOGLE_PLACES_API_KEY` | `google_places` source: ratings, review counts, phone, website, hours | Google Cloud Console → Places API (New) |
| `BING_MAPS_API_KEY` | `bing_places` source | Bing Maps Dev Center |
| `SERPAPI_API_KEY` | `search` source **and** *confirmed* Google Ads detection (real paid results) | serpapi.com |
| `BRAVE_SEARCH_API_KEY` | `search` source | brave.com/search/api |
| `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` | `search` source | Google Programmable Search |
| `COMPANIES_HOUSE_API_KEY` | Legal name, company number, incorporation date (UK) | developer.company-information.service.gov.uk |
| `META_AD_LIBRARY_TOKEN` | *Confirmed* Meta ads where the Ad Library covers the market | Meta for Developers |
| `PAGESPEED_API_KEY` | Real Lighthouse mobile score instead of the heuristic estimate | Google Cloud Console → PageSpeed Insights API |

Politeness, caching, storage and scoring defaults are also configurable via
`.env` — see the comments in `.env.example`.

---

## Running the pipeline

```bash
# Single niche, single location
python pipeline.py --niche cosmetic_dentists --location "Newcastle" --radius 30

# Only high scorers
python pipeline.py --niche roofers --location "Sunderland" --radius 25 --min-score 70

# Every configured niche across one area
python pipeline.py --all-niches --location "Newcastle" --radius 50

# Many locations from a CSV
python pipeline.py --input fixtures/locations.csv --niche solar_installers

# Postcode / coordinates / multiple locations
python pipeline.py --niche builders --location "NE1 6EE" --radius 15
python pipeline.py --niche builders --location "54.9783,-1.6178" --radius 20
python pipeline.py --niche builders --location "Leeds" --location "York"

# Re-export what is already stored, with no network access
python pipeline.py --export-only --niche roofers --min-score 70 --format csv,json
```

`locations.csv` accepts the minimal form from the brief:

```csv
location
Sunderland
Newcastle upon Tyne
Durham
```

…and a richer form: `location,region,country,radius_km,latitude,longitude`.

### What a run prints

```
==============================================================
SCRAPE COMPLETE
==============================================================
Businesses discovered: 427
Duplicates removed:    83
Businesses enriched:   301
Qualified leads:       147
  Score 80-100: 24
  Score 70-79: 43
  Score 60-69: 80
Errors (non-fatal):    12 (timeout x7, robots_disallowed x3, dns x2)
HTTP: 940 requests, 210 cache hits, 18 retries, 12 failures, 3 robots-blocked

Top opportunities:
1. Example Dental Clinic
   Score: 94
   Location: Newcastle
   Rating: 4.8
   Reviews: 237
   Opportunity: Google Ads detected but paid traffic lands on a generic homepage
   Recommended: Landing Page + Google Ads management (fix the destination, then the account)
```

---

## CLI reference

**Targeting**

| Flag | Meaning |
| --- | --- |
| `--niche NAME` | Niche key or alias, repeatable, comma-separated allowed |
| `--all-niches` | Run every configured niche |
| `--location VALUE` | City, town, postcode or `lat,lon`; repeatable |
| `--input FILE.csv` | Locations CSV |
| `--radius KM` | Search radius (default 25) |
| `--country NAME` | Country for geocoding and phone formatting (default UK) |
| `--region NAME` | Region/county hint applied to every location |

**Pipeline behaviour**

| Flag | Meaning |
| --- | --- |
| `--source NAME` | Restrict to sources: `google_places`, `bing_places`, `openstreetmap`, `search`, `directory`, `companies_house`, `fixture` |
| `--fixture PATH` | Local JSON/CSV of businesses (offline runs, imports) |
| `--min-score N` | Qualification threshold (default 60) |
| `--limit N` | Max businesses per niche+location query (default 60) |
| `--total-limit N` | Hard cap on leads processed after dedupe |
| `--analyse-websites` / `--no-analyse-websites` | Website fetching + analysis (default on) |
| `--analyse-ads` / `--no-analyse-ads` | Advertising analysis (default on) |
| `--recheck-days N` | Skip re-enriching leads checked within N days (default 14) |
| `--no-resume` | Ignore checkpoints and re-enrich everything |
| `--concurrency N` | Global concurrent request cap (default 12) |
| `--rate N` | Default per-host requests/second (default 1.0) |
| `--no-cache` | Bypass the HTTP cache for this run |
| `--dry-run` | Run without writing to the database |

**Output**

| Flag | Meaning |
| --- | --- |
| `--output DIR` | Output directory (default `./output`) |
| `--format FMT` | `csv`, `json`, `jsonl`, `sqlite`, `all`; repeatable or comma-separated |
| `--basename NAME` | Base filename for exports |
| `--audit-text` | Also write human-readable audit briefs as `.txt` |
| `--include-raw` | Include raw source payloads in the JSON export |
| `--top N` | How many top leads to print (default 10) |

**Configuration and admin**

| Flag | Meaning |
| --- | --- |
| `--db PATH` | SQLite database (default `./leads.sqlite`) |
| `--cache-dir DIR` | HTTP cache directory |
| `--env-file PATH` | Explicit `.env` |
| `--niches-file` / `--weights-file` | Override the config JSON files |
| `--log-level` / `--log-file` / `--quiet` | Logging (file logs are JSON lines) |
| `--list-niches` / `--list-sources` / `--db-stats` / `--list-runs` | Info commands |
| `--export-only` | Export stored leads without scraping |
| `--delete-lead ID` | Soft-delete (hides the lead, scrubs contact fields) |
| `--purge-lead ID` | Hard-delete the lead and every dependent record |

---

## What gets collected

**Company** — `company_name`, `trading_name`, `legal_name`, `niche`,
`sub_niche`, `description`, `website`, `domain`, `business_phone`,
`business_email`, `address`, `city`, `postcode`, `region`, `country`,
`latitude`, `longitude`.

**Online presence** — `website`, `google_maps_url`, `facebook_url`,
`instagram_url`, `linkedin_url`, `tiktok_url`, `youtube_url`.

**Google / local** — `google_rating`, `google_review_count`, `google_category`,
`google_place_id`, `google_maps_url`, `opening_hours` (Places API only).

**Website analysis** — `website_exists`, `website_loads`, `mobile_friendly`,
`page_speed_score`, `ssl_enabled`, `has_booking_system`, `has_contact_form`,
`has_phone_cta`, `has_primary_cta`, `has_pricing`, `has_testimonials`,
`has_reviews`, `has_before_after`, `has_case_studies`, `has_finance_option`,
`has_online_booking`, `has_live_chat`, `has_tracking_pixel`,
`has_google_analytics`, `has_meta_pixel`, `has_google_tag_manager`,
`landing_page_quality_score`, plus `website_quality_score`, discovered service
pages, missing service pages, niche keyword coverage, CMS, booking/chat
providers and the pages checked.

`page_speed_score` is a heuristic (load time, payload size, script and image
counts) unless `PAGESPEED_API_KEY` is set, in which case it is a real
Lighthouse mobile score. The field `page_speed_source` records which.

**Every value keeps its source.** `field_sources` maps each field to the source
that produced it, `sources` lists every contributing source, and
`source_provenance` records each source record with its URL and retrieval time.

---

## Lead scoring

A 0–100 score built from five categories. Each category accumulates raw points
that are rescaled to the caps in `config/scoring_weights.json`.

| Category | Default cap | Rewards |
| --- | --- | --- |
| Business value | 25 | High-ticket niche, premium positioning, multiple locations, scale/ability-to-pay signals |
| Marketing opportunity | 25 | Missing service pages, weak/absent CTA, poor mobile, no booking, no tracking, weak social proof, slow site, thin copy, low landing-page score |
| Paid acquisition opportunity | 20 | Search demand, auction competitiveness, service value, weak or badly-routed advertising, keyword gaps |
| Business credibility | 15 | Review volume, rating, website quality, years since incorporation |
| Outreach accessibility | 15 | Public business email, phone, contact form, active social profiles, publicly listed contact |

Every component carries the evidence behind its points. In the JSON export:

```json
{
  "name": "marketing_opportunity",
  "points": 17.0,
  "max_points": 25.0,
  "reasons": [
    "Missing dedicated pages for Teeth straightening, Free consultation (+4.0)",
    "No click-to-call phone CTA (+2.0)",
    "No analytics or advertising pixels detected (+4.0)"
  ]
}
```

Alongside the score each lead gets:

- `opportunities` — specific, observed problems usable in outreach
- `strengths` — what they already do well
- `lead_reason` — one grounded sentence
- `recommended_service` — which of the three offers fits the evidence
- an **audit record**: company, website, niche, location, score, what they do
  well, top 3 problems, biggest opportunity, recommended service, why they are
  a good prospect (exported to `*_audit.csv`, the JSON, and optionally
  `*_audit.txt`)

Niche-specific rules live in `config/niches.json`: each vertical declares its
service keywords, premium/trust/conversion/finance signals and its **money
pages** (the high-intent pages a serious advertiser should own — e.g.
Invisalign, Emergency roofing, Resin driveways, Savings calculator). Missing
money pages are the most common finding.

---

## Advertising intelligence and confidence levels

Advertising is reported with an explicit confidence level. Nothing is upgraded
beyond what the source supports.

| Value | Means |
| --- | --- |
| `confirmed` | A live ad was returned by an ads API (SerpAPI paid results, Meta Ad Library) for this business |
| `likely` | Conversion-grade tracking installed (Google Ads `AW-` tag, Meta Pixel `init`) — strong but indirect |
| `possible` | Only generic analytics/tag manager, or an unattributable fingerprint |
| `not_detected` | The site loaded and contained none of the above |
| `unknown` | We could not observe the site (no site, blocked by robots.txt, error) |

Fields: `appears_to_be_running_google_ads`, `appears_to_be_running_meta_ads`,
`ad_landing_page`, `advertising_platform`, `number_of_visible_ads`,
`creative_count`, `estimated_ad_activity` (`none`/`low`/`moderate`/`high`/
`unknown`), `ad_quality_score` (only when an ad was actually seen), plus an
`evidence` list.

Coverage caveat: the Meta Ad Library API does not expose every ad in every
market. A negative result means *not detected*, never *not advertising*.

---

## Deduplication

Two passes over every discovered record:

1. **Exact blocking keys** — Google Place ID, registrable domain, phone
   (E.164, last 9 digits), address + postcode, normalized name + locality.
   Address and name+locality merges are refused when the two records
   contradict each other on a strong identifier (different domains, different
   place IDs, different phones) — two businesses can share a building.
2. **Fuzzy names** — within a postcode/city bucket, normalized-name similarity
   above the threshold merges *only* when a second signal corroborates it.

Merging keeps everything: the surviving lead lists every contributing source,
every source record, and the source of each individual field.

```json
{ "sources": ["google_places", "company_website", "companies_house"] }
```

Names are normalized before comparison (legal suffixes, punctuation, accents
and `&`/`and` all collapse), so `The Smile Studio (Newcastle) Ltd.` and
`Smile Studio Newcastle` match.

---

## Email policy

Only addresses **observed verbatim** on a public page are recorded — none are
ever guessed or constructed.

| Category | Example | Outreach |
| --- | --- | --- |
| `generic_business` | `info@`, `hello@`, `enquiries@`, `sales@`, `bookings@`, `office@` | ✅ |
| `role_based` | `accounts@`, `support@`, `marketing@` | ✅ |
| `company_domain` | other address on the business's own domain | ✅ |
| `free_provider_business` | `info@gmail.com` published as the business contact | ✅ |
| `named_individual` | `sarah.jones@` | ❌ by default |
| `blocked` / `invalid` | placeholders, tooling addresses, bad syntax | ❌ |

Named-individual addresses are captured with the flag
`accept_for_outreach: false` and excluded from `business_email`. Set
`ALLOW_NAMED_CONTACT_EMAILS=true` only where you have a lawful basis to contact
a named person at a business; even then, only addresses on the company's own
domain are accepted.

**The pipeline never sends email.**

---

## Output formats

Written to `--output` (default `./output`), named `<basename>.<ext>`.

**CSV** — exactly these columns:

```
company_name, niche, sub_niche, website, phone, email, address, city, postcode,
google_rating, google_review_count, website_quality_score,
landing_page_quality_score, lead_score, advertising_status, opportunities,
lead_reason, google_maps_url, facebook_url, instagram_url, linkedin_url,
source, date_discovered
```

A companion `<basename>_audit.csv` carries the personalisation briefs.

**JSON** — one document with run metadata, complete structured lead records
(including full website/advertising analysis and the score breakdown) and the
audit records. `--include-raw` adds the raw source payloads. `jsonl` writes one
lead per line.

**SQLite** — a portable single file containing just the exported leads
(`leads`, `website_analysis`, `advertising_analysis`, `lead_scores`,
`audit_records`). This is separate from the persistent database.

---

## Database structure

`leads.sqlite` (override with `--db` / `DB_PATH`) persists between runs.

| Table | Contents |
| --- | --- |
| `leads` | One row per business, updated in place. Keeps `date_discovered`, `last_seen`, `last_checked`, `times_seen`, `lead_score`, `previous_lead_score`, `deleted_at` |
| `lead_sources` | Every source record that contributed, with URL and retrieval time |
| `lead_field_provenance` | Which source produced each individual field |
| `lead_run_appearances` | Which runs saw which leads |
| `website_analysis` | One row per analysis (append-only history) |
| `advertising_analysis` | One row per analysis (append-only history) |
| `lead_scores` | One row per scoring event — full score history |
| `lead_opportunities` | Opportunities per lead per run |
| `scrape_runs` | Run parameters, counters, status, interruption flag |
| `errors` | Every non-fatal failure with stage, source, target and type |
| `locations` | Every location searched, with resolved coordinates |
| `sources` | Registered sources and their attribution |
| `checkpoints` | Completed enrichment per run key (resume support) |

Re-running the same business updates the row: `date_discovered` is preserved,
`previous_lead_score` captures the last score, `last_seen` and `times_seen`
advance, and null values never overwrite known data. A lead checked within
`--recheck-days` reuses its stored analyses instead of re-fetching, and the run
summary says so.

Useful queries:

```sql
-- Score movement over time
SELECT l.company_name, s.scored_at, s.total
FROM lead_scores s JOIN leads l ON l.id = s.lead_id
ORDER BY l.company_name, s.scored_at;

-- Best untouched prospects
SELECT company_name, city, lead_score, lead_reason
FROM leads WHERE deleted_at IS NULL AND lead_score >= 75
ORDER BY lead_score DESC;

-- What failed in the last run
SELECT stage, error_type, COUNT(*) FROM errors
WHERE run_id = (SELECT MAX(id) FROM scrape_runs) GROUP BY 1, 2;
```

**Deleting leads** (data-subject or client request):

```bash
python pipeline.py --delete-lead <id>   # soft: hidden everywhere, contact fields scrubbed
python pipeline.py --purge-lead  <id>   # hard: row and all dependent records removed
```

---

## Extending

### Add a niche

Edit `config/niches.json` — **no code changes needed**:

```json
"wedding_photographers": {
  "label": "Wedding photographers",
  "aliases": ["wedding photography", "photographer"],
  "search_terms": ["wedding photographer", "wedding photography studio"],
  "google_place_types": ["photographer"],
  "osm_filters": ["nwr[\"shop\"=\"photo\"]", "nwr[\"craft\"=\"photographer\"]"],
  "ticket_value": 7,
  "search_demand": 7,
  "competition": 6,
  "service_keywords": ["wedding photography", "engagement shoot", "albums"],
  "premium_keywords": ["luxury", "destination weddings", "award winning"],
  "trust_keywords": ["portfolio", "real weddings", "testimonial"],
  "conversion_keywords": ["check availability", "book a call", "enquire now"],
  "finance_keywords": ["payment plan", "deposit"],
  "money_pages": [
    { "name": "Portfolio", "keywords": ["portfolio", "real weddings"], "url_hints": ["portfolio"] },
    { "name": "Pricing",   "keywords": ["pricing", "packages"],        "url_hints": ["pricing", "packages"] }
  ],
  "recommended_service": "Portfolio Landing Page + Meta Ads"
}
```

`ticket_value`, `search_demand` and `competition` are 1–10 analyst estimates
that feed Business value and Paid acquisition. `money_pages` drive
"no dedicated X page" findings and sub-niche detection. Verify with
`python pipeline.py --list-niches`.

Use `--niches-file other.json` (or `NICHES_PATH`) to keep a private niche set
outside the repo.

### Add a data source

1. Create `sources/my_source.py`:

```python
from .base import BaseSource, SearchQuery, SourceContext

class MySource(BaseSource):
    name = "my_source"
    kind = "discovery"
    description = "What it returns"
    attribution = "Data provider name"
    requires_credentials = ("my_source_api_key",)   # attribute name on Settings

    async def search(self, query: SearchQuery, ctx: SourceContext):
        payload = await ctx.client.get_json(
            "https://api.example.com/search",
            params={"q": query.terms()[0], "near": query.location.query_string()},
            check_robots=False,          # False only for authorised API endpoints
            cache_ttl=self.settings.cache_ttl_seconds,
        )
        for item in payload.get("results", []):
            yield self.make_record(
                {"company_name": item["name"], "website": item.get("url"),
                 "business_phone": item.get("phone"), "address": item.get("address")},
                source_url=item.get("url"),
                source_record_id=str(item["id"]),
                raw=item,
            )
```

2. Add `my_source_api_key: str | None = None` to `Settings` and read it in
   `Settings.from_env` (plus a line in `.env.example`).
3. Register the class in `sources/__init__.py` (`SOURCE_CLASSES`, and
   `DEFAULT_DISCOVERY_ORDER` if it should run by default).
4. Optionally add its trust rank to `DEFAULT_SOURCE_PRIORITY` in
   `utils/deduplication.py` — lower numbers win field conflicts.

The rest of the pipeline (dedupe, enrichment, scoring, export) needs no change.
Use `sources/fixture.py` as the simplest reference implementation and
`sources/google_places.py` for a full API adapter.

For an HTML directory you are permitted to crawl, you do not need code at all —
add an entry to `config/directories.json` (format documented in that file).
The adapter always checks robots.txt and stops on any anti-bot challenge.

### Change scoring weights

Edit `config/scoring_weights.json`:

```json
{ "weights": { "business_value": 15, "marketing_opportunity": 40,
               "paid_acquisition": 20, "credibility": 10,
               "outreach_accessibility": 15 } }
```

Each category's raw points are rescaled to its cap, so totals stay on 0–100 as
long as the caps sum to 100. Use `--weights-file` for a per-run variant. To
change *how* points are earned rather than their weight, edit the component
methods in `scoring/lead_score.py` — each one is small and independently
testable.

---

## Performance and politeness

- **Async throughout** with a global concurrency cap (`--concurrency`) and a
  per-host cap (`PER_HOST_CONCURRENCY`, default 2).
- **Per-host token-bucket rate limiting** (default 1 req/s), lowered
  automatically by a robots.txt `Crawl-delay` or a sustained 429.
- **HTTP caching** in SQLite (default 7 days) — a repeat run inside the TTL
  performs zero network requests.
- **Retries** on timeouts, connection/DNS errors and 408/429/5xx, with
  exponential backoff, jitter and `Retry-After` support.
- **Page budget** of `MAX_PAGES_PER_SITE` (default 6) per business: homepage
  plus the highest-value internal pages only.
- **Checkpointing** — completed enrichment is recorded per run key, and leads
  checked within `--recheck-days` are skipped.
- **Graceful interruption** — Ctrl-C once drains in-flight work, persists and
  exports partial results, and marks the run `interrupted`; twice aborts.
- **Failure isolation** — one bad site, source or API call is recorded in
  `errors` and the run continues.
- **Structured logging** — human-readable console, JSON lines to `--log-file`.

---

## Compliance

Built-in behaviour:

- Public business information only; official APIs preferred over scraping.
- `robots.txt` is fetched, cached and honoured for every website and directory
  fetch, including `Crawl-delay`. A disallowed host is skipped and recorded —
  and never retried via a `www.` variant.
- Authorised API endpoints (Google Places, Bing, Overpass, Nominatim,
  Companies House, PageSpeed, search APIs) are called under their own terms
  rather than robots.txt, and only with the credentials you supply.
- **No CAPTCHA solving, no authentication bypass, no paywall bypass.** The
  directory adapter aborts the moment it sees a challenge page.
- No private accounts, no social-network scraping — social presence is derived
  from links the business publishes itself.
- Rate limits and concurrency caps on by default.
- No sensitive personal data. Companies House officer/PSC endpoints (personal
  data) are deliberately not called; only company-level registry fields are read.
- Named-individual emails excluded from outreach by default.
- Every data point keeps its source; every run keeps its errors.
- Leads can be deleted (soft or hard) at any time.
- **Nothing is ever sent to a lead.**

Your responsibilities:

- Set `CONTACT_EMAIL` so your crawler is identifiable (required by the OSM
  usage policy, and good practice everywhere).
- Check the terms of any directory before enabling it in
  `config/directories.json`.
- Google Maps Platform terms restrict caching and display of Places content —
  review them before retaining or publishing Google-sourced fields.
- OpenStreetMap data is ODbL: attribute "© OpenStreetMap contributors".
- Under UK GDPR/PECR, B2B outreach still needs a lawful basis, accurate
  records, and an honoured opt-out. Keep your suppression list outside this
  tool and delete leads on request.
- `--ignore-robots` exists for sites you own or have written permission to
  crawl. It prints a warning. Do not use it otherwise.

---

## Testing

```bash
cd lead_pipeline
python -m pytest              # 320 tests, ~20s, fully offline
python -m pytest -v tests/test_scoring.py
```

The suite runs with no network access: HTTP goes through a fake transport and
the clock is injected for rate-limit tests. Coverage by area:

| File | Covers |
| --- | --- |
| `test_normalization.py` | Company names, phones, URLs, postcodes, addresses, fuzzy matching |
| `test_deduplication.py` | Blocking keys, fuzzy merges, contradiction refusal, cross-source provenance |
| `test_scoring.py` | Score shape and direction, weight overrides, all 10 niches, opportunities, lead reasons, audit records |
| `test_database.py` | Insert/update, history preservation, provenance, runs, errors, checkpoints, soft/hard delete, round-trip |
| `test_exporters.py` | CSV columns and escaping, JSON structure, SQLite export, format selection |
| `test_http.py` | Timeouts, DNS/SSL failures, retries and backoff, `Retry-After`, caching, robots.txt, API failures |
| `test_rate_limit.py` | Token bucket, per-host rates, crawl-delay, concurrency caps |
| `test_website_analysis.py` | Signal extraction, tracking detection, dead sites, robots-blocked sites, page budget |
| `test_ads_and_social.py` | Confidence grading, SERP-confirmed ads, social canonicalisation, review bands |
| `test_email_validation.py` | Syntax, categories, named-individual policy, extraction |
| `test_sources.py` | Every adapter: parsing, availability, API failure handling |
| `test_geo.py` | Location parsing, CSV loading, distance, geocoding |
| `test_cli.py` | Argument handling, info commands, admin commands, a full offline CLI run |
| `test_end_to_end.py` | Full pipeline over a small dataset including a dead site and a robots-blocked site |

---

## Troubleshooting

**"No usable data sources"** — every requested source is missing its
credential. Run `python pipeline.py --list-sources`. With no keys at all, use
`--source openstreetmap` (needs no key) or `--fixture PATH`.

**Zero results from OpenStreetMap** — OSM coverage of trades is patchy, and the
source needs coordinates. Check that geocoding worked (`--log-level DEBUG`),
widen `--radius`, or add tag filters to the niche's `osm_filters`.

**Geocoding fails / Nominatim errors** — set `CONTACT_EMAIL`; Nominatim rejects
unidentified clients and allows only 1 req/s. Or pass coordinates directly:
`--location "54.9783,-1.6178"`.

**Google Places returns 403** — the Places API (New) is not enabled on the key,
billing is off, or a key restriction is blocking the call. The error is recorded
in the `errors` table with the message.

**Everything scores low** — websites were probably not analysed (all the
opportunity signals come from there). Check `--analyse-websites` is on and look
for `timeout`/`dns` entries in the `errors` table.

**Second run does nothing / makes no requests** — leads were checked within
`--recheck-days` and reused their stored analyses (the summary says so). Use
`--no-resume` or `--recheck-days 0` to force a re-check, and `--no-cache` to
bypass the HTTP cache.

**Run is slow** — raise `--concurrency` and `--rate` (stay polite), keep the
cache on, and lower `MAX_PAGES_PER_SITE`. Most time is spent waiting on other
people's servers.

**`aiohttp` not installed** — `pip install -r requirements.txt`. The scoring,
dedupe, database and export layers work without it; live fetching does not.

**Robots-blocked sites** — expected and correct. They appear in the summary as
`robots-blocked` and their leads carry `error_kind: robots_disallowed` with
`unknown` advertising confidence.

**Interrupted run** — Ctrl-C once saves and exports partial results; the run is
recorded with `status = interrupted`. Re-running resumes from checkpoints.
