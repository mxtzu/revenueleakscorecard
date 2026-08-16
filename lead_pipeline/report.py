"""Run reporting: the end-of-run summary and personalisation briefs."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence

from .models import Lead, RunStats
from .scoring.opportunities import AuditRecord

BAND_ORDER = ["80-100", "70-79", "60-69", "40-59", "0-39"]


def render_survey(run: RunStats, leads: Sequence[Lead]) -> str:
    """Per-niche counts for a discovery-only run.

    Answers "which of these verticals actually exists in volume around here"
    before committing to a full scrape.

    Every requested niche is listed, including the ones that returned nothing,
    and a niche whose source errored is labelled unmeasured rather than shown
    as a zero. Reading a failed query as "no businesses here" is how a whole
    vertical gets written off by mistake.

    The numbers are what the configured sources returned after dedupe, not a
    census: OpenStreetMap maps regulated premises (dentists, clinics) far more
    completely than sole-trader crafts, so a low count can mean a thin niche or
    a thinly mapped one. Compare like with like, and add Google Places for
    coverage the free sources miss.
    """
    counts = run.niche_counts or {}
    requested = list(run.niches) or list(counts)

    # Discovery errors are recorded against "<niche>@<location>".
    errored = {
        (error.target or "").split("@", 1)[0]
        for error in run.errors
        if error.stage == "discovery" and error.target
    }

    lines = ["=" * 62, "NICHE SURVEY", "=" * 62]
    lines.append(f"Locations:  {', '.join(run.locations) or '-'}")
    lines.append(f"Sources:    {', '.join(run.sources_used) or '-'}")
    lines.append(f"Found:      {run.discovered} businesses, "
                 f"{run.duplicates_removed} duplicates removed")
    lines.append("")

    if not requested:
        lines.append("No niches were requested.")
        lines.append("=" * 62)
        return "\n".join(lines)

    ranked = sorted(requested, key=lambda name: (-counts.get(name, 0), name))
    width = max(len(name) for name in ranked)
    biggest = max(counts.values()) if counts else 0
    unmeasured: list[str] = []

    for name in ranked:
        count = counts.get(name, 0)
        if count:
            bar = "#" * max(1, round(count / biggest * 28))
            lines.append(f"  {name.ljust(width)}  {str(count).rjust(4)}  {bar}")
        elif name in errored:
            unmeasured.append(name)
            lines.append(f"  {name.ljust(width)}     -  unmeasured (source errors)")
        else:
            lines.append(f"  {name.ljust(width)}     0  none found")

    lines.append("")
    if counts:
        winner = min(counts, key=lambda name: (-counts[name], name))
        location = run.locations[0] if run.locations else "<location>"
        lines.append(f"Densest measured niche: {winner} ({counts[winner]} businesses)")
        lines.append("Run it in full with:")
        lines.append(
            f'  python -m lead_pipeline.pipeline --niche {winner} --location "{location}"'
        )
    else:
        lines.append("Nothing was measured. Widen --radius, add --source google_places,")
        lines.append("or check the errors below.")

    if unmeasured:
        lines.append("")
        lines.append(
            f"{len(unmeasured)} of {len(requested)} niches went unmeasured. "
            "They are not empty - retry them alone:"
        )
        location = run.locations[0] if run.locations else "<location>"
        lines.append(
            f'  python -m lead_pipeline.pipeline --niche {",".join(unmeasured)} '
            f'--location "{location}" --survey'
        )

    if run.errors:
        by_type: dict[str, int] = {}
        for error in run.errors:
            by_type[error.error_type] = by_type.get(error.error_type, 0) + 1
        summary = ", ".join(f"{k} x{v}" for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])[:5])
        lines.append("")
        lines.append(f"Errors (non-fatal): {len(run.errors)} ({summary})")

    lines.append("=" * 62)
    return "\n".join(lines)


def render_summary(
    run: RunStats,
    leads: Sequence[Lead],
    qualified: Sequence[Lead],
    *,
    top_n: int = 10,
    exports: dict[str, Path] | None = None,
) -> str:
    lines: list[str] = []
    lines.append("=" * 62)
    lines.append("SCRAPE COMPLETE" if not run.interrupted else "SCRAPE INTERRUPTED (partial results saved)")
    lines.append("=" * 62)
    lines.append(f"Businesses discovered: {run.discovered}")
    lines.append(f"Duplicates removed:    {run.duplicates_removed}")
    lines.append(f"Businesses enriched:   {run.enriched}")
    lines.append(f"Qualified leads:       {len(qualified)}")

    if len(run.niche_counts) > 1:
        lines.append("Discovered per niche:")
        for name, count in run.niche_counts.items():
            lines.append(f"  {name}: {count}")

    bands = run.score_bands or {}
    for band in BAND_ORDER:
        count = bands.get(band, 0)
        if count or band in {"80-100", "70-79", "60-69"}:
            lines.append(f"  Score {band}: {count}")

    if run.errors:
        by_type: dict[str, int] = {}
        for error in run.errors:
            by_type[error.error_type] = by_type.get(error.error_type, 0) + 1
        summary = ", ".join(f"{k} x{v}" for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])[:5])
        lines.append(f"Errors (non-fatal):    {len(run.errors)} ({summary})")

    if run.http:
        lines.append(
            "HTTP: {requests} requests, {cache_hits} cache hits, {retries} retries, "
            "{errors} failures, {robots_blocked} robots-blocked".format(**{
                "requests": run.http.get("requests", 0),
                "cache_hits": run.http.get("cache_hits", 0),
                "retries": run.http.get("retries", 0),
                "errors": run.http.get("errors", 0),
                "robots_blocked": run.http.get("robots_blocked", 0),
            })
        )

    top = list(qualified)[:top_n]
    if top:
        lines.append("")
        lines.append("Top opportunities:")
        for index, lead in enumerate(top, start=1):
            lines.append(f"{index}. {lead.company_name}")
            lines.append(f"   Score: {lead.lead_score:.0f}")
            location = lead.city or (lead.search_locations[0] if lead.search_locations else "") or "-"
            lines.append(f"   Location: {location}")
            if lead.google_rating is not None:
                lines.append(f"   Rating: {lead.google_rating}")
            if lead.google_review_count is not None:
                lines.append(f"   Reviews: {lead.google_review_count}")
            if lead.opportunities:
                lines.append(f"   Opportunity: {lead.opportunities[0]}")
            if lead.recommended_service:
                lines.append(f"   Recommended: {lead.recommended_service}")
    else:
        lines.append("")
        lines.append("No leads met the minimum score. Try lowering --min-score or widening --radius.")

    if exports:
        lines.append("")
        lines.append("Exports:")
        for fmt, path in exports.items():
            lines.append(f"  {fmt:<10} {path}")

    if run.notes:
        lines.append("")
        lines.append("Notes:")
        for note in run.notes:
            lines.append(f"  - {note}")

    return "\n".join(lines)


def render_audit_records(records: Iterable[AuditRecord]) -> str:
    blocks = [record.render() for record in records]
    return ("\n" + "-" * 62 + "\n").join(blocks)


def write_audit_text(records: Sequence[AuditRecord], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_audit_records(records) + "\n", encoding="utf-8")
    return target


def render_source_table(rows: Sequence[dict[str, object]]) -> str:
    lines = [f"{'SOURCE':<18} {'KIND':<11} {'STATUS':<12} DETAIL"]
    lines.append("-" * 92)
    for row in rows:
        status = "available" if row.get("available") else "unavailable"
        detail = str(row.get("reason") or row.get("description") or "")
        lines.append(f"{str(row.get('name')):<18} {str(row.get('kind')):<11} {status:<12} {detail}")
    return "\n".join(lines)


def render_niche_table(rules: Sequence[object]) -> str:
    lines = [f"{'KEY':<28} {'LABEL':<34} {'TICKET':<7} {'DEMAND':<7} COMPETITION"]
    lines.append("-" * 92)
    for rule in rules:
        lines.append(
            f"{getattr(rule, 'key', ''):<28} {getattr(rule, 'label', ''):<34} "
            f"{getattr(rule, 'ticket_value', ''):<7} {getattr(rule, 'search_demand', ''):<7} "
            f"{getattr(rule, 'competition', '')}"
        )
    return "\n".join(lines)
