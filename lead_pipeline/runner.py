"""Pipeline orchestration.

    discover -> deduplicate -> enrich -> analyse ads -> score -> persist -> export

Design notes:

* every stage is fault-tolerant: one bad website, source or API call is
  recorded as an error and the run continues;
* enrichment runs concurrently under a global semaphore, on top of the HTTP
  client's per-host rate limits;
* SIGINT is caught once and drains in-flight work, then persists and exports
  what has been completed (press twice to abort hard);
* completed enrichment is checkpointed in SQLite, so a re-run of the same
  parameters skips the work it already did.
"""

from __future__ import annotations

import asyncio
import hashlib
import signal
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from .config import NicheRule, ScoringWeights, Settings
from .database import Database
from .enrichment.ads import AdMarketSnapshot, AdvertisingAnalyzer
from .enrichment.reviews import enrich_reviews
from .enrichment.social import enrich_social
from .enrichment.website import WebsiteAnalyzer, apply_website_analysis
from .exporters import export_all
from .models import Lead, PipelineError, RunStats, iso_now
from .scoring.lead_score import LeadScorer
from .scoring.niche_rules import assess_niche
from .scoring.opportunities import (
    AuditRecord,
    build_audit_record,
    build_lead_reason,
    detect_opportunities,
    detect_strengths,
    recommend_service,
)
from .sources import BaseSource, SearchQuery, SourceContext, build_sources, record_to_lead
from .sources.companies_house import CompaniesHouseSource, years_since
from .sources.search import SearchSource
from .utils.cache import HttpCache, NullCache
from .utils.deduplication import Deduplicator
from .utils.geo import Geocoder, Location
from .utils.http import AiohttpTransport, HttpClient, Transport
from .utils.logging import get_logger
from .utils.rate_limit import RateLimiter

logger = get_logger("runner")


@dataclass
class PipelineConfig:
    """Everything one invocation needs."""

    niches: list[NicheRule]
    locations: list[Location]
    source_names: list[str] = field(default_factory=list)
    limit_per_query: int = 60
    total_limit: int | None = None
    min_score: float = 60.0
    analyse_websites: bool = True
    analyse_ads: bool = True
    formats: list[str] = field(default_factory=lambda: ["csv", "json"])
    output_dir: Path = Path("output")
    basename: str | None = None
    fixture_path: str | None = None
    recheck_days: int = 14
    dry_run: bool = False
    survey: bool = False
    """Discover and dedupe only: count what exists per niche, enrich nothing."""
    include_raw: bool = False
    resume: bool = True
    country: str = "UK"


@dataclass
class PipelineResult:
    run: RunStats
    leads: list[Lead]
    qualified: list[Lead]
    audit_records: list[AuditRecord]
    exports: dict[str, Path] = field(default_factory=dict)


