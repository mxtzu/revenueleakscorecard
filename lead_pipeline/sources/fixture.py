"""Local file source (JSON/CSV).

Two uses:

* import a list of businesses you already have (a client list, an export from
  another tool) and run it through enrichment/scoring;
* run the whole pipeline offline for demos and end-to-end tests.

Point it at a file with ``--fixture path.json`` (or ``--source fixture`` with
``FIXTURE_PATH`` set).
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

from ..models import SourceRecord
from ..utils.normalization import clean_text
from .base import BaseSource, SearchQuery, SourceContext

FIELD_ALIASES = {
    "name": "company_name",
    "business_name": "company_name",
    "phone": "business_phone",
    "telephone": "business_phone",
    "email": "business_email",
    "url": "website",
    "web": "website",
    "rating": "google_rating",
    "reviews": "google_review_count",
    "review_count": "google_review_count",
    "place_id": "google_place_id",
    "category": "google_category",
    "maps_url": "google_maps_url",
    "facebook": "facebook_url",
    "instagram": "instagram_url",
    "linkedin": "linkedin_url",
    "tiktok": "tiktok_url",
    "youtube": "youtube_url",
    "lat": "latitude",
    "lon": "longitude",
    "lng": "longitude",
}


class FixtureSource(BaseSource):
    name = "fixture"
    kind = "discovery"
    description = "Local JSON/CSV file of businesses (offline runs, imports, tests)"
    attribution = "Local file"
    requires_credentials = ()

    def __init__(self, settings: Any, path: str | Path | None = None) -> None:
        super().__init__(settings)
        self.path = Path(path) if path else None
        self._records: list[dict[str, Any]] | None = None

    def is_available(self) -> bool:
        return bool(self.path and Path(self.path).is_file())

    def unavailable_reason(self) -> str:
        if not self.path:
            return "no fixture path configured (use --fixture PATH)"
        if not Path(self.path).is_file():
            return f"fixture file not found: {self.path}"
        return ""

    def load(self) -> list[dict[str, Any]]:
        if self._records is not None:
            return self._records
        if not self.path:
            self._records = []
            return self._records
        path = Path(self.path)
        if path.suffix.lower() == ".csv":
            self._records = _load_csv(path)
        else:
            self._records = _load_json(path)
        return self._records

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        emitted = 0
        for row in self.load():
            if emitted >= query.limit:
                break
            data = _normalize_keys(row)
            if not data.get("company_name"):
                continue
            if not _matches(data, query):
                continue
            data.setdefault("country", query.country)
            source_name = clean_text(str(data.pop("source", "") or "")) or None
            record = self.make_record(
                data,
                source_url=data.get("source_url") or data.get("website"),
                source_record_id=str(row.get("id") or data.get("google_place_id") or data.get("website") or ""),
                raw={"fixture_row": row},
            )
            if source_name:
                # Fixtures can simulate several upstream sources (dedupe tests).
                record.source = source_name
            emitted += 1
            yield record


def _load_json(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        for key in ("businesses", "records", "leads", "results", "items"):
            if isinstance(payload.get(key), list):
                return list(payload[key])
        return [payload]
    if isinstance(payload, list):
        return list(payload)
    return []


def _load_csv(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def _normalize_keys(row: dict[str, Any]) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key, value in row.items():
        if value in (None, ""):
            continue
        canonical = FIELD_ALIASES.get(str(key).strip().lower(), str(key).strip().lower())
        data[canonical] = value
    if isinstance(data.get("opening_hours"), str):
        data["opening_hours"] = [h.strip() for h in data["opening_hours"].split("|") if h.strip()]
    return data


def _matches(data: dict[str, Any], query: SearchQuery) -> bool:
    """Filter fixture rows by niche/location when those columns are present."""
    niche_value = str(data.get("niche") or "").strip().lower()
    if niche_value and not query.niche.matches(niche_value):
        if niche_value.replace(" ", "_") != query.niche.key:
            return False

    location_fields = [
        str(data.get("city") or ""),
        str(data.get("region") or ""),
        str(data.get("address") or ""),
        str(data.get("search_location") or ""),
    ]
    target = query.location.label.strip().lower()
    if not target or target in {"anywhere", "*"}:
        return True
    if any(target in value.lower() for value in location_fields if value):
        return True
    # No location columns at all -> keep the row (single-location fixture file).
    return not any(location_fields)


def iter_fixture_files(paths: Iterable[str | Path]) -> list[Path]:
    files: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            files.extend(sorted(p for p in path.iterdir() if p.suffix.lower() in {".json", ".csv"}))
        elif path.is_file():
            files.append(path)
    return files
