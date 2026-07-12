"""Central configuration for the ASCEND lead pipeline.

All thresholds mirror the source workbook's Scoring Rubric and the task's
qualification filters. Nothing here fabricates data; these are the discovery
floor, the hard revenue ceiling, and the transparent revenue heuristic.
"""
from __future__ import annotations

TARGET_LEADS = 1000

# ---- Qualification filters (all must pass) -------------------------------
MIN_VISITS = 5_000_000          # A. size fit, hard floor
MIN_CCU = 100                   # B. current activity, hard floor
MAX_UPDATE_AGE_DAYS = 365       # C. recency hard cut
BEST_UPDATE_AGE_DAYS = 45       # C. recency scores best
MIN_PUBLIC_PASSES = 1           # D. monetization surface, hard floor

# Exclusion ceilings (mirror the workbook Exclusions logic)
MEGA_VISITS = 1_000_000_000     # >1B visits => mega, drop
MEGA_CCU = 50_000               # >50K CCU  => mega, drop

# ---- Revenue band (HARD FILTER F) ----------------------------------------
# Only rows whose estimated monthly-revenue MIDPOINT falls in this USD band
# are included.
REV_BAND_LOW = 5_000
REV_BAND_HIGH = 20_000

# ---- Revenue heuristic (transparent, conservative) -----------------------
# Robux -> USD at the standard DevEx rate ($0.0035 per earned Robux, 2024-2026).
DEVEX_USD_PER_ROBUX = 0.0035
# ARPDAU expressed in Robux per concurrent user per day, banded by genre
# monetization intensity. These are documented planning heuristics, NOT
# measured values; every row records the basis and a range, never false
# precision. Tune per real cohort data before relying on the point estimate.
BASE_ARPDAU_ROBUX_PER_CCU = 9.0     # low end of band, per CCU per day
GENRE_INTENSITY = {
    "simulator": 1.35, "tycoon": 1.25, "rpg": 1.30, "anime": 1.30,
    "fighting": 1.15, "horror": 1.05, "survival": 1.10,
    "progression rp": 1.20, "roleplay": 1.00, "sports": 1.05,
    "strategy": 1.10, "trading": 1.40, "economy": 1.40,
    "tower defense": 1.20, "obby": 0.80, "default": 1.0,
}
# Pass-catalogue richness nudges the estimate: more public passes + a wider
# price ladder implies more monetization surface. Applied as a small multiplier.
PASS_RICHNESS_STEP = 0.03           # per public pass, capped
PASS_RICHNESS_CAP = 0.45
# Uncertainty band half-width applied to the point estimate (+/-).
REV_BAND_HALFWIDTH = 0.35

# ---- Genres considered a fit (filter E) ----------------------------------
FIT_GENRES = {
    "simulator", "tycoon", "rpg", "anime", "fighting", "horror",
    "survival", "progression rp", "roleplay", "sports", "strategy",
    "trading", "economy", "tower defense", "action", "battlegrounds",
}

# ---- Discovery: explore sorts + keyword matrix ---------------------------
EXPLORE_SORTS = [
    "top-playing-now", "top-rated", "up-and-coming", "recommended",
    "top-earning", "popular-nearby",
]

GENRE_TERMS = [
    "simulator", "tycoon", "tower defense", "rng", "obby", "rpg", "anime",
    "fighting", "horror", "survival", "sports", "racing", "strategy",
    "trading", "gacha", "incremental", "clicker", "pet", "farming",
    "mining", "restaurant", "roleplay",
]
LIVEOPS_TERMS = [
    "codes", "update", "boost", "x2", "luck", "rebirth", "season", "pass",
    "crate", "egg", "aura", "index", "event",
]
AUDIENCE_TERMS = ["clan", "guild", "pvp", "grind", "endgame"]
# Non-English variants (pt-BR, es, ru, tr, id) — under-served operator segment.
INTL_TERMS = [
    "simulador", "simulateur", "juego de", "aventura", "guerra",
    "симулятор", "аниме", "выживание", "savaş", "hayatta kalma",
    "petualangan", "simulasi",
]

# ---- HTTP politeness ------------------------------------------------------
REQUEST_TIMEOUT = 20
MAX_RETRIES = 5
BACKOFF_BASE = 2.0        # seconds: 2,4,8,16,32
CONCURRENCY = 4           # keep low; respect rate limits
USER_AGENT = "ASCEND-lead-research/1.0 (public-data; contact ops@ascend.example)"

# ---- Files ----------------------------------------------------------------
SOURCE_WORKBOOK = "ASCEND_Leads__IMPORTANT_.xlsx"   # dedup source (place beside run.py)
EXCLUSIONS_JSON = "exclusions.json"                  # baked keys from the source workbook
CHECKPOINT_DIR = "checkpoints"
OUTPUT_XLSX = "ASCEND_Leads__NEW_1000.xlsx"