class Pipeline:
    def __init__(
        self,
        settings: Settings,
        config: PipelineConfig,
        *,
        database: Database | None = None,
        transport: Transport | None = None,
        weights: ScoringWeights | None = None,
    ) -> None:
        self.settings = settings
        self.config = config
        self.db = database or Database(settings.db_path)
        self._owns_db = database is None

        cache = (
            HttpCache(Path(settings.cache_dir) / "http_cache.sqlite", settings.cache_ttl_seconds)
            if settings.cache_enabled
            else NullCache()
        )
        limiter = RateLimiter(
            settings.default_rate_per_second,
            global_concurrency=settings.global_concurrency,
            per_host_concurrency=settings.per_host_concurrency,
            overrides=settings.host_rate_overrides,
        )
        self.client = HttpClient(
            user_agent=settings.user_agent,
            transport=transport or AiohttpTransport(),
            cache=cache,
            limiter=limiter,
            respect_robots=settings.respect_robots,
            timeout=settings.request_timeout,
            connect_timeout=settings.connect_timeout,
            max_retries=settings.max_retries,
            backoff_base=settings.backoff_base,
            backoff_max=settings.backoff_max,
            max_response_bytes=settings.max_response_bytes,
            default_cache_ttl=settings.cache_ttl_seconds,
        )
        self.stats = RunStats(
            niches=[n.key for n in config.niches],
            locations=[loc.raw for loc in config.locations],
        )
        self.ctx = SourceContext(settings=settings, client=self.client)
        self.scorer = LeadScorer(weights or ScoringWeights.load(settings.weights_path))
        self.deduplicator = Deduplicator()
        self.website_analyzer = WebsiteAnalyzer(settings, self.client)
        self._interrupted = asyncio.Event()
        self._hard_stop = False
        self._sources: list[BaseSource] = []
        self._search_source: SearchSource | None = None
        self._companies_house: CompaniesHouseSource | None = None
        self.ads_analyzer: AdvertisingAnalyzer | None = None
        #: Leads whose analyses were produced by *this* run (vs. reused from
        #: storage), so we only append genuinely new analysis history.
        self._freshly_enriched: set[str] = set()
        self._reused: set[str] = set()

    # ------------------------------------------------------------------
    @property
    def run_key(self) -> str:
        basis = "|".join(
            [
                ",".join(sorted(n.key for n in self.config.niches)),
                ",".join(sorted(loc.raw.lower() for loc in self.config.locations)),
                ",".join(sorted(self.config.source_names)),
                str(self.config.limit_per_query),
            ]
        )
        return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]

    def _install_signal_handler(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover
            return

        def handler() -> None:
            if self._interrupted.is_set():
                self._hard_stop = True
                logger.warning("Second interrupt received - aborting immediately")
                raise KeyboardInterrupt
            self._interrupted.set()
            self.stats.interrupted = True
            logger.warning(
                "Interrupt received - finishing in-flight work, then saving and exporting "
                "(press Ctrl-C again to abort)"
            )

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, handler)
            except (NotImplementedError, RuntimeError, ValueError):  # pragma: no cover - platform dependent
                continue

    # ------------------------------------------------------------------ run
    async def run(self) -> PipelineResult:
        self._install_signal_handler()
        config = self.config

        self._sources = build_sources(
            self.settings, config.source_names or None, fixture_path=config.fixture_path
        )
        usable = [s for s in self._sources if s.is_available()]
        for source in self._sources:
            if not source.is_available():
                message = f"Source '{source.name}' unavailable: {source.unavailable_reason()}"
                logger.info(message)
                self.stats.notes.append(message)
        if not usable:
            raise RuntimeError(
                "No usable data sources. Configure an API key in .env, enable a directory, "
                "or pass --fixture with a local file. Run `--list-sources` to see status."
            )
        self.stats.sources_used = [s.name for s in usable]

        self._search_source = next((s for s in usable if isinstance(s, SearchSource)), None)
        if self._search_source is None:
            candidate = SearchSource(self.settings)
            self._search_source = candidate if candidate.is_available() else None
        self._companies_house = CompaniesHouseSource(self.settings)
        self.ads_analyzer = AdvertisingAnalyzer(self.settings, self._search_source)

        self.stats.run_id = self.db.start_run(
            niches=[n.key for n in config.niches],
            locations=[loc.raw for loc in config.locations],
            sources=[s.name for s in usable],
            radius_km=config.locations[0].radius_km if config.locations else None,
            country=config.country,
            min_score=config.min_score,
            params={
                "limit_per_query": config.limit_per_query,
                "analyse_websites": config.analyse_websites,
                "analyse_ads": config.analyse_ads,
                "formats": config.formats,
                "run_key": self.run_key,
            },
        )
        self.ctx.run_id = self.stats.run_id

        for source in usable:
            self.db.upsert_source(source.name, source.kind, source.attribution)

        try:
            await self._geocode_locations()
            raw_leads = await self._discover(usable)
            self.stats.discovered = len(raw_leads)

            dedupe_result = self.deduplicator.dedupe(raw_leads)
            leads = dedupe_result.leads
            self.stats.duplicates_removed = dedupe_result.duplicates_removed

            self.stats.niche_counts = _count_by_niche(leads)

            if config.survey:
                # Stop here. A survey answers "how many of these exist around
                # this location", which needs discovery only - enriching every
                # niche just to count them would cost hours and hammer sites
                # the user has not decided to target yet.
                self.stats.finished_at = iso_now()
                self.stats.status = "interrupted" if self.stats.interrupted else "completed"
                self.stats.http = self.client.stats.as_dict()
                self.stats.cache = self.client.cache.stats()
                self.stats.errors.extend(self.ctx.errors)
                if self.stats.run_id is not None:
                    self.db.record_errors(self.stats.errors, self.stats.run_id)
                    self.db.finish_run(
                        self.stats.run_id,
                        status=self.stats.status,
                        discovered=self.stats.discovered,
                        duplicates_removed=self.stats.duplicates_removed,
                        error_count=len(self.stats.errors),
                        interrupted=self.stats.interrupted,
                        notes=self.stats.notes,
                    )
                return PipelineResult(run=self.stats, leads=leads, qualified=[], audit_records=[])

            if config.total_limit:
                leads = leads[: config.total_limit]

            await self._enrich_all(leads)
            self._score_all(leads)

            qualified = [lead for lead in leads if lead.lead_score >= config.min_score]
            qualified.sort(key=lambda lead: lead.lead_score, reverse=True)
            self.stats.qualified = len(qualified)
            self.stats.score_bands = _band_counts(leads)

            audit_records = [
                build_audit_record(lead, self._rule_for(lead), assess_niche(lead, self._rule_for(lead)))
                for lead in qualified
            ]

            if not config.dry_run:
                self._persist(leads)
            exports = self._export(qualified or leads, audit_records)

            self.stats.finished_at = iso_now()
            self.stats.status = "interrupted" if self.stats.interrupted else "completed"
            self.stats.http = self.client.stats.as_dict()
            self.stats.cache = self.client.cache.stats()
            self.stats.errors.extend(self.ctx.errors)

            if self.stats.run_id is not None:
                self.db.record_errors(self.stats.errors, self.stats.run_id)
                self.db.finish_run(
                    self.stats.run_id,
                    status=self.stats.status,
                    discovered=self.stats.discovered,
                    duplicates_removed=self.stats.duplicates_removed,
                    enriched=self.stats.enriched,
                    qualified=self.stats.qualified,
                    error_count=len(self.stats.errors),
                    interrupted=self.stats.interrupted,
                    notes=self.stats.notes,
                )

            return PipelineResult(
                run=self.stats,
                leads=leads,
                qualified=qualified,
                audit_records=audit_records,
                exports=exports,
            )
        finally:
            await self.client.close()
            if self._owns_db:
                self.db.close()

    # ------------------------------------------------------------ locations
    #: Sources that need (or materially benefit from) real coordinates.
    GEO_DEPENDENT_SOURCES = {"openstreetmap", "bing_places", "google_places"}

    async def _geocode_locations(self) -> None:
        needs_coordinates = any(
            source.name in self.GEO_DEPENDENT_SOURCES for source in self._sources if source.is_available()
        )
        if not needs_coordinates:
            for location in self.config.locations:
                self.db.upsert_location(location)
            return

        geocoder = Geocoder(self.client, country=self.config.country, email=self.settings.contact_email)
        for location in self.config.locations:
            if self._interrupted.is_set():
                break
            try:
                await geocoder.geocode(location)
            except Exception as exc:  # pragma: no cover - network dependent
                self.ctx.record_error(
                    stage="geocode", source="nominatim", target=location.raw, error=exc
                )
            self.db.upsert_location(location)

    # ------------------------------------------------------------ discovery
    #: Consecutive failed queries before a source is dropped for the rest of
    #: the run. A public API having a bad day should cost one or two slow
    #: queries, not one per niche x location.
    SOURCE_FAILURE_LIMIT = 3
    MAX_SOURCE_FAILURE_LIMIT = 10

    def _source_failure_limit(self) -> int:
        """Tolerate a longer bad patch on a long run.

        Three consecutive failures means "dead" in a 10-query run, but a
        120-query sweep can hit a transient patch that size and recover, and
        cutting it short there would lose far more than it saves.
        """
        planned = max(1, len(self.config.niches) * len(self.config.locations))
        return max(self.SOURCE_FAILURE_LIMIT, min(self.MAX_SOURCE_FAILURE_LIMIT, planned // 10))

    async def _discover(self, sources: Sequence[BaseSource]) -> list[Lead]:
        leads: list[Lead] = []
        consecutive_failures: dict[str, int] = {}
        exhausted: set[str] = set()
        failure_limit = self._source_failure_limit()
        for niche in self.config.niches:
            for location in self.config.locations:
                if self._interrupted.is_set():
                    return leads
                query = SearchQuery(
                    niche=niche,
                    location=location,
                    limit=self.config.limit_per_query,
                    country=self.config.country,
                )
                for source in sources:
                    if self._interrupted.is_set():
                        return leads
                    if source.name in exhausted:
                        continue
                    errors_before = len(self.ctx.errors)
                    found = 0
                    try:
                        async for record in source.search(query, self.ctx):
                            lead = record_to_lead(
                                record, niche=niche.key, location=location, country=self.config.country
                            )
                            if lead is None:
                                continue
                            if self.stats.run_id is not None:
                                lead.run_ids.append(self.stats.run_id)
                            leads.append(lead)
                            found += 1
                    except asyncio.CancelledError:  # pragma: no cover
                        raise
                    except Exception as exc:
                        self.ctx.record_error(
                            stage="discovery", source=source.name,
                            target=f"{niche.key}@{location.label}", error=exc,
                        )
                        logger.warning(
                            "Source failed; continuing",
                            extra={"source": source.name, "error": str(exc), "niche": niche.key},
                        )
                    logger.info(
                        "Discovery complete",
                        extra={
                            "source": source.name, "niche": niche.key,
                            "location": location.label, "found": found,
                        },
                    )

                    # Give up on a source that keeps failing rather than paying
                    # its timeout once per remaining niche x location.
                    if found == 0 and len(self.ctx.errors) > errors_before:
                        consecutive_failures[source.name] = (
                            consecutive_failures.get(source.name, 0) + 1
                        )
                        if consecutive_failures[source.name] >= failure_limit:
                            exhausted.add(source.name)
                            note = (
                                f"Source '{source.name}' failed "
                                f"{consecutive_failures[source.name]} times in a row and was "
                                f"skipped for the rest of this run"
                            )
                            self.stats.notes.append(note)
                            logger.warning(note, extra={"source": source.name})
                    else:
                        consecutive_failures[source.name] = 0
        return leads

    # ----------------------------------------------------------- enrichment
    async def _enrich_all(self, leads: Sequence[Lead]) -> None:
        if not leads:
            return
        semaphore = asyncio.Semaphore(max(1, self.settings.global_concurrency))
        markets: dict[str, AdMarketSnapshot | None] = {}

        if self.config.analyse_ads and self.ads_analyzer and self.ads_analyzer.can_confirm_google:
            for niche in self.config.niches:
                for location in self.config.locations:
                    if self._interrupted.is_set():
                        break
                    try:
                        markets[f"{niche.key}|{location.label.lower()}"] = (
                            await self.ads_analyzer.prepare_market(niche, location, self.ctx)
                        )
                    except Exception as exc:
                        self.ctx.record_error(
                            stage="ads_analysis", source="serpapi",
                            target=f"{niche.key}@{location.label}", error=exc,
                        )

        async def worker(lead: Lead) -> None:
            if self._interrupted.is_set():
                return
            async with semaphore:
                if self._interrupted.is_set():
                    return
                try:
                    await self._enrich_one(lead, markets)
                except asyncio.CancelledError:  # pragma: no cover
                    raise
                except Exception as exc:
                    self.ctx.record_error(
                        stage="enrichment", source="pipeline", target=lead.company_name, error=exc
                    )
                    logger.warning(
                        "Enrichment failed; continuing",
                        extra={"company": lead.company_name, "error": str(exc)},
                    )

        await asyncio.gather(*(worker(lead) for lead in leads), return_exceptions=False)
        self.stats.enriched = len(self._freshly_enriched)
        if self._reused:
            self.stats.notes.append(
                f"{len(self._reused)} lead(s) reused analyses checked within the last "
                f"{self.config.recheck_days} days (use --no-resume to force a re-check)"
            )

    async def _enrich_one(self, lead: Lead, markets: dict[str, AdMarketSnapshot | None]) -> None:
        rule = self._rule_for(lead)

        if self._should_skip_enrichment(lead):
            logger.debug("Skipping recently checked lead", extra={"company": lead.company_name})
            self._load_cached_analyses(lead)
            self._reused.add(lead.lead_id)
            return

        # 1. find a website if no source supplied one
        if not lead.website and self._search_source is not None:
            locality = lead.city or lead.postcode or (lead.search_locations[0] if lead.search_locations else None)
            try:
                website, hit = await self._search_source.find_official_website(
                    lead.company_name, locality, self.ctx
                )
            except Exception as exc:
                website, hit = None, None
                self.ctx.record_error(
                    stage="enrichment", source="search", target=lead.company_name, error=exc
                )
            if website:
                lead.set_field("website", website, "search")
                lead.normalize()
                if hit is not None:
                    lead.add_source(
                        self._search_source.make_record(
                            {"company_name": lead.company_name, "website": website},
                            source_url=hit.url,
                        )
                    )

        # 2. website analysis
        if self.config.analyse_websites:
            analysis = await self.website_analyzer.analyse(lead, rule, self.ctx)
            apply_website_analysis(lead, analysis)

        # 3. registry lookup (legal name / age)
        if self._companies_house and self._companies_house.is_available():
            record = await self._companies_house.lookup(
                lead.company_name, self.ctx, postcode=lead.postcode
            )
            if record is not None:
                lead.add_source(record)
                lead.set_field("legal_name", record.data.get("legal_name"), "companies_house")
                lead.set_field("company_number", record.data.get("company_number"), "companies_house")
                lead.set_field(
                    "incorporation_date", record.data.get("incorporation_date"), "companies_house"
                )
                lead.years_in_operation = years_since(lead.incorporation_date)

        # 4. social + reviews (local, no fetching)
        enrich_social(lead)
        enrich_reviews(lead)

        # 5. advertising intelligence
        if self.config.analyse_ads and self.ads_analyzer is not None:
            location_key = (lead.search_locations[0].lower() if lead.search_locations else "")
            market = markets.get(f"{rule.key}|{location_key}")
            lead.advertising_analysis = await self.ads_analyzer.analyse(
                lead, rule, self.ctx, market=market
            )

        lead.last_checked = iso_now()
        self._freshly_enriched.add(lead.lead_id)
        if self.stats.run_id is not None:
            self.db.checkpoint(self.run_key, lead.lead_id, "enrichment")

    def _should_skip_enrichment(self, lead: Lead) -> bool:
        if not self.config.resume:
            return False
        existing = self.db.find_existing_lead(lead)
        if not existing or not existing.get("last_checked"):
            return False
        try:
            checked = datetime.fromisoformat(existing["last_checked"])
        except (TypeError, ValueError):
            return False
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        fresh = datetime.now(timezone.utc) - checked < timedelta(days=self.config.recheck_days)
        if fresh:
            lead.lead_id = existing["id"]
            lead.last_checked = existing["last_checked"]
        return fresh

    def _load_cached_analyses(self, lead: Lead) -> None:
        """Reuse the stored analyses for a lead we are not re-checking."""
        from .database.db import _advertising_from_payload, _load_json, _website_from_payload

        website_row = self.db.latest_website_analysis(lead.lead_id)
        if website_row:
            payload = _load_json(website_row.get("raw_json"), {})
            if payload:
                lead.website_analysis = _website_from_payload(payload)
                apply_website_analysis(lead, lead.website_analysis)
        ads_row = self.db.latest_advertising_analysis(lead.lead_id)
        if ads_row:
            payload = _load_json(ads_row.get("raw_json"), {})
            if payload:
                lead.advertising_analysis = _advertising_from_payload(payload)
        enrich_social(lead)
        enrich_reviews(lead)

    # -------------------------------------------------------------- scoring
    def _score_all(self, leads: Iterable[Lead]) -> None:
        for lead in leads:
            rule = self._rule_for(lead)
            assessment = assess_niche(lead, rule)
            if assessment.sub_niche and not lead.sub_niche:
                lead.sub_niche = assessment.sub_niche
            review_profile = enrich_reviews(lead)
            social_presence = enrich_social(lead)

            lead.score = self.scorer.score(
                lead,
                rule,
                assessment=assessment,
                review_profile=review_profile,
                social_presence=social_presence,
            )
            lead.opportunities = detect_opportunities(lead, rule, assessment)
            lead.strengths = detect_strengths(lead, rule, assessment)
            lead.lead_reason = build_lead_reason(lead, rule, lead.opportunities, lead.strengths)
            lead.recommended_service = recommend_service(lead, rule)

    # ------------------------------------------------------------ persistence
    def _persist(self, leads: Sequence[Lead]) -> None:
        run_id = self.stats.run_id
        for lead in leads:
            fresh = lead.lead_id in self._freshly_enriched
            try:
                self.db.upsert_lead(lead, run_id)
                # Only append analysis history that this run actually produced;
                # reused analyses already have their row from the earlier run.
                if lead.website_analysis and fresh:
                    self.db.save_website_analysis(lead.lead_id, lead.website_analysis, run_id)
                if lead.advertising_analysis and fresh:
                    self.db.save_advertising_analysis(lead.lead_id, lead.advertising_analysis, run_id)
                if lead.score:
                    self.db.save_score(lead.lead_id, lead.score, run_id)
                if lead.opportunities:
                    self.db.save_opportunities(lead.lead_id, lead.opportunities, run_id)
            except Exception as exc:
                self.ctx.record_error(
                    stage="persistence", source="database", target=lead.company_name, error=exc
                )
                logger.warning(
                    "Failed to persist lead", extra={"company": lead.company_name, "error": str(exc)}
                )

    # ---------------------------------------------------------------- export
    def _export(self, leads: Sequence[Lead], audit_records: Sequence[AuditRecord]) -> dict[str, Path]:
        if not self.config.formats:
            return {}
        basename = self.config.basename or _default_basename(self.config)
        try:
            return export_all(
                list(leads),
                formats=self.config.formats,
                output_dir=self.config.output_dir,
                basename=basename,
                run=self.stats,
                audit_records=list(audit_records),
                include_raw=self.config.include_raw,
            )
        except Exception as exc:
            self.ctx.record_error(stage="export", source="exporters", target=basename, error=exc)
            logger.error("Export failed", extra={"error": str(exc)})
            return {}

    # ------------------------------------------------------------- helpers
    def _rule_for(self, lead: Lead) -> NicheRule:
        for rule in self.config.niches:
            if rule.key == lead.niche:
                return rule
        return self.config.niches[0]


def _count_by_niche(leads: Sequence[Lead]) -> dict[str, int]:
    """How many distinct businesses each niche turned up, most first."""
    counts: dict[str, int] = {}
    for lead in leads:
        counts[lead.niche] = counts.get(lead.niche, 0) + 1
    return dict(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def _band_counts(leads: Iterable[Lead]) -> dict[str, int]:
    bands = {"80-100": 0, "70-79": 0, "60-69": 0, "40-59": 0, "0-39": 0}
    for lead in leads:
        band = lead.score.band if lead.score else "0-39"
        bands[band] = bands.get(band, 0) + 1
    return bands


def _default_basename(config: PipelineConfig) -> str:
    niche_part = config.niches[0].key if len(config.niches) == 1 else "all-niches"
    if len(config.locations) == 1:
        location_part = _slug(config.locations[0].label)
    else:
        location_part = f"{len(config.locations)}-locations"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"leads_{niche_part}_{location_part}_{stamp}"


def _slug(value: str) -> str:
    from .utils.normalization import slugify

    return slugify(value) or "location"


async def run_pipeline(
    settings: Settings,
    config: PipelineConfig,
    *,
    database: Database | None = None,
    transport: Transport | None = None,
    weights: ScoringWeights | None = None,
) -> PipelineResult:
    pipeline = Pipeline(settings, config, database=database, transport=transport, weights=weights)
    return await pipeline.run()


def _unused(*args: Any) -> None:  # pragma: no cover - keeps linters quiet on optional imports
    return None
