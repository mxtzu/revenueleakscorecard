#!/usr/bin/env python3
"""Command-line entry point.

Examples::

    python pipeline.py --niche cosmetic_dentists --location "Newcastle" --radius 30
    python pipeline.py --niche roofers --location "Sunderland" --radius 25 --min-score 70
    python pipeline.py --all-niches --location "Newcastle" --radius 50
    python pipeline.py --input locations.csv --niche solar_installers
    python pipeline.py --list-sources
    python pipeline.py --delete-lead 1a2b3c4d5e6f7788
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

if __package__ in (None, ""):  # allow `python pipeline.py` from inside the package
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lead_pipeline import __version__  # noqa: E402
from lead_pipeline.config import ScoringWeights, Settings, load_niches  # noqa: E402
from lead_pipeline.database import Database, row_to_lead  # noqa: E402
from lead_pipeline.exporters import FORMATS, export_all  # noqa: E402
from lead_pipeline.report import (  # noqa: E402
    render_niche_table,
    render_source_table,
    render_summary,
    write_audit_text,
)
from lead_pipeline.runner import Pipeline, PipelineConfig  # noqa: E402
from lead_pipeline.scoring.niche_rules import assess_niche  # noqa: E402
from lead_pipeline.scoring.opportunities import build_audit_record  # noqa: E402
from lead_pipeline.sources import DEFAULT_DISCOVERY_ORDER, SOURCE_CLASSES, available_sources  # noqa: E402
from lead_pipeline.utils.geo import MAX_SEARCH_RADIUS_KM, load_locations_csv, parse_location  # noqa: E402
from lead_pipeline.utils.logging import setup_logging  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pipeline.py",
        description="Local business lead scraping, enrichment, scoring and export pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    targeting = parser.add_argument_group("targeting")
    targeting.add_argument("--niche", action="append", default=[],
                           help="Niche key or alias (repeatable). See --list-niches.")
    targeting.add_argument("--all-niches", action="store_true", help="Run every configured niche.")
    targeting.add_argument("--location", action="append", default=[],
                           help="City, town, postcode or 'lat,lon' (repeatable).")
    targeting.add_argument("--input", dest="input_csv",
                           help="CSV of locations (column: location / city / postcode).")
    targeting.add_argument("--radius", type=float, help="Search radius in km (default 25).")
    targeting.add_argument("--country", help="Country for geocoding and phone formatting (default UK).")
    targeting.add_argument("--region", help="Region/county hint applied to every location.")

    behaviour = parser.add_argument_group("pipeline behaviour")
    behaviour.add_argument("--source", action="append", default=[],
                           help=f"Restrict to a source (repeatable): {', '.join(sorted(SOURCE_CLASSES))}")
    behaviour.add_argument("--fixture", help="Local JSON/CSV file of businesses (offline runs, imports).")
    behaviour.add_argument("--min-score", type=float, help="Minimum lead score to qualify (default 60).")
    behaviour.add_argument("--limit", type=int, help="Max businesses per niche+location query (default 60).")
    behaviour.add_argument("--total-limit", type=int, help="Hard cap on leads processed after dedupe.")
    behaviour.add_argument("--analyse-websites", dest="analyse_websites", action="store_true", default=None,
                           help="Force website analysis on (default on).")
    behaviour.add_argument("--no-analyse-websites", dest="analyse_websites", action="store_false",
                           help="Skip website fetching entirely.")
    behaviour.add_argument("--analyse-ads", dest="analyse_ads", action="store_true", default=None,
                           help="Force advertising analysis on (default on).")
    behaviour.add_argument("--no-analyse-ads", dest="analyse_ads", action="store_false",
                           help="Skip advertising analysis.")
    behaviour.add_argument("--recheck-days", type=int,
                           help="Re-enrich a lead only if last checked more than N days ago (default 14).")
    behaviour.add_argument("--no-resume", action="store_true",
                           help="Ignore checkpoints and re-enrich everything.")
    behaviour.add_argument("--concurrency", type=int, help="Global concurrent request cap (default 12).")
    behaviour.add_argument("--rate", type=float, help="Default per-host requests/second (default 1.0).")
    behaviour.add_argument("--no-cache", action="store_true", help="Bypass the HTTP cache for this run.")
    behaviour.add_argument("--ignore-robots", action="store_true",
                           help=argparse.SUPPRESS)  # intentionally undocumented; see README compliance note
    behaviour.add_argument("--dry-run", action="store_true", help="Run without writing to the database.")

    output = parser.add_argument_group("output")
    output.add_argument("--output", help="Output directory (default ./output).")
    output.add_argument("--format", action="append", default=[],
                        help=f"Export format (repeatable or comma-separated): {', '.join(FORMATS)}, all")
    output.add_argument("--basename", help="Base filename for exports.")
    output.add_argument("--include-raw", action="store_true", help="Include raw source payloads in JSON.")
    output.add_argument("--top", type=int, default=10, help="How many top leads to print (default 10).")
    output.add_argument("--audit-text", action="store_true",
                        help="Also write the human-readable audit briefs as a .txt file.")

    admin = parser.add_argument_group("configuration and admin")
    admin.add_argument("--db", help="SQLite database path (default ./leads.sqlite).")
    admin.add_argument("--cache-dir", help="HTTP cache directory (default ./.lead_pipeline_cache).")
    admin.add_argument("--env-file", help="Path to a .env file.")
    admin.add_argument("--niches-file", help="Override config/niches.json.")
    admin.add_argument("--weights-file", help="Override config/scoring_weights.json.")
    admin.add_argument("--log-level", help="DEBUG, INFO, WARNING, ERROR (default INFO).")
    admin.add_argument("--log-file", help="Write structured JSON logs to this file.")
    admin.add_argument("--quiet", action="store_true", help="Suppress console logging (summary still prints).")
    admin.add_argument("--list-niches", action="store_true", help="Print configured niches and exit.")
    admin.add_argument("--list-sources", action="store_true", help="Print source availability and exit.")
    admin.add_argument("--db-stats", action="store_true", help="Print database counts and exit.")
    admin.add_argument("--list-runs", action="store_true", help="Print recent runs and exit.")
    admin.add_argument("--export-only", action="store_true",
                       help="Export existing database leads without scraping.")
    admin.add_argument("--delete-lead", action="append", default=[],
                       help="Soft-delete a lead by id (repeatable).")
    admin.add_argument("--purge-lead", action="append", default=[],
                       help="Hard-delete a lead and all its records by id (repeatable).")
    admin.add_argument("--version", action="version", version=f"lead_pipeline {__version__}")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    settings = Settings.from_env(args.env_file)
    settings = settings.with_overrides(
        db_path=Path(args.db) if args.db else None,
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        output_dir=Path(args.output) if args.output else None,
        min_score=args.min_score,
        recheck_days=args.recheck_days,
        default_country=args.country,
        default_radius_km=args.radius,
        global_concurrency=args.concurrency,
        default_rate_per_second=args.rate,
        log_level=args.log_level,
        log_file=Path(args.log_file) if args.log_file else None,
        niches_path=Path(args.niches_file) if args.niches_file else None,
        weights_path=Path(args.weights_file) if args.weights_file else None,
        cache_enabled=False if args.no_cache else None,
        respect_robots=False if args.ignore_robots else None,
    )

    setup_logging(settings.log_level, settings.log_file, quiet=args.quiet)

    if args.ignore_robots:
        print(
            "WARNING: --ignore-robots disables robots.txt checking. Only use it against sites you own "
            "or have written permission to crawl.",
            file=sys.stderr,
        )

    try:
        registry = load_niches(settings.niches_path)
    except (OSError, ValueError) as exc:
        print(f"Could not load niches config: {exc}", file=sys.stderr)
        return 2

    # ---------------------------------------------------------- info modes
    if args.list_niches:
        print(render_niche_table(registry.all()))
        return 0

    if args.list_sources:
        print(render_source_table(available_sources(settings, args.fixture)))
        print()
        print("Credential status:")
        for key, present in settings.credential_status().items():
            print(f"  {key:<26} {'set' if present else 'not set'}")
        return 0

    if args.db_stats:
        with Database(settings.db_path) as db:
            for table, count in db.counts().items():
                print(f"{table:<24} {count}")
        return 0

    if args.list_runs:
        with Database(settings.db_path) as db:
            runs = db.list_runs()
        if not runs:
            print("No runs recorded yet.")
            return 0
        print(f"{'ID':<5} {'STARTED':<22} {'STATUS':<12} {'FOUND':<7} {'DUPES':<7} {'QUALIFIED':<10} NICHES")
        for run in runs:
            print(
                f"{run['id']:<5} {str(run['started_at'])[:19]:<22} {run['status']:<12} "
                f"{run['discovered'] or 0:<7} {run['duplicates_removed'] or 0:<7} "
                f"{run['qualified'] or 0:<10} {run['niches']}"
            )
        return 0

    if args.delete_lead or args.purge_lead:
        with Database(settings.db_path) as db:
            for lead_id in args.delete_lead:
                ok = db.delete_lead(lead_id, hard=False, reason="cli request")
                print(f"{'Soft-deleted' if ok else 'Not found'}: {lead_id}")
            for lead_id in args.purge_lead:
                ok = db.delete_lead(lead_id, hard=True, reason="cli purge")
                print(f"{'Purged' if ok else 'Not found'}: {lead_id}")
        return 0

    # ------------------------------------------------------------- niches
    if args.all_niches:
        niches = registry.all()
    elif args.niche:
        niches = []
        for token in args.niche:
            for part in token.split(","):
                part = part.strip()
                if not part:
                    continue
                rule = registry.find(part)
                if rule is None:
                    print(
                        f"Unknown niche {part!r}. Configured: {', '.join(registry.keys)}",
                        file=sys.stderr,
                    )
                    return 2
                if rule not in niches:
                    niches.append(rule)
    else:
        niches = []

    # ---------------------------------------------------------- export only
    if args.export_only:
        return _export_only(args, settings, niches)

    if not niches:
        parser.error("choose a niche with --niche or --all-niches (or use --export-only)")

    # ----------------------------------------------------------- locations
    radius = args.radius if args.radius is not None else settings.default_radius_km
    country = args.country or settings.default_country
    locations = []
    for value in args.location:
        for part in value.split("|"):
            part = part.strip()
            if part:
                locations.append(parse_location(part, country=country, radius_km=radius, region=args.region))
    if args.input_csv:
        try:
            locations.extend(load_locations_csv(args.input_csv, country=country, radius_km=radius))
        except (OSError, ValueError) as exc:
            print(f"Could not read locations CSV: {exc}", file=sys.stderr)
            return 2
    if not locations:
        parser.error("provide at least one --location or an --input CSV")

    if any(loc.radius_km > MAX_SEARCH_RADIUS_KM for loc in locations):
        print(
            f"NOTE: --radius {radius:g} exceeds the {MAX_SEARCH_RADIUS_KM:g} km maximum the "
            f"discovery APIs accept (Google Places caps its search circle there, and a wider "
            f"Overpass query is refused), so {MAX_SEARCH_RADIUS_KM:g} km will be used.\n"
            f"      To cover a larger area, pass several --location values or an --input CSV; "
            f"results are deduplicated across them.",
            file=sys.stderr,
        )

    formats = args.format or ["csv", "json"]
    source_names = []
    for value in args.source:
        source_names.extend(part.strip() for part in value.split(",") if part.strip())
    if args.fixture and not source_names:
        source_names = ["fixture"]
    if not source_names:
        source_names = list(DEFAULT_DISCOVERY_ORDER)

    config = PipelineConfig(
        niches=niches,
        locations=locations,
        source_names=source_names,
        limit_per_query=args.limit or 60,
        total_limit=args.total_limit,
        min_score=settings.min_score,
        analyse_websites=True if args.analyse_websites is None else args.analyse_websites,
        analyse_ads=True if args.analyse_ads is None else args.analyse_ads,
        formats=formats,
        output_dir=settings.output_dir,
        basename=args.basename,
        fixture_path=args.fixture,
        recheck_days=settings.recheck_days,
        dry_run=args.dry_run,
        include_raw=args.include_raw,
        resume=not args.no_resume,
        country=country,
    )

    try:
        weights = ScoringWeights.load(settings.weights_path)
    except (OSError, ValueError) as exc:
        print(f"Could not load scoring weights: {exc}", file=sys.stderr)
        return 2

    pipeline = Pipeline(settings, config, weights=weights)
    try:
        result = asyncio.run(pipeline.run())
    except RuntimeError as exc:
        print(f"Cannot start pipeline: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        return 130

    exports = dict(result.exports)
    if args.audit_text and result.audit_records:
        basename = config.basename or Path(next(iter(exports.values()), Path("leads"))).stem
        exports["audit_txt"] = write_audit_text(
            result.audit_records, Path(config.output_dir) / f"{basename}_audit.txt"
        )

    print()
    print(render_summary(result.run, result.leads, result.qualified, top_n=args.top, exports=exports))
    return 0


def _export_only(args: argparse.Namespace, settings: Settings, niches: list) -> int:
    """Re-export what is already in the database, with no network access."""
    with Database(settings.db_path) as db:
        rows = db.query_leads(
            niche=niches[0].key if len(niches) == 1 else None,
            min_score=settings.min_score,
            limit=args.total_limit,
        )
        leads = []
        for row in rows:
            lead = row_to_lead(
                row,
                website=db.latest_website_analysis(row["id"]),
                advertising=db.latest_advertising_analysis(row["id"]),
            )
            leads.append(lead)

    if not leads:
        print("No stored leads match the filters.")
        return 0

    registry = load_niches(settings.niches_path)
    audit_records = []
    for lead in leads:
        rule = registry.find(lead.niche)
        if rule is None:
            continue
        audit_records.append(build_audit_record(lead, rule, assess_niche(lead, rule)))

    exports = export_all(
        leads,
        formats=args.format or ["csv", "json"],
        output_dir=settings.output_dir,
        basename=args.basename or "leads_export",
        audit_records=audit_records,
        include_raw=args.include_raw,
    )
    print(f"Exported {len(leads)} leads from {settings.db_path}")
    for fmt, path in exports.items():
        print(f"  {fmt:<10} {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
