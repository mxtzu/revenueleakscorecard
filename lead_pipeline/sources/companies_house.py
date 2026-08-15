"""Companies House adapter (UK registry, enrichment only).

Uses the official public Companies House REST API with HTTP Basic auth (API
key as the username). Only company-level public registry data is read - legal
name, company number, status and incorporation date. Officer/PSC endpoints
carry personal data and are deliberately not called.
"""

from __future__ import annotations

import base64
from datetime import date, datetime
from typing import Any, AsyncIterator

from ..models import SourceRecord
from ..utils.http import HttpError
from ..utils.normalization import clean_text, company_name_similarity, normalize_postcode
from .base import BaseSource, SearchQuery, SourceContext

SEARCH_URL = "https://api.company-information.service.gov.uk/search/companies"


class CompaniesHouseSource(BaseSource):
    name = "companies_house"
    kind = "enrichment"
    description = "UK Companies House public company registry (legal name, number, incorporation date)"
    attribution = "Companies House (Open Government Licence)"
    requires_credentials = ("companies_house_api_key",)

    async def search(self, query: SearchQuery, ctx: SourceContext) -> AsyncIterator[SourceRecord]:
        """Companies House is an enrichment source; it does no local discovery."""
        return
        yield  # pragma: no cover

    def _auth_header(self) -> dict[str, str]:
        key = self.settings.companies_house_api_key or ""
        token = base64.b64encode(f"{key}:".encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}", "Accept": "application/json"}

    async def lookup(
        self,
        company_name: str,
        ctx: SourceContext,
        *,
        postcode: str | None = None,
        min_similarity: float = 0.82,
    ) -> SourceRecord | None:
        """Find the registry entry for a trading name, if a confident match exists."""
        if not self.settings.companies_house_api_key or not company_name:
            return None
        try:
            payload = await ctx.client.get_json(
                SEARCH_URL,
                params={"q": company_name, "items_per_page": "10"},
                headers=self._auth_header(),
                check_robots=False,  # authorised API call
                cache_ttl=30 * 24 * 3600,
                label="companies_house_search",
            )
        except HttpError as exc:
            ctx.record_error(stage="enrichment", source=self.name, target=company_name, error=exc,
                             error_type=exc.kind)
            return None

        best: tuple[float, dict[str, Any]] | None = None
        target_postcode = normalize_postcode(postcode)
        for item in (payload or {}).get("items") or []:
            title = clean_text(item.get("title") or "")
            if not title:
                continue
            similarity = company_name_similarity(company_name, title)
            address = item.get("address") or {}
            item_postcode = normalize_postcode(address.get("postal_code"))
            if target_postcode and item_postcode and target_postcode == item_postcode:
                similarity = min(1.0, similarity + 0.12)
            if best is None or similarity > best[0]:
                best = (similarity, item)

        if best is None or best[0] < min_similarity:
            return None

        item = best[1]
        if (item.get("company_status") or "").lower() not in {"active", ""}:
            return None

        incorporation_date = item.get("date_of_creation")
        address = item.get("address") or {}
        data = {
            "company_name": clean_text(item.get("title") or company_name),
            "legal_name": clean_text(item.get("title") or ""),
            "company_number": item.get("company_number"),
            "incorporation_date": incorporation_date,
            "postcode": normalize_postcode(address.get("postal_code")),
            "address": clean_text(
                ", ".join(
                    p for p in [
                        address.get("premises"), address.get("address_line_1"),
                        address.get("locality"), address.get("postal_code"),
                    ] if p
                )
            ),
            "business_status": item.get("company_status"),
        }
        record = self.make_record(
            data,
            source_url=f"https://find-and-update.company-information.service.gov.uk/company/{item.get('company_number')}",
            source_record_id=item.get("company_number"),
            raw={"match_similarity": round(best[0], 3), "item": item},
        )
        return record


def years_since(iso_date: str | None) -> float | None:
    if not iso_date:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y"):
        try:
            parsed = datetime.strptime(iso_date, fmt).date()
            break
        except ValueError:
            parsed = None  # type: ignore[assignment]
    else:
        return None
    if parsed is None:
        return None
    delta = date.today() - parsed
    return round(delta.days / 365.25, 1)
