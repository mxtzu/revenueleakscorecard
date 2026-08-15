"""JSON export - the complete structured record for every lead."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Sequence

from ..models import Lead, RunStats


def export_json(
    leads: Iterable[Lead],
    path: str | Path,
    *,
    run: RunStats | None = None,
    audit_records: Sequence[Any] | None = None,
    include_raw: bool = False,
    indent: int = 2,
) -> Path:
    """Write a single JSON document: run metadata, leads, audit briefs."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "generated_at": _now(),
        "run": run.as_dict() if run else None,
        "lead_count": 0,
        "leads": [],
    }
    lead_payloads = [lead.as_dict(include_raw=include_raw) for lead in leads]
    payload["leads"] = lead_payloads
    payload["lead_count"] = len(lead_payloads)
    if audit_records is not None:
        payload["audit_records"] = [
            record.as_dict() if hasattr(record, "as_dict") else dict(record) for record in audit_records
        ]
    target.write_text(json.dumps(payload, indent=indent, default=str, ensure_ascii=False), encoding="utf-8")
    return target


def export_jsonl(leads: Iterable[Lead], path: str | Path, *, include_raw: bool = False) -> Path:
    """One JSON object per line - convenient for streaming into other tools."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for lead in leads:
            handle.write(json.dumps(lead.as_dict(include_raw=include_raw), default=str, ensure_ascii=False))
            handle.write("\n")
    return target


def _now() -> str:
    from ..models import iso_now

    return iso_now()
