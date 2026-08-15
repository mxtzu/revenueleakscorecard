"""Export formats: CSV, JSON and a portable SQLite file."""

from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import Lead, RunStats
from .csv_exporter import CSV_COLUMNS, export_audit_csv, export_csv, lead_to_csv_row
from .json_exporter import export_json, export_jsonl
from .sqlite_exporter import export_sqlite

FORMATS = ("csv", "json", "jsonl", "sqlite")


def export_all(
    leads: Sequence[Lead],
    *,
    formats: Iterable[str],
    output_dir: str | Path,
    basename: str,
    run: RunStats | None = None,
    audit_records: Sequence[Any] | None = None,
    include_raw: bool = False,
) -> dict[str, Path]:
    """Write every requested format. Returns ``{format: path}``."""
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}

    requested = []
    for value in formats:
        for part in str(value).split(","):
            part = part.strip().lower()
            if part == "all":
                requested.extend(["csv", "json", "sqlite"])
            elif part:
                requested.append(part)
    seen: dict[str, None] = {}
    for fmt in requested:
        seen.setdefault(fmt, None)

    for fmt in seen:
        if fmt not in FORMATS:
            raise ValueError(f"Unknown export format {fmt!r}. Supported: {', '.join(FORMATS)}")
        if fmt == "csv":
            written["csv"] = export_csv(leads, directory / f"{basename}.csv")
            if audit_records:
                written["audit_csv"] = export_audit_csv(audit_records, directory / f"{basename}_audit.csv")
        elif fmt == "json":
            written["json"] = export_json(
                leads, directory / f"{basename}.json", run=run, audit_records=audit_records,
                include_raw=include_raw,
            )
        elif fmt == "jsonl":
            written["jsonl"] = export_jsonl(leads, directory / f"{basename}.jsonl", include_raw=include_raw)
        elif fmt == "sqlite":
            written["sqlite"] = export_sqlite(
                leads, directory / f"{basename}.sqlite", run=run, audit_records=audit_records
            )
    return written


__all__ = [
    "export_all",
    "export_csv",
    "export_audit_csv",
    "export_json",
    "export_jsonl",
    "export_sqlite",
    "lead_to_csv_row",
    "CSV_COLUMNS",
    "FORMATS",
]
