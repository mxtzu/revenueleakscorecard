"""Configuration loading: environment settings, niche rules, scoring weights.

Credentials are read from the environment (optionally seeded from a ``.env``
file). Nothing is ever hard-coded — every key defaults to ``None`` and the
sources that need it simply report themselves as unavailable.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable, Mapping

PACKAGE_ROOT = Path(__file__).resolve().parent
CONFIG_DIR = PACKAGE_ROOT / "config"
DEFAULT_NICHES_PATH = CONFIG_DIR / "niches.json"
DEFAULT_WEIGHTS_PATH = CONFIG_DIR / "scoring_weights.json"
DEFAULT_DIRECTORIES_PATH = CONFIG_DIR / "directories.json"


# --------------------------------------------------------------------------
# .env loading
# --------------------------------------------------------------------------
def load_dotenv(path: str | os.PathLike[str] | None = None, override: bool = False) -> dict[str, str]:
    """Load a ``.env`` file into ``os.environ``.

    Uses ``python-dotenv`` when installed and falls back to a small parser so
    the pipeline still works in minimal environments.
    """
    candidates: list[Path]
    if path is not None:
        candidates = [Path(path)]
    else:
        candidates = [Path.cwd() / ".env", PACKAGE_ROOT / ".env", PACKAGE_ROOT.parent / ".env"]

    loaded: dict[str, str] = {}
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:  # pragma: no cover - trivial import branch
            from dotenv import dotenv_values  # type: ignore

            values = {k: v for k, v in dotenv_values(candidate).items() if v is not None}
        except Exception:
            values = _parse_env_file(candidate)
        for key, value in values.items():
            loaded[key] = value
            if override or key not in os.environ:
                os.environ[key] = value
        break
    return loaded


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.lower().startswith("export "):
            line = line[7:]
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    try:
        return int(raw) if raw is not None else default
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    try:
        return float(raw) if raw is not None else default
    except ValueError:
        return default


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
@dataclass
class Settings:
    """Runtime settings. Everything is overridable by env var or CLI flag."""

    # --- credentials (all optional) ---
    google_places_api_key: str | None = None
    bing_maps_api_key: str | None = None
    serpapi_api_key: str | None = None
    brave_search_api_key: str | None = None
    google_cse_api_key: str | None = None
    google_cse_cx: str | None = None
    companies_house_api_key: str | None = None
    meta_ad_library_token: str | None = None
    pagespeed_api_key: str | None = None

    # --- endpoints (switchable to a mirror without touching code) ---
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    #: Execution budget declared inside the Overpass query.
    overpass_query_timeout: int = 60
    #: How long to wait for a response. Overpass queues requests when all
    #: execution slots are busy, and that queue time is on top of the
    #: execution budget - so this must be generously larger, or every
    #: request during a busy period is abandoned before it ever runs.
    overpass_http_timeout: int = 180

    # --- identification / politeness ---
    # Short and conventional. Long parenthetical agents - especially ones
    # carrying a URL - are a common trigger for WAF rules that reject the
    # request outright. CONTACT_EMAIL is appended when set.
    user_agent: str = "LeadPipeline/1.0"
    contact_email: str | None = None
    respect_robots: bool = True

    # --- HTTP behaviour ---
    request_timeout: float = 20.0
    connect_timeout: float = 10.0
    max_retries: int = 3
    backoff_base: float = 0.5
    backoff_max: float = 30.0
    max_response_bytes: int = 3_000_000
    global_concurrency: int = 12
    per_host_concurrency: int = 2
    default_rate_per_second: float = 1.0
    host_rate_overrides: dict[str, float] = field(default_factory=dict)
    max_pages_per_site: int = 6

    # --- caching ---
    cache_enabled: bool = True
    cache_dir: Path = Path(".lead_pipeline_cache")
    cache_ttl_seconds: int = 7 * 24 * 3600

    # --- storage / output ---
    db_path: Path = Path("leads.sqlite")
    output_dir: Path = Path("output")

    # --- pipeline behaviour ---
    min_score: float = 60.0
    recheck_days: int = 14
    default_radius_km: float = 25.0
    default_country: str = "UK"
    allow_named_contact_emails: bool = False
    collect_contact_names: bool = True
    """Read decision-maker names the business publishes on its own site."""

    # --- logging ---
    log_level: str = "INFO"
    log_file: Path | None = None

    # --- config file overrides ---
    niches_path: Path = DEFAULT_NICHES_PATH
    weights_path: Path = DEFAULT_WEIGHTS_PATH
    directories_path: Path = DEFAULT_DIRECTORIES_PATH

    @classmethod
    def from_env(cls, env_file: str | os.PathLike[str] | None = None, load_env: bool = True) -> "Settings":
        if load_env:
            load_dotenv(env_file)

        contact_email = _env("CONTACT_EMAIL")
        user_agent = _env("USER_AGENT")
        if not user_agent:
            user_agent = cls.user_agent
            if contact_email:
                user_agent = f"{user_agent} ({contact_email})"

        host_overrides: dict[str, float] = {}
        raw_overrides = _env("HOST_RATE_OVERRIDES")
        if raw_overrides:
            for chunk in raw_overrides.split(","):
                host, _, rate = chunk.partition(":")
                try:
                    host_overrides[host.strip().lower()] = float(rate)
                except ValueError:
                    continue

        log_file = _env("LOG_FILE")
        return cls(
            google_places_api_key=_env("GOOGLE_PLACES_API_KEY"),
            bing_maps_api_key=_env("BING_MAPS_API_KEY"),
            serpapi_api_key=_env("SERPAPI_API_KEY"),
            brave_search_api_key=_env("BRAVE_SEARCH_API_KEY"),
            google_cse_api_key=_env("GOOGLE_CSE_API_KEY"),
            google_cse_cx=_env("GOOGLE_CSE_CX"),
            companies_house_api_key=_env("COMPANIES_HOUSE_API_KEY"),
            meta_ad_library_token=_env("META_AD_LIBRARY_TOKEN"),
            pagespeed_api_key=_env("PAGESPEED_API_KEY"),
            overpass_url=_env("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
            or "https://overpass-api.de/api/interpreter",
            overpass_query_timeout=_env_int("OVERPASS_QUERY_TIMEOUT", 60),
            overpass_http_timeout=_env_int("OVERPASS_HTTP_TIMEOUT", 180),
            user_agent=user_agent,
            contact_email=contact_email,
            respect_robots=_env_bool("RESPECT_ROBOTS", True),
            request_timeout=_env_float("REQUEST_TIMEOUT", 20.0),
            connect_timeout=_env_float("CONNECT_TIMEOUT", 10.0),
            max_retries=_env_int("MAX_RETRIES", 3),
            backoff_base=_env_float("BACKOFF_BASE", 0.5),
            backoff_max=_env_float("BACKOFF_MAX", 30.0),
            max_response_bytes=_env_int("MAX_RESPONSE_BYTES", 3_000_000),
            global_concurrency=_env_int("GLOBAL_CONCURRENCY", 12),
            per_host_concurrency=_env_int("PER_HOST_CONCURRENCY", 2),
            default_rate_per_second=_env_float("DEFAULT_RATE_PER_SECOND", 1.0),
            host_rate_overrides=host_overrides,
            max_pages_per_site=_env_int("MAX_PAGES_PER_SITE", 6),
            cache_enabled=_env_bool("CACHE_ENABLED", True),
            cache_dir=Path(_env("CACHE_DIR", ".lead_pipeline_cache") or ".lead_pipeline_cache"),
            cache_ttl_seconds=_env_int("CACHE_TTL_SECONDS", 7 * 24 * 3600),
            db_path=Path(_env("DB_PATH", "leads.sqlite") or "leads.sqlite"),
            output_dir=Path(_env("OUTPUT_DIR", "output") or "output"),
            min_score=_env_float("MIN_SCORE", 60.0),
            recheck_days=_env_int("RECHECK_DAYS", 14),
            default_radius_km=_env_float("DEFAULT_RADIUS_KM", 25.0),
            default_country=_env("DEFAULT_COUNTRY", "UK") or "UK",
            allow_named_contact_emails=_env_bool("ALLOW_NAMED_CONTACT_EMAILS", False),
            collect_contact_names=_env_bool("COLLECT_CONTACT_NAMES", True),
            log_level=_env("LOG_LEVEL", "INFO") or "INFO",
            log_file=Path(log_file) if log_file else None,
            niches_path=Path(_env("NICHES_PATH", str(DEFAULT_NICHES_PATH)) or DEFAULT_NICHES_PATH),
            weights_path=Path(_env("WEIGHTS_PATH", str(DEFAULT_WEIGHTS_PATH)) or DEFAULT_WEIGHTS_PATH),
            directories_path=Path(
                _env("DIRECTORIES_PATH", str(DEFAULT_DIRECTORIES_PATH)) or DEFAULT_DIRECTORIES_PATH
            ),
        )

    def with_overrides(self, **kwargs: Any) -> "Settings":
        clean = {k: v for k, v in kwargs.items() if v is not None}
        return replace(self, **clean)

    def credential_status(self) -> dict[str, bool]:
        return {
            "GOOGLE_PLACES_API_KEY": bool(self.google_places_api_key),
            "BING_MAPS_API_KEY": bool(self.bing_maps_api_key),
            "SERPAPI_API_KEY": bool(self.serpapi_api_key),
            "BRAVE_SEARCH_API_KEY": bool(self.brave_search_api_key),
            "GOOGLE_CSE_API_KEY": bool(self.google_cse_api_key and self.google_cse_cx),
            "COMPANIES_HOUSE_API_KEY": bool(self.companies_house_api_key),
            "META_AD_LIBRARY_TOKEN": bool(self.meta_ad_library_token),
            "PAGESPEED_API_KEY": bool(self.pagespeed_api_key),
        }


# --------------------------------------------------------------------------
# Niche rules
# --------------------------------------------------------------------------
@dataclass
class MoneyPage:
    """A high-intent service page we expect a serious advertiser to own."""

    name: str
    keywords: list[str]
    url_hints: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "MoneyPage":
        return cls(
            name=str(data["name"]),
            keywords=[str(k).lower() for k in data.get("keywords", [])],
            url_hints=[str(u).lower() for u in data.get("url_hints", [])],
        )


@dataclass
class NicheRule:
    """Everything the pipeline needs to know about one vertical.

    Loaded from ``config/niches.json`` so new niches never require code edits.
    """

    key: str
    label: str
    aliases: list[str] = field(default_factory=list)
    search_terms: list[str] = field(default_factory=list)
    google_place_types: list[str] = field(default_factory=list)
    osm_filters: list[str] = field(default_factory=list)
    #: Distinctive words matched against OSM POI names. Keep these
    #: business-identifying - a generic word makes the Overpass query too
    #: expensive and the server refuses it.
    osm_name_keywords: list[str] = field(default_factory=list)
    ticket_value: int = 5  # 1-10, typical customer value
    search_demand: int = 5  # 1-10, paid search intent volume
    competition: int = 5  # 1-10, local auction competitiveness
    service_keywords: list[str] = field(default_factory=list)
    premium_keywords: list[str] = field(default_factory=list)
    trust_keywords: list[str] = field(default_factory=list)
    conversion_keywords: list[str] = field(default_factory=list)
    finance_keywords: list[str] = field(default_factory=list)
    money_pages: list[MoneyPage] = field(default_factory=list)
    negative_keywords: list[str] = field(default_factory=list)
    recommended_service: str = "Landing Page + Google Ads"
    notes: str = ""

    @classmethod
    def from_dict(cls, key: str, data: Mapping[str, Any]) -> "NicheRule":
        def lower_list(name: str) -> list[str]:
            return [str(v).lower() for v in data.get(name, [])]

        return cls(
            key=key,
            label=str(data.get("label", key.replace("_", " ").title())),
            aliases=lower_list("aliases"),
            search_terms=[str(v) for v in data.get("search_terms", [])],
            google_place_types=lower_list("google_place_types"),
            osm_filters=[str(v) for v in data.get("osm_filters", [])],
            osm_name_keywords=lower_list("osm_name_keywords"),
            ticket_value=int(data.get("ticket_value", 5)),
            search_demand=int(data.get("search_demand", 5)),
            competition=int(data.get("competition", 5)),
            service_keywords=lower_list("service_keywords"),
            premium_keywords=lower_list("premium_keywords"),
            trust_keywords=lower_list("trust_keywords"),
            conversion_keywords=lower_list("conversion_keywords"),
            finance_keywords=lower_list("finance_keywords"),
            money_pages=[MoneyPage.from_dict(mp) for mp in data.get("money_pages", [])],
            negative_keywords=lower_list("negative_keywords"),
            recommended_service=str(data.get("recommended_service", "Landing Page + Google Ads")),
            notes=str(data.get("notes", "")),
        )

    def all_keywords(self) -> list[str]:
        seen: dict[str, None] = {}
        for group in (
            self.service_keywords,
            self.premium_keywords,
            self.trust_keywords,
            self.conversion_keywords,
            self.finance_keywords,
        ):
            for kw in group:
                seen.setdefault(kw, None)
        for page in self.money_pages:
            for kw in page.keywords:
                seen.setdefault(kw, None)
        return list(seen)

    def matches(self, token: str) -> bool:
        token = token.strip().lower().replace(" ", "_")
        if token == self.key:
            return True
        plain = token.replace("_", " ")
        return plain in self.aliases or plain == self.label.lower()


class NicheRegistry:
    """Container for the configured niches."""

    def __init__(self, rules: Iterable[NicheRule]):
        self._rules: dict[str, NicheRule] = {rule.key: rule for rule in rules}

    def __len__(self) -> int:
        return len(self._rules)

    def __iter__(self):
        return iter(self._rules.values())

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and self.find(key) is not None

    @property
    def keys(self) -> list[str]:
        return list(self._rules)

    def find(self, token: str) -> NicheRule | None:
        token_key = token.strip().lower().replace(" ", "_").replace("-", "_")
        if token_key in self._rules:
            return self._rules[token_key]
        for rule in self._rules.values():
            if rule.matches(token):
                return rule
        return None

    def get(self, token: str) -> NicheRule:
        rule = self.find(token)
        if rule is None:
            raise KeyError(
                f"Unknown niche {token!r}. Configured niches: {', '.join(sorted(self._rules))}"
            )
        return rule

    def all(self) -> list[NicheRule]:
        return list(self._rules.values())


def load_niches(path: str | os.PathLike[str] | None = None, extra_path: str | os.PathLike[str] | None = None) -> NicheRegistry:
    """Load niche rules from JSON. ``extra_path`` merges/overrides entries."""
    base_path = Path(path) if path else DEFAULT_NICHES_PATH
    data: dict[str, Any] = json.loads(Path(base_path).read_text(encoding="utf-8"))
    niches: dict[str, Any] = dict(data.get("niches", data))
    if extra_path:
        extra = json.loads(Path(extra_path).read_text(encoding="utf-8"))
        for key, value in dict(extra.get("niches", extra)).items():
            merged = dict(niches.get(key, {}))
            merged.update(value)
            niches[key] = merged
    return NicheRegistry(NicheRule.from_dict(key, value) for key, value in niches.items())


# --------------------------------------------------------------------------
# Scoring weights
# --------------------------------------------------------------------------
DEFAULT_WEIGHTS: dict[str, float] = {
    "business_value": 25.0,
    "marketing_opportunity": 25.0,
    "paid_acquisition": 20.0,
    "credibility": 15.0,
    "outreach_accessibility": 15.0,
}


@dataclass
class ScoringWeights:
    business_value: float = 25.0
    marketing_opportunity: float = 25.0
    paid_acquisition: float = 20.0
    credibility: float = 15.0
    outreach_accessibility: float = 15.0

    @property
    def total(self) -> float:
        return (
            self.business_value
            + self.marketing_opportunity
            + self.paid_acquisition
            + self.credibility
            + self.outreach_accessibility
        )

    def as_dict(self) -> dict[str, float]:
        return {
            "business_value": self.business_value,
            "marketing_opportunity": self.marketing_opportunity,
            "paid_acquisition": self.paid_acquisition,
            "credibility": self.credibility,
            "outreach_accessibility": self.outreach_accessibility,
        }

    @classmethod
    def load(cls, path: str | os.PathLike[str] | None = None) -> "ScoringWeights":
        target = Path(path) if path else DEFAULT_WEIGHTS_PATH
        if not Path(target).is_file():
            return cls()
        data = json.loads(Path(target).read_text(encoding="utf-8"))
        weights = data.get("weights", data)
        return cls(**{k: float(v) for k, v in weights.items() if k in DEFAULT_WEIGHTS})


def load_directories(path: str | os.PathLike[str] | None = None) -> list[dict[str, Any]]:
    """Load public-directory adapter definitions (empty by default)."""
    target = Path(path) if path else DEFAULT_DIRECTORIES_PATH
    if not Path(target).is_file():
        return []
    data = json.loads(Path(target).read_text(encoding="utf-8"))
    return list(data.get("directories", []))
